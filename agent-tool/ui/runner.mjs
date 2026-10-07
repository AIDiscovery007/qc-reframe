import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { root, extension, requireExtension, sourceState, fingerprint, fixtureState } from './inventory.mjs';
import { scenarios, rules, uncovered } from './catalog.mjs';
import { probeLayout } from './probe.mjs';
import { prepareExample, checkExample } from './examples.mjs';

const { chromium } = requireExtension('playwright');
const buildDirectory = resolve(extension, '.output/chrome-mv3');
const stampPath = resolve(extension, '.output/ui-build.json');
export const faults = {
  'canvas-padding': { scenario: 'workspace-wide', css: '.canvas-input { padding-left:8px!important; }' },
  'quick-height': { scenario: 'popup', css: '.quick-canvas { height:188px!important; }' },
  'image-offset': { scenario: 'popup', css: '.image-preview-trigger { transform:translateX(-8px)!important; }' },
};

function terminate(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function buildCurrent(build, children) {
  const source = await sourceState();
  if (build) {
    await new Promise((resolvePromise, reject) => {
      const child = spawn('npm', ['run', 'build'], { cwd: extension, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      children.add(child);
      let log = '';
      child.stdout.on('data', data => { log = (log + data).slice(-6000); });
      child.stderr.on('data', data => { log = (log + data).slice(-6000); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolvePromise() : reject(new Error(`Build failed (${code}):\n${log}`)));
    });
    if (source.hash !== (await sourceState()).hash) throw new Error('构建期间源码变化，停止验证；请重新运行 verify。');
    await writeFile(stampPath, JSON.stringify({ sourceHash: source.hash, buildHash: await fingerprint(buildDirectory) }));
  }
  const stamp = JSON.parse(await readFile(stampPath, 'utf8').catch(() => { throw new Error('没有 UI 构建指纹；先运行 verify（不加 --no-build）。'); }));
  if (stamp.sourceHash !== source.hash || stamp.buildHash !== await fingerprint(buildDirectory)) throw new Error('源码或构建与上次指纹不符；移除 --no-build 重新构建。');
  return { ...source, ...stamp };
}

async function startPreview(directory, children) {
  const sharp = requireExtension('sharp');
  const asset = join(directory, 'synthetic.png');
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#efe9de"/><circle cx="300" cy="320" r="150" fill="#569399"/><path d="M100 650H500V700H100Z" fill="#bd6c50"/></svg>')).png().toFile(asset);
  const child = spawn(process.execPath, [resolve(root, 'agent-tool/preview.mjs')], {
    cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PREVIEW_PORT: '0', PREVIEW_INPUT_IMAGE: asset, PREVIEW_RESULT_IMAGE: asset },
  });
  children.add(child);
  const url = await new Promise((resolvePromise, reject) => {
    let output = '';
    const timeout = setTimeout(() => { terminate(child); reject(new Error('预览启动超时')); }, 20000);
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/UI preview: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolvePromise(match[1]); }
    });
    child.stderr.on('data', data => { output = (output + data).slice(-4000); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`预览退出 (${code}): ${output}`)); });
  });
  return { child, url };
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = once(child, 'exit');
  terminate(child);
  const timeout = setTimeout(() => terminate(child, 'SIGKILL'), 3000);
  await exited;
  clearTimeout(timeout);
}

