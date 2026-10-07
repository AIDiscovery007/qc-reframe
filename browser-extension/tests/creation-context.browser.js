// Build + preview, then /workspace.html?state=alignment&mode=recreate&inputSaveDelay=1800&creationContextRegression=mode
// Cases: mode, version, project, failure (also add swap=failed for failure).
// Upload through the real canvas DOM; navigate through the public workspace reminder URL.
// Navigation controls are deliberately disabled during saves: never bypass their disabled state.
const find = selector => document.querySelector(selector);
const assert = (value, message) => { if (!value) throw new Error(message); };
const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 12000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const setValue = (element, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, value);
  element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
const navigate = task => { location.hash = 'workspace=' + new URLSearchParams({ task, request: crypto.randomUUID() }); };
const mode = () => find('[aria-label="逆向模式"]');
const version = () => find('[aria-label="提示词版本"]');
const instruction = () => find('[aria-label="任务指令"]');
const reference = () => find('.canvas-large img')?.getAttribute('src');
const showInput = async () => {
  [...document.querySelectorAll('.workspace-canvas-tabs button')].find(button => button.textContent === '输入画布')?.click();
  find('[aria-label="收起提示词面板"]')?.click();
  await waitFor(() => find('.workspace-editor') && !find('.workspace-editor').inert && find('#workspace-prompt-sheet')?.inert, '应显示输入画布');
  find('[aria-label="查看参考图"]').click();
  await waitFor(reference, '应显示历史参考图');
  await waitFor(() => instruction() && !instruction().disabled && !find('[aria-label="替换当前图片"]')?.disabled, '输入画布应完成恢复并允许编辑');
};
const project = 'a'.repeat(64);
const originalTask = '11111111-1111-4111-8111-111111111111';
const scenario = new URLSearchParams(location.search).get('creationContextRegression');
try {
  assert(['mode', 'version', 'project', 'failure'].includes(scenario), '必须指定有效回归场景');
  assert(Number(new URLSearchParams(location.search).get('inputSaveDelay')) >= 1000, '需设置至少 1000ms 的 inputSaveDelay');
  await waitFor(mode, '工作台应就绪');
  if (mode().value !== 'recreate') setValue(mode(), 'recreate');
  await waitFor(() => mode()?.value === 'recreate' && version(), '复刻版本应就绪');
  // Initial rendering may already display originalTask. Make the next navigation observable:
  // matching the old DOM alone must not let uploads race its asynchronous prompt reveal.
  if (version().value === originalTask) {
    navigate('22222222-2222-4222-8222-222222222222');
    await waitFor(() => version()?.value === '22222222-2222-4222-8222-222222222222'
      && !location.hash && find('#workspace-prompt-sheet') && !find('#workspace-prompt-sheet').inert, '准备导航应完成并展开目标提示词');
  }
  navigate(originalTask);
  await waitFor(() => mode()?.value === 'recreate' && version()?.value === originalTask && !mode().disabled
    && !location.hash && find('#workspace-prompt-sheet') && !find('#workspace-prompt-sheet').inert, '初始历史导航及提示词展开应完成');
  await showInput();
  const originalImage = reference();
  const draft = `未提交指令 · ${scenario}`;
  setValue(instruction(), draft);
  await waitFor(() => instruction().value === draft, '指令草稿应写入');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  canvas.getContext('2d').fillRect(0, 0, 32, 32);
  const file = new File([await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))], 'input-lease.png', { type: 'image/png' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  find('.canvas-large').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  await waitFor(() => mode().disabled && version().disabled, '保存期间真实导航控件应锁定');
  if (scenario === 'failure') {
    await waitFor(() => document.body.textContent.includes('保存失败（预览），原输入已保留') && !mode().disabled, '失败应提示并释放输入锁');
    assert(version().value === originalTask && instruction().value === draft && reference() === originalImage, '保存失败必须保留版本、指令草稿及原图');
    const saved = await chrome.runtime.sendMessage({ type: 'alchemy:project-reference', id: project });
    assert(saved.value.inputRevision === 0, '失败不能写入持久输入');
  } else {
    // Observe only the public read API: durable write precedes its deliberately delayed reply.
    await waitFor(async () => (await chrome.runtime.sendMessage({ type: 'alchemy:project-reference', id: project })).value.inputRevision === 1, '上传必须真正进入输入事务后才导航');
    assert(mode().disabled, '导航必须发生在旧输入响应到达之前');
    const target = scenario === 'mode' ? '33333333-3333-4333-8333-333333333333'
      : scenario === 'version' ? '22222222-2222-4222-8222-222222222222' : '44444444-4444-4444-8444-444444444444';
    const targetMode = scenario === 'mode' ? 'reenact' : 'recreate';
    navigate(target);
    await waitFor(() => version()?.value === target && mode()?.value === targetMode && !location.hash
      && find('#workspace-prompt-sheet') && !find('#workspace-prompt-sheet').inert, '提醒应在输入保存中切换上下文并展开目标提示词');
    await waitFor(() => !mode().disabled, '旧输入请求应完成并释放锁');
    await showInput();
    assert(version().value === target && mode().value === targetMode, '旧响应不能回填原模式或将目标历史版本切成当前输入');
    assert(instruction().value !== draft && reference() === originalImage, '旧响应不能用保存中的指令或图片覆盖目标历史输入');
    const active = find('.project-button[aria-current="page"]');
    assert(active?.getAttribute('aria-label') === `打开项目：${scenario === 'project' ? '另一个空白项目' : '暖纸底几何模板'}`, '旧响应不能切回原项目');
    const saved = await chrome.runtime.sendMessage({ type: 'alchemy:project-reference', id: project });
    assert(saved.value.inputRevision === 1 && saved.value.inputs.recreate.instruction === draft, '导航只丢弃旧视图回填，不能取消持久保存');
  }
  document.documentElement.dataset.creationContextRegression = 'passed';
  find('#preview-notice').textContent = `创作上下文回归：PASS · ${scenario} · 真实输入保存 / lease / 草稿保护`;
} catch (error) {
  document.documentElement.dataset.creationContextRegression = 'failed';
  find('#preview-notice').textContent = `创作上下文回归：FAIL · ${scenario} · ${error.message}`;
  console.error(error);
}
