import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { prepare, terminate, stop, validationWindow } from './build.mjs';
import { root, extension, requireExtension, sourceState, fingerprint, fixtureState } from './inventory.mjs';
import { scenarios, rules, uncovered } from './catalog.mjs';
import { probeLayout } from './probe.mjs';
import { prepareExample, checkExample } from './examples.mjs';
import { checkImageOrderKeyboard } from './image-order.mjs';
import { checkEndToEndKeyboard, checkGenerationReadiness } from './end-to-end.mjs';
import { checkAgentSettings } from './agent-settings.mjs';

const { chromium } = requireExtension('playwright');
const buildDirectory = resolve(extension, '.output/chrome-mv3');
export const faults = {
  'settings-overflow': { scenario: 'agent-settings-layout-narrow', css: '.agent-settings .settings-model-fields { width:900px!important; }' },
  'settings-focus': { scenario: 'agent-settings-layout-wide', css: '.settings-agent-card:has(:focus-visible) { box-shadow:none!important; }' },
  'canvas-padding': { scenario: 'workspace-wide', css: '.canvas-input { padding-left:8px!important; }' },
  'quick-height': { scenario: 'popup', css: '.quick-canvas { height:188px!important; }' },
  'image-offset': { scenario: 'popup', css: '.image-preview-trigger { transform:translateX(-8px)!important; }' },
};

async function startPreview(directory, children) {
  const sharp = requireExtension('sharp');
  const asset = join(directory, 'synthetic.png');
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#efe9de"/><circle cx="300" cy="320" r="150" fill="#569399"/><path d="M100 650H500V700H100Z" fill="#bd6c50"/></svg>')).png().toFile(asset);
  const child = spawn(process.execPath, [resolve(root, 'agent-tool/preview.mjs')], {
    cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, PREVIEW_PORT: '0', PREVIEW_INPUT_IMAGE: asset, PREVIEW_RESULT_IMAGE: asset },
  });
  const receipts = [];
  child.on('message', message => { if (message.type === 'script-receipt') receipts.push(message); });
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
  return { child, url, receipts };
}

