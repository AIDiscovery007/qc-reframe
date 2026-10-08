// Build + preview, then /workspace.html?state=alignment&mode=recreate&generationActionsRegression=1&generationDelay=60000&generationStartDelay=200
// Runs the real React bundle with fake extension messages; no CLI/model calls.
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
const generate = () => find('.canvas-generation-actions .generate-button');
const sheet = () => find('#workspace-prompt-sheet');
const closePrompt = async () => {
  find('[aria-label="收起提示词面板"]').click();
  await waitFor(() => sheet().inert, '提示词应收起');
};
const showInput = async () => {
  const tab = [...document.querySelectorAll('.workspace-canvas-tabs button')].find(button => button.textContent === '输入画布');
  tab?.click();
  await waitFor(() => !find('.workspace-editor').inert, '应返回输入画布');
};
try {
  await waitFor(() => find('[aria-label="逆向模式"]'), '工作台应就绪');
  setValue(find('[aria-label="逆向模式"]'), 'recreate');
  await waitFor(() => generate() && !generate().disabled, '主操作应直接可用');
  const footer = find('.canvas-generation-actions');
  const ratio = footer.querySelector('select');
  const actions = find('.canvas-primary-actions');
  assert(document.querySelectorAll('.generate-button').length === 1, '只能存在一套生图操作');
  assert(actions.contains(find('.canvas-generate')) && actions.contains(generate()), '两个生成动作必须在同一操作栏');
  assert(find('.canvas-generate').textContent === '更新提示词' && generate().textContent === '再生成图片', '两个动作名称必须明确区分');
  assert(!footer.closest('[inert]') && !sheet().contains(footer) && sheet().inert, '主操作不应依赖提示词面板');
  await showInput();
  const expand = find('[aria-label="放大指令"]');
  assert(expand.querySelector('svg') && !expand.textContent && expand.title, '放大入口应为有名称的图标');
  expand.focus();
  expand.click();
  await waitFor(() => expand.getAttribute('aria-expanded') === 'true', '指令应可放大');
  find('[aria-label="任务指令"]').focus();
  find('[aria-label="任务指令"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => expand.getAttribute('aria-expanded') === 'false', 'Escape 应恢复指令框');
  assert(document.activeElement === expand, '恢复后焦点应回到放大图标');
  find('[aria-label="展开提示词"]').click();
  await waitFor(() => !sheet().inert, '提示词应能按需展开');
  assert(!find('.canvas-generate').closest('[inert]') && !generate().closest('[inert]'), '提示词面板不能阻断统一操作栏');
  setValue(ratio, 'custom');
  await waitFor(() => find('[aria-label="比例宽"]'), '应显示自定义比例');
  setValue(find('[aria-label="比例宽"]'), '0');
  await waitFor(() => generate().disabled, '无效比例必须阻止生成');
  setValue(find('[aria-label="比例宽"]'), '7');
  setValue(find('[aria-label="比例高"]'), '5');
  await waitFor(() => !generate().disabled, '合法比例应可生成');
  find('[aria-label="编辑提示词"]').click();
  await waitFor(() => generate().disabled && footer.textContent.includes('编辑未保存'), '未保存编辑应禁用生图并解释原因');
  await closePrompt();
  assert(generate().disabled, '收起提示词不能绕过未保存编辑');
  find('[aria-label="展开提示词"]').click();
  await waitFor(() => !sheet().inert, '编辑状态应可恢复');
  find('.prompt-save .quiet-button').click();
  await waitFor(() => !generate().disabled, '取消编辑应恢复生图');
  await closePrompt();
  assert(ratio === footer.querySelector('select') && find('[aria-label="比例宽"]').value === '7', '面板开合应复用控件并保留比例');
  const instruction = find('[aria-label="任务指令"]');
  const original = instruction.value;
  setValue(instruction, original + ' 修改');
  await waitFor(() => generate().disabled && footer.textContent.includes('更新提示词'), '过期输入必须禁用并提示更新');
  setValue(instruction, original);
  await waitFor(() => !generate().disabled, '还原输入应恢复生图');
  generate().click();
  await waitFor(() => generate().textContent.includes('正在提交'), '请求提交期间应锁定');
  assert(ratio.disabled, '提交期间尺寸不能更改');
  await waitFor(() => find('[aria-label="取消生图"]'), '运行中应保留取消入口');
  assert(generate().disabled && !footer.closest('[inert]') && !find('.canvas-generate').closest('[inert]'), '结果页两个动作应可达且防止重复提交');
  find('[aria-label="取消生图"]').click();
  await waitFor(() => !generate().disabled, '取消后应恢复主操作');
  await showInput();
  const versions = find('[aria-label="提示词版本"]');
  const current = versions.value;
  setValue(versions, 'older-style');
  await waitFor(() => generate()?.textContent === '生成图片', '未生成版本应显示首次生图操作');
  assert(footer.querySelector('select').value === 'auto', '版本之间不能泄漏临时比例');
  setValue(versions, current);
  await waitFor(() => generate()?.textContent === '再生成图片', '切回版本应恢复其生图历史');
  setValue(versions, 'new');
  await waitFor(() => find('.canvas-generation-actions .generate-button')?.disabled, '无结果时生图应保持禁用');
  assert(generate().disabled && find('.canvas-generate').textContent === '仅逆向', '无结果时两个动作仍可见且区分可用状态');
  find('.canvas-generate').click();
  await waitFor(() => find('.canvas-generate')?.getAttribute('aria-busy') === 'true', '应开始逆向');
  assert(generate().disabled && find('.canvas-generate').textContent === '取消提示词', '提示词运行中保留明确取消动作');
  await waitFor(() => find('.canvas-generate')?.getAttribute('aria-busy') === 'false' && generate() && !generate().disabled, '逆向完成应直接激活主操作');
  assert(sheet().inert, '逆向完成不应强制展开提示词');
  setValue(find('[aria-label="提示词版本"]'), 'new');
  await waitFor(() => find('.canvas-generation-actions .generate-button')?.disabled, '新输入应回到生图未就绪状态');
  find('.canvas-generate').click();
  await waitFor(() => find('.canvas-generate')?.textContent === '取消提示词', '提示词任务应有取消入口');
  find('.canvas-generate').click();
  await waitFor(() => find('.canvas-generate')?.getAttribute('aria-busy') === 'false', '提示词取消应恢复');
  assert(generate().disabled, '取消提示词不能直接生图');
  document.documentElement.dataset.generationActionsRegression = 'passed';
  find('#preview-notice').textContent = '主操作行为回归：PASS · 双动作 / 无结果 / 放大焦点 / 比例 / 编辑 / 提交取消 / 版本隔离 / 按需提示词';
} catch (error) {
  document.documentElement.dataset.generationActionsRegression = 'failed';
  find('#preview-notice').textContent = `主操作行为回归：FAIL · ${error.message}`;
  console.error(error);
}
