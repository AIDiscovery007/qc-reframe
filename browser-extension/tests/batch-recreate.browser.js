// Built React UI and synthetic messages; no real project data or model calls.
const find = selector => document.querySelector(selector);
const button = (text, root = document) => [...(root?.querySelectorAll('button') || [])].find(item => item.textContent.trim() === text && item.checkVisibility());
const assert = (value, message) => { if (!value) throw new Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 10000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error(message); await delay(25); }
};
const scenario = new URLSearchParams(location.search).get('batchRecreateRegression');
const starts = [], previews = [], cancellations = [];
let healthHidden = [];
const send = chrome.runtime.sendMessage;
chrome.runtime.sendMessage = async message => {
  if (message.type === 'alchemy:batch-start') starts.push(structuredClone(message));
  if (message.type === 'alchemy:batch-preview') previews.push(structuredClone(message));
  if (message.type === 'alchemy:batch-cancel') cancellations.push(structuredClone(message));
  const response = await send(message);
  if (message.type === 'alchemy:query' && message.path === '/health') healthHidden = response.value?.hiddenProjectIds || [];
  return response;
};
const hideProject = async project => {
  await send({ type: 'alchemy:set-project-hidden', ids: [project.id], hidden: true });
  // Resume the production visibility poll, as when returning from another window.
  document.dispatchEvent(new Event('visibilitychange'));
  await waitFor(() => healthHidden.includes(project.id), 'App 健康轮询应收到已隐藏项目');
  await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
};
const select = (label, root) => [...root.querySelectorAll('label')].find(item => item.querySelector('span')?.textContent === label)?.querySelector('select');
const setValue = (element, value) => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, value);
  element.dispatchEvent(new Event('change', { bubbles: true }));
};
const run = async () => {
  await waitFor(() => find('[aria-label="全部项目"]') && !find('[aria-label="全部项目"]').disabled, '项目导航应就绪');
  find('[aria-label="全部项目"]').click();
  await waitFor(() => button('批量管理'), '项目库应提供批量管理');
  button('批量管理').click();
  await waitFor(() => find('.history-toolbar input[type="checkbox"]'), '应显示选择本页');
  find('.history-toolbar input[type="checkbox"]').click();
  await waitFor(() => button('批量完整复刻'), '已选项目应提供批量完整复刻入口');
  button('批量完整复刻').click();
  await waitFor(() => find('dialog:open'), '批量完整复刻应打开原生对话框');
  const dialog = find('dialog:open');
  if (scenario === 'preflight-hidden') {
    await waitFor(() => previews.length === 1, '预检请求应已发出');
    const projects = (await send({ type: 'alchemy:projects', limit: 24 })).value.items;
    await hideProject(projects[0]);
    await delay(1700);
    assert(!dialog.textContent.includes(projects[0].title), '迟到预检不得恢复已隐藏项目标题');
    assert(button('启动 2 个项目', dialog), '预检在途隐藏项不得计入新提交');
    await hideProject(projects[1]);
    assert(!dialog.textContent.includes(projects[1].title), '已完成预检也须即时移除隐藏标题');
    assert(button('启动 1 个项目', dialog), '完成预检后隐藏项不得计入新提交');
    await hideProject(projects[2]); await hideProject(projects[3]);
    assert(projects.every(project => !dialog.textContent.includes(project.title)), '全部隐藏后不得显示原项目标题');
    assert(button('启动 0 个项目', dialog)?.disabled, '全部隐藏后不得新提交任何项目');
    button('启动 0 个项目', dialog).click();
    assert(starts.length === 0, '零个可见项目不能发出新提交');
    button('取消', dialog).click();
    await waitFor(() => !find('dialog:open'), '应可关闭零项目预检');
    [...document.querySelectorAll('[aria-label="包含隐藏项目"]')].find(item => item.checkVisibility()).click();
    await waitFor(() => document.querySelectorAll('[aria-label^="选择项目："]').length === 4, '包含开关应恢复四个隐藏项目');
    const all = find('.history-toolbar input[type="checkbox"]');
    if (!all.checked) all.click();
    button('批量完整复刻').click();
    await waitFor(() => button('启动 3 个项目', find('dialog:open')), '包含隐藏项目时应允许重新预检');
    const reopened = find('dialog:open');
    assert(projects.every(project => reopened.textContent.includes(project.title)), '包含开关开启应展示隐藏项目标题');
    button('启动 3 个项目', reopened).click();
    await waitFor(() => starts.length === 1, '包含开关开启可提交合格隐藏项目');
    assert(starts[0].projects.length === 3 && projects.slice(0, 3).every(project => starts[0].projects.some(item => item.projectId === project.id)), '显式包含时新提交应保留三项合格隐藏项目');
    return;
  }
  if (scenario === 'late') {
    await waitFor(() => previews.length === 1, '预检请求应已发出');
    dialog.dispatchEvent(new Event('cancel', { cancelable: true, bubbles: true }));
    await waitFor(() => !find('dialog:open'), '关闭应立即隐藏预检');
    const selected = [...document.querySelectorAll('[aria-label^="选择项目："]')];
    selected[0].click();
    await delay(1800);
    assert(!find('dialog:open') && !selected[0].checked && selected[1].checked, '迟到预检不能重开弹窗或覆盖新选择');
    assert(starts.length === 0, '关闭预检不得启动任务');
    return;
  }
  assert(!dialog.querySelector('input[type="file"], [aria-label="逆向模式"]'), '完整复刻不应提供模式或主体上传');
  await waitFor(() => button('启动 3 个项目', dialog), '预检应显示三个合格项目和一个失败项目');
  assert(dialog.textContent.includes('参考图缺失'), '预检应明确缺失参考图的原因');
  assert(previews.length === 1 && previews[0].projects.length === 4 && previews[0].projects.every(item => Number.isInteger(item.inputRevision)), '预检必须包含本页四个项目的版本');
  setValue(select('提示词语言', dialog), 'en');
  setValue(select('图片比例', dialog), '3:2');
  await delay(50);
  const start = button('启动 3 个项目', dialog);
  start.click(); start.click();
  await waitFor(() => starts.length === 1, '重复点击只能提交一次');
  assert(starts[0].language === 'en' && starts[0].aspectRatio.width === 3 && starts[0].aspectRatio.height === 2, '批次必须传递所选语言和比例');
  assert(starts[0].projects.length === 3 && !('mode' in starts[0]) && !('subjectImage' in starts[0]), '只提交合格完整复刻项目');
  if (scenario === 'retry' || scenario === 'retry-hidden') {
    await waitFor(() => dialog.textContent.includes('响应丢失') && button('重试提交', dialog) && !button('重试提交', dialog).disabled, '响应丢失应保留重试入口');
    assert(select('提示词语言', dialog).disabled && select('图片比例', dialog).disabled, '未知结果重试必须锁定原选项');
    if (scenario === 'retry-hidden') {
      const project = (await send({ type: 'alchemy:projects', limit: 24 })).value.items.find(item => item.id === starts[0].projects[0].projectId);
      await hideProject(project);
      assert(!dialog.textContent.includes(project.title), '未知提交结果后隐藏项目不得继续显示标题');
    }
    button('重试提交', dialog).click();
    await waitFor(() => starts.length === 2, '应重新发送原请求');
    assert(JSON.stringify(starts[0]) === JSON.stringify(starts[1]), '未知受理结果重试必须使用同键同体');
    if (scenario === 'retry-hidden') return;
  }
  await waitFor(() => button('查看任务'), '受理后应提供查看任务');
  assert(find('[aria-label="搜索项目"]') && !find('.canvas-workspace'), '提交后应留在项目库');
  const checked = [...document.querySelectorAll('[aria-label^="选择项目："]')].filter(item => item.checked);
  assert(checked.length === 2, '只清除两个受理项目，预检失败与提交拒绝项保留选择');
  button('查看任务').click();
  await waitFor(() => button('停止剩余'), '任务中心应显示批次和停止剩余');
  await waitFor(() => !document.body.textContent.includes('正在读取任务…'), '任务中心应完成批次与单项读取');
  if (scenario === 'history') {
    assert(document.querySelectorAll('.task-list > ul .task-item[data-status="running"]').length === 1, '批次完成后手动生图仍应显示在单项任务区');
    assert(document.querySelectorAll('.batch-tasks .task-item[data-status="completed"]').length === 1, '自动生图完成应显示在批次中');
    const batch = (await send({ type: 'alchemy:batches' })).value[0];
    assert([...document.querySelectorAll('.task-list > ul button[title]')].filter(item => item.title === '打开逆向版本 ' + batch.items[0].jobId).length === 1, '同job只展示后续手动生图，不重复逆向或自动生图');
    return;
  }
  if (scenario === 'hidden') {
    const batch = (await send({ type: 'alchemy:batches' })).value[0], hidden = batch.items[0];
    await send({ type: 'alchemy:set-project-hidden', ids: [hidden.projectId], hidden: true });
    const visible = () => [...document.querySelectorAll('.batch-tasks strong')].some(item => item.textContent === hidden.title);
    await waitFor(() => !visible(), '隐藏项目应从批次列表收起');
    button('停止剩余').click();
    await waitFor(() => cancellations.length === 1 && !button('停止剩余'), '停止排队回包应完成');
    assert(!visible(), '取消完整批次回包不得重新显示隐藏项目');
    find('.task-center [aria-label="包含隐藏项目"]').click();
    await waitFor(visible, '包含隐藏项目应恢复批次项目');
    return;
  }
  assert(document.querySelectorAll('.task-item[data-status="running"]').length === 1, '批次运行项不能在单项任务区重复出现');
  assert(document.body.textContent.includes('排队') && document.body.textContent.includes('正在逆向'), '批次应显示排队和运行阶段');
  button('停止剩余').click();
  await waitFor(() => cancellations.length === 1, '停止剩余应提交批次取消');
  assert(!cancellations[0].projectId, '停止剩余不能取消运行项');
  const batch = (await send({ type: 'alchemy:batches' })).value[0];
  assert(batch.items[0].status === 'running' && batch.items[1].status === 'cancelled', '停止剩余保留运行项');
  await waitFor(() => button('取消'), '运行中单项应保留取消入口');
  button('取消').click();
  await waitFor(() => cancellations.length === 2, '应提交单项取消');
  assert(cancellations[1].projectId === batch.items[0].projectId, '单项取消必须绑定准确项目');
  if (scenario === 'narrow') assert(document.documentElement.scrollWidth <= innerWidth, '窄屏不得产生横向溢出');
};
try {
  if (!['keyboard', 'all-accepted'].includes(scenario)) {
    await run();
    document.documentElement.dataset.batchRecreateRegression = 'passed';
    find('#preview-notice').textContent = `批量复刻回归：PASS · ${scenario} · 合成消息 / 真实控件`;
  }
} catch (error) {
  document.documentElement.dataset.batchRecreateRegression = 'failed';
  find('#preview-notice').textContent = `批量复刻回归：FAIL · ${scenario} · ${error.message}`;
  console.error(error);
}
