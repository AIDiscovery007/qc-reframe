// Build + preview: /workspace.html?state=projects&mode=style&autoStyleRegression=1&inputSaveDelay=250
// Real React actions and public messages; the preview backend never calls a model.
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
  element.dispatchEvent(new Event('change', { bubbles: true }));
};
const send = chrome.runtime.sendMessage.bind(chrome.runtime), starts = [];
chrome.runtime.sendMessage = async message => {
  if (message.type === 'alchemy:start') starts.push(structuredClone(message));
  return send(message);
};
const mode = () => find('[aria-label="逆向模式"]');
const version = () => find('[aria-label="提示词版本"]');
const reverse = () => find('.canvas-generate');
const subject = () => find('[aria-label="查看主体图"] img')?.getAttribute('src');
const projectId = 'a'.repeat(64);
const currentInput = async () => (await send({ type: 'alchemy:project-reference', id: projectId })).value;
const showInput = async () => {
  [...document.querySelectorAll('.workspace-canvas-tabs button')].find(button => button.textContent === '输入画布')?.click();
  find('[aria-label="收起提示词面板"]')?.click();
  await waitFor(() => reverse() && !reverse().disabled && !find('.workspace-editor')?.inert, '输入应就绪');
};
const submit = async expected => {
  const before = starts.length;
  reverse().click();
  await waitFor(() => starts.length === before + 1, '生成提示词应提交一次');
  assert(starts.at(-1).mode === 'style', '应使用提取风格模式');
  assert(starts.at(-1).reenact?.subjectImage === expected, '请求应仅依据当前有效主体图');
  assert(starts.at(-1).instruction.trim(), '任务指令应保留');
  await waitFor(() => reverse()?.getAttribute('aria-busy') === 'true', '应显示逆向运行状态');
  await waitFor(() => reverse()?.getAttribute('aria-busy') === 'false' && !reverse().disabled, '逆向应完成并恢复');
  const input = await currentInput();
  assert(input.inputs.style.subjectImage === expected, '保存结果应与本次主体角色一致');
  return version().value;
};
try {
  await waitFor(mode, '工作台应加载');
  if (mode().value !== 'style') setValue(mode(), 'style');
  await waitFor(() => mode()?.value === 'style' && version(), '风格版本应加载');
  await showInput();
  assert(/^图 \d+$/.test(find('.canvas-label span')?.textContent || ''), '画布标签应显示当前图片编号');
  assert(!find('.canvas-generic') && !find('#generation-prerequisite'), '通用风格与生图前提不应重复显示');
  const historical = version().value;
  const originalSubject = subject();
  assert(originalSubject, '历史专属版本应恢复主体');
  find('[aria-label="查看主体图"]').click();
  await waitFor(() => !find('[aria-label="移除主体"]').disabled, '应先切到主体画布');
  find('[aria-label="移除主体"]').click();
  await waitFor(() => !subject() && !reverse().disabled, '移除主体应成功保存');
  const generic = await submit(undefined);
  assert(find('.generate-button').disabled, '通用风格仍不能直接生图');

  const invalid = new DataTransfer();
  invalid.items.add(new File(['invalid'], 'invalid-subject.txt', { type: 'text/plain' }));
  find('.canvas-filmstrip').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: invalid }));
  await waitFor(() => find('.canvas-error')?.textContent.includes('PNG') && reverse().disabled, '主体上传失败应保留错误与提交保护');
  const failedCount = starts.length;
  reverse().click();
  assert(starts.length === failedCount && !subject(), '上传失败不能静默发起通用风格请求');
  assert(!find('[aria-label="逆向模式"]').disabled, '失败后导航不能锁死');
  setValue(mode(), 'recreate');
  await waitFor(() => mode()?.value === 'recreate' && !reverse().disabled, '失败后切换模式应恢复');
  setValue(mode(), 'style');
  await waitFor(() => mode()?.value === 'style' && !reverse().disabled && !subject(), '切回原模式应恢复明确空输入');
  find('.canvas-filmstrip').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: invalid }));
  await waitFor(() => reverse().disabled && find('.canvas-error')?.textContent.includes('PNG'), '重新失败应继续阻止提交');

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  canvas.getContext('2d').fillRect(0, 0, 32, 32);
  const file = new File([await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))], 'auto-style-subject.png', { type: 'image/png' });
  const transfer = new DataTransfer(); transfer.items.add(file);
  find('.canvas-filmstrip').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  await waitFor(() => reverse().disabled, '上传保存期间应锁定逆向');
  const count = starts.length;
  reverse().click();
  assert(starts.length === count, '未就绪的主体不能降级为通用提取');
  await waitFor(() => subject() && !reverse().disabled, '上传主体应成功恢复操作');
  const uploaded = subject();
  assert(uploaded !== originalSubject, '新主体应替换旧主体');
  const dedicated = await submit(uploaded);
  assert(!find('.generate-button').disabled, '专属提示词应允许生图');

  setValue(version(), generic);
  await waitFor(() => version()?.value === generic && !reverse().disabled && !subject(), '历史通用版本不应泄漏新主体');
  setValue(version(), dedicated);
  await waitFor(() => version()?.value === dedicated && !reverse().disabled && subject() === uploaded, '切回专属版本应恢复对应主体');
  find('[aria-label="打开项目：另一个空白项目"]').click();
  await waitFor(() => !version() && !reverse().disabled && !subject(), '空白项目不应继承主体');
  find('[aria-label="打开项目：暖纸底几何模板"]').click();
  await waitFor(() => version()?.value === dedicated && !reverse().disabled && subject() === uploaded, '切回项目应恢复当前主体');
  await showInput();
  find('[aria-label="查看主体图"]').click();
  await waitFor(() => !find('[aria-label="移除主体"]').disabled, '应先切到主体画布');
  find('[aria-label="移除主体"]').click();
  await waitFor(() => !subject() && !reverse().disabled, '专属版本删除主体应保留明确空输入');
  await submit(undefined);
  setValue(version(), historical);
  await waitFor(() => version()?.value === historical && !reverse().disabled && subject() === originalSubject, '历史主体与版本应仍可读取');
  document.documentElement.dataset.autoStyleRegression = 'passed';
  find('#preview-notice').textContent = '自动风格回归：PASS · 上传/删除/历史/项目隔离/请求与保存';
} catch (error) {
  document.documentElement.dataset.autoStyleRegression = 'failed';
  find('#preview-notice').textContent = `自动风格回归：FAIL · ${error.message}`;
  console.error(error);
} finally { chrome.runtime.sendMessage = send; }
