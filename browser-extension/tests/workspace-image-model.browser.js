// Given synthetic settings/catalog/health, exercise production UI without a gateway or real model.
const scenario = new URLSearchParams(location.search).get('workspaceImageModelRegression');
const find = selector => document.querySelector(selector);
const assert = (value, message) => { if (!value) throw new Error(message); };
const wait = async (predicate, message) => {
  const deadline = Date.now() + 12000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const settled = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
const fill = (node, value) => {
  assert(node, '控件应存在');
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value').set.call(node, value);
  node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
const button = (text, root = document) => [...root.querySelectorAll('button')].find(node => node.textContent.trim() === text);
const records = [], gates = [];
const send = chrome.runtime.sendMessage;
let directoryFailed = false, saveFailed = false;
chrome.runtime.sendMessage = async message => {
  const record = { message: structuredClone(message) }; records.push(record);
  const gate = gates.find(item => !item.claimed && item.matches(message));
  if (gate) { gate.claimed = true; gate.record = record; }
  let response;
  if (scenario === 'directory-failure' && message.type === 'alchemy:image-models' && !directoryFailed) {
    response = { error: '示例：模型目录暂时不可用' };
  } else if (scenario === 'save-failure' && message.type === 'alchemy:image-settings-save' && !saveFailed) {
    saveFailed = true; response = { error: '示例：生图模型保存失败' };
  } else response = await send(message);
  if (gate?.response) response = gate.response;
  record.response = structuredClone(response);
  if (gate) await gate.promise;
  record.delivered = true; return response;
};
const hold = (matches, response) => {
  let release; const promise = new Promise(resolve => { release = resolve; });
  const gate = { matches, response, promise, release }; gates.push(gate); return gate;
};
const fields = () => find('.canvas-generation-actions .generation-ratio');
const model = () => find('.canvas-generation-actions [aria-label="生图模型"]');
const modelField = () => find('.canvas-generation-actions .generation-model-field');
const generate = () => find('.canvas-generation-actions .generate-button');
const submissions = () => records.filter(({ message }) => message.type === 'alchemy:generate' || message.type === 'alchemy:batch-start' || message.type === 'alchemy:start' && message.generation);
const saves = () => records.filter(({ message }) => message.type === 'alchemy:image-settings-save');
const gpt = 'fixture/gpt-image-2', gemini = 'fixture/gemini-3-pro-image';
const oldDirectory = scenario === 'stale-directory' ? hold(message => message.type === 'alchemy:image-models', { ok: true, value: { version: 'old', models: [{ id: gpt, name: '旧 GPT 目录', inputImages: true }] } }) : undefined;
const profile = next => next === gemini ? 'gemini' : 'gpt';
const readyModel = async next => {
  await wait(() => model()?.value === next && !model().disabled && fields().dataset.sizeProfile === profile(next), '保存后模型与尺寸规则应一致');
};
const openSettings = async () => {
  find('[aria-label="设置中心"]').click();
  await wait(() => find('.settings-center-nav'), '设置中心应打开'); button('生图渠道', find('.settings-center-nav')).click();
  await wait(() => find('.image-generation-settings [aria-label="生图模型"]') && !find('.image-generation-settings [aria-label="生图模型"]').disabled, '设置中心目录应加载');
};
const closeSettings = async () => {
  find('[aria-label="关闭设置"]').click(); await wait(() => !find('.image-generation-settings'), '设置中心应关闭');
};
const assertSaved = next => {
  const saved = saves().at(-1)?.message.settings;
  assert(saved?.provider === 'magpie' && saved.model === next && saved.baseUrl === 'http://127.0.0.1:3425', '选择必须保存全局 Magpie 模型与原网关地址');
};
const switchModel = async next => { fill(model(), next); await readyModel(next); assertSaved(next); };
const noGeneration = () => assert(!submissions().length, '模型切换、失败和重试均不得触发生图');
const run = async () => {
  // Given a ready Magpie workspace, Then its native model selector follows target size and submission-preview copy is absent.
  await wait(() => fields() && generate() && (scenario === 'empty' || !generate().disabled), '工作台应完成初始化');
  await wait(() => model(), '目标尺寸旁应提供目录驱动的生图模型选择器');
  assert(model().tagName === 'SELECT', '生图模型应使用原生 select');
  assert(fields().querySelector('select').compareDocumentPosition(model()) & Node.DOCUMENT_POSITION_FOLLOWING, '生图模型应在目标尺寸之后');
  assert(!document.body.textContent.includes('提交预览') && !fields().querySelector('.ratio-hint'), '所有提交预览文案应移除');
  if (scenario === 'directory-failure') {
    // When catalog loading fails, Then the effective model remains visible and retry restores its options without saving.
    await wait(() => modelField()?.querySelector('[role="alert"]')?.textContent.includes('示例：模型目录暂时不可用'), '目录失败应显示错误');
    assert(model().value === gpt && fields().dataset.sizeProfile === 'gpt', '目录失败必须保留原有效模型');
    directoryFailed = true;
    button('重试模型', modelField()).click(); await readyModel(gpt);
    assert([...model().options].some(option => option.value === gemini), '目录重试应恢复 Gemini 选项');
    assert(!saves().length, '目录重试不得修改已保存设置'); noGeneration(); return;
  }
  if (scenario === 'stale-directory') {
    // Given an old held catalog, When settings save a new model and load a newer catalog, Then releasing the old catalog cannot replace it.
    await wait(() => oldDirectory.record?.response, '旧目录请求应处于在途');
    await openSettings(); fill(find('.image-generation-settings [aria-label="生图模型"]'), gemini); await settled();
    find('.image-generation-settings .primary').click();
    await wait(() => fields().dataset.sizeProfile === 'gemini', '设置中心保存应刷新工作台模型');
    await closeSettings(); await readyModel(gemini);
    oldDirectory.release(); await wait(() => oldDirectory.record.delivered, '旧目录应已送达'); await settled();
    assert(model().value === gemini && [...model().options].some(option => option.value === gemini) && fields().dataset.sizeProfile === 'gemini', '旧目录不得移除当前模型或回滚尺寸规则');
    noGeneration(); return;
  }
  await readyModel(gpt);
  if (scenario === 'save-failure') {
    // When saving another model fails, Then the confirmed selection/profile stay intact and the same choice can be retried.
    fill(model(), gemini);
    await wait(() => modelField()?.querySelector('[role="alert"]')?.textContent.includes('示例：生图模型保存失败'), '保存失败应显示错误');
    assert(model().value === gpt && fields().dataset.sizeProfile === 'gpt', '保存失败不能更改当前有效选择');
    button('重试模型', modelField()).click(); await readyModel(gpt);
    assert((await send({ type: 'alchemy:image-settings' })).value.configs.magpie.model === gpt, '失败不能改写有效设置');
    await switchModel(gemini);
    assert(saves().length === 2, '失败后应只新增一次明确保存重试'); noGeneration(); return;
  }
  if (scenario === 'stale-health') {
    // Given a held old health response, When the model saves successfully, Then the late old health cannot roll back the confirmed selection.
    const old = hold(message => message.type === 'alchemy:query' && message.path === '/health');
    document.dispatchEvent(new Event('visibilitychange'));
    await wait(() => old.record?.response, '旧健康快照应在途');
    assert(old.record.response.value.generationModel === gpt, '旧快照应包含 GPT');
    await switchModel(gemini);
    old.release(); await wait(() => old.record.delivered, '旧健康响应应送达'); await settled();
    assert(model().value === gemini && fields().dataset.sizeProfile === 'gemini', '旧健康响应不能回滚当前模型与尺寸');
    noGeneration(); return;
  }
  if (scenario === 'snapshot') {
    // Given an accepted GPT generation, When global settings switch to Gemini, Then its saved model and dimensions remain unchanged.
    fill(fields().querySelector('select'), '1536:1024'); await settled(); generate().click();
    await wait(() => submissions().at(-1)?.response?.ok, '合成生图应受理');
    const accepted = submissions().at(-1).response.value.generations.at(-1), snapshot = structuredClone(accepted);
    assert(snapshot.model === gpt && snapshot.imageSize.width === 1536 && snapshot.submittedImageSize.width === 1536, '受理记录应冻结 GPT 与请求/提交尺寸');
    await switchModel(gemini);
    const saved = (await send({ type: 'alchemy:query', path: '/jobs' })).value.flatMap(job => job.generations || []).find(item => item.id === snapshot.id);
    assert(JSON.stringify(saved) === JSON.stringify(snapshot), '全局模型切换不能串改在途任务快照');
    assert(submissions().length === 1, '切换模型不能产生第二条生图'); return;
  }
  // When selecting Gemini and GPT in place, Then saved settings and size profiles follow without generating.
  fill(fields().querySelector('select'), 'custom'); await settled();
  fill(fields().querySelector('[aria-label="像素宽"]'), '1001.5');
  fill(fields().querySelector('[aria-label="像素高"]'), '10000'); await settled();
  for (const next of [gemini, gpt]) {
    await switchModel(next);
    assert(fields().querySelector('[aria-label="像素宽"]').value === '1001.5' && fields().querySelector('[aria-label="像素高"]').value === '10000', '模型保存后必须保留自定义尺寸文本');
    for (const input of fields().querySelectorAll('[aria-describedby]')) {
      assert(input.getAttribute('aria-describedby').split(/\s+/).every(id => document.getElementById(id)), '删除提交预览后不得留下悬空描述');
    }
    await openSettings();
    assert(find('.image-generation-settings [aria-label="生图模型"]').value === next, '设置中心应同步工作台已保存模型');
    await closeSettings();
  }
  await settled(); assert(saves().length === 2, '两次模型选择只保存两次'); noGeneration();
  if (scenario === 'narrow') {
    // Then the two neighboring native controls remain usable within the narrow viewport, whether inline or wrapped.
    model().scrollIntoView({ block: 'center' }); await settled();
    for (const control of [fields().querySelector('select'), model(), ...fields().querySelectorAll('input')]) {
      const rect = control.getBoundingClientRect();
      assert(rect.width >= 60 && rect.left >= 0 && rect.right <= innerWidth + 1, '窄屏目标尺寸与生图模型控件不得横向溢出或压扁');
    }
    assert(document.documentElement.scrollWidth <= innerWidth + 1, '窄屏工作台不得出现横向溢出');
  }
};
try {
  await run(); document.documentElement.dataset.workspaceImageModelRegression = 'passed';
  find('#preview-notice').textContent = '工作台生图模型回归：PASS';
} catch (error) {
  document.documentElement.dataset.workspaceImageModelRegression = 'failed';
  find('#preview-notice').textContent = `工作台生图模型回归：FAIL · ${error.message}`; console.error(error);
}
