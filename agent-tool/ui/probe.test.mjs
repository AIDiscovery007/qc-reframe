import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { probeLayout } from './probe.mjs';

const { chromium } = createRequire(new URL('../../browser-extension/package.json', import.meta.url))('playwright');
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const failed = result => result.checks.filter(check => check.status === 'failed');
async function pageFor(t, markup, width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  t.after(() => page.close());
  await page.setContent(markup);
  return page;
}
const canvas = `<style>
  * { box-sizing:border-box } body { margin:0 } [hidden] { display:none!important }
  .workspace-body { display:flex;width:900px;height:500px;position:relative }
  .workspace-editor,.workspace-results { width:450px;height:500px }
  .canvas-input,.generated-pane { display:grid;grid-template-rows:26px 326px 56px 68px;gap:8px;height:500px }
  .canvas-stage { display:contents } .result-footer { grid-row:3/5;display:grid;grid-template-rows:56px 68px;gap:8px }
  @media(max-width:650px) {
    .workspace-body { width:100% } .workspace-editor,.workspace-results { width:100% }
    .workspace-body[data-results-open="true"] .workspace-editor,.workspace-body[data-results-open="false"] .workspace-results { display:none }
  }
</style><div class="app workspace-app"><div class="workspace-body" data-results-open="true" data-history="false">
  <div class="workspace-editor"><main><section class="canvas-workspace"><div class="canvas-input"><div class="canvas-stage">
    <div class="canvas-label">Input</div><div class="canvas-large"></div><div class="canvas-filmstrip"></div>
  </div><div class="canvas-controls"></div></div></section></main></div>
  <aside class="workspace-results"><section class="generated-pane"><div class="result-toolbar">Result</div><div class="preview-canvas"></div>
    <div class="result-footer"><div class="result-history"></div><div class="result-controls"></div></div>
  </section></aside>
</div></div>`;
const picture = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="gold"/></svg>');
const popup = `<style>
  * { box-sizing:border-box } body { margin:0 } [hidden] { display:none!important }
  .quick-canvas { height:180px } .quick-filmstrip { height:36px }
  .image-preview { display:block;position:relative;width:200px;height:180px }
  .image-preview img { display:block;width:200px;height:180px;object-fit:contain }
  .image-preview-trigger { position:absolute;width:34px;height:34px;right:4px;bottom:44px;padding:0;border:0 }
</style><div class="app"><section class="quick-workspace"><div class="quick-heading"><h1>Fixture project</h1></div><div class="quick-canvas"><span class="image-preview">
  <img src="${picture}"><span class="image-preview-anchor"><button class="image-preview-trigger"></button></span>
</span></div><div class="quick-filmstrip"></div></section></div>`;
const evaluate = (page, surface, rules) => page.evaluate(probeLayout, { surface, rules });

test('aligned wide tracks pass; an 8px one-sided padding change fails with bounded diagnostics', async t => {
  const page = await pageFor(t, canvas);
  assert.equal(failed(await evaluate(page, 'workspace', ['UI-LAYOUT-CANVAS'])).length, 0);
  await page.addStyleTag({ content: '.canvas-input { padding-left:8px }' });
  const result = await evaluate(page, 'workspace', ['UI-LAYOUT-CANVAS']);
  assert.equal(failed(result).length, 3);
  assert.ok(result.diagnostics.every(item => item.ancestors.length <= 5 && item.sourceCandidates.length));
  assert.ok(result.diagnostics.some(item => item.ancestors.some(ancestor => ancestor.computedStyle.padding === '0px 0px 0px 8px')));
});

