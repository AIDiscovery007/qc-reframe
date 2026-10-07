// Synthetic preview only: UI actions and public messages, without bridge, accounts or models.
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
  element.dispatchEvent(new Event(element.tagName === 'TEXTAREA' ? 'input' : 'change', { bubbles: true }));
};
const options = new URLSearchParams(location.search), scenario = options.get('imageOrderRegression');
const instructionFixture = options.get('instructionFixture'), instructionMode = options.get('mode');
const instruction = () => find('[aria-label="任务指令"]')?.value;
const send = chrome.runtime.sendMessage.bind(chrome.runtime), starts = [], saves = [];
chrome.runtime.sendMessage = async message => {
  if (message.type === 'alchemy:start') starts.push(structuredClone(message));
  if (message.type === 'alchemy:update-project-input') saves.push(structuredClone(message));
  return send(message);
};
const strip = () => find('[aria-label="图片图条"]');
const imageButtons = () => [...strip().querySelectorAll('button[aria-description]')];
const imageId = button => button.dataset.imageId || (button.getAttribute('aria-label') === '查看参考图' ? 'reference' : 'subject');
const imageButton = id => imageButtons().find(button => imageId(button) === id);
const ids = () => imageButtons().map(imageId);
const order = expected => JSON.stringify(ids()) === JSON.stringify(expected);
const version = () => find('[aria-label="提示词版本"]');
const mode = () => find('[aria-label="逆向模式"]');
const reverse = () => find('.canvas-generate') || find('.quick-reverse');
const input = async () => (await send({ type: 'alchemy:project-reference', id: 'a'.repeat(64) })).value;
const assertNumberedDefault = () => {
  if (!instructionFixture || mode().value !== instructionMode) return;
  const value = instruction(), referenceNumber = ids().indexOf('reference') + 1;
  const referenceNumbers = [...value.matchAll(/图 (\d+)（参考(?:图|模板)）/g)].map(match => Number(match[1]));
  assert(referenceNumbers.length && referenceNumbers.every(number => number === referenceNumber), `默认参考图号应为${referenceNumber}：${value}`);
  const subjectNumbers = ids().flatMap((id, index) => id === 'reference' ? [] : [index + 1]);
  if (mode().value === 'multi-reenact') assert(value.includes(subjectNumbers.map(number => `图 ${number}`).join('、') + '提供的各主体'), '多图默认应列出所有主体的当前图号');
  else assert(value.includes(`图 ${subjectNumbers[0]}（主体图）`), '双图默认主体编号应与图条一致');
};
const move = async (id, direction, expected) => {
  imageButton(id).click();
  const button = () => find(`[aria-label="图片${direction}移"]`);
  await waitFor(() => button() && !button().disabled, '移动按钮应可用');
  const count = saves.length;
  button().click();
  await waitFor(() => saves.length > count && order(expected) && !find('[aria-label="逆向模式"]').disabled, '顺序应保存并显示');
  await waitFor(async () => (await input()).inputs[mode().value].referenceIndex === expected.indexOf('reference'), '保存编号应与图条一致');
  ids().forEach((id, index) => assert(imageButton(id).textContent.includes(`图 ${index + 1}`), '图号应与位置一致'));
  assertNumberedDefault();
};
try {
  await waitFor(mode, '模式入口应加载');
  if (scenario === 'multi' && mode().value !== 'multi-reenact') setValue(mode(), 'multi-reenact');
  if (instructionFixture && mode().value !== instructionMode) {
    setValue(mode(), instructionMode);
    await waitFor(() => mode().value === instructionMode && ids().length > 1, '指令测试模式应就绪');
  }
  await waitFor(() => strip() && ids().length > 1 && mode(), '图片图条应加载');
  assertNumberedDefault();
  const originalJobs = instructionFixture ? (await send({ type: 'alchemy:project', id: 'a'.repeat(64) })).value.jobs : [];
  if (scenario === 'instruction-legacy') {
    assert(!instruction().includes('基于图 1'), '精确旧默认应迁移为当前编号默认');
    await move('reference', '后', ['subject', 'reference']);
  } else if (scenario === 'failed') {
    assert(order(['reference', 'subject']), '新输入参考图应默认为图1');
    imageButton('reference').click();
    await waitFor(() => !find('[aria-label="图片后移"]').disabled, '改序入口应可用');
    find('[aria-label="图片后移"]').click();
    await waitFor(() => find('.canvas-error')?.textContent.includes('保存失败'), '保存失败应有明确反馈');
    assert(order(['reference', 'subject']), '失败应保留原顺序');
    assert((await input()).inputs.style.referenceIndex === 0, '失败不能改写已存输入');
    await move('reference', '后', ['subject', 'reference']);
  } else if (scenario === 'multi') {
    assert(order(['reference', 'person', 'cup']), '多图新输入参考应为图1');
    await move('reference', '后', ['person', 'reference', 'cup']);
    await move('reference', '后', ['person', 'cup', 'reference']);
    await move('person', '后', ['cup', 'person', 'reference']);
    await move('person', '后', ['cup', 'reference', 'person']);
    assert((await input()).inputs['multi-reenact'].subjects.map(item => item.id).join() === 'cup,person', '主体相对顺序应保存');
    imageButton('cup').click();
    await waitFor(() => !find('[aria-label="移除主体"]').disabled, '主体应可移除');
    find('[aria-label="移除主体"]').click();
    await waitFor(() => order(['reference', 'person']) && !find('[aria-label="逆向模式"]').disabled, '删除参考前主体应保留其余相对顺序');
    assert((await input()).inputs['multi-reenact'].referenceIndex === 0, '删除后参考位置应递减');
    assertNumberedDefault();
    imageButton('person').click();
    await waitFor(() => !find('[aria-label="替换当前图片"]').disabled, '主体应可替换');
    find('[aria-label="替换当前图片"]').click();
    const before = (await input()).inputs['multi-reenact'].subjects[0].subjectImage;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    canvas.getContext('2d').fillRect(0, 0, 32, 32);
    const transfer = new DataTransfer();
    transfer.items.add(new File([await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))], 'replacement.png', { type: 'image/png' }));
    const upload = find('[aria-label="上传画布图片"]'); upload.files = transfer.files;
    upload.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(async () => (await input()).inputs['multi-reenact'].subjects[0].subjectImage !== before && !find('[aria-label="逆向模式"]').disabled, '替换图应保存');
    assert(order(['reference', 'person']), '替换主体应保留图号与角色');
    await waitFor(() => !find('[aria-label="添加主体图"]').disabled, '替换保存应完成');
    find('[aria-label="添加主体图"]').click();
    const addition = new DataTransfer();
    addition.items.add(new File([await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))], 'addition.png', { type: 'image/png' }));
    upload.files = addition.files;
    upload.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => ids().length === 3 && !mode().disabled, '重新增图应保留已有图序');
    assert(ids()[0] === 'reference' && ids()[1] === 'person', '新增主体应追加在现有输入后');
    assertNumberedDefault();
  } else {
    if (scenario === 'legacy') {
      assert(order(['subject', 'reference']), '旧提示词应保留参考图2');
      const historical = version().value;
      await move('reference', '前', ['reference', 'subject']);
      await waitFor(() => version().value === 'new', '改序应进入当前输入');
      setValue(version(), historical);
      await waitFor(() => order(['subject', 'reference']) && version().value === historical, '重开旧提示词应保持旧编号');
      setValue(version(), 'new');
      await waitFor(() => order(['reference', 'subject']) && version().value === 'new', '返回当前输入应恢复新顺序');
    } else {
      assert(order(['reference', 'subject']), '双图新输入参考应为图1');
      await move('reference', '后', ['subject', 'reference']);
      if (scenario !== 'popup') {
        setValue(mode(), 'reenact');
        await waitFor(() => mode().value === 'reenact' && order(['subject', 'reference']), '另一模式应保留自己的旧历史顺序');
        await move('reference', '前', ['reference', 'subject']);
        setValue(mode(), 'style');
        await waitFor(() => mode().value === 'style' && order(['subject', 'reference']), '切回应恢复原模式顺序');
        find('[aria-label="打开项目：另一个空白项目"]').click();
        await waitFor(() => ids().length === 1, '空白项目应不继承主体');
        find('[aria-label="打开项目：暖纸底几何模板"]').click();
        await waitFor(() => order(['subject', 'reference']), '重开项目应恢复保存顺序');
      }
    }
  }
  if (!['failed', 'popup'].includes(scenario)) {
    const expected = ids().indexOf('reference'), expectedSubjects = ids().filter(id => id !== 'reference');
    assertNumberedDefault();
    const displayedInstruction = instruction();
    if (instructionFixture) assert((await input()).inputs[mode().value].instruction === displayedInstruction, '保存重开后的默认指令应与当前编号一致');
    await waitFor(() => reverse() && !reverse().disabled, '逆向入口应可用');
    reverse().click();
    await waitFor(() => starts.length === 1, '应提交一次逆向请求');
    assert(starts[0].referenceIndex === expected, '逆向请求应携带用户指定顺序');
    if (instructionFixture) assert(starts[0].instruction === displayedInstruction, '逆向请求应携带当前编号默认指令');
    if (scenario === 'multi') assert(starts[0].reenact.subjects.map(item => item.id).join() === expectedSubjects.join(), '逆向请求主体顺序应一致');
    await waitFor(async () => (await input()).inputs[mode().value].referenceIndex === expected, '新任务输入快照应保存顺序');
  }
  if (instructionFixture) {
    await waitFor(() => reverse()?.getAttribute('aria-busy') === 'false' && !reverse().disabled, '默认指令逆向应完成');
    const after = (await send({ type: 'alchemy:project', id: 'a'.repeat(64) })).value.jobs;
    assert(originalJobs.every(original => JSON.stringify(after.find(job => job.id === original.id)) === JSON.stringify(original)), '迁移与改序不能写回旧任务或结果');
    if (scenario !== 'multi') {
      const custom = instruction() + '\n用户自定义：图 1 保留蓝色，图 2 保留红色。';
      setValue(find('[aria-label="任务指令"]'), custom);
      await waitFor(() => instruction() === custom, '自定义指令应进入草稿');
      imageButton('reference').click();
      await waitFor(() => !find('[aria-label="图片前移"]').disabled, '自定义指令时应能改序');
      find('[aria-label="图片前移"]').click();
      await waitFor(() => order(['reference', 'subject']) && !reverse().disabled, '自定义指令改序应保存');
      assert(instruction() === custom && (await input()).inputs[mode().value].instruction === custom, '自定义内容即使包含旧图号也必须原样保留');
      reverse().click();
      await waitFor(() => starts.length === 2, '自定义指令应可提交');
      assert(starts[1].instruction === custom, '提交不能改写自定义内容');
    }
  }
  document.documentElement.dataset.imageOrderRegression = 'passed';
  find('#preview-notice').textContent = `图片顺序回归：PASS · ${scenario}`;
} catch (error) {
  document.documentElement.dataset.imageOrderRegression = 'failed';
  find('#preview-notice').textContent = `图片顺序回归：FAIL · ${error.message}`;
  console.error(error);
} finally { chrome.runtime.sendMessage = send; }
