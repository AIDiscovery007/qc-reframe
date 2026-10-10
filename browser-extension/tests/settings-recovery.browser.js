// Run after build: npm run preview, then /workspace.html?state=library&settingsRegression=1.
// Exercises the real React bundle with the preview's fake extension messages; no CLI/model calls.
const waitFor = async predicate => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待界面状态超时");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const active = () => document.querySelector('.settings-center-nav [aria-current="page"]')?.textContent;
const handoff = section => chrome.runtime.sendMessage({ type: "alchemy:open-workspace", view: "settings", section, context: { mode: "recreate" } });
const assert = (value, message) => { if (!value) throw new Error(message); };
try {
  await waitFor(() => document.querySelector('.connection-state')?.textContent.includes('已连接'));
  await handoff('cli');
  await waitFor(() => active() === '插件模型');
  await waitFor(() => document.querySelector('.agent-management-target select')?.value === 'codex' && document.querySelector('.agent-cli-settings h3')?.textContent === 'Codex CLI');
  const dialog = document.querySelector('.settings-center');
  for (const [section, label] of [['models', '插件模型'], ['connection', '本机连接'], ['cli', '插件模型']]) {
    await handoff(section);
    await waitFor(() => active() === label);
    if (section === 'cli') await waitFor(() => document.querySelector('.agent-management-target select')?.value === 'codex' && document.querySelector('.agent-cli-settings h3')?.textContent === 'Codex CLI');
    assert(dialog === document.querySelector('.settings-center'), '恢复导航不应重挂载设置弹窗');
  }
  // Navigate to a different section: CLI recovery now shares the models page.
  [...dialog.querySelectorAll('nav button')].find(button => button.textContent === '本机连接').click();
  await waitFor(() => active() === '本机连接');
  await handoff('cli');
  await waitFor(() => active() === '插件模型');
  await waitFor(() => document.querySelector('.agent-management-target select')?.value === 'codex' && document.querySelector('.agent-cli-settings h3')?.textContent === 'Codex CLI');
  assert(dialog === document.querySelector('.settings-center'), '重复目标仍应复用弹窗');
  dialog.querySelector('[aria-label="关闭设置"]').click();
  await waitFor(() => !document.querySelector('.settings-center'));
  await handoff('connection');
  await waitFor(() => active() === '本机连接');
  assert(!document.querySelector('.settings-pair-label, #pair-token'), '自动接入不应显示手动配对输入');
  assert(!document.querySelector('.settings-center-content').textContent.includes('如何启动本机服务'), '设置中不应显示启动说明');
  assert(!document.querySelector('.settings-center-content').textContent.includes('Codex 安装'), 'CLI状态应统一插件模型');
  assert(!document.querySelector('.settings-center-content').textContent.includes('服务地址'), '隐藏重复连接信息');
  document.querySelector('#preview-notice').textContent = '设置恢复行为回归：PASS · 无项目交接 / 分类切换 / 重复目标 / 关闭重开';
  document.documentElement.dataset.settingsRegression = 'passed';
} catch (error) {
  document.querySelector('#preview-notice').textContent = `设置恢复行为回归：FAIL · ${error.message}`;
  document.documentElement.dataset.settingsRegression = 'failed';
  console.error(error);
}
