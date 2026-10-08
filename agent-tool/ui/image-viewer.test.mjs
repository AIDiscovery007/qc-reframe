import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { exampleScenarios, prepareExample } from './examples.mjs';
import { checkImageViewer } from './image-viewer.mjs';

const { chromium } = createRequire(new URL('../../browser-extension/package.json', import.meta.url))('playwright');
let browser, preview, baseURL = process.env.UI_PREVIEW_URL;
before(async () => {
  // Reuse a supplied preview process, or start the same preview entry point against an existing build.
  // This suite never builds, contacts a model or opens an existing user browser profile.
  await readFile(new URL('../../browser-extension/.output/chrome-mv3/workspace.html', import.meta.url));
  browser = await chromium.launch({ headless: true });
  if (baseURL) {
    const url = new URL(baseURL);
    assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.username + url.password, '');
    return;
  }
  preview = spawn(process.execPath, [fileURLToPath(new URL('../preview.mjs', import.meta.url))], { env: { ...process.env, PREVIEW_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  baseURL = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Preview startup timeout')), 20000);
    preview.stdout.on('data', chunk => {
      output = (output + chunk).slice(-4000);
      const match = output.match(/UI preview: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
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

async function open(t, scenario) {
  const page = await browser.newPage({ viewport: scenario.viewport, reducedMotion: 'reduce' });
  t.after(() => page.close()); page.setDefaultTimeout(8000);
  await page.goto(baseURL + scenario.path);
  await prepareExample(page, scenario);
  return page;
}

// Positive checker contract once; the gate owns all six production viewport variants.
for (const scenario of exampleScenarios.filter(item => item.id === 'example-image-viewer')) test(`production image viewport: ${scenario.id}`, async t => {
  const page = await open(t, scenario), captures = [];
  const checks = await checkImageViewer(page, label => { captures.push(label); });
  assert.deepEqual(checks.filter(check => check.status === 'failed'), []);
  assert.ok(checks.every(check => check.ruleId === 'UI-IMAGE-VIEWPORT' && check.sourceFiles.length));
  assert.ok(checks.some(check => check.target === 'pointer pan' && check.status === 'passed'));
  assert.ok(checks.some(check => check.target === 'keyboard pan' && check.status === 'passed'));
  assert.ok(captures.includes('fit') && captures.includes('zoom-pan'));
  if (await page.getByRole('button', { name: '右转 90°', exact: true }).count()) {
    assert.ok(checks.some(check => check.target === 'fit after rotation' && check.status === 'passed'));
    assert.ok(captures.includes('rotation-fit'));
  }
  assert.equal(await page.locator('.image-preview-dialog:modal').count(), 1, 'The caller retains control of Escape/focus verification');
});

test('open preview refits after a viewport resize while zoomed', async t => {
  const page = await open(t, exampleScenarios.find(item => item.id === 'example-image-viewer-portrait'));
  const stage = page.locator('.image-viewer-stage');
  const before = await stage.boundingBox();
  await stage.dblclick();
  assert.equal(await page.locator('.image-viewer-tools output').textContent(), '200%');
  await page.setViewportSize({ width: 640, height: 360 });
  await page.waitForFunction(height => document.querySelector('.image-viewer-stage').clientHeight < height, before.height);
  const checks = await checkImageViewer(page);
  assert.deepEqual(checks.filter(check => check.status === 'failed'), []);
  assert.ok(checks.some(check => check.target === 'fit after rotation' && check.status === 'passed'));
});

for (const fault of ['hidden', 'disabled']) test(`input rotation ${fault} cannot be silently skipped`, async t => {
  const page = await open(t, exampleScenarios.find(item => item.id === 'example-image-viewer'));
  await page.getByRole('button', { name: '右转 90°', exact: true }).evaluate((button, fault) => {
    if (fault === 'hidden') button.style.display = 'none'; else button.disabled = true;
  }, fault);
  const checks = await checkImageViewer(page);
  assert.ok(checks.some(check => check.status === 'failed' && check.actual.error?.includes('rotation control')));
});

for (const [fault, css, target] of [
  ['old absolute overlay', '.image-viewer { position:relative } .image-viewer-stage { position:absolute;inset:0 } .image-viewer-tools { position:absolute;bottom:14px;left:50%;transform:translateX(-50%) }', '.image-viewer-stage / .image-viewer-tools'],
  ['visible image overflow', '.image-viewer-stage { overflow:visible!important }', 'zoom clipping'],
]) test(`reject ${fault}`, async t => {
  const scenario = exampleScenarios.find(item => item.id === 'example-image-viewer');
  const page = await open(t, scenario);
  await page.addStyleTag({ content: css });
  const checks = await checkImageViewer(page);
  assert.ok(checks.some(check => check.target === target && check.status === 'failed'), JSON.stringify(checks));
});

test('production shared CSS separates the toolbar in an isolated closed shadow fixture', async t => {
  const page = await browser.newPage({ viewport: { width: 400, height: 740 } }); t.after(() => page.close());
  const output = new URL('../../browser-extension/.output/chrome-mv3/', import.meta.url);
  const html = await readFile(new URL('popup.html', output), 'utf8');
  const links = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)];
  assert.ok(links.length);
  const css = (await Promise.all(links.map(([, href]) => readFile(new URL(href.replace(/^\//, ''), output), 'utf8')))).join('\n');
  const geometry = await page.evaluate(css => {
    const host = document.createElement('section'); document.body.append(host);
    // The handle belongs only to this fixture, not to the real extension's closed root.
    const shadow = host.attachShadow({ mode: 'closed' }), style = document.createElement('style'); style.textContent = css; shadow.append(style);
    const app = document.createElement('main'); app.className = 'app';
    app.innerHTML = '<dialog class="modal image-preview-dialog"><div class="image-preview-heading"><h2>Fixture</h2></div><div class="image-viewer"><div class="image-viewer-stage"></div><div class="image-viewer-tools"><button>−</button><output>100%</output><button>+</button></div></div><div class="image-rotation-tools"><div><button>Rotate fixture</button></div></div></dialog>';
    shadow.append(app); const dialog = app.querySelector('dialog'); dialog.showModal();
    const stage = app.querySelector('.image-viewer-stage'), tools = app.querySelector('.image-viewer-tools');
    const a = stage.getBoundingClientRect(), b = tools.getBoundingClientRect(), d = dialog.getBoundingClientRect();
    return { closed: host.shadowRoot === null, stageHeight: a.height, separated: a.bottom <= b.top + 1, contained: a.top >= d.top - 1 && b.bottom <= d.bottom + 1, normalFlow: !['absolute', 'fixed'].includes(getComputedStyle(tools).position), overflow: getComputedStyle(stage).overflow };
  }, css);
  assert.equal(geometry.closed, true); assert.ok(geometry.stageHeight > 40);
  assert.ok(geometry.separated && geometry.contained && geometry.normalFlow);
  assert.ok(['hidden', 'clip'].includes(geometry.overflow));
  t.diagnostic('CSS hierarchy fixture only: it neither runs copied viewer logic nor inspects the actual extension closed ShadowRoot.');
});
