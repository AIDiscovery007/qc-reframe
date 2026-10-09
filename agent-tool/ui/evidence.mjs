import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { release, homedir } from 'node:os';
import { resolve, isAbsolute, join } from 'node:path';
import { sourceState, fixtureState, fingerprint, root, requireExtension, extension } from './inventory.mjs';
import { scenarios } from './catalog.mjs';
import { validationWindow } from './build.mjs';
import { visualScenarios, visualPolicy } from './visual.mjs';

export async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const fontDirectories = () => process.platform === 'darwin' ? ['/System/Library/Fonts', '/Library/Fonts', join(homedir(), 'Library/Fonts')] : ['/usr/share/fonts', '/usr/local/share/fonts', '/etc/fonts', join(homedir(), '.fonts'), join(homedir(), '.local/share/fonts'), join(homedir(), '.config/fontconfig')];

// Portable selection identity: retain ordered roots and relative filenames, hash
// actual font/config bytes (including symlink targets), never installation mtimes.
export async function fontContentInventory(directories = fontDirectories()) {
  const hash = createHash('sha256');
  async function visit(path, name, ancestors = new Set()) {
    const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    hash.update(JSON.stringify(name));
    if (!info) { hash.update('missing'); return; }
    const actual = await realpath(path);
    if (ancestors.has(actual)) throw Error('Cyclic font directory: ' + path);
    if (info.isSymbolicLink()) { await visit(actual, name, ancestors); return; }
    if (info.isFile()) { hash.update('file').update(await fileDigest(path)); return; }
    if (!info.isDirectory()) throw Error('Unsupported font entry: ' + path);
    hash.update('directory');
    for (const file of (await readdir(path)).sort()) await visit(join(path, file), name + '/' + file, new Set([...ancestors, actual]));
  }
  for (const [index, directory] of directories.entries()) await visit(directory, String(index));
  return hash.digest('hex');
}

