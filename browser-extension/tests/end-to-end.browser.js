// Synthetic preview of the built React UI; public messages only, never a model call.
const find = selector => document.querySelector(selector);
const assert = (value, message) => { if (!value) throw new Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(25);
  }
};
const setValue = (element, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, value);
  element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
const scenario = new URLSearchParams(location.search).get('endToEndRegression');
const popup = location.pathname === '/popup.html';
const starts = [], generates = [];
const send = chrome.runtime.sendMessage;
chrome.runtime.sendMessage = async message => {
  if (message.type === 'alchemy:start') starts.push(structuredClone(message));
  if (message.type === 'alchemy:generate') generates.push(structuredClone(message));
  return send(message);
};
const jobs = async () => (await send({ type: 'alchemy:query', path: '/jobs' })).value;
const getJob = async id => (await jobs()).find(job => job.id === id);
const chain = () => popup ? find('.quick-submit-actions .primary') : [...document.querySelectorAll('.canvas-generate')].find(button => button.textContent.includes('逆向并生图'));
const reverse = () => find(popup ? '.quick-submit-actions .text-button' : '.canvas-generate');
const generate = () => find(popup ? '.quick-result .primary' : '.canvas-generation-actions .generate-button');
const cancel = () => popup ? [...document.querySelectorAll('.quick-submit button')].find(button => button.textContent === '取消' && button.checkVisibility()) : find('.canvas-generate[aria-busy="true"]');
const newJob = async oldIds => {
  await waitFor(async () => (await jobs()).some(job => !oldIds.includes(job.id)), '提交应创建新提示词任务');
  return (await jobs()).find(job => !oldIds.includes(job.id));
};
const run = async () => {
  await waitFor(() => find('[aria-label="逆向模式"]') && reverse() && !reverse().disabled, '模式控件应就绪');
  setValue(find('[aria-label="逆向模式"]'), 'recreate');
  await waitFor(() => chain() && !chain().disabled && find('[aria-label="逆向模式"]').value === 'recreate', '端到端入口应可用');
  const oldJobs = await jobs();
  if (scenario === 'popup-start-failed') {
    const failed = oldJobs.find(job => job.autoGeneration?.status === 'failed');
    assert(failed?.status === 'completed' && failed.result && !failed.generations?.length, '失败场景应保留提示词且尚无生图记录');
    assert(failed.autoGeneration.aspectRatio.width === 3 && failed.autoGeneration.aspectRatio.height === 2, '失败任务应保留原始 3:2 比例');
    await waitFor(() => generate() && !generate().disabled, '自动启动失败后应允许独立生图');
    generate().click();
    await waitFor(() => generates.length === 1, '独立生图控件应发出请求');
    assert(generates[0].id === failed.id && generates[0].aspectRatio?.width === 3 && generates[0].aspectRatio?.height === 2, '快捷端重试请求必须沿用失败任务的 3:2 比例');
    await waitFor(async () => (await getJob(failed.id)).generations?.[0]?.status === 'completed', '独立重试应完成');
    const retried = await getJob(failed.id);
    assert(starts.length === 0 && retried.generations.length === 1 && retried.generations[0].aspectRatio.width === 3 && retried.generations[0].aspectRatio.height === 2, '重试应保留 3:2 比例且不得重新逆向');
    return;
  }
  if (scenario === 'workspace' || scenario === 'popup') {
    find(popup ? '.quick-prompt-toggle' : '[aria-label="展开提示词"]').click();
    await waitFor(() => find('.language-tabs button:last-child') && !find('.language-tabs button:last-child').closest('[inert]'), '语言选项应可达');
    find('.language-tabs button:last-child').click();
    await waitFor(() => find('.language-tabs button:last-child').getAttribute('aria-pressed') === 'true', '应选择英文');
    find(popup ? '.quick-prompt-toggle' : '[aria-label="收起提示词面板"]').click();
    if (!popup) {
      setValue(find('.canvas-generation-actions select'), '3:2');
      await waitFor(() => find('.canvas-generation-actions select').value === '3:2', '比例应更新');
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }
  }
  const button = chain();
  button.click(); button.click();
  const created = await newJob(oldJobs.map(job => job.id));
  assert(starts.length === 1, '同一轮重复点击只能提交一次逆向');
  assert(created.autoGeneration?.status === 'pending', '应先逆向并持久记录待生图意图');
  assert(!created.generations?.length, '逆向完成前不能生图');
  if (scenario === 'cancel' || scenario === 'phase-cancel') {
    if (scenario === 'phase-cancel') await waitFor(async () => (await getJob(created.id)).result, '阶段间取消应等到提示词保存');
    await waitFor(() => cancel() && !cancel().disabled, '应提供取消入口');
    cancel().click();
    await waitFor(async () => (await getJob(created.id)).autoGeneration.status === 'cancelled', '取消应关闭后续生图意图');
    await delay(2500);
    const cancelled = await getJob(created.id);
    assert(!cancelled.generations?.length, '取消后延迟回调不能补生图');
    if (scenario === 'phase-cancel') assert(cancelled.result, '阶段间取消应保留成功提示词');
  } else {
    if (scenario === 'context') {
      find('[aria-label="打开项目：另一个空白项目"]').click();
      await waitFor(() => find('[aria-label="打开项目：另一个空白项目"]')?.getAttribute('aria-current') === 'page', '应切到另一项目');
      setValue(find('[aria-label="逆向模式"]'), 'style');
    }
    await waitFor(async () => {
      const job = await getJob(created.id);
      return job.autoGeneration.status === 'failed' || ['completed', 'failed'].includes(job.generations?.[0]?.status);
    }, '自动流程应有明确终态');
    const completed = await getJob(created.id);
    if (scenario === 'reverse-failed') {
      assert(completed.status === 'failed' && !completed.generations?.length, '逆向失败不能生图');
    } else {
      assert(completed.status === 'completed' && completed.result, '提示词应成功保存');
      assert(completed.generations?.length === 1 && completed.autoGeneration.generationId === completed.generations[0].id, '自动生图应只创建一次并关联本次提示词：' + (completed.autoGeneration.error || ''));
      const generation = completed.generations[0];
      assert(generation.prompt === completed.result[generation.language === 'en' ? 'promptEn' : 'promptZh'], '生图应使用本次保存的提示词');
      assert(generation.model === completed.model, '生图应使用任务模型快照');
      assert(generates.length === 0, '浏览器不得在轮询中额外提交生图');
      if (scenario === 'generation-failed') {
        assert(generation.status === 'failed' && completed.result, '生图失败应保留可重试的提示词');
        await waitFor(() => generate() && !generate().disabled, '失败后独立生图应重新可用');
        generate().click();
        await waitFor(async () => (await getJob(created.id)).generations.length === 2, '失败后应可独立重试并保留失败历史');
      } else if (scenario === 'context') {
        assert(completed.projectId === 'a'.repeat(64) && completed.mode === 'recreate', '后台应继续原项目和模式');
        assert((await jobs()).filter(job => job.projectId === 'b'.repeat(64)).length === 0, '新项目不能收到旧结果或自动生图');
        assert(find('[aria-label="打开项目：另一个空白项目"]').getAttribute('aria-current') === 'page' && find('[aria-label="逆向模式"]').value === 'style', '旧结果不得切回原上下文');
      } else {
        assert(generation.language === 'en' && starts[0].generation.language === 'en', '端到端应保留所选语言');
        if (!popup) assert(generation.aspectRatio.width === 3 && generation.aspectRatio.height === 2 && starts[0].generation.aspectRatio.width === 3, '端到端应保留所选比例');
        for (let count = 2; count <= 3; count++) {
          await waitFor(() => generate() && !generate().disabled, '独立生图应可用');
          generate().click();
          await waitFor(async () => (await getJob(created.id)).generations?.length === count && (await getJob(created.id)).generations.at(-1).status === 'completed', '同提示词应可重复生图');
        }
        const repeated = await getJob(created.id);
        assert(new Set(repeated.generations.map(item => item.id)).size === 3 && repeated.generations.every(item => item.prompt === generation.prompt), '每次生成应保留独立历史并沿用同一提示词');
        assert(starts.length === 1 && generates.length === 2, '重复生图不得重新逆向');
        if (!popup) assert(repeated.generations.every(item => item.aspectRatio?.width === 3 && item.aspectRatio?.height === 2), '重复生图应沿用端到端选择的比例');
        await waitFor(() => reverse() && !reverse().disabled, '仅逆向入口应恢复');
        const before = (await jobs()).map(job => job.id);
        reverse().click();
        const only = await newJob(before);
        await waitFor(async () => (await getJob(only.id)).status === 'completed', '独立逆向应完成');
        assert(!starts.at(-1).generation && !(await getJob(only.id)).generations?.length && !(await getJob(only.id)).autoGeneration, '仅逆向不能自动生图');
        if (popup) assert(document.documentElement.scrollWidth <= innerWidth, '320px 双入口不能造成页面横向溢出');
      }
    }
  }
};
try {
  await run();
  document.documentElement.dataset.endToEndRegression = 'passed';
  find('#preview-notice').textContent = `端到端回归：PASS · ${scenario} · 合成消息 / 真实控件`;
} catch (error) {
  document.documentElement.dataset.endToEndRegression = 'failed';
  find('#preview-notice').textContent = `端到端回归：FAIL · ${scenario} · ${error.message}`;
  console.error(error);
}
