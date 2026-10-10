// Production settings UI, synthetic messages only; no credentials or API calls.
const wait = async predicate => {
  const end = Date.now() + 6000;
  while (!predicate()) { if (Date.now() > end) throw new Error('等待生图设置超时'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const assert = (value, message) => { if (!value) throw new Error(message); };
const section = () => document.querySelector('.image-generation-settings');
const input = type => section()?.querySelector(`input${type ? `[type="${type}"]` : ':not([type])'}`);
const fill = (node, value) => { Object.getOwnPropertyDescriptor(node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
const open = async () => { document.querySelector('[aria-label="设置中心"]').click(); await wait(() => document.querySelector('.settings-center-nav')); [...document.querySelectorAll('.settings-center-nav button')].find(button => button.textContent === '生图渠道').click(); };
const scenario = new URLSearchParams(location.search).get('imageSettingsRegression');
try {
  await wait(() => document.querySelector('.connection-state')?.textContent.includes('已连接'));
  await open(); await wait(section);
  if (scenario === 'legacy') {
    await wait(() => section().querySelector('[role="alert"]'));
    assert(section().textContent.includes('更新并重启本机服务'), '旧服务应显示明确升级说明');
    assert(section().querySelector('select').disabled, '读取失败不能覆盖设置');
  } else {
    await wait(() => !section().querySelector('select').disabled);
    assert(section().querySelector('select').value === 'codex', '旧配置默认 Codex');
    fill(section().querySelector('select'), 'openai'); await wait(() => input('url'));
    fill(input('url'), 'https://images.example/v1'); fill(input(), 'fixture-image'); fill(input('password'), 'fixture-secret');
    section().querySelector('.primary').click();
    await wait(() => section().querySelector('[role="alert"]'));
    assert(input('password').value === 'fixture-secret', '失败保留输入以便重试');
    assert(section().textContent.includes('当前使用：Codex'), '保存失败保持原渠道');
    section().querySelector('.primary').click();
    await wait(() => section().textContent.includes('已保存，用于之后提交'));
    assert(input('password').value === '', '保存成功立即清空输入密钥');
    assert(section().textContent.includes('当前使用：OpenAI'), '保存成功显示实际渠道');
    document.querySelector('[aria-label="关闭设置"]').click(); await wait(() => !section());
    await open(); await wait(() => input('url'));
    assert(input('url').value === 'https://images.example/v1' && input().value === 'fixture-image', '重开恢复地址与模型');
    assert(input('password').value === '' && section().textContent.includes('已保存密钥'), '重开只读取密钥存在状态');
    fill(section().querySelector('select'), 'gemini'); await wait(() => input('url').value.includes('googleapis'));
    assert(input('password').value === '', '切换供应商不得带入密钥');
    fill(input(), 'gemini-fixture'); fill(input('password'), 'gemini-secret');
    section().querySelector('.primary').click(); await wait(() => section().textContent.includes('当前使用：Gemini'));
    section().querySelector('button[type="button"]').click(); await wait(() => section().textContent.includes('API Key 已清除'));
    assert(section().textContent.includes('尚未保存密钥'), '清除成功可观察');
    assert(document.querySelector('.settings-center-content').scrollWidth <= document.querySelector('.settings-center-content').clientWidth + 1, '窄屏不能横向溢出');
  }
  document.documentElement.dataset.imageSettingsRegression = 'passed';
  document.querySelector('#preview-notice').textContent = '生图设置回归：PASS';
} catch (error) {
  document.documentElement.dataset.imageSettingsRegression = 'failed';
  document.querySelector('#preview-notice').textContent = `生图设置回归：FAIL · ${error.message}`;
  console.error(error);
}
