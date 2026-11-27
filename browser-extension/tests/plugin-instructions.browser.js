// Production plugin instruction settings, synthetic messages only; no bridge or model calls.
const wait = async predicate => {
  const end = Date.now() + 6000;
  while (!predicate()) { if (Date.now() > end) throw new Error('等待插件指令超时'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const assert = (value, message) => { if (!value) throw new Error(message); };
const section = () => document.querySelector('.plugin-instructions');
const editor = () => section()?.querySelector('textarea');
const save = () => section().querySelector('.primary');
const button = label => [...section().querySelectorAll('button')].find(item => item.textContent === label);
const fill = value => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor(), value); editor().dispatchEvent(new Event('input', { bubbles: true })); };
const open = async () => {
  document.querySelector('[aria-label="设置中心"]').click(); await wait(() => document.querySelector('.settings-center-nav'));
  [...document.querySelectorAll('.settings-center-nav button')].find(item => item.textContent === '插件指令').click();
};
const close = async () => { document.querySelector('[aria-label="关闭设置"]').click(); await wait(() => !section()); };
const scenario = new URLSearchParams(location.search).get('pluginInstructionsRegression');
try {
  await wait(() => document.querySelector('.connection-state')?.textContent.includes('已连接'));
  await open(); await wait(section);
  if (scenario === 'legacy') {
    await wait(() => section().querySelector('[role="alert"]'));
    assert(section().textContent.includes('更新并重启本机服务'), '旧服务应显示明确升级说明');
    assert(editor().disabled && save().disabled, '读取失败不能编辑或保存');
  } else {
    await wait(() => !editor().disabled);
    const builtin = editor().value;
    assert(builtin.includes('资深视觉设计师') && section().textContent.includes('当前：内置指令'), '首次显示内置指令');
    assert(section().textContent.includes('AGENTS.md / CLAUDE.md'), '说明插件指令对应的文件约定');
    assert(save().disabled, '未修改不能保存');
    fill('只用摄影术语描述光线。');
    await wait(() => !save().disabled);
    assert(section().textContent.includes('有未保存的修改'), '草稿状态可见');
    if (scenario === 'failure') {
      save().click(); await wait(() => section().querySelector('[role="alert"]'));
      assert(editor().value === '只用摄影术语描述光线。' && section().textContent.includes('当前：内置指令'), '保存失败保留草稿与原指令');
    }
    save().click(); await wait(() => section().textContent.includes('已保存，用于之后提交'));
    assert(section().textContent.includes('当前：自定义指令') && !section().querySelector('[role="alert"]') && save().disabled, '保存成功显示自定义指令');
    await close(); await open(); await wait(() => editor() && !editor().disabled);
    assert(editor().value === '只用摄影术语描述光线。', '重开读取已保存指令');
    button('填入内置指令').click();
    await wait(() => editor().value === builtin);
    assert(section().textContent.includes('保存后生效') && section().textContent.includes('当前：自定义指令'), '填入内置指令不直接保存');
    save().click(); await wait(() => section().textContent.includes('已恢复内置指令'));
    assert(section().textContent.includes('当前：内置指令') && button('填入内置指令').disabled, '恢复内置后随插件更新');
    const content = document.querySelector('.settings-center-content');
    assert(content.scrollWidth <= content.clientWidth + 1, '设置内容不能横向溢出');
  }
  document.documentElement.dataset.pluginInstructionsRegression = 'passed';
  document.querySelector('#preview-notice').textContent = '插件指令回归：PASS';
} catch (error) {
  document.documentElement.dataset.pluginInstructionsRegression = 'failed';
  document.querySelector('#preview-notice').textContent = `插件指令回归：FAIL · ${error.message}`;
  console.error(error);
}