test('fully hidden/clip ancestor clipping fails required tracks; reachable scroll content stays valid', async t => {
  const page = await pageFor(t, canvas);
  for (const overflow of ['hidden', 'clip']) {
    await page.locator('.app').evaluate((node, value) => { node.style.cssText = `height:0;overflow:${value}`; }, overflow);
    assert.equal(failed(await evaluate(page, 'workspace', ['UI-LAYOUT-CANVAS'])).length, 3, overflow);
  }
  await page.locator('.app').evaluate(node => { node.style.cssText = 'width:0;overflow:clip'; });
  assert.equal(failed(await evaluate(page, 'workspace', ['UI-LAYOUT-CANVAS'])).length, 3);
  for (const overflow of ['auto', 'scroll']) {
    await page.locator('.app').evaluate((node, value) => { node.style.cssText = `height:100px;overflow:${value}`; }, overflow);
    assert.equal(failed(await evaluate(page, 'workspace', ['UI-LAYOUT-CANVAS'])).length, 0, overflow);
  }
  await page.locator('.app').evaluate(node => { node.style.cssText = 'height:100px;overflow:hidden'; });
  await page.locator('.workspace-body').evaluate(node => { node.style.cssText = 'height:100px;overflow:auto'; });
  assert.equal(failed(await evaluate(page, 'workspace', ['UI-LAYOUT-CANVAS'])).length, 0, 'scrollport inside a clipping ancestor');
});

test('right-side drift and successful inspect retain both sides within diagnostic bounds', async t => {
  const page = await pageFor(t, canvas);
  const inspected = await page.evaluate(probeLayout, { surface: 'workspace', rules: ['UI-LAYOUT-CANVAS'], inspect: true });
  assert.equal(failed(inspected).length, 0);
  assert.equal(inspected.diagnostics.length, 6);
  assert.ok(inspected.diagnostics.some(item => item.measuredTarget === 'div.canvas-label'));
  assert.ok(inspected.diagnostics.some(item => item.measuredTarget === 'div.result-toolbar'));
  await page.addStyleTag({ content: '.generated-pane { padding-left:8px }' });
  const result = await evaluate(page, 'workspace', ['UI-LAYOUT-CANVAS']);
  assert.equal(failed(result).length, 3);
  assert.equal(result.diagnostics.length, 6);
  assert.ok(result.diagnostics.every(item => item.ancestors.length <= 5));
  for (const check of failed(result)) {
    const pair = result.diagnostics.filter(item => item.target === check.target);
    assert.equal(pair.length, 2);
    assert.ok(pair[0].measuredTarget.includes('canvas-'));
    assert.ok(pair[1].ancestors.some(item => item.target === 'section.generated-pane' && item.computedStyle.padding === '0px 0px 0px 8px'));
  }
});

test('track drift and missing expected targets are failures, not skipped successes', async t => {
  const page = await pageFor(t, canvas);
  await page.addStyleTag({ content: '.result-toolbar { transform:translateY(8px) }' });
  assert.equal(failed(await evaluate(page, 'workspace', ['UI-LAYOUT-CANVAS'])).length, 1);
  await page.locator('.canvas-filmstrip').evaluate(node => node.remove());
  assert.ok(failed(await evaluate(page, 'workspace', ['UI-LAYOUT-CANVAS'])).some(check => check.target === '.canvas-filmstrip'));
  await page.setContent('<div>wrong page</div>');
  assert.ok(failed(await evaluate(page, 'workspace')).length >= 2);
});

test('narrow layouts validate active full-width tracks and inactive inert on both sides', async t => {
  const page = await pageFor(t, canvas, 600);
  await page.locator('.workspace-editor').evaluate(node => { node.inert = true; });
  assert.equal(failed(await evaluate(page, 'workspace', ['UI-LAYOUT-CANVAS'])).length, 0);
  await page.locator('.workspace-editor').evaluate(node => { node.inert = false; });
  assert.ok(failed(await evaluate(page, 'workspace', ['UI-LAYOUT-CANVAS'])).some(check => check.target === 'narrow drawer sides'));
  await page.locator('.workspace-body').evaluate(node => { node.dataset.resultsOpen = 'false'; });
  await page.locator('.workspace-results').evaluate(node => { node.inert = true; });
  assert.equal(failed(await evaluate(page, 'workspace', ['UI-LAYOUT-CANVAS'])).length, 0);
  await page.addStyleTag({ content: '.workspace-editor { min-width:700px }' });
  assert.ok(failed(await evaluate(page, 'workspace', ['UI-LAYOUT-CANVAS'])).length > 0);
});