async function ready(page, scenario) {
  await page.waitForSelector(scenario.surface === 'workspace' ? '.canvas-workspace' : '.quick-workspace');
  await page.evaluate(() => document.fonts.ready);
  if (scenario.regression) return;
  await page.getByRole('combobox', { name: '逆向模式', exact: true }).selectOption('recreate');
  await page.waitForFunction(() => [...document.querySelectorAll('.image-preview img')].some(img => img.complete && img.naturalWidth > 0));
  if (scenario.surface === 'workspace') {
    // Start from a declared result state, using the real UI action if initially collapsed.
    const button = page.locator('.result-return');
    if (await button.getAttribute('aria-expanded') === 'false') await button.click();
    await page.waitForSelector('.workspace-results .generated-pane');
  }
  if (scenario.prepare === 'prompt') {
    await page.locator('.canvas-workspace textarea').first().fill('长任务指令用于检查换行和空间分配。'.repeat(100));
    await page.getByRole('button', { name: '展开提示词', exact: true }).click();
    await page.waitForSelector('.canvas-workspace[data-prompt-open="true"]');
  }
  if (scenario.prepare === 'image-failed') {
    await page.locator('.quick-canvas img').evaluate(image => { image.src = 'data:image/png;base64,broken'; });
    await page.waitForFunction(() => { const image = document.querySelector('.quick-canvas img'); return image?.complete && !image.naturalWidth; });
  }
  await page.waitForFunction(() => [...document.querySelectorAll('.image-preview img')].every(img => img.complete));
  // Require geometry to settle; no fixed screenshot delay or image polling side effects.
  await page.evaluate(async () => {
    const selectors = '.canvas-large,.preview-canvas,.quick-canvas,.quick-filmstrip';
    let previous = '', stable = 0;
    for (let frame = 0; frame < 120 && stable < 3; frame++) {
      await new Promise(requestAnimationFrame);
      const current = JSON.stringify([...document.querySelectorAll(selectors)].map(el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
      stable = current === previous ? stable + 1 : 0;
      previous = current;
    }
    if (stable < 3) throw new Error('布局在120帧内未稳定');
  });
}

export async function verify({ scenario: id, build = true, fault, inspect = false, progress = () => {} } = {}) {
  if (id && !scenarios.some(scenario => scenario.id === id)) throw new Error(`未知场景 ${id}`);
  if (fault && !faults[fault]) throw new Error(`未知故障 ${fault}`);
  if (fault && id && id !== faults[fault].scenario) throw new Error(`故障 ${fault} 只能用于 ${faults[fault].scenario}`);
  const selected = scenarios.filter(scenario => !id && !fault || scenario.id === (id || faults[fault]?.scenario));
  const directory = await mkdtemp(join(tmpdir(), 'reframe-ui-'));
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), environment: { platform: process.platform, arch: process.arch, osRelease: release(), headless: true, node: process.version, locale: 'zh-CN', timezone: 'Asia/Taipei', dpr: 1, motion: 'reduce', previewShell: 'existing-notice-and-size-overrides' }, source: null, fault: fault || null, uncovered, scenarios: [], status: 'failed' };
  let browser, preview, interrupted = false;
  const children = new Set();
  const interrupt = () => {
    interrupted = true;
    for (const child of children) terminate(child);
    void browser?.close().catch(() => {});
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    report.rulesAndRunnerHash = await fingerprint(resolve(root, 'agent-tool/ui'));
    report.fixture = await fixtureState();
    report.environment.clock = 'fixed browser Date for geometry; live behavior and server fixture clocks';
    progress(build ? '构建当前源码并记录指纹' : '核对源码与构建指纹');
    report.source = await buildCurrent(build, children);
    if (interrupted) throw new Error('验证已取消');
    preview = await startPreview(directory, children);
    browser = await chromium.launch({ headless: true });
    report.environment.browser = browser.version();
    for (const scenario of selected) {
      if (interrupted) throw new Error('验证已取消');
      progress(`检查 ${scenario.id}`);
      const context = await browser.newContext({ viewport: scenario.viewport, locale: 'zh-CN', timezoneId: 'Asia/Taipei', deviceScaleFactor: 1, reducedMotion: 'reduce' });
      await context.route('**/*', route => new URL(route.request().url()).origin === preview.url ? route.continue() : route.abort());
      await context.addInitScript(() => localStorage.setItem('preview-motion-preference', 'reduce'));
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      // Behavior fixtures use Date.now for IDs/timeouts; preserve their real clock.
      if (!scenario.regression) await page.clock.setFixedTime(new Date('2026-10-07T00:00:00Z'));
      const item = { id: scenario.id, surface: scenario.surface, viewport: scenario.viewport, path: scenario.path, checks: [], diagnostics: [], errors: [], evidence: {}, reproduction: `node agent-tool/ui.mjs ${inspect ? 'inspect' : 'verify'} --scenario ${scenario.id}${fault ? ' --fault ' + fault : ''}` };
      page.on('pageerror', error => item.errors.push(error.message.slice(0, 500)));
      try {
        await page.goto(preview.url + scenario.path);
        if (scenario.regression) {
          await page.waitForFunction(key => ['passed', 'failed'].includes(document.documentElement.dataset[key]), scenario.regression, { timeout: 60000 });
          const actual = await page.evaluate(key => document.documentElement.dataset[key], scenario.regression);
          item.checks.push({ ruleId: 'UI-BEHAVIOR', status: actual === 'passed' ? 'passed' : 'failed', target: scenario.regression, expected: 'passed', actual });
        } else if (scenario.example) {
          await prepareExample(page, scenario);
          const geometryRules = scenario.rules.filter(id => rules.some(rule => rule.id === id && rule.kind === 'geometry'));
          if (geometryRules.length) Object.assign(item, await page.evaluate(probeLayout, { surface: scenario.surface, rules: geometryRules, inspect }));
          item.checks.push(...await checkExample(page, scenario));
        } else {
          await ready(page, scenario);
          if (fault) await page.addStyleTag({ content: faults[fault].css });
          Object.assign(item, await page.evaluate(probeLayout, { surface: scenario.surface, rules: scenario.rules, inspect }));
        }
      } catch (error) {
        item.checks.push({ ruleId: 'UI-SCENARIO', status: 'failed', target: scenario.id, expected: '场景就绪并完成检查', actual: error.message });
      }
      if (item.errors.length) item.checks.push({ ruleId: 'UI-PAGE-ERROR', status: 'failed', target: scenario.id, expected: '无未捕获页面异常', actual: item.errors });
      item.status = item.checks.some(check => check.status === 'failed') ? 'failed' : item.checks.some(check => check.status === 'passed') ? 'passed' : 'uncovered';
      const fonts = await page.evaluate(async () => {
        await document.fonts.ready;
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
        const stacks = [...new Set(['body', '.app', 'button', 'select', 'textarea'].flatMap(selector => [...document.querySelectorAll(selector)].map(node => getComputedStyle(node).font)))].sort();
        return { stacks: stacks.map(font => { context.font = font; return [font, context.measureText('Reframe 0123456789 中文字体测量').width]; }), loaded: [...document.fonts].map(font => [font.family, font.style, font.weight, font.status]).sort() };
      });
      item.fontsHash = createHash('sha256').update(JSON.stringify(fonts)).digest('hex');
      const screenshot = join(directory, scenario.id + '.png');
      await page.screenshot({ path: screenshot, fullPage: true });
      item.evidence.screenshot = screenshot;
      if (item.status !== 'passed' || inspect) {
        const trace = join(directory, scenario.id + '.trace.zip');
        await context.tracing.stop({ path: trace });
        item.evidence.trace = trace;
      } else await context.tracing.stop();
      report.scenarios.push(item);
      await context.close();
    }
    if ((await sourceState()).hash !== report.source.hash || await fingerprint(buildDirectory) !== report.source.buildHash || await fingerprint(resolve(root, 'agent-tool/ui')) !== report.rulesAndRunnerHash) throw new Error('验证过程中源码、构建或检查器变化，结果作废，请重跑。');
    if ((await fixtureState()).hash !== report.fixture.hash) throw new Error('验证过程中预览入口或 fixture 变化，结果作废，请重跑；无需仅因此重建产品。');
    if (interrupted) throw new Error('验证已取消');
    report.status = report.scenarios.every(scenario => scenario.status === 'passed') ? 'passed' : 'failed';
  } catch (error) {
    report.error = interrupted ? '验证已取消' : error.message;
  } finally {
    const cleanup = await Promise.allSettled([browser?.close(), ...[...children].map(stop)]);
    const errors = cleanup.filter(item => item.status === 'rejected').map(item => String(item.reason));
    if (errors.length) { report.status = 'failed'; report.cleanupErrors = errors; }
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    report.finishedAt = new Date().toISOString();
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
    const summary = [`# Reframe UI 检查：${report.status}`, '', `源码：${report.source?.revision || '未建立'}；工作区有修改：${report.source?.dirty ?? '未知'}`, '', ...report.scenarios.map(item => `- ${item.id}: ${item.status} — [截图](${item.id}.png)${item.evidence.trace ? ` / [trace](${item.id}.trace.zip)` : ''}`), '', ...report.scenarios.flatMap(item => item.checks.filter(check => check.status === 'failed').map(check => `- ${item.id} / ${check.ruleId} / ${check.target}: ${JSON.stringify(check.actual)}`)), ...(report.error ? ['', report.error] : []), '', '## 未覆盖', '', ...uncovered.map(text => '- ' + text), '', '完整测量与祖先样式见 report.json；源码路径是候选来源，不是精确根因。', ''];
    await writeFile(join(directory, 'report.md'), summary.join('\n'));
  }
  return { ...report, reportPath: join(directory, 'report.json'), summaryPath: join(directory, 'report.md') };
}
