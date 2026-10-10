import { checkImageViewer } from './image-viewer.mjs';
import { components, exampleScenarios } from './catalog.mjs';
export { exampleScenarios } from './catalog.mjs';

const longInstruction = '保留主体的形状、布局、材质和光影；使用参考图的画法，保持画面关系清楚。\n'.repeat(100);
export const exampleCoverage = components.map(component => ({ component: component.name, source: component.source,
  examples: exampleScenarios.filter(scenario => scenario.components.includes(component.name)).map(({ id, states }) => ({ id, states })),
  scope: 'Representative preview cases; execution results are required to claim verification.',
}));
export const exampleLimitations = [
  '使用构建后的生产组件与预览消息数据，不发送真实模型请求。导航链接打开起始场景，交互准备步骤由下方说明或CLI自动验收执行。',
  '覆盖代表状态，不表示所有组件/路径/状态组合已验收。真实扩展、closed ShadowRoot、系统下拉像素、触屏及屏幕阅读器未覆盖。',
  '图片旋转保存忙碌保护、嵌套dialog及读取失败重试的完整业务闭环尚未覆盖。',
  '原生系统下拉的键盘选值受headless平台支持限制；不支持时明确跳过该项，另用原生select选值事件验证状态保存，不将其冒充键盘证据。',
];

function example(scenario) {
  const value = typeof scenario === 'string' ? exampleScenarios.find(item => item.id === scenario) : scenario;
  if (!value?.example || !exampleScenarios.some(item => item.id === value.id)) throw new Error(`Unknown component example: ${typeof scenario === 'string' ? scenario : scenario?.id}`);
  return value;
}

export function imageTrigger(page, item) {
  const canvas = item.imageTarget === 'result' ? (item.surface === 'popup' ? '.quick-result' : '.generation-result-preview') : item.surface === 'popup' ? '.quick-canvas' : '.canvas-large';
  return page.locator(`${canvas} .image-preview-trigger`);
}