test('legitimate closed, library and empty states are explicitly skipped', async t => {
  const page = await pageFor(t, canvas);
  await page.locator('.workspace-body').evaluate(node => { node.dataset.resultsOpen = 'false'; });
  assert.equal((await evaluate(page, 'workspace', ['UI-LAYOUT-CANVAS'])).checks[0].status, 'skipped');
  await page.setContent('<div class="app workspace-app"><div class="workspace-body" data-history="true"></div></div>');
  assert.ok((await evaluate(page, 'workspace')).checks.every(check => check.status === 'skipped'));
  await page.setContent('<div class="app workspace-app"><main><section class="empty"></section></main></div>');
  assert.equal(failed(await evaluate(page, 'workspace')).length, 0);
});

test('popup fixed geometry and letterboxed image button pass at 400 and 320px', async t => {
  const page = await pageFor(t, popup, 400);
  for (const width of [400, 320]) {
    await page.setViewportSize({ width, height: 700 });
    assert.equal(failed(await evaluate(page, 'popup')).length, 0);
  }
  await page.addStyleTag({ content: '.quick-canvas { height:188px } .image-preview-trigger { bottom:4px }' });
  const result = await evaluate(page, 'popup');
  assert.ok(failed(result).some(check => check.ruleId === 'UI-LAYOUT-QUICK'));
  assert.ok(failed(result).some(check => check.ruleId === 'UI-IMAGE-PREVIEW'));
  assert.ok(!JSON.stringify(result).includes('data:image'));
});

test('loaded image requires a button; unavailable image requires a hidden button', async t => {
  const page = await pageFor(t, popup);
  await page.locator('.image-preview-trigger').evaluate(node => { node.hidden = true; });
  assert.equal(failed(await evaluate(page, 'popup', ['UI-IMAGE-PREVIEW'])).length, 1);
  await page.locator('.image-preview img').evaluate(img => { img.src = 'data:image/png;base64,broken'; });
  await page.waitForFunction(() => document.querySelector('img').complete);
  assert.equal(failed(await evaluate(page, 'popup', ['UI-IMAGE-PREVIEW'])).length, 0);
  await page.locator('.image-preview-trigger').evaluate(node => { node.hidden = false; });
  assert.equal(failed(await evaluate(page, 'popup', ['UI-IMAGE-PREVIEW'])).length, 1);
});

test('landscape, portrait and square contain images anchor to actual image edges', async t => {
  const page = await pageFor(t, popup);
  for (const [width, height, right, bottom] of [[120, 60, 4, 44], [60, 120, 59, 4], [100, 100, 14, 4]]) {
    await page.locator('img').evaluate((img, [width, height]) => {
      img.src = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`);
    }, [width, height]);
    await page.waitForFunction(() => document.querySelector('img').complete && document.querySelector('img').naturalWidth > 0);
    await page.locator('.image-preview-trigger').evaluate((button, [right, bottom]) => {
      button.style.right = right + 'px'; button.style.bottom = bottom + 'px';
    }, [right, bottom]);
    assert.equal(failed(await evaluate(page, 'popup', ['UI-IMAGE-PREVIEW'])).length, 0);
  }
});

test('missing quick canvas/filmstrip/preview fail; explicit upload empty state is valid', async t => {
  const page = await pageFor(t, popup);
  await page.locator('.quick-filmstrip').evaluate(node => node.remove());
  assert.ok(failed(await evaluate(page, 'popup', ['UI-LAYOUT-QUICK'])).some(check => check.target === '.quick-filmstrip'));
  await page.locator('.quick-canvas').evaluate(node => { node.innerHTML = '<button class="quick-upload">Upload</button>'; });
  assert.ok(failed(await evaluate(page, 'popup')).some(check => check.target === '.quick-filmstrip'));
  await page.locator('h1').evaluate(node => { node.textContent = '选择参考图'; });
  assert.equal(failed(await evaluate(page, 'popup')).length, 0);
  await page.locator('.quick-canvas').evaluate(node => node.remove());
  const result = await evaluate(page, 'popup');
  assert.ok(failed(result).some(check => check.target === '.quick-canvas'));
  assert.ok(failed(result).some(check => check.ruleId === 'UI-IMAGE-PREVIEW'));
});