async function checkBatchToolbar(page, directory, item) {
  const checks = [], samples = [];
  const record = (target, actual) => checks.push({ ruleId: 'UI-BEHAVIOR', target, expected: true, actual, status: actual ? 'passed' : 'failed' });
  await page.getByRole('button', { name: '全部项目', exact: true }).click();
  await page.getByRole('button', { name: '批量管理', exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  const all = page.getByRole('checkbox', { name: '选择本页', exact: true });
  const boxes = page.getByRole('checkbox', { name: /^选择项目：/ });
  for (const hidden of [false, true]) {
    if (hidden) {
      await page.evaluate(async () => {
        const projects = (await chrome.runtime.sendMessage({ type: 'alchemy:projects', limit: 24 })).value.items;
        await chrome.runtime.sendMessage({ type: 'alchemy:set-project-hidden', ids: [projects[0].id], hidden: true });
      });
      await page.getByRole('button', { name: '包含隐藏项目', exact: true }).filter({ visible: true }).click();
      await page.getByRole('button', { name: '恢复所选', exact: true }).waitFor();
    }
    for (const view of ['卡片视图', '列表视图']) {
      await page.getByRole('button', { name: view, exact: true }).click();
      await all.uncheck();
      let baseline;
      for (const count of [0, 1, 10, 24, 0]) {
        if (count === 24) await all.check();
        else if (!count) await all.uncheck();
        else for (let index = 0; index < count; index++) await boxes.nth(index).check();
        await page.evaluate(async () => { document.querySelector('.workspace-library-content').scrollTop = 0; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
        const sample = await page.locator('.history-toolbar').evaluate(node => {
          const rect = element => { const r = element.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
          const controls = [...node.querySelectorAll('label,button')];
          const texts = controls.map(element => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), lines = [];
            while (walker.nextNode()) if (walker.currentNode.textContent.trim()) {
              const range = document.createRange(); range.selectNodeContents(walker.currentNode);
              lines.push(...[...range.getClientRects()].map(r => r.y));
            }
            return new Set(lines.map(y => Math.round(y))).size <= 1;
          });
          return {
            geometry: [...rect(node), ...rect(document.querySelector('.workspace-library-content')), ...controls.flatMap(rect)],
            singleLine: texts.every(Boolean),
            contained: controls.every(element => { const r = element.getBoundingClientRect(), bar = node.getBoundingClientRect(); return r.left >= bar.left - 1 && r.right <= bar.right + 1 && element.scrollWidth <= element.clientWidth + 1; }),
            transparent: [...node.querySelectorAll('.text-button')].every(element => getComputedStyle(element).backgroundColor === 'rgba(0, 0, 0, 0)'),
            noOverflow: document.documentElement.scrollWidth <= innerWidth,
            checked: document.querySelectorAll('[aria-label^="选择项目："]:checked').length,
          };
        });
        baseline ||= sample.geometry;
        const label = `${hidden ? '含隐藏' : '可见'} / ${view} / ${count}项`;
        record(label + ' 选择准确', sample.checked === count);
        record(label + ' 文字完整单行且动作不溢出', sample.singleLine && sample.contained && sample.noOverflow);
        record(label + ' 文字动作无填充底色', sample.transparent);
        record(label + ' 选择不移动操作栏、按钮和内容区', sample.geometry.every((value, index) => Math.abs(value - baseline[index]) < 1));
        samples.push({ label, ...sample });
        if (view === '卡片视图' && [0, 24].includes(count)) {
          const key = `${hidden ? 'hidden' : 'visible'}-${count}`;
          const path = join(directory, `${item.id}-${key}.png`);
          await page.screenshot({ path });
          (item.evidence.toolbar ||= {})[key] = path;
        }
      }
    }
  }
  await boxes.first().focus(); await page.keyboard.press('Space');
  const hide = page.getByRole('button', { name: '隐藏所选', exact: true });
  // A second visible project enables the hide action without changing any real data.
  await boxes.nth(1).check();
  await page.keyboard.press('Tab'); await hide.focus();
  record('文字动作保留键盘焦点提示', await hide.evaluate(node => node.matches(':focus-visible') && getComputedStyle(node).outlineStyle !== 'none'));
  item.toolbarSamples = samples;
  return checks;
}

async function checkBatchKeyboard(page, screenshot, allAccepted) {
  const activate = async locator => { await locator.focus(); await page.keyboard.press('Enter'); };
  await activate(page.getByRole('button', { name: '全部项目', exact: true }));
  await activate(page.getByRole('button', { name: '批量管理', exact: true }));
  await page.getByRole('checkbox', { name: '选择本页', exact: true }).focus();
  await page.keyboard.press('Space');
  const trigger = page.getByRole('button', { name: '批量完整复刻', exact: true });
  await activate(trigger);
  const dialog = page.locator('dialog:visible');
  await dialog.waitFor();
  const startLabel = `启动 ${allAccepted ? 4 : 3} 个项目`;
  await page.getByRole('button', { name: startLabel, exact: true }).waitFor();
  const checks = [];
  const record = (target, actual) => checks.push({ ruleId: 'UI-BEHAVIOR', target, expected: true, actual, status: actual ? 'passed' : 'failed' });
  record('keyboard open places focus in modal', await dialog.evaluate(node => node.contains(document.activeElement)));
  let backgroundControlFocused = false, browserBoundaryStops = 0;
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab');
    const focus = await dialog.evaluate(node => ({ inside: node.contains(document.activeElement), browserBoundary: document.activeElement === document.body && node.matches(':modal') }));
    if (focus.browserBoundary) browserBoundaryStops++;
    else if (!focus.inside) backgroundControlFocused = true;
  }
  checks.push({ ruleId: 'UI-BEHAVIOR', target: 'Tab cannot focus background controls', expected: { backgroundControlFocused: false }, actual: { backgroundControlFocused, browserBoundaryStops }, status: backgroundControlFocused ? 'failed' : 'passed' });
  record('batch dialog remains inside viewport', await dialog.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && node.scrollWidth <= node.clientWidth; }));
  await page.screenshot({ path: screenshot, fullPage: true });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  record('Escape returns focus to batch trigger', await trigger.evaluate(node => node === document.activeElement));
  await page.keyboard.press('Enter');
  await dialog.waitFor();
  const start = page.getByRole('button', { name: startLabel, exact: true });
  await activate(start);
  await page.getByRole('button', { name: '查看任务', exact: true }).waitFor();
  record('Enter clears only accepted selections', await page.getByRole('checkbox', { name: /^选择项目：/ }).evaluateAll((nodes, count) => nodes.filter(node => node.checked).length === count, allAccepted ? 0 : 2));
  if (allAccepted) {
    record('all accepted returns focus to usable task action or library heading', await page.evaluate(() => {
      const element = document.activeElement;
      return element?.matches('button:not(:disabled)') && element.textContent?.trim() === '查看任务' || element?.matches('h1,h2,h3') && element.textContent?.includes('全部项目');
    }));
    await page.keyboard.press('Tab');
    record('Tab continues from successful batch submission', await page.evaluate(() => document.activeElement !== document.body && document.activeElement?.checkVisibility() && !document.activeElement?.matches(':disabled')));
  }
  record('workspace has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  return checks;
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

export function verify(options = {}) { return validationWindow('verify', () => runVerify(options)); }

async function runVerify({ coverage = false, scenario: id, scenarioIds, build = true, fault, inspect = false, reason = 'development', progress = () => {} } = {}) {
  if (coverage && process.env.REFRAME_TEST_COVERAGE !== '1') throw new Error('Browser coverage requires REFRAME_TEST_COVERAGE=1 and a matching coverage build');
  if (id && !scenarios.some(scenario => scenario.id === id)) throw new Error(`未知场景 ${id}`);
  if (fault && !faults[fault]) throw new Error(`未知故障 ${fault}`);
  if (fault && id && id !== faults[fault].scenario) throw new Error(`故障 ${fault} 只能用于 ${faults[fault].scenario}`);
  if (scenarioIds && (!scenarioIds.length || id || fault || new Set(scenarioIds).size !== scenarioIds.length || scenarioIds.some(key => !scenarios.some(scene => scene.id === key)))) throw new Error('场景列表为空、重复、未知或与单场景/故障冲突');
  const selected = scenarios.filter(scenario => scenarioIds ? scenarioIds.includes(scenario.id) : !id && !fault || scenario.id === (id || faults[fault]?.scenario));
  const directory = await mkdtemp(join(tmpdir(), 'reframe-ui-'));
  const report = { schemaVersion: 1, reason, timing: { waitMs: 0, phases: {} }, scope: selected.length === scenarios.length ? 'complete' : 'development-only', selectedScenarios: selected.map(scene => scene.id), startedAt: new Date().toISOString(), environment: { platform: process.platform, arch: process.arch, osRelease: release(), headless: true, node: process.version, locale: 'zh-CN', timezone: 'Asia/Taipei', dpr: 1, motion: 'reduce', previewShell: 'existing-notice-and-size-overrides' }, source: null, fault: fault || null, uncovered, scenarios: [], status: 'failed' };
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
    let phaseStart = performance.now();
    report.source = (await prepare({ build })).source;
    report.timing.phases.buildMs = Math.round(performance.now() - phaseStart);
    phaseStart = performance.now();
    if (interrupted) throw new Error('验证已取消');
    preview = await startPreview(directory, children);
    browser = await chromium.launch({ headless: true });
    report.environment.browser = browser.version();
    report.timing.phases.startupMs = Math.round(performance.now() - phaseStart);
    for (const scenario of selected) {
      if (interrupted) throw new Error('验证已取消');
      const scenarioStart = performance.now();
      progress(`检查 ${scenario.id}`);
      const context = await browser.newContext({ viewport: scenario.viewport, locale: 'zh-CN', timezoneId: 'Asia/Taipei', deviceScaleFactor: 1, reducedMotion: 'reduce' });
      await context.route('**/*', route => new URL(route.request().url()).origin === preview.url ? route.continue() : route.abort());
      await context.addInitScript(() => localStorage.setItem('preview-motion-preference', 'reduce'));
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      if (coverage) await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
      // Behavior fixtures use Date.now for IDs/timeouts; preserve their real clock.
      if (!scenario.regression) await page.clock.setFixedTime(new Date('2026-10-07T00:00:00Z'));
      const item = { id: scenario.id, surface: scenario.surface, viewport: scenario.viewport, path: scenario.path, checks: [], diagnostics: [], errors: [], evidence: {}, reproduction: `node agent-tool/ui.mjs ${inspect ? 'inspect' : 'verify'} --scenario ${scenario.id}${fault ? ' --fault ' + fault : ''}` };
      page.on('pageerror', error => item.errors.push(error.message.slice(0, 500)));
      try {
        await page.goto(preview.url + scenario.path);
        if (scenario.settingsUi) {
          if (fault) await page.addStyleTag({ content: faults[fault].css });
          item.checks.push(...await checkAgentSettings(page, scenario, async label => {
            const path = join(directory, `${scenario.id}-${label}.png`);
            await page.screenshot({ path });
            (item.evidence.settings ||= {})[label] = path;
          }));
        } else if (scenario.batchToolbar) {
          item.checks.push(...await checkBatchToolbar(page, directory, item));
        } else if (scenario.batchKeyboard) {
          item.evidence.batchDialog = join(directory, scenario.id + '-dialog.png');
          item.checks.push(...await checkBatchKeyboard(page, item.evidence.batchDialog, scenario.batchAllAccepted));
        } else if (scenario.generationReadiness) {
          item.checks.push(...await checkGenerationReadiness(page, scenario));
        } else if (scenario.flowKeyboardCase) {
          item.checks.push(...await checkEndToEndKeyboard(page, scenario));
        } else if (scenario.keyboardCase) {
          item.checks.push(...await checkImageOrderKeyboard(page, scenario));
        } else if (scenario.regression) {
          await page.waitForFunction(key => ['passed', 'failed'].includes(document.documentElement.dataset[key]), scenario.regression, { timeout: 60000 });
          const actual = await page.evaluate(key => document.documentElement.dataset[key], scenario.regression);
          item.checks.push({ ruleId: 'UI-BEHAVIOR', status: actual === 'passed' ? 'passed' : 'failed', target: scenario.regression, expected: 'passed', actual });
        } else if (scenario.example) {
          await prepareExample(page, scenario);
          const geometryRules = scenario.rules.filter(id => rules.some(rule => rule.id === id && rule.kind === 'geometry'));
          if (geometryRules.length) Object.assign(item, await page.evaluate(probeLayout, { surface: scenario.surface, rules: geometryRules, inspect }));
          item.checks.push(...await checkExample(page, scenario, async label => {
            const path = join(directory, `${scenario.id}-${label}.png`);
            await page.screenshot({ path });
            (item.evidence.imageViewer ||= {})[label] = path;
          }));
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
      if (scenario.imageOpenViewport) item.evidence.returnViewport = page.viewportSize();
      if (item.status !== 'passed' || inspect) {
        const trace = join(directory, scenario.id + '.trace.zip');
        await context.tracing.stop({ path: trace });
        item.evidence.trace = trace;
      } else await context.tracing.stop();
      if (coverage) {
        const { mapBrowserCoverage } = await import('../test-impact.mjs');
        item.execution = await mapBrowserCoverage(await page.coverage.stopJSCoverage(), { root, buildDirectory, origin: preview.url, receipts: preview.receipts });
      }
      await context.close();
      item.durationMs = Math.round(performance.now() - scenarioStart);
      report.scenarios.push(item);
    }
    if ((await sourceState()).hash !== report.source.hash || await fingerprint(buildDirectory) !== report.source.buildHash || await fingerprint(resolve(root, 'agent-tool/ui')) !== report.rulesAndRunnerHash) throw new Error('验证过程中源码、构建或检查器变化，结果作废，请重跑。');
    if ((await fixtureState()).hash !== report.fixture.hash) throw new Error('验证过程中预览入口或 fixture 变化，结果作废，请重跑；无需仅因此重建产品。');
    if (interrupted) throw new Error('验证已取消');
    report.status = report.scenarios.every(scenario => scenario.status === 'passed') ? 'passed' : 'failed';
  } catch (error) {
    report.error = interrupted ? '验证已取消' : error.message;
  } finally {
    const cleanupStart = performance.now();
    const cleanup = await Promise.allSettled([browser?.close(), ...[...children].map(stop)]);
    const errors = cleanup.filter(item => item.status === 'rejected').map(item => String(item.reason));
    if (errors.length) { report.status = 'failed'; report.cleanupErrors = errors; }
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    report.finishedAt = new Date().toISOString();
    report.timing.phases.cleanupMs = Math.round(performance.now() - cleanupStart);
    report.timing.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
    const summary = [`# Reframe UI 检查：${report.status}`, '', `源码：${report.source?.revision || '未建立'}；工作区有修改：${report.source?.dirty ?? '未知'}`, '', ...report.scenarios.map(item => `- ${item.id}: ${item.status} — [截图](${item.id}.png)${Object.keys(item.evidence.imageViewer || {}).map(label => ` / [${label}](${item.id}-${label}.png)`).join('')}${item.evidence.trace ? ` / [trace](${item.id}.trace.zip)` : ''}`), '', ...report.scenarios.flatMap(item => item.checks.filter(check => check.status === 'failed').map(check => `- ${item.id} / ${check.ruleId} / ${check.target}: ${JSON.stringify(check.actual)}`)), ...(report.error ? ['', report.error] : []), '', '## 未覆盖', '', ...uncovered.map(text => '- ' + text), '', '完整测量与祖先样式见 report.json；源码路径是候选来源，不是精确根因。', ''];
    await writeFile(join(directory, 'report.md'), summary.join('\n'));
  }
  return { ...report, reportPath: join(directory, 'report.json'), summaryPath: join(directory, 'report.md') };
}
