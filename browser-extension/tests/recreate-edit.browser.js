// Build + preview, then /workspace.html?state=alignment&mode=recreate&recreateEditRegression=<submit|failed|legacy>&generationDelay=1000
// Runs the real React bundle with fake extension messages; no CLI/model calls.
//
// user edits the original image in 完整复刻:
//   Given a 完整复刻 version whose reverse scanned editable elements
//   When the user switches 生图方式 to 原图编辑 and opens the edit dialog
//   Then each element shows its current content with an empty「保持不变」field, and submit stays disabled until one change is filled
//   When the user fills one change and submits
//   Then the dialog closes, the new record keeps the frozen change and its info reads「原图 + 1 项修改」
// user keeps the edit dialog after a failed submission:
//   Given the generation request fails
//   Then the dialog stays open with the error and the filled change
// user cannot edit a version without editable elements:
//   Given an older 完整复刻 version without scanned elements
//   Then 原图编辑 keeps generation disabled and asks for a new reverse
const find = selector => document.querySelector(selector);
const assert = (value, message) => { if (!value) throw new Error(message); };
const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const setValue = (element, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, value);
  element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
const flow = new URLSearchParams(location.search).get('recreateEditRegression');
const generate = () => find('.canvas-generation-actions .generate-button');
const mode = () => find('.canvas-generation-actions [aria-label="生图方式"]');
const dialog = () => find('dialog.recreate-edit');
const fields = () => [...dialog().querySelectorAll('.edit-element input')];
const submit = () => dialog().querySelector('button[type="submit"]');
try {
  await waitFor(() => find('[aria-label="逆向模式"]'), '工作台应就绪');
  assert(!mode(), '其他路径不显示生图方式');
  setValue(find('[aria-label="逆向模式"]'), 'recreate');
  await waitFor(() => generate() && !generate().disabled && mode(), '完整复刻应显示生图方式并可生成');
  assert(mode().value === 'text', '最新记录是文生图时默认文生图');
  assert(find('.canvas-generation-actions .generation-ratio select') !== mode(), '目标尺寸仍是第一个尺寸控件');
  setValue(mode(), 'edit');
  if (flow === 'legacy') {
    await waitFor(() => generate().disabled && find('.canvas-generation-actions').textContent.includes('此版本没有可编辑元素'), '旧版本应禁用原图编辑并说明原因');
    setValue(mode(), 'text');
    await waitFor(() => !generate().disabled, '切回文生图应恢复生成');
  } else {
    await waitFor(() => generate().textContent.includes('填写修改并生成'), '原图编辑应先填写修改');
    generate().click();
    await waitFor(() => dialog()?.open, '应打开编辑窗口');
    assert(fields().length === 3 && fields().every(input => !input.value && input.placeholder === '保持不变'), '每个可编辑元素都应有空白的保持不变输入');
    assert(dialog().textContent.includes('当前：画面中央的橄榄绿圆形'), '应显示元素的当前内容');
    assert(submit().disabled, '未填写修改不能提交');
    setValue(fields()[0], '画面中央的陶土红三角形');
    await waitFor(() => !submit().disabled, '填写一项后可以提交');
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !dialog(), 'Escape 应关闭编辑窗口');
    generate().click();
    await waitFor(() => dialog()?.open && fields()[0].value === '画面中央的陶土红三角形', '重新打开应保留未提交的修改');
    dialog().querySelector('details summary').click();
    assert(dialog().querySelector('.edit-prompt-preview').textContent.includes('改为「画面中央的陶土红三角形」'), '预览应显示拼装后的修改');
    const records = document.querySelectorAll('.result-thumb').length;
    submit().click();
    if (flow === 'failed') {
      await waitFor(() => dialog()?.querySelector('.error')?.textContent.includes('生成请求提交失败'), '失败应在编辑窗口内提示');
      assert(fields()[0].value === '画面中央的陶土红三角形' && !submit().disabled, '失败后保留修改并允许重试');
    } else {
      await waitFor(() => !dialog(), '提交成功应关闭编辑窗口');
      await waitFor(() => document.querySelectorAll('.result-thumb').length === records + 1, '应新增一条生成记录');
      assert(mode().value === 'edit', '提交后保持原图编辑');
      await waitFor(() => !find('[aria-label="生成信息"]').disabled, '生成信息应可查看');
      find('[aria-label="生成信息"]').click();
      await waitFor(() => find('.generation-details'), '应打开生成信息');
      assert(find('.generation-details').textContent.includes('原图 + 1 项修改'), '生成信息应标明原图编辑');
      assert(find('.generation-details .prompt-text').textContent.includes('以图 1 为原图进行局部编辑'), '记录应保存拼装后的编辑提示词');
      find('[aria-label="本次生成信息"] .close-btn').click();
      await waitFor(() => !find('.generation-details'), '应关闭生成信息');
      document.querySelectorAll('.result-thumb')[0].click();
      await waitFor(() => mode().value === 'text', '查看文生图记录应沿用其生图方式');
    }
  }
  document.documentElement.dataset.recreateEditRegression = 'passed';
  find('#preview-notice').textContent = `原图编辑回归：PASS · ${flow}`;
} catch (error) {
  document.documentElement.dataset.recreateEditRegression = 'failed';
  find('#preview-notice').textContent = `原图编辑回归：FAIL · ${error.message}`;
  console.error(error);
}