async function fontInventory() {
  const hash = createHash('sha256');
  async function visit(path) {
    const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    hash.update(path).update(info ? `${info.size}:${info.mtimeMs}` : 'missing');
    if (info?.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  }
  for (const directory of fontDirectories()) await visit(directory);
  return hash.digest('hex');
}

// This is a same-machine, same-environment receipt, not a portable or signed approval.
export async function evidenceState() {
  return {
    sourceHash: (await sourceState()).hash,
    buildHash: await fingerprint(resolve(extension, '.output/chrome-mv3')),
    fixtureHash: (await fixtureState()).hash,
    checkerHash: await fingerprint(resolve(root, 'agent-tool/ui')),
    environment: await evidenceEnvironment(),
  };
}

export async function evidenceEnvironment({ portableFonts = false } = {}) {
  const { chromium } = requireExtension('playwright');
  // Pinned Playwright exposes its registry through coreBundle; fail closed if that contract changes.
  const { registry } = requireExtension('playwright-core/lib/coreBundle');
  const headlessShell = registry.registry.findExecutable('chromium-headless-shell').executablePath();
  return {
    platform: process.platform, arch: process.arch, osRelease: release(), node: process.version,
    playwright: requireExtension('playwright/package.json').version,
    chromium: await fileDigest(chromium.executablePath()), headlessShell: await fileDigest(headlessShell),
    browserDriver: await fileDigest(requireExtension.resolve('playwright-core/lib/coreBundle')), fonts: await (portableFonts ? fontContentInventory() : fontInventory()),
    variables: Object.fromEntries(['LANG', 'LC_ALL', 'TZ', 'FONTCONFIG_FILE', 'FONTCONFIG_PATH', 'PLAYWRIGHT_BROWSERS_PATH'].map(key => [key, process.env[key] || ''])),
  };
}

function artifactPaths(report) {
  const paths = new Set();
  function walk(value, key = '') {
    if (typeof value === 'string' && isAbsolute(value) && /\.(json|md|html|png|zip)$/.test(value) && key !== 'directory') paths.add(value);
    else if (value && typeof value === 'object') for (const [name, child] of Object.entries(value)) walk(child, name);
  }
  for (const step of report.steps) {
    if (step.reportPath) paths.add(step.reportPath);
    if (step.summaryPath) paths.add(step.summaryPath);
    walk(step.evidence);
    for (const scene of step.scenarios || []) walk(scene.evidence);
  }
  walk(report.visualCandidate);
  return [...paths].sort();
}

export async function sealArtifacts(report) {
  return Promise.all(artifactPaths(report).map(async path => ({ path, sha256: await fileDigest(path) })));
}

export function validateBrowserCoverage(preview, extensionReport, expectedScenarios) {
  if (preview.status !== 'passed' || preview.fault || preview.error || preview.cleanupErrors?.length) throw new Error('预览存在失败、故障注入、中断或清理错误');
  if (!expectedScenarios?.length || new Set(expectedScenarios).size !== expectedScenarios.length || expectedScenarios.some(id => !scenarios.some(scene => scene.id === id))) throw new Error('应跑场景为空、重复或未知');
  if (JSON.stringify(preview.scenarios?.map(scene => scene.id).sort()) !== JSON.stringify([...expectedScenarios].sort())) throw new Error('必需场景缺失或重复');
  const skips = [];
  for (const scene of preview.scenarios) {
    const spec = scenarios.find(item => item.id === scene.id);
    if (scene.status !== 'passed' || scene.errors?.length || !scene.checks?.length || !scene.evidence?.screenshot) throw new Error('场景证据不完整: ' + scene.id);
    for (const ruleId of spec.regression ? ['UI-BEHAVIOR'] : spec.rules) {
      if (!scene.checks.some(check => check.ruleId === ruleId && check.status === 'passed')) throw new Error(`场景缺必需检查: ${scene.id}/${ruleId}`);
    }
    for (const check of scene.checks) {
      if (check.status === 'passed') continue;
      const rotationNA = ['example-image-viewer-result-short', 'example-image-viewer-result-popup'].includes(scene.id) && check.ruleId === 'UI-IMAGE-VIEWPORT' && check.target === 'rotation aspect ratio' && check.actual?.present === false;
      const nativePicker = scene.id === 'example-native-controls' && check.target === 'native select keyboard picker' && check.actual?.capability?.changed === false;
      if (check.status !== 'skipped' || !check.message || !(rotationNA || nativePicker)) throw new Error('失败或未经说明的跳过: ' + scene.id);
      skips.push({ scenario: scene.id, ...check, reason: check.message });
    }
  }
  const counts = { 'UI-EXTENSION-BUILD': 2, 'UI-EXTENSION-LOAD': 1, 'UI-EXTENSION-NETWORK': 2, 'UI-EXTENSION-POPUP': 2, 'UI-EXTENSION-CLOSED-SHADOW': 3, 'UI-EXTENSION-MENU': 2, 'UI-EXTENSION-FOCUS': 2, 'UI-EXTENSION-PAGE-ERROR': 1, 'UI-EXTENSION-CLEANUP': 1 };
  if (extensionReport.status !== 'passed' || extensionReport.error || !extensionReport.checks || extensionReport.checks.length !== 16 || extensionReport.checks.some(check => check.status !== 'passed') || Object.entries(counts).some(([id, count]) => extensionReport.checks.filter(check => check.ruleId === id).length !== count)) throw new Error('真实扩展必需检查不完整');
  const env = extensionReport.environment;
  if (!env || env.interrupted || env.productionBundleModified !== false || !env.profileRemoved || !env.browserClosed || !env.serverClosed) throw new Error('扩展隔离或清理条件不符');
  if (!preview.source?.hash || !preview.source?.buildHash || [env.before, env.after].some(item => item?.sourceHash !== preview.source.hash || item?.buildHash !== preview.source.buildHash)) throw new Error('报告来源相互不一致');
  return skips;
}

export function validateCoverage(report) {
  if (report.schemaVersion !== 2 || report.status !== 'passed' || report.error || !['browser', 'full'].includes(report.tier)) throw new Error('需要当前格式且完整通过的 browser/full 门禁');
  const expectedSteps = ['static-and-maintenance', 'preview', 'extension', ...(report.tier === 'full' ? ['visual'] : [])];
  if (JSON.stringify(report.steps?.map(step => step.id)) !== JSON.stringify(expectedSteps) || report.steps.some(step => step.status !== 'passed')) throw new Error('门禁步骤缺失、重复、失败或顺序不符');
  const preview = report.steps[1], extensionReport = report.steps[2];
  if (preview.scope !== 'complete') throw new Error('预览仅开发覆盖，不是完整门禁');
  if (report.tier === 'full') {
    const visual = report.steps[3];
    if (JSON.stringify(visual.policy) !== JSON.stringify(visualPolicy) || JSON.stringify(visual.scenarios?.map(scene => scene.id).sort()) !== JSON.stringify([...visualScenarios].sort()) || visual.scenarios.some(scene => scene.status !== 'passed' || !scene.evidence?.before || !scene.evidence?.after || !scene.evidence?.diff)) throw new Error('视觉检查范围、策略或证据不完整');
  }
  const skips = validateBrowserCoverage(preview, extensionReport, scenarios.map(scene => scene.id));
  const state = report.evidenceState;
  if (!state || preview.source?.hash !== state.sourceHash || preview.source?.buildHash !== state.buildHash || preview.fixture?.hash !== state.fixtureHash || preview.rulesAndRunnerHash !== state.checkerHash) throw new Error('报告来源相互不一致');
  return skips;
}

export function inspectEvidence({ report: path, sha256, reason = 'review' } = {}) {
  return validationWindow('evidence', async () => {
    const started = performance.now();
    if (!/^[a-f0-9]{64}$/.test(sha256 || '') || await fileDigest(path) !== sha256) throw new Error('证据摘要不符；使用执行者交付时记录的可信 SHA-256，不从待审报告重新生成摘要');
    const report = JSON.parse(await readFile(path, 'utf8'));
    const skips = validateCoverage(report);
    // Time-dependent exceptions and the diff base are cheap to recheck; only browser work is reused.
    const { check } = await import('./gate.mjs');
    const staticCheck = await check({ changed: true, base: report.base || 'HEAD' });
    if (staticCheck.status !== 'passed') throw new Error('当前静态/目录/例外门禁未通过，不复用为当前交付证据');
    const age = Date.now() - Date.parse(report.finishedAt);
    if (!Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000) throw new Error('证据超过同日工作窗口（24h）或时间无效');
    if (process.platform === 'win32') throw new Error('Windows环境尚未登记字体指纹策略，不复用浏览器证据');
    const current = await evidenceState();
    if (JSON.stringify(current) !== JSON.stringify(report.evidenceState)) throw new Error('当前源码、构建、fixture、检查器或运行环境已变化');
    const artifacts = await sealArtifacts(report);
    if (JSON.stringify(artifacts) !== JSON.stringify(report.artifacts)) throw new Error('报告/截图/trace/候选附件缺失、损坏或被修改');
    for (const step of report.steps.filter(step => step.reportPath)) {
      const stored = JSON.parse(await readFile(step.reportPath, 'utf8'));
      for (const key of ['status', 'scenarios', 'checks', 'environment', 'source', 'fixture', 'rulesAndRunnerHash']) if (JSON.stringify(stored[key]) !== JSON.stringify(step[key])) throw new Error('门禁与原始报告内容不一致: ' + step.id);
    }
    return { status: 'passed', reusable: true, reportPath: path, evidenceSha256: sha256, reason, durationMs: Math.round(performance.now() - started), staticCheck: { status: staticCheck.status, findings: staticCheck.findings, exceptions: staticCheck.exceptions }, scope: 'Same-machine browser evidence only; independent risk review remains required. No product/tool test or visual approval is inferred.', skipped: skips, visualApproval: 'not-inferred', uncovered: [...report.steps[1].uncovered, ...report.steps[2].uncovered] };
  });
}
