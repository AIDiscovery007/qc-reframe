import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { extension, requireExtension } from './inventory.mjs';

const sharp = requireExtension('sharp');
export const visualScenarios = Object.freeze(['workspace-wide', 'workspace-narrow', 'popup']);
export const visualPolicy = Object.freeze({ channelTolerance: 8, maxDiffPixels: 0 });
export const defaultBaselineDirectory = resolve(extension, 'docs/uiux/visual-baselines');
const digest = data => createHash('sha256').update(data).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const validHash = value => typeof value === 'string' && hashPattern.test(value);
const nonempty = value => typeof value === 'string' && !!value.trim();
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function selection(ids = visualScenarios) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !visualScenarios.includes(id))) throw new Error('视觉场景必须明确选择已登记核心场景，不能使用路径、通配符或重复项');
  return ids;
}

export function visualEnvironment(report, scenario) {
  const environment = {};
  for (const key of ['platform', 'arch', 'osRelease', 'browser', 'locale', 'timezone', 'motion', 'previewShell']) {
    const value = report.environment?.[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少受控环境字段 ${key}`);
    environment[key] = value;
  }
  if (typeof report.environment.headless !== 'boolean' || !(report.environment.dpr > 0) || !Number.isFinite(report.environment.dpr)) throw new Error('缺少受控环境 headless/dpr');
  environment.headless = report.environment.headless;
  environment.dpr = report.environment.dpr;
  environment.fontsHash = scenario.fontsHash || report.environment.fontsHash;
  if (!validHash(environment.fontsHash)) throw new Error('缺少真实字体测量指纹 fontsHash');
  const { width, height } = scenario.viewport || {};
  if (![width, height].every(value => Number.isInteger(value) && value > 0)) throw new Error('缺少场景 viewport');
  environment.viewport = { width, height };
  return { environment, environmentKey: digest(JSON.stringify(environment)) };
}

function provenance(report, scenario) {
  if (report.status !== 'passed' || report.error || report.fault || scenario.status !== 'passed') throw new Error('只允许使用完成且通过、未注入故障的验证报告');
  for (const value of [report.source?.hash, report.source?.buildHash, report.fixture?.hash, report.rulesAndRunnerHash]) if (!validHash(value)) throw new Error('报告缺少有效的源码、构建、fixture 或检查器指纹');
  if (!nonempty(report.source.revision) || typeof report.source.dirty !== 'boolean') throw new Error('来源必须包含有效 revision 和 boolean dirty');
  if (typeof scenario.path !== 'string' || !scenario.path.startsWith('/') || scenario.path.startsWith('//')) throw new Error('场景缺少本地预览路径');
  return {
    source: { hash: report.source.hash, buildHash: report.source.buildHash, revision: report.source.revision, dirty: report.source.dirty },
    fixtureHash: report.fixture.hash, rulesAndRunnerHash: report.rulesAndRunnerHash, path: scenario.path,
  };
}

function validateMetadata(entry) {
  const verified = visualEnvironment({ environment: entry.environment }, { viewport: entry.environment?.viewport });
  if (!validHash(entry.environmentKey) || verified.environmentKey !== entry.environmentKey) throw new Error('环境 key 与实际环境元数据不符');
  if (JSON.stringify(entry.policy) !== JSON.stringify(visualPolicy)) throw new Error('候选或基线阈值与受控策略不一致');
  provenance({ status: 'passed', source: entry.source, fixture: { hash: entry.fixtureHash }, rulesAndRunnerHash: entry.rulesAndRunnerHash }, { status: 'passed', path: entry.path });
}

function validateReview(review) {
  if (!nonempty(review?.reason) || !nonempty(review?.reviewer) || typeof review.reviewedAt !== 'string' || !Number.isFinite(Date.parse(review.reviewedAt)) || new Date(review.reviewedAt).toISOString() !== review.reviewedAt) throw new Error('基线缺少有效审阅者、理由或审阅时间');
}

function validateScreenshot(screenshot) {
  if (!validHash(screenshot?.sha256) || ![screenshot.width, screenshot.height].every(value => Number.isInteger(value) && value > 0)) throw new Error('图片指纹或尺寸元数据无效');
}

async function directory(path, create = false) {
  if (create) await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('目录不能是符号链接或普通文件');
  return realpath(path);
}

async function localFile(path) {
  if (!isAbsolute(path)) throw new Error('截图路径必须为绝对路径');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 50 * 1024 * 1024) throw new Error('只接受不超过50MB的普通文件，拒绝符号链接');
  return readFile(path);
}

async function png(bytes) {
  const image = sharp(bytes, { limitInputPixels: 20_000_000 });
  if ((await image.metadata()).format !== 'png') throw new Error('视觉证据必须是 PNG');
  const { data, info } = await image.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, sha256: digest(bytes) };
}

async function loadBaseline(base, id) {
  let scenarioDirectory;
  try { scenarioDirectory = await directory(join(await directory(base), id)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let raw;
  try { raw = await localFile(join(scenarioDirectory, 'manifest.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const manifest = JSON.parse(raw);
  if (manifest.schemaVersion !== 1 || manifest.scenario !== id || manifest.screenshot?.file !== `baseline-${manifest.screenshot?.sha256}.png`) throw new Error('基线 manifest 或图片路径无效');
  validateMetadata(manifest);
  validateScreenshot(manifest.screenshot);
  validateReview(manifest.review);
  if (!Array.isArray(manifest.history)) throw new Error('基线缺少审阅历史数组');
  for (const previous of manifest.history) {
    validateScreenshot(previous.screenshot);
    validateReview(previous.review);
    provenance({ status: 'passed', source: previous.source, fixture: { hash: manifest.fixtureHash }, rulesAndRunnerHash: manifest.rulesAndRunnerHash }, { status: 'passed', path: manifest.path });
  }
  const bytes = await localFile(join(scenarioDirectory, manifest.screenshot.file));
  if (digest(bytes) !== manifest.screenshot.sha256) throw new Error('基线图片指纹不符');
  const image = await png(bytes);
  if (image.width !== manifest.screenshot.width || image.height !== manifest.screenshot.height) throw new Error('基线图片尺寸与 manifest 不符');
  return { manifest, bytes, image };
}

async function pixelDifference(before, after) {
  const width = Math.max(before.width, after.width), height = Math.max(before.height, after.height);
  if (width * height > 20_000_000) throw new Error('差异图超过2000万像素');
  const pixels = Buffer.alloc(width * height * 4);
  let changedPixels = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = (y * before.width + x) * 4, b = (y * after.width + x) * 4, output = (y * width + x) * 4;
    const absent = x >= before.width || y >= before.height || x >= after.width || y >= after.height;
    const changed = absent || [0, 1, 2, 3].some(channel => Math.abs(before.data[a + channel] - after.data[b + channel]) > visualPolicy.channelTolerance);
    if (changed) { changedPixels++; pixels.set([255, 0, 128, 255], output); }
    else { const gray = Math.round((after.data[b] + after.data[b + 1] + after.data[b + 2]) / 3); pixels.set([gray, gray, gray, 120], output); }
  }
  return { changedPixels, totalPixels: width * height, png: await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer() };
}

async function saveComparison(result) {
  await writeFile(result.reportPath, JSON.stringify(result, null, 2));
  const sections = result.scenarios.map(item => `<section><h2>${escape(item.id)} — ${escape(item.status)}</h2><p>${escape(item.reason || '')}</p><p>${item.changedPixels ?? '—'} changed pixels / ${item.totalPixels ?? '—'}</p><details><summary>Environment, source and review metadata</summary><pre>${escape(JSON.stringify({ current: item.metadata, baseline: item.baselineMetadata }, null, 2))}</pre></details><div class="images">${['before', 'after', 'diff'].map(kind => item.evidence?.[kind] ? `<figure><figcaption>${kind}</figcaption><a href="${escape(item.id + '.' + kind + '.png')}"><img src="${escape(item.id + '.' + kind + '.png')}" alt="${escape(item.id + ' ' + kind)}"></a></figure>` : `<p>${kind}: unavailable</p>`).join('')}</div></section>`).join('');
  await writeFile(result.htmlPath, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'"><title>Reframe visual comparison</title><style>body{font:16px system-ui;margin:24px;background:#fafafa;color:#202020}section{margin:32px 0}.images{display:flex;gap:16px;align-items:start;overflow:auto}figure{margin:0;min-width:240px;flex:1}img{max-width:100%;border:1px solid #777}figcaption{font-weight:bold;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Reframe visual comparison: ${escape(result.status)}</h1><p>Fixed RGBA channel tolerance: ${visualPolicy.channelTolerance}; allowed changed pixels: ${visualPolicy.maxDiffPixels}. No masks. Click images for their original size.</p>${result.candidatePath ? '<p><a href="candidate.json">Candidate manifest</a> — no baseline is accepted. A reviewer name does not establish authorization.</p>' : ''}${sections}</html>`);
}

export async function compareVisual(report, { baselineDirectory = defaultBaselineDirectory, scenarioIds } = {}) {
  const ids = selection(scenarioIds), output = await mkdtemp(join(tmpdir(), 'reframe-ui-visual-'));
  const result = { schemaVersion: 1, status: 'uncovered', policy: visualPolicy, directory: output, reportPath: join(output, 'visual.json'), htmlPath: join(output, 'index.html'), scenarios: [] };
  for (const id of ids) {
    const item = { id, status: 'uncovered', evidence: {} };
    result.scenarios.push(item);
    try {
      const matching = report.scenarios?.filter(scenario => scenario.id === id) || [];
      if (matching.length !== 1) throw new Error('报告缺少唯一场景');
      const scenario = matching[0];
      const metadata = { ...visualEnvironment(report, scenario), ...provenance(report, scenario) };
      item.metadata = metadata;
      const bytes = await localFile(scenario.evidence?.screenshot || '');
      const current = await png(bytes);
      item.evidence.after = join(output, id + '.after.png');
      await writeFile(item.evidence.after, bytes);
      const baseline = await loadBaseline(baselineDirectory, id);
      if (!baseline) { item.reason = 'missing-baseline: 尚未审阅并接受基线'; continue; }
      item.baselineMetadata = baseline.manifest;
      item.evidence.before = join(output, id + '.before.png');
      await writeFile(item.evidence.before, baseline.bytes);
      if (baseline.manifest.environmentKey !== metadata.environmentKey || baseline.manifest.fixtureHash !== metadata.fixtureHash || baseline.manifest.path !== metadata.path) {
        item.reason = 'incompatible-baseline: 环境、字体、视口或 fixture 不匹配';
        item.expectedEnvironment = baseline.manifest.environment;
        item.actualEnvironment = metadata.environment;
        continue;
      }
      const difference = await pixelDifference(baseline.image, current);
      item.changedPixels = difference.changedPixels;
      item.totalPixels = difference.totalPixels;
      item.evidence.diff = join(output, id + '.diff.png');
      await writeFile(item.evidence.diff, difference.png);
      const sameSize = baseline.image.width === current.width && baseline.image.height === current.height;
      item.status = sameSize && difference.changedPixels <= visualPolicy.maxDiffPixels ? 'passed' : 'failed';
      item.reason = !sameSize ? 'screenshot-size-changed' : item.status === 'failed' ? 'pixel-difference' : 'within-fixed-policy';
    } catch (error) { item.status = 'failed'; item.reason = error.message; }
  }
  result.status = result.scenarios.some(item => item.status === 'failed') ? 'failed' : result.scenarios.every(item => item.status === 'passed') ? 'passed' : 'uncovered';
  await saveComparison(result);
  return result;
}

export async function proposeVisual(report, { baselineDirectory = defaultBaselineDirectory, scenarioIds } = {}) {
  const comparison = await compareVisual(report, { baselineDirectory, scenarioIds: selection(scenarioIds) });
  try {
    const entries = [];
    for (const item of comparison.scenarios) {
      if (!item.metadata || !item.evidence.after) throw new Error(item.reason || '候选缺少有效截图证据');
      // Accept exactly the immutable copy displayed as "after", never reread the source.
      const image = await png(await localFile(item.evidence.after));
      const entry = { scenario: item.id, ...item.metadata, policy: visualPolicy, screenshot: { file: item.id + '.after.png', sha256: image.sha256, width: image.width, height: image.height } };
      validateMetadata(entry);
      item.metadata = entry;
      entries.push(entry);
    }
    const candidatePath = join(comparison.directory, 'candidate.json');
    const result = { ...comparison, status: 'candidate', comparisonStatus: comparison.status, candidatePath };
    await saveComparison(result);
    const manifest = { schemaVersion: 1, status: 'candidate', createdAt: new Date().toISOString(), scenarios: entries, reviewArtifact: { file: 'index.html', sha256: digest(await localFile(result.htmlPath)) } };
    await writeFile(candidatePath, JSON.stringify(manifest, null, 2));
    return result;
  } catch (error) { await rm(comparison.directory, { recursive: true, force: true }); throw error; }
}

export async function acceptVisual(candidateDirectory, { baselineDirectory = defaultBaselineDirectory, scenario, reason, reviewer } = {}) {
  selection([scenario]);
  if (typeof reason !== 'string' || reason.trim().length < 3 || typeof reviewer !== 'string' || !reviewer.trim()) throw new Error('接受基线必须提供明确 scenario、reason 和 reviewer；工具不代替人工审阅');
  const candidateRoot = await directory(candidateDirectory);
  const proposal = JSON.parse(await localFile(join(candidateRoot, 'candidate.json')));
  if (proposal.schemaVersion !== 1 || proposal.status !== 'candidate' || !Array.isArray(proposal.scenarios)) throw new Error('候选 manifest 无效');
  if (proposal.reviewArtifact?.file !== 'index.html' || !validHash(proposal.reviewArtifact.sha256) || digest(await localFile(join(candidateRoot, 'index.html'))) !== proposal.reviewArtifact.sha256) throw new Error('候选审阅 HTML 已变化或缺少指纹，请重新生成并复核');
  const matches = proposal.scenarios.filter(item => item.scenario === scenario);
  if (matches.length !== 1) throw new Error('候选缺少唯一指定场景');
  const entry = matches[0];
  if (entry.screenshot?.file !== scenario + '.after.png' || !validHash(entry.screenshot.sha256)) throw new Error('候选图片路径或指纹无效');
  validateMetadata(entry);
  validateScreenshot(entry.screenshot);
  const bytes = await localFile(join(candidateRoot, entry.screenshot.file)), image = await png(bytes);
  if (image.sha256 !== entry.screenshot.sha256 || image.width !== entry.screenshot.width || image.height !== entry.screenshot.height) throw new Error('候选图片已变化，请重新生成并复核');
  const base = await directory(baselineDirectory, true);
  const destination = await directory(join(base, scenario), true);
  const lock = join(destination, '.accept-lock');
  await mkdir(lock);
  try {
    const previous = await loadBaseline(base, scenario);
    const review = { reason: reason.trim(), reviewer: reviewer.trim(), reviewedAt: new Date().toISOString(), artifactHash: proposal.reviewArtifact.sha256 };
    const manifest = { schemaVersion: 1, ...entry, screenshot: { ...entry.screenshot, file: `baseline-${image.sha256}.png` }, review, history: [...(previous?.manifest.history || []), ...(previous ? [{ screenshot: previous.manifest.screenshot, review: previous.manifest.review, source: previous.manifest.source }] : [])] };
    const imagePath = join(destination, manifest.screenshot.file);
    try { await writeFile(imagePath, bytes, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST' || digest(await localFile(imagePath)) !== image.sha256) throw error; }
    const staging = join(destination, '.manifest-' + randomUUID() + '.json');
    try { await writeFile(staging, JSON.stringify(manifest, null, 2), { flag: 'wx' }); await rename(staging, join(destination, 'manifest.json')); }
    finally { await rm(staging, { force: true }); }
    return { status: 'accepted', scenario, manifestPath: join(destination, 'manifest.json'), review, screenshot: manifest.screenshot };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
