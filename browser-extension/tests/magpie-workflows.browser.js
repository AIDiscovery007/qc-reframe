// Production UI with synthetic messages only; no gateway, credentials, real image generation or project writes.
const scenario = new URLSearchParams(location.search).get('magpieWorkflowsRegression');
const find = selector => document.querySelector(selector);
const button = (text, root = document) => [...root.querySelectorAll('button')].find(node => node.textContent.trim() === text && node.checkVisibility());
const assert = (value, message) => { if (!value) throw new Error(message); };
const wait = async (predicate, message) => {
  const deadline = Date.now() + 12000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
const setValue = (element, value) => {
  assert(element, '预期控件应存在');
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, value);
  element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
const settled = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
const messages = [];
const send = chrome.runtime.sendMessage;
chrome.runtime.sendMessage = async message => { messages.push(structuredClone(message)); return send(message); };
const generates = () => messages.filter(message => message.type === 'alchemy:generate');
const saveRequests = () => messages.filter(message => message.type === 'alchemy:save-generation');
const generate = () => find('.canvas-generation-actions .generate-button, .quick-result .primary');
const sizes = () => find('.canvas-generation-actions .generation-ratio select');
const run = async () => {
  if (scenario === 'batch') {
    await wait(async () => (await send({ type: 'alchemy:query', path: '/health' })).value.generationProvider === 'magpie', '批量入口应使用 Magpie 渠道');
    await wait(() => find('[aria-label="全部项目"]') && !find('[aria-label="全部项目"]').disabled, '项目库应可打开');
    find('[aria-label="全部项目"]').click();
    await wait(() => button('批量管理'), '应提供批量管理'); button('批量管理').click();
    await wait(() => find('.history-toolbar input[type="checkbox"]'), '应显示全选'); find('.history-toolbar input[type="checkbox"]').click();
    await wait(() => button('批量完整复刻') && !button('批量完整复刻').disabled, 'Magpie 批量入口应可用'); button('批量完整复刻').click();
    await wait(() => button('启动 3 个项目'), '预检应保留合格项目');
    const dialog = find('dialog:open');
    setValue(dialog.querySelector('.generation-ratio select'), '1536:1024');
    await settled();
    button('启动 3 个项目', dialog).click();
    await wait(() => messages.some(message => message.type === 'alchemy:batch-start'), '批量应提交');
    const body = messages.find(message => message.type === 'alchemy:batch-start');
    assert(body.imageSize.width === 1536 && body.imageSize.height === 1024 && !body.aspectRatio && !('pixelSize' in body), '批量仅发送像素快照，不发送比例或本地展示字段');
    return;
  }
  await wait(() => find('[aria-label="逆向模式"]') && document.body.textContent.includes('附图支持取决于'), '应读取 Magpie 渠道状态');
  await wait(() => generate() && !generate().disabled, 'Magpie 当前任务应可操作');
  if (scenario.startsWith('save-')) {
    assert(generate().textContent.trim() === '重试保存', '保存失败必须提供保存重试，不能默认重新付费生图');
    if (scenario === 'save-asset') assert(!find('.generation-result-image') && !messages.some(message => message.type === 'alchemy:generation-image'), '待保存记录不能提前读取或展示为完成图片');
    generate().click();
    await wait(() => document.body.textContent.includes('示例：保存失败，仍可重试保存') && !generate().disabled, '保存失败应保留错误并允许重试');
    assert(saveRequests().length === 1 && !generates().length, '保存失败不能触发生成');
    generate().click();
    await wait(() => generate()?.textContent.includes('再生成图片'), '保存完成后恢复正常生成入口');
    assert(saveRequests().length === 2 && saveRequests()[0].generationId === saveRequests()[1].generationId && !generates().length, '两次重试必须保存同一结果且零生图请求');
    return;
  }
  if (scenario === 'quick') {
    generate().click();
    await wait(() => generates().length === 1, '快捷入口应提交生图');
    assert(generates()[0].imageSize?.width === 1536 && generates()[0].imageSize.height === 1024 && !generates()[0].aspectRatio, '快捷入口应继承像素快照');
    return;
  }
  await wait(() => sizes(), '尺寸控件应可用');
  if (scenario === 'history') {
    assert(sizes().value === 'auto', '旧 3:2 比例历史进入 Magpie 不得转为 3×2 像素');
    generate().click(); await wait(() => generates().length === 1, '历史任务应可以再次生图');
    assert(!generates()[0].imageSize && !generates()[0].aspectRatio, '自动尺寸不传历史比例或像素');
    return;
  }
  if (scenario.startsWith('custom')) {
    setValue(sizes(), 'custom');
    await wait(() => find('[aria-label="像素宽"]'), '自定义像素输入应出现');
    setValue(find('[aria-label="像素宽"]'), '10000'); setValue(find('[aria-label="像素高"]'), '10000');
    await wait(() => generate().disabled, '超过像素预算应阻止提交');
    assert(!generates().length, '非法尺寸不能发出请求');
    assert([...document.querySelectorAll('.custom-ratio input')].every(input => input.getBoundingClientRect().width >= 60), '窄屏输入框必须完整容纳五位数像素与原生步进按钮');
    find('[aria-label="像素高"]').focus(); find('[aria-label="像素高"]').blur();
    await wait(() => find('[aria-label="像素高"]').getAttribute('aria-invalid') === 'true' && find('.ratio-error'), '交互后应展示尺寸校验错误');
    if (scenario === 'custom-invalid') { find('.generation-ratio').scrollIntoView({ block: 'center' }); await settled(); return; }
    setValue(find('[aria-label="像素宽"]'), '1536'); setValue(find('[aria-label="像素高"]'), '1024');
    await wait(() => !generate().disabled, '修正像素后应恢复提交');
  } else setValue(sizes(), '1536:1024');
  await settled();
  if (scenario === 'continuous') {
    await wait(() => button('逆向并生图') && !button('逆向并生图').disabled, 'Magpie 连续入口应可用');
    button('逆向并生图').click();
    await wait(() => messages.some(message => message.type === 'alchemy:start'), '连续生成应提交');
    const body = messages.find(message => message.type === 'alchemy:start');
    assert(body.generation.imageSize?.width === 1536 && body.generation.imageSize.height === 1024 && !body.generation.aspectRatio, '连续任务应冻结像素尺寸');
    assert(body.reenact?.subjectImage, '附图路径保留主体');
    await wait(async () => (await send({ type: 'alchemy:query', path: '/jobs' })).value.some(job => job.autoGeneration?.status === 'started' && job.generations?.some(item => item.imageSize?.width === 1536)), '自动阶段应使用提交时像素');
    return;
  }
  const recordsBefore = document.querySelectorAll('.result-thumb').length;
  generate().click();
  await wait(() => generates().length === 1, '应提交 Magpie 附图生图');
  assert(generates()[0].subjectImage && generates()[0].imageSize.width === 1536 && generates()[0].imageSize.height === 1024 && !generates()[0].aspectRatio, '附图和像素尺寸应同时提交');
  await wait(() => document.querySelectorAll('.result-thumb').length === recordsBefore + 1 && find('.generated-pane')?.dataset.pending === 'false' && !generate().disabled, '新增图片记录完成后应可查看生成信息');
  await wait(() => find('[aria-label="生成信息"]') && !find('[aria-label="生成信息"]').disabled, '应可查看生成记录');
  find('[aria-label="生成信息"]').click();
  await wait(() => find('dialog:open')?.textContent.includes('请求尺寸：1536 × 1024 px'), '历史应展示请求像素');
  assert(find('dialog:open').textContent.includes('实际图片：320 × 400 px'), '实际返回尺寸必须单独展示');
  if (scenario === 'custom') { find('[aria-label="关闭窗口"]').click(); await wait(() => !find('dialog:open'), '应关闭信息并展示自定义尺寸'); find('.generation-ratio').scrollIntoView({ block: 'center' }); await settled(); }
};
try {
  await run();
  document.documentElement.dataset.magpieWorkflowsRegression = 'passed';
  find('#preview-notice').textContent = 'Magpie 工作流回归：PASS';
} catch (error) {
  document.documentElement.dataset.magpieWorkflowsRegression = 'failed';
  find('#preview-notice').textContent = `Magpie 工作流回归：FAIL · ${error.message}`;
  console.error(error);
}