// Call after navigating to scenario.path in an isolated preview context.
export async function prepareExample(page, scenario) {
  const item = example(scenario);
  await page.waitForSelector('.app');
  await page.evaluate(() => document.fonts.ready);
  if (item.example === 'image') {
    if (item.imageOpenViewport) await page.setViewportSize(item.imageOpenViewport);
    await page.waitForSelector(item.surface === 'popup' ? '.quick-workspace' : '.canvas-workspace');
    await page.getByRole('combobox', { name: '逆向模式', exact: true }).selectOption('recreate');
    if (item.surface === 'workspace' && item.imageTarget === 'result') {
      const toggle = page.locator('.result-return');
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    }
    const trigger = imageTrigger(page, item);
    await trigger.waitFor({ state: 'visible' });
    await trigger.focus(); await trigger.press('Enter');
    await page.waitForFunction(() => { const img = document.querySelector('.image-viewer-stage img'); return img?.complete && img.naturalWidth > 0 && img.style.width; });
    if (item.imageOpenViewport) await page.setViewportSize(item.viewport);
  } else if (item.example === 'empty') {
    if (item.surface === 'workspace') await page.waitForSelector('main > .empty');
    else await page.waitForSelector('.quick-upload');
  } else if (item.example === 'loading') {
    await page.waitForSelector('.canvas-large .loading-placeholder');
    await page.waitForFunction(() => document.querySelector('.canvas-reverse-actions button')?.disabled);
  } else if (item.example === 'busy') {
    await page.getByRole('button', { name: '取消', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.quick-compose textarea')?.disabled);
  } else if (item.example === 'failed') await page.locator('.quick-workspace .error').waitFor();
  else if (item.example === 'disabled') {
    await page.waitForFunction(() => document.querySelector('.quick-submit .primary')?.disabled);
  } else {
    await page.waitForSelector('.canvas-workspace');
    await page.getByRole('combobox', { name: '逆向模式', exact: true }).selectOption('recreate');
    await page.waitForFunction(() => { const image = document.querySelector('.canvas-large img'); return image?.complete && image.naturalWidth > 0; });
    if (item.example === 'long') {
      await page.getByRole('textbox', { name: '任务指令', exact: true }).fill(longInstruction);
      await page.getByRole('button', { name: '展开提示词', exact: true }).click();
      await page.waitForSelector('.canvas-workspace[data-prompt-open="true"]');
    } else if (item.example.startsWith('narrow-')) {
      await page.getByRole('button', { name: item.example === 'narrow-input' ? '输入画布' : '生成结果', exact: true }).click();
    } else if (item.example === 'controls') {
      const trigger = page.getByRole('button', { name: '设置中心', exact: true });
      await trigger.focus(); await trigger.press('Enter');
      await page.getByRole('button', { name: '界面与动效', exact: true }).click();
      await page.getByRole('combobox', { name: '减少动态效果', exact: true }).waitFor();
    }
  }
  return item;
}

async function chooseWithKeyboard(page, select) {
  await select.selectOption('system');
  const initial = await select.inputValue();
  await select.focus();
  for (const key of ['Home', 'ArrowDown', 'Enter']) await page.keyboard.press(key);
  const selected = await select.inputValue();
  await page.keyboard.press('Tab'); // Leave the picker without risking dismissal of its surrounding modal.
  return { initial, selected, changed: selected !== initial && selected === 'reduce' };
}

async function nativeSelectCapability(page) {
  // Separate context excludes product handlers, preview data and runner init scripts.
  const context = await page.context().browser().newContext();
  try {
    const control = await context.newPage();
    await control.setContent('<select><option value="system">System</option><option value="reduce">Reduce</option><option value="full">Full</option></select>');
    return { ...await chooseWithKeyboard(control, control.locator('select')), platform: await control.evaluate(() => navigator.platform), source: 'isolated plain native select in a separate browser context' };
  } finally { await context.close(); }
}

export async function checkExample(page, scenario, capture) {
  const item = example(scenario), checks = [];
  const ruleId = item.example === 'image' || item.example === 'controls' ? 'UI-EXAMPLE-KEYBOARD' : 'UI-EXAMPLE-STATE';
  const sourceFiles = components.filter(component => item.components.includes(component.name)).map(component => component.source);
  const record = (ok, target, expected, actual, message) => checks.push({ ruleId, status: ok ? 'passed' : 'failed', target, expected, actual, sourceFiles, message });
  const visible = async selector => page.locator(selector).first().isVisible();
  const snapshot = async selector => page.locator(selector).first().evaluate(node => ({ disabled: !!node.disabled, length: node.value?.length ?? 0, open: !!node.open, tag: node.tagName }));
  try {
    if (item.example === 'empty') {
      const selector = item.surface === 'workspace' ? 'main > .empty' : '.quick-upload', shown = await visible(selector);
      record(shown, selector, 'visible explicit empty state', { visible: shown }, 'No reference selected.');
      if (item.surface === 'popup') record(await page.locator('.quick-compose').count() === 0, '.quick-compose', 'absent before reference selection', { count: await page.locator('.quick-compose').count() }, 'No premature submit form.');
    } else if (item.example === 'loading') {
      const shown = await visible('.canvas-large .loading-placeholder'), button = await snapshot('.canvas-reverse-actions button');
      record(shown && button.disabled, '.canvas-large / .canvas-reverse-actions', { placeholder: true, submitDisabled: true }, { placeholder: shown, submitDisabled: button.disabled }, 'Reference loading stays in its canvas and blocks submission.');
    } else if (item.example === 'busy') {
      const input = await snapshot('.quick-compose textarea'), cancel = page.getByRole('button', { name: '取消', exact: true });
      const actual = { inputDisabled: input.disabled, cancelVisible: await cancel.isVisible(), cancelEnabled: await cancel.isEnabled(), statusPresent: !!(await page.locator('.quick-submit [role="status"]').textContent()) };
      record(Object.values(actual).every(Boolean), '.quick-compose', { inputDisabled: true, cancelVisible: true, cancelEnabled: true, statusPresent: true }, actual, 'Running fixture preserves progress and cancel while locking the input.');
    } else if (item.example === 'failed') {
      const error = page.locator('.quick-workspace .error');
      const actions = await Promise.all((await error.locator('button').all()).map(async button => await button.isVisible() && await button.isEnabled()));
      const actual = { visible: await error.isVisible(), alert: await error.getAttribute('role') === 'alert', recovery: actions.some(Boolean) };
      record(Object.values(actual).every(Boolean), '.quick-workspace .error', { visible: true, alert: true, recovery: true }, actual, 'Failure has a readable alert and a real recovery action.');
    } else if (item.example === 'disabled') {
      const submit = await snapshot('.quick-submit .primary'), input = await snapshot('.quick-compose textarea');
      record(submit.disabled && input.disabled, '.quick-submit / textarea', { submitDisabled: true, inputDisabled: true }, { submitDisabled: submit.disabled, inputDisabled: input.disabled }, 'No verified model cannot submit.');
    } else if (item.example === 'long') {
      const value = await page.locator('textarea[aria-label="任务指令"]').inputValue();
      const open = await page.locator('.canvas-workspace').getAttribute('data-prompt-open') === 'true';
      record(value === longInstruction && open, '.canvas-workspace', { draftLength: longInstruction.length, promptOpen: true }, { draftLength: value.length, promptOpen: open }, 'Opening the prompt preserves the long instruction draft.');
    } else if (item.example.startsWith('narrow-')) {
      const actual = await page.evaluate(() => ({ editorInert: !!document.querySelector('.workspace-editor')?.inert, resultInert: !!document.querySelector('.workspace-results')?.inert, resultsOpen: document.querySelector('.workspace-body')?.dataset.resultsOpen === 'true' }));
      const result = item.example === 'narrow-result';
      record(actual.editorInert === result && actual.resultInert !== result && actual.resultsOpen === result, '.workspace-body', { editorInert: result, resultInert: !result, resultsOpen: result }, actual, 'Only the selected narrow workspace is interactive.');
    } else {
      const selector = item.example === 'image' ? '.image-preview-dialog' : '.settings-center';
      const modal = await page.locator(selector).evaluate(node => ({ nativeModal: node.matches(':modal'), focusInside: node.contains(document.activeElement) }));
      record(modal.nativeModal && modal.focusInside, selector, { nativeModal: true, focusInside: true }, modal, 'Production dialog uses the native modal focus boundary.');
      if (item.example === 'image') {
        checks.push(...await checkImageViewer(page, capture));
        const output = page.getByRole('status', { name: '缩放比例', exact: true });
        await page.getByRole('button', { name: '放大图片', exact: true }).focus();
        await page.keyboard.press('Enter');
        const zoomed = await output.textContent();
        await page.getByRole('button', { name: '适应窗口', exact: true }).focus();
        await page.keyboard.press('Enter');
        const fitted = await output.textContent();
        record(parseInt(zoomed) > 100 && fitted === '100%', '.image-viewer-tools', { zoomedAbove100: true, fit: '100%' }, { zoomed, fitted }, 'Keyboard zoom and fit use production ImageViewer controls.');
      } else {
        const select = page.getByRole('combobox', { name: '减少动态效果', exact: true });
        const capability = await nativeSelectCapability(page);
        const keyboard = await chooseWithKeyboard(page, select), keyboardSelection = keyboard.changed;
        const keyboardCheck = { ruleId, target: 'native select keyboard picker', expected: 'Home + ArrowDown + Enter changes system to reduce', actual: { ...keyboard, capability }, sourceFiles };
        checks.push({ ...keyboardCheck, status: keyboardSelection ? 'passed' : capability.changed ? 'failed' : 'skipped', message: keyboardSelection ? 'Keyboard changed the production native select from a different initial value.' : capability.changed ? 'The independent native control supports keyboard selection, but the production control did not change.' : 'An independent plain native select also failed this keyboard sequence; OS picker keyboard behavior is unverified on this platform. Picker-specific Escape remains manual.' });
        // Force a separate change event even when keyboard selection already chose reduce.
        await select.selectOption('full');
        await page.waitForFunction(() => document.querySelector('.app')?.dataset.motion === 'full');
        await select.selectOption('reduce');
        await page.waitForFunction(() => document.querySelector('.app')?.dataset.motion === 'reduce');
        const actual = { nativeSelect: await select.evaluate(node => node instanceof HTMLSelectElement), selected: await select.inputValue(), keyboardSelection, motionApplied: await page.locator('.app').getAttribute('data-motion') === 'reduce' };
        record(actual.nativeSelect && actual.selected === 'reduce' && actual.motionApplied, '.settings-center select', { nativeSelect: true, selected: 'reduce', motionApplied: true }, actual, 'Native select change updates the application motion preference.');
        const summary = page.locator('.inline-help summary');
        await summary.focus(); await page.keyboard.press('Enter');
        const opened = await page.locator('.inline-help').evaluate(node => node.open);
        await page.keyboard.press('Space');
        const closed = await page.locator('.inline-help').evaluate(node => !node.open);
        record(opened && closed, '.inline-help', { enterOpens: true, spaceCloses: true }, { enterOpens: opened, spaceCloses: closed }, 'Native details supports keyboard disclosure without hover.');
      }
      let backgroundControlFocused = false, browserBoundaryStops = 0;
      const stops = await page.locator(selector).locator('button:enabled,select:enabled,input:enabled,summary,[tabindex="0"]').count();
      for (let index = 0; index < Math.min(stops + 2, 30); index++) {
        await page.keyboard.press('Tab');
        const focus = await page.locator(selector).evaluate(node => ({ inside: node.contains(document.activeElement), browserBoundary: document.activeElement === document.body && node.matches(':modal') }));
        if (focus.browserBoundary) browserBoundaryStops++;
        else if (!focus.inside) backgroundControlFocused = true;
      }
      record(!backgroundControlFocused, selector, 'Tab cannot focus page controls behind native modal', { backgroundControlFocused, browserBoundaryStops }, 'Native browser focus boundary stops are allowed; background page controls are not.');
      // The short workspace cannot render its background trigger. Restore the opening size before testing focus return.
      if (item.imageOpenViewport) {
        await page.setViewportSize(item.imageOpenViewport);
        await page.waitForFunction(() => { const trigger = document.querySelector('.generation-result-preview .image-preview-trigger'); return trigger && !trigger.disabled && trigger.getBoundingClientRect().width > 0; });
      }
      await page.keyboard.press('Escape');
      await page.locator(selector).waitFor({ state: 'detached' });
      const trigger = item.example === 'image' ? imageTrigger(page, item) : page.getByRole('button', { name: '设置中心', exact: true });
      const restored = await trigger.evaluate(node => node === document.activeElement);
      record(restored, selector, 'Escape closes and returns focus to its trigger', { closed: !await visible(selector), focusRestored: restored }, 'Dialog closing restores the initiating control.');
    }
  } catch (error) {
    record(false, item.id, 'expected production state and controls available', { error: String(error.message).slice(0, 600) }, 'Example interaction could not complete.');
  }
  return checks;
}

export function renderExamples({ baseURL = 'http://127.0.0.1:43188' } = {}) {
  const url = new URL(baseURL);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Examples require a local preview URL at http://127.0.0.1.');
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Reframe UIUX 组件状态样例</title><style>body{font:16px/1.6 system-ui;margin:32px;max-width:1200px;color:#26241f;background:#faf9f6}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid #e5e1d8}a{color:#225a91}code{overflow-wrap:anywhere}.table{overflow:auto}small{display:block}li{margin:8px 0}</style><h1>Reframe UIUX 组件状态样例</h1><p>链接复用生产页面和预览fixture；不复制组件。按标注尺寸打开，依照步骤检查交互。CLI执行结果才构成自动验收证据。</p><div class="table"><table><thead><tr><th>示例 / 状态</th><th>组件</th><th>尺寸 / 准备步骤</th></tr></thead><tbody>${exampleScenarios.map(item => `<tr><td><a href="${escape(new URL(item.path, url).href)}">${escape(item.title)}</a><small><code>${escape(item.id)}</code> · ${escape(item.states.join(', '))}</small></td><td>${escape(item.components.join(', '))}</td><td>${item.viewport.width} × ${item.viewport.height}<br>${escape(item.steps)}</td></tr>`).join('')}</tbody></table></div><h2>边界</h2><ul>${exampleLimitations.map(item => `<li>${escape(item)}</li>`).join('')}</ul></html>`;
}
