import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../../browser-extension/package.json', import.meta.url))('playwright');
const output = new URL('../../browser-extension/.output/chrome-mv3/', import.meta.url);
const contracts = [
  { selector: '.reminder-toast', property: 'borderTopColor', declaration: 'border', token: '--line', color: 'rgb(229, 225, 216)' },
  { selector: '.reminder-toast', property: 'backgroundColor', declaration: 'background', token: '--surface', color: 'rgb(255, 254, 250)' },
  { selector: '.reminder-toast', property: 'color', declaration: 'color', token: '--ink', color: 'rgb(38, 36, 31)' },
  { selector: '.canvas-prompt-sheet[popover]', property: 'backgroundColor', declaration: 'background', token: '--surface', color: 'rgb(255, 254, 250)' },
  { selector: '.gallery-preview .preview-art', property: 'backgroundColor', declaration: 'background', token: '--surface-muted', color: 'rgb(240, 237, 230)' },
];
let browser, styles;

before(async () => {
  // Read the exact stylesheets, in order, linked by the production build. Never rebuild here.
  styles = {};
  for (const surface of ['popup', 'workspace']) {
    const html = await readFile(new URL(`${surface}.html`, output), 'utf8');
    const links = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)];
    assert.ok(links.length, `Missing built ${surface} stylesheet`);
    styles[surface] = (await Promise.all(links.map(([, href]) => readFile(new URL(href.replace(/^\//, ''), output), 'utf8')))).join('\n');
  }
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

async function sample(t, { closed = false, removeScope = false, override = false } = {}) {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.route('**/*', route => route.abort());
  return page.evaluate(({ css, contracts, closed, removeScope, override }) => {
    // These are selector fixtures using production aggregate CSS, not copied component styles.
    // Only this test retains its own closed root handle; extension internals remain inaccessible.
    const host = document.createElement('section'); document.body.append(host);
    const root = closed ? host.attachShadow({ mode: 'closed' }) : document;
    const scope = closed ? host : document.documentElement;
    if (closed && !removeScope) {
      // A hostile page's inherited values must not replace the panel's :host defaults.
      for (const { token } of contracts) document.documentElement.style.setProperty(token, 'rgb(1, 2, 3)');
    }
    const style = document.createElement('style'); style.textContent = css;
    (closed ? root : document.head).append(style);
    const rules = [];
    function collect(sheet) {
      for (const rule of sheet.cssRules) {
        if (rule.style) rules.push(rule);
        if (rule.cssRules) collect(rule);
      }
    }
    collect(style.sheet);
    const tokenRules = rules.filter(rule => rule.selectorText?.includes(closed ? ':host' : ':root') && rule.style.getPropertyValue('--surface'));
    if (removeScope) for (const rule of tokenRules) for (const token of new Set(contracts.map(item => item.token))) rule.style.removeProperty(token);
    if (override) for (const { token } of contracts) scope.style.setProperty(token, 'rgb(12, 34, 56)');
    const app = document.createElement('main'); app.className = 'app workspace-app';
    app.innerHTML = '<aside class="reminder-toast" popover="manual">Reminder</aside>' + (closed ? '' : '<section class="canvas-prompt-sheet" popover="manual">Prompt</section><dialog class="gallery-preview" open><div class="preview-art">Artwork</div></dialog>');
    (closed ? root : document.body).append(app);
    for (const popover of app.querySelectorAll('[popover]')) popover.showPopover();
    return {
      closed: closed && host.shadowRoot === null,
      tokenRuleCount: tokenRules.length,
      values: contracts.map(contract => {
        const element = root.querySelector(contract.selector);
        const computed = element && getComputedStyle(element);
        return {
          selector: contract.selector, property: contract.property,
          token: computed?.getPropertyValue(contract.token).trim() || '',
          scopeToken: getComputedStyle(scope).getPropertyValue(contract.token).trim(),
          color: computed?.[contract.property] || '',
          // Reject stale builds that still contain the pre-migration literal declarations.
          usesToken: rules.some(rule => rule.selectorText === contract.selector && rule.style.getPropertyValue(contract.declaration).includes(`var(${contract.token})`)),
        };
      }),
    };
  }, { css: styles[closed ? 'popup' : 'workspace'], contracts: closed ? contracts.slice(0, 3) : contracts, closed, removeScope, override });
}

function failures(result, expected) {
  return result.values.filter((value, index) => !value.usesToken || !value.token || value.token !== value.scopeToken || value.color !== expected[index]);
}

for (const closed of [false, true]) {
  const scope = closed ? 'closed ShadowRoot :host' : 'document :root';
  const expected = (closed ? contracts.slice(0, 3) : contracts).map(item => item.color);
  test(`production aggregate CSS preserves migrated colors through ${scope}`, async t => {
    const result = await sample(t, { closed });
    assert.ok(result.tokenRuleCount > 0, `Missing ${scope} token definition`);
    assert.equal(result.closed, closed);
    assert.deepEqual(failures(result, expected), []);
  });
  test(`${scope} overrides propagate to the actual migrated selectors`, async t => {
    const result = await sample(t, { closed, override: true });
    assert.deepEqual(failures(result, expected.map(() => 'rgb(12, 34, 56)')), []);
  });
  test(`${scope} missing token scope is rejected`, async t => {
    const result = await sample(t, { closed, removeScope: true });
    assert.ok(result.tokenRuleCount > 0, 'Fault injection must remove existing token definitions');
    assert.equal(failures(result, expected).length, expected.length);
    assert.ok(result.values.every(value => value.token === '' && value.scopeToken === '' && value.usesToken));
  });
}
