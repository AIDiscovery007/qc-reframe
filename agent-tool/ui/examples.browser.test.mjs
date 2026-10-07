import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { exampleScenarios, prepareExample, checkExample, renderExamples } from './examples.mjs';

const { chromium } = createRequire(new URL('../../browser-extension/package.json', import.meta.url))('playwright');
let browser, preview, baseURL;
before(async () => {
  // Deliberately consume an existing product build; this suite never rebuilds shared artifacts.
  const stamp = JSON.parse(await readFile(new URL('../../browser-extension/.output/ui-build.json', import.meta.url), 'utf8'));
  assert.ok(stamp.sourceHash && stamp.buildHash, 'Run UI verify once to establish a build stamp before examples.');
  browser = await chromium.launch({ headless: true });
  preview = spawn(process.execPath, [fileURLToPath(new URL('../preview.mjs', import.meta.url))], { env: { ...process.env, PREVIEW_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  baseURL = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Preview startup timeout')), 20000);
    preview.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); const match = output.match(/UI preview: (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
    preview.stderr.on('data', chunk => { output = (output + chunk).slice(-4000); });
    preview.once('error', error => { clearTimeout(timeout); reject(error); });
    preview.once('exit', code => { clearTimeout(timeout); reject(new Error(`Preview exited ${code}: ${output}`)); });
  });
});
after(async () => {
  await browser?.close();
  if (preview && preview.exitCode === null && !preview.signalCode) {
    const exited = once(preview, 'exit'); preview.kill();
    const timeout = setTimeout(() => preview.kill('SIGKILL'), 3000);
    await exited; clearTimeout(timeout);
  }
});

for (const scenario of exampleScenarios) test(`production example: ${scenario.id}`, async t => {
  const page = await browser.newPage({ viewport: scenario.viewport });
  t.after(() => page.close()); page.setDefaultTimeout(10000);
  await page.goto(baseURL + scenario.path);
  await prepareExample(page, scenario);
  const checks = await checkExample(page, scenario);
  assert.ok(checks.some(check => check.status === 'passed'));
  assert.deepEqual(checks.filter(check => check.status === 'failed'), []);
  assert.ok(checks.every(check => check.ruleId && check.target && check.sourceFiles.length));
  for (const check of checks.filter(check => check.status === 'skipped')) t.diagnostic(`Explicit limitation: ${check.target}: ${check.message}`);
});

test('state checks reject a real but incompatible production state', async t => {
  const page = await browser.newPage({ viewport: { width: 400, height: 740 } });
  t.after(() => page.close()); page.setDefaultTimeout(3000);
  await page.goto(baseURL + '/popup.html?state=models-new');
  await prepareExample(page, 'example-no-model');
  const checks = await checkExample(page, 'example-reverse-failed');
  assert.ok(checks.some(check => check.status === 'failed'));
});

for (const fault of ['hidden', 'disabled']) test(`failure recovery rejects all ${fault} actions`, async t => {
  const page = await browser.newPage({ viewport: { width: 400, height: 740 } });
  t.after(() => page.close()); page.setDefaultTimeout(3000);
  await page.goto(baseURL + '/popup.html?state=failed');
  await prepareExample(page, 'example-reverse-failed');
  // Fault injection only: the ordinary scenario above still exercises unmodified production state.
  await page.locator('.quick-workspace .error button').evaluateAll((buttons, fault) => {
    for (const button of buttons) if (fault === 'hidden') button.style.display = 'none'; else button.disabled = true;
  }, fault);
  const checks = await checkExample(page, 'example-reverse-failed');
  assert.ok(checks.some(check => check.target === '.quick-workspace .error' && check.status === 'failed' && check.actual.recovery === false));
});

test('preselected reduce cannot pass a blocked native keyboard sequence', async t => {
  const scenario = exampleScenarios.find(item => item.id === 'example-native-controls');
  const page = await browser.newPage({ viewport: scenario.viewport });
  t.after(() => page.close()); page.setDefaultTimeout(5000);
  await page.goto(baseURL + scenario.path);
  await prepareExample(page, scenario);
  const select = page.getByRole('combobox', { name: '减少动态效果', exact: true });
  await select.selectOption('reduce');
  await select.evaluate(node => node.addEventListener('keydown', event => {
    if (['Home', 'ArrowDown', 'Enter'].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true));
  const checks = await checkExample(page, scenario);
  const keyboard = checks.find(check => check.target === 'native select keyboard picker');
  assert.ok(keyboard, JSON.stringify(checks));
  assert.equal(keyboard.actual.initial, 'system');
  assert.equal(keyboard.actual.selected, 'system');
  assert.equal(keyboard.status, keyboard.actual.capability.changed ? 'failed' : 'skipped');
  assert.equal(keyboard.actual.capability.initial, 'system');
  assert.match(keyboard.actual.capability.source, /separate browser context/);
  assert.ok(checks.some(check => check.target === '.settings-center select' && check.status === 'passed' && check.actual.keyboardSelection === false));
});

test('generated navigation opens a production preview without copied components', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.setContent(renderExamples({ baseURL }));
  assert.equal(await page.locator('a').count(), exampleScenarios.length);
  await page.getByRole('link', { name: '轻量上传空态', exact: true }).click();
  await page.waitForSelector('.quick-workspace .quick-upload');
  assert.ok(page.url().startsWith(baseURL + '/popup.html?state=empty'));
});
