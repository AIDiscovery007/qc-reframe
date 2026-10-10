// Given synthetic settings/health only, exercise production UI and public messages; never call a real model.
const scenario = new URLSearchParams(location.search).get('imageSettingsSyncRegression');
const find = selector => document.querySelector(selector);
const button = (text, root = document) => [...root.querySelectorAll('button')].find(node => node.textContent.trim() === text);
const assert = (value, message) => { if (!value) throw new Error(message); };
const wait = async (predicate, message, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const settled = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
const fill = (node, value) => {
  assert(node, '控件应存在');
  Object.getOwnPropertyDescriptor(node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(node, value);
  node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
};
const records = [], gates = [];
const send = chrome.runtime.sendMessage;
chrome.runtime.sendMessage = async message => {
  const record = { message: structuredClone(message) }; records.push(record);
  const gate = gates.find(item => !item.claimed && item.matches(message));
  if (gate) { gate.claimed = true; gate.record = record; }
  if (gate?.before) await gate.promise;
  const response = await send(message);
  record.response = structuredClone(response);
  if (gate && !gate.before) await gate.promise;
  record.delivered = true;
  return response;
};
const hold = (matches, before = false) => {
  let release; const promise = new Promise(resolve => { release = resolve; });
  const gate = { matches, before, promise, release }; gates.push(gate); return gate;
};
const health = message => message.type === 'alchemy:query' && message.path === '/health';
const submitted = () => records.filter(({ message }) => message.type === 'alchemy:generate' || message.type === 'alchemy:batch-start' || message.type === 'alchemy:start' && message.generation);
const section = () => find('.image-generation-settings');
const generate = () => find('.canvas-generation-actions .generate-button');
const sizes = () => find('.canvas-generation-actions .generation-ratio select');
const isBatch = scenario.endsWith('-batch');
const target = scenario.startsWith('magpie-to-') ? 'codex' : 'magpie';
const option = provider => provider === 'magpie' ? '1536:1024' : '3:2';
const assertSize = (body, provider) => {
  assert(provider === 'magpie' ? body.imageSize?.width === 1536 && body.imageSize.height === 1024 && !body.aspectRatio
    : body.aspectRatio?.width === 3 && body.aspectRatio.height === 2 && !body.imageSize, `${provider} 提交必须使用本渠道尺寸字段`);
};
const assertProvider = provider => {
  const options = [...sizes().options].map(node => node.value);
  assert(options.includes(option(provider)) && !options.includes(option(provider === 'magpie' ? 'codex' : 'magpie')), '尺寸控件应同步已保存渠道，不能被迟到健康响应回滚');
};
const openSettings = async (waitReady = true) => {
  find('[aria-label="设置中心"]').click();
  await wait(() => find('.settings-center-nav'), '设置应打开');
  button('生图渠道', find('.settings-center-nav')).click();
  await wait(() => section()?.querySelector('select') && (!waitReady || !section().querySelector('select').disabled), '设置应读出当前渠道');
};
const choose = async provider => {
  fill(section().querySelector('select'), provider);
  if (provider === 'magpie') {
    await wait(() => section().querySelector('[aria-label="生图模型"]') && !section().querySelector('[aria-label="生图模型"]').disabled, 'Magpie 模型目录应加载');
    fill(section().querySelector('[aria-label="生图模型"]'), 'fixture/image');
  }
  await wait(() => !section().querySelector('.primary').disabled, '渠道应允许保存');
};
const closeSettings = async () => { find('[aria-label="关闭设置"]').click(); await wait(() => !section(), '设置应关闭'); };
const assertBlocked = async () => {
  await settled();
  const before = submitted().length;
  if (isBatch) {
    const entry = button('批量完整复刻'); assert(entry?.disabled, '保存或刷新期间批量入口必须禁用'); entry.click();
  } else {
    assert(generate()?.disabled, '保存或刷新期间手动生图必须禁用'); generate().click();
    const chain = button('逆向并生图'); assert(chain?.disabled, '保存或刷新期间连续生图必须禁用'); chain.click();
  }
  await settled(); assert(submitted().length === before, '不可用期间点击不得发出付费提交');
};
const save = async (provider, inspectPending = true) => {
  await choose(provider);
  const pending = hold(message => message.type === 'alchemy:image-settings-save', true);
  section().querySelector('.primary').click();
  await wait(() => pending.claimed, '保存请求应发出');
  if (inspectPending) await assertBlocked();
  const refresh = hold(health);
  pending.release();
  await wait(() => refresh.record?.response, '保存后应立即刷新健康状态，不等定时轮询', 3000);
  if (inspectPending) await assertBlocked();
  refresh.release();
  await wait(() => section()?.textContent.includes(`当前使用：${provider === 'magpie' ? 'Magpie' : 'Codex'}`) && !section().querySelector('.primary').disabled, '应完成设置与健康状态同步');
  await settled();
};
const submit = async provider => {
  if (isBatch) {
    await wait(() => button('批量完整复刻') && !button('批量完整复刻').disabled, '新渠道应立即开放批量入口');
    button('批量完整复刻').click();
    // Given the projects fixture contains exactly two projects, Then preflight must preserve both eligible inputs.
    await wait(() => button('启动 2 个项目', find('dialog:open') || document), '两个项目的预检应完成');
    const preview = records.filter(record => record.message.type === 'alchemy:batch-preview').at(-1);
    assert(preview.message.projects.length === 2 && preview.response.value.items.length === 2 && preview.response.value.items.every(item => item.eligible), '预检必须提交并返回夹具中的两个合格项目');
    const dialog = find('dialog:open'); fill(dialog.querySelector('.generation-ratio select'), option(provider)); await settled();
    button('启动 2 个项目', dialog).click();
  } else {
    assertProvider(provider); fill(sizes(), option(provider)); await settled();
    const action = scenario.endsWith('-continuous') ? button('逆向并生图') : generate();
    assert(action && !action.disabled, '新渠道就绪后应立即可提交'); action.click();
  }
  await wait(() => submitted().at(-1)?.response?.ok, '提交应返回合成任务');
  const record = submitted().at(-1), body = record.message.generation || record.message;
  assertSize(body, provider);
  if (isBatch) assert(body.projects.length === 2 && body.projects.map(item => item.projectId).sort().join() === records.filter(record => record.message.type === 'alchemy:batch-preview').at(-1).message.projects.map(item => item.projectId).sort().join(), '批量提交必须保留预检的两个项目');
  const value = record.response.value;
  const snapshot = record.message.type === 'alchemy:start' ? value.job.autoGeneration : record.message.type === 'alchemy:generate' ? value.generations.at(-1) : value;
  assert(snapshot.provider === provider, '已受理任务应记录当时渠道快照'); assertSize(snapshot, provider);
  return structuredClone(snapshot);
};
const run = async () => {
  await wait(() => sizes() && generate() && !generate().disabled && !find('[aria-label="逆向模式"]').disabled, '工作台初始化完成');
  assertProvider(target === 'magpie' ? 'codex' : 'magpie');
  if (isBatch) {
    find('[aria-label="全部项目"]').click(); await wait(() => button('批量管理'), '项目库应就绪'); button('批量管理').click();
    await wait(() => find('.history-toolbar input[type="checkbox"]'), '项目选择应可用'); find('.history-toolbar input[type="checkbox"]').click();
    await wait(() => button('批量完整复刻') && !button('批量完整复刻').disabled, '原渠道批量入口应可用');
  }
  if (scenario === 'snapshot') {
    // Given an accepted Codex request, When settings change during generation, Then its snapshot remains Codex/ratio.
    const original = await submit('codex');
    await openSettings(); await save('magpie', false); await closeSettings();
    const jobs = (await send({ type: 'alchemy:query', path: '/jobs' })).value;
    const preserved = jobs.flatMap(job => job.generations || []).find(item => item.id === original.id);
    assert(preserved.provider === 'codex', '渠道切换不得改写在途任务 provider'); assertSize(preserved, 'codex');
    return;
  }
  let stale;
  if (scenario === 'stale-health') {
    // Given an already sampled old health response, When a newer save completes, Then the old response cannot roll back the UI.
    stale = hold(health); document.dispatchEvent(new Event('visibilitychange'));
    await wait(() => stale.record?.response, '旧健康请求应已取样并挂起');
    assert(stale.record.response.value.generationProvider === 'codex', '旧响应确实来自原渠道');
  }
  await openSettings();
  if (scenario === 'reopen-draft') {
    // Given an unfinished Magpie save, When the user reopens settings and edits Gemini, Then later sync must preserve the entire draft.
    await choose('magpie'); const firstSave = hold(message => message.type === 'alchemy:image-settings-save', true);
    section().querySelector('.primary').click(); await wait(() => firstSave.claimed, '首个保存应在落盘前挂起');
    await closeSettings(); await openSettings(false);
    await wait(() => section().textContent.includes('当前使用：Codex') && !section().querySelector('select').disabled, '重开应读到原渠道并允许编辑新草稿');
    await choose('gemini');
    const draft = { baseUrl: 'https://gemini-draft.example/v1beta', model: 'gemini-draft-image', apiKey: 'fixture-draft-secret' };
    fill(section().querySelector('input[type="url"]'), draft.baseUrl);
    fill(section().querySelector('input:not([type])'), draft.model);
    fill(section().querySelector('input[type="password"]'), draft.apiKey);
    const assertDraft = () => {
      assert(section().querySelector('select').value === 'gemini', '旧保存完成不得覆盖新编辑的 Gemini 渠道');
      assert(section().querySelector('input[type="url"]')?.value === draft.baseUrl, '旧保存完成不得覆盖新编辑的 API 地址');
      assert(section().querySelector('input:not([type])')?.value === draft.model, '旧保存完成不得覆盖新编辑的模型 ID');
      assert(section().querySelector('input[type="password"]')?.value === draft.apiKey, '旧保存完成不得清除新编辑的 API Key');
    };
    await settled(); assertDraft();
    const firstHealth = hold(health); firstSave.release();
    await wait(() => firstHealth.record?.response?.value.generationProvider === 'magpie', '首次保存健康响应应已取样');
    firstHealth.release();
    await wait(() => section().textContent.includes('当前使用：Magpie') && firstHealth.record.delivered, '已保存渠道与健康响应应更新为 Magpie');
    await settled(); assertDraft();
    assert(submitted().length === 0, '保存与草稿同步不得触发生图提交');
    assert(records.filter(record => record.message.type === 'alchemy:image-settings-save').length === 1, '未提交的 Gemini 草稿不得自动保存');
    return;
  }
  if (scenario === 'rapid-switch') {
    // Given a save not yet written, When settings are reopened, Then its eventual saved provider must reach the new panel.
    await choose('magpie'); const firstSave = hold(message => message.type === 'alchemy:image-settings-save', true);
    section().querySelector('.primary').click(); await wait(() => firstSave.claimed, '首个保存应在落盘前挂起');
    await closeSettings(); await openSettings(false);
    await wait(() => section().textContent.includes('当前使用：Codex'), '重开应先读取尚未更改的 Codex');
    assert(section().querySelector('select').value === 'codex', '首个保存尚未落盘时不能伪装已使用 Magpie');
    const firstHealth = hold(health); firstSave.release();
    await wait(() => firstHealth.record?.response?.value.generationProvider === 'magpie', '首次保存健康响应应已取样');
    await wait(() => section().textContent.includes('当前使用：Magpie') && section().querySelector('select').value === 'magpie', '旧面板发起的保存完成后新面板必须自动显示 Magpie');
    await assertBlocked();
    // When another provider is saved before the first health response arrives, Then only the latest response applies.
    await save('codex'); await closeSettings();
    firstHealth.release(); await settled(); assertProvider('codex'); await submit('codex'); return;
  }
  await save(target); await closeSettings();
  if (stale) { stale.release(); await settled(); assert(stale.record.delivered, '旧健康响应应确实送达'); }
  await submit(target);
};
try {
  await run(); document.documentElement.dataset.imageSettingsSyncRegression = 'passed';
  find('#preview-notice').textContent = '生图渠道即时同步回归：PASS';
} catch (error) {
  document.documentElement.dataset.imageSettingsSyncRegression = 'failed';
  find('#preview-notice').textContent = `生图渠道即时同步回归：FAIL · ${error.message}`; console.error(error);
} finally { gates.forEach(gate => gate.release()); }
