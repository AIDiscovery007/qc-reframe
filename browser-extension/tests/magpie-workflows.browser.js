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
const messages = [], healthModels = [];
let healthModel;
const send = chrome.runtime.sendMessage;
chrome.runtime.sendMessage = async message => {
  messages.push(structuredClone(message));
  const response = await send(message);
  if (message.type === 'alchemy:query' && message.path === '/health') {
    if (healthModel) response.value.generationModel = healthModel;
    healthModels.push(response.value.generationModel);
  }
  return response;
};
const generates = () => messages.filter(message => message.type === 'alchemy:generate');
const saveRequests = () => messages.filter(message => message.type === 'alchemy:save-generation');
const generate = () => find('.canvas-generation-actions .generate-button, .quick-result .primary');
const sizes = () => find('.canvas-generation-actions .generation-ratio select');
const noPreview = () => assert(!document.body.textContent.includes('提交预览') && !document.querySelector('.generation-ratio .ratio-hint, .quick-size-preview'), '尺寸控件不应再展示提交预览文案');
const submittedSize = async (width, height) => {
  const request = generates().at(-1);
  let generation;
  await wait(async () => {
    const jobs = (await send({ type: 'alchemy:query', path: '/jobs' })).value;
    generation = jobs.flatMap(job => job.generations || []).find(item => item.id && item.imageSize?.width === request.imageSize?.width && item.imageSize?.height === request.imageSize?.height && item.sizeRule);
    return generation;
  }, '已受理历史应保存归一化尺寸');
  assert(width == null ? generation.submittedImageSize === null : generation.submittedImageSize?.width === width && generation.submittedImageSize?.height === height, '历史提交尺寸应使用已保存的归一化结果');
};
const run = async () => {
  if (scenario.startsWith('batch')) {
    await wait(async () => (await send({ type: 'alchemy:query', path: '/health' })).value.generationProvider === 'magpie', '批量入口应使用 Magpie 渠道');
    await wait(() => find('[aria-label="全部项目"]') && !find('[aria-label="全部项目"]').disabled, '项目库应可打开');
    find('[aria-label="全部项目"]').click();
    await wait(() => button('批量管理'), '应提供批量管理'); button('批量管理').click();
    await wait(() => find('.history-toolbar input[type="checkbox"]'), '应显示全选'); find('.history-toolbar input[type="checkbox"]').click();
    await wait(() => button('批量完整复刻') && !button('批量完整复刻').disabled, 'Magpie 批量入口应可用'); button('批量完整复刻').click();
    await wait(() => button('启动 3 个项目'), '预检应保留合格项目');
    const dialog = find('dialog:open');
    setValue(dialog.querySelector('.generation-ratio select'), '1536:1024');
    if (scenario === 'batch-snapshot') {
      // Given an unconfirmed accepted request, When the active model changes, Then retries retain the original raw size and model profile.
      setValue(dialog.querySelector('.generation-ratio select'), 'custom'); await settled();
      setValue(dialog.querySelector('[aria-label="像素宽"]'), '10000'); setValue(dialog.querySelector('[aria-label="像素高"]'), '10000');
    }
    await settled();
    button('启动 3 个项目', dialog).click();
    await wait(() => messages.some(message => message.type === 'alchemy:batch-start'), '批量应提交');
    const body = messages.find(message => message.type === 'alchemy:batch-start');
    if (scenario === 'batch-snapshot') {
      await wait(() => button('重试提交', dialog), '响应丢失后应保留同一批量请求');
      assert(dialog.querySelector('[aria-label="像素宽"]').value === '10000' && dialog.querySelector('[aria-label="像素高"]').value === '10000', '待确认请求应保留原始像素草稿'); noPreview();
      healthModel = 'gemini-3-pro-image'; document.dispatchEvent(new Event('visibilitychange'));
      await wait(() => healthModels.includes(healthModel), '新生图模型健康状态应送达'); await settled();
      assert(dialog.querySelector('.generation-ratio').dataset.sizeProfile === 'gpt' && dialog.querySelector('[aria-label="像素宽"]').value === '10000' && dialog.querySelector('[aria-label="像素高"]').value === '10000', '新模型不能改变待确认批次的展示快照');
      button('重试提交', dialog).click();
      await wait(() => messages.filter(message => message.type === 'alchemy:batch-start').length === 2, '应核对同一批量请求');
      const requests = messages.filter(message => message.type === 'alchemy:batch-start');
      assert(JSON.stringify(requests[0]) === JSON.stringify(requests[1]), '重试必须保留原 requestId 与尺寸快照');
      assert(body.imageSize.width === 10000 && body.imageSize.height === 10000 && !body.aspectRatio && !('generationModel' in body), '批量必须保留原始尺寸且不发送本地展示模型');
      await wait(() => !find('.batch-recreate'), '同一批次确认成功后应关闭对话框');
      return;
    }
    assert(body.imageSize.width === 1536 && body.imageSize.height === 1024 && !body.aspectRatio && !('pixelSize' in body), '批量仅发送像素快照，不发送比例或本地展示字段');
    return;
  }
  await wait(() => find('[aria-label="逆向模式"]') && document.body.textContent.includes('附图支持取决于'), '应读取 Magpie 渠道状态');
  await wait(() => generate() && !generate().disabled, 'Magpie 当前任务应可操作');
  noPreview();
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
  if (scenario === 'gemini-ratios') {
    // Given a Gemini image model, When choosing its ratio, Then exactly ten aspect labels map to gateway pixel carriers without a resolution promise.
    const labels = [...sizes().options].filter(option => !['auto', 'custom'].includes(option.value)).map(option => option.textContent);
    assert(labels.join(',') === '1:1,2:3,3:2,3:4,4:3,4:5,5:4,9:16,16:9,21:9', 'Gemini 必须展示完整十比例选项');
    assert(!labels.some(label => /1K|2K|4K/.test(label)), 'Gemini 不能承诺像素档位');
    setValue(sizes(), '1536:864'); await settled();
    assert(sizes().selectedOptions[0].textContent === '16:9', 'Gemini 应用比例标签表达选中的目标'); noPreview();
    generate().click(); await wait(() => generates().length === 1, 'Gemini 比例应可提交');
    assert(generates()[0].imageSize.width === 1536 && generates()[0].imageSize.height === 864 && !generates()[0].aspectRatio, 'Magpie Gemini 仅提交尺寸原意图');
    await submittedSize(1536, 864);
    return;
  }
  if (scenario === 'model-switch' || scenario === 'unknown-auto') {
    // Given a raw custom draft, When the model changes or is unknown, Then the draft stays intact while the available size choices safely change.
    setValue(sizes(), 'custom'); await settled();
    setValue(find('[aria-label="像素宽"]'), '1001.5'); setValue(find('[aria-label="像素高"]'), '1000'); await settled();
    if (scenario === 'model-switch') {
      assert(find('.generation-ratio').dataset.sizeProfile === 'gpt' && [...sizes().options].some(option => option.value === '1536:1024'), 'GPT 应显示自己的像素预设');
      for (const [model, profile] of [['gemini-3-pro-image', 'gemini'], ['fixture/unknown', 'unknown'], ['gpt-image-2', 'gpt']]) {
        healthModel = model; document.dispatchEvent(new Event('visibilitychange'));
        await wait(() => find('.generation-ratio').dataset.sizeProfile === profile, '尺寸规则应跟随可信的新模型');
        assert(find('[aria-label="像素宽"]').value === '1001.5' && find('[aria-label="像素高"]').value === '1000', '模型变化不能重挂并丢失原始草稿');
        assert(profile === 'unknown' ? sizes().options.length === 2 : [...sizes().options].some(option => option.value === (profile === 'gemini' ? '1536:864' : '1536:1024')), '当前模型应提供自己的尺寸选项'); noPreview();
      }
    } else {
      assert([...sizes().options].map(option => option.value).join(',') === 'auto,custom', '未知模型不冒充 GPT/Gemini 预设');
      assert(sizes().options[0].value === 'auto', '未知模型应提供网关自动尺寸选项'); noPreview();
    }
    assert(!generate().disabled, '模型适配或自动降级不能拦截提交');
    generate().click(); await wait(() => generates().length === 1, '原始意图应可提交');
    assert(generates()[0].imageSize.width === 1001.5 && generates()[0].imageSize.height === 1000 && !generates()[0].aspectRatio, '模型变化不能覆盖提交的用户原始意图');
    await submittedSize(scenario === 'unknown-auto' ? null : 1008, scenario === 'unknown-auto' ? null : 1008);
    return;
  }
  if (scenario.startsWith('custom')) {
    setValue(sizes(), 'custom');
    await wait(() => find('[aria-label="像素宽"]'), '自定义像素输入应出现');
    setValue(find('[aria-label="像素宽"]'), '10000'); setValue(find('[aria-label="像素高"]'), '10000');
    await wait(() => !generate().disabled, '超预算原始意图应保留提交能力');
    assert(!generates().length, '编辑尺寸本身不能发出请求');
    assert([...document.querySelectorAll('.custom-ratio input')].every(input => input.getBoundingClientRect().width >= 60), '窄屏输入框必须完整容纳五位数像素与原生步进按钮');
    find('[aria-label="像素高"]').focus(); find('[aria-label="像素高"]').blur();
    assert(find('[aria-label="像素高"]').getAttribute('aria-invalid') !== 'true' && !find('.ratio-error'), '自动修正不能显示阻断错误');
    if (scenario === 'custom-invalid') {
      for (const value of ['', '-1', '0', '1e309']) {
        setValue(find('[aria-label="像素宽"]'), value); await settled();
        assert(!generate().disabled && !find('.ratio-error'), '空、负数与非有限输入必须自动降级且不阻断'); noPreview();
      }
      generate().click(); await wait(() => generates().length === 1, '自动尺寸应允许提交');
      assert(!generates()[0].imageSize && !generates()[0].aspectRatio, '自动尺寸必须省略原始尺寸且不得发送 NaN');
      await submittedSize(null, null);
      find('.generation-ratio').scrollIntoView({ block: 'center' }); await settled(); return;
    }
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
  const expected = scenario === 'custom' ? [10000, 10000] : [1536, 1024];
  assert(generates()[0].subjectImage && generates()[0].imageSize.width === expected[0] && generates()[0].imageSize.height === expected[1] && !generates()[0].aspectRatio, '附图与用户原始像素意图应同时提交');
  await wait(() => document.querySelectorAll('.result-thumb').length === recordsBefore + 1 && find('.generated-pane')?.dataset.pending === 'false' && !generate().disabled, '新增图片记录完成后应可查看生成信息');
  await wait(() => find('[aria-label="生成信息"]') && !find('[aria-label="生成信息"]').disabled, '应可查看生成记录');
  find('[aria-label="生成信息"]').click();
  await wait(() => find('dialog:open')?.textContent.includes(`请求尺寸：${expected[0]} × ${expected[1]} px`), '历史应展示请求像素');
  assert(find('dialog:open').textContent.includes(scenario === 'custom' ? '提交尺寸：2880 × 2880 px' : '提交尺寸：1536 × 1024 px'), '历史必须展示已保存的归一化提交尺寸');
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
