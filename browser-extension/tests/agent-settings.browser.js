// Real settings components with synthetic preview messages; no CLI or model calls.
const waitFor = async predicate => {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待 Agent 设置超时');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const assert = (value, message) => { if (!value) throw new Error(message); };
const open = () => chrome.runtime.sendMessage({ type: 'alchemy:open-workspace', view: 'settings', section: 'models', context: { mode: 'recreate' } });
const radio = agent => document.querySelector(`input[name="reverse-agent"][value="${agent}"]`);
const ready = () => radio('pi') && !radio('pi').matches(':disabled') && radio('pi').getAttribute('aria-disabled') !== 'true';
const choose = (select, value) => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); };
const primary = () => document.querySelector('.model-settings .primary');
const model = () => document.querySelector('.model-settings select');
const effort = () => document.querySelectorAll('.model-settings select')[1];
const verified = () => primary()?.textContent.includes('已验证');
const cliTitle = () => document.querySelector('.agent-cli-settings h3')?.textContent;
const recover = section => chrome.runtime.sendMessage({ type: 'alchemy:open-workspace', view: 'settings', section, context: { mode: 'recreate' } });
const scenario = new URLSearchParams(location.search).get('agentSettingsRegression');
try {
  await waitFor(() => document.querySelector('.connection-state')?.textContent.includes('已连接'));
  await open();
  if (scenario === 'legacy') {
    await waitFor(() => document.querySelector('.model-settings select')?.value);
    assert(!radio('pi'), '旧服务保持原模型设置');
  } else {
    await waitFor(ready);
    assert(radio('codex').checked, '旧设置默认 Codex');
    assert(verified(), '已保存且匹配模型与强度的验证配置显示已验证');
    choose(effort(), 'high');
    await waitFor(() => !verified());
    primary().click();
    await waitFor(() => primary()?.textContent.includes('正在验证'));
    assert(!verified(), '验证中不显示旧成功');
    await waitFor(verified);
    assert(effort().value === 'high', '验证成功绑定当前强度');
    choose(effort(), 'low'); await waitFor(() => !verified());
    choose(effort(), 'high'); await waitFor(verified);
    choose(model(), 'preview-unavailable'); await waitFor(() => !verified());
    primary().click();
    await waitFor(() => document.querySelector('.model-settings [role="alert"]'));
    assert(!verified(), '失败模型不能保留已验证');
    choose(model(), 'preview-vision'); await waitFor(() => effort().value === 'medium');
    assert(!verified(), '已验证模型的其他强度不冒用成功');
    choose(effort(), 'high'); await waitFor(verified);
    assert(document.querySelector('.settings-agent-cards').getAttribute('aria-label') === '逆向 Agent', '精简后保留卡片组无障碍名');
    assert(!document.querySelector('.settings-agent-legend, .model-manage-link, .agent-management-target select'), '删除重复管理和可见legend');
    assert(!document.querySelector('.agent-selection-status, .model-status'), '空闲时无重复说明');
    radio('pi').focus();
    radio('pi').click();
    await waitFor(() => document.querySelector('.agent-settings [role="alert"]'));
    assert(radio('codex').checked && !radio('pi').checked, '保存失败必须保留原 Agent');
    assert(document.activeElement === radio('pi'), '保存失败保留卡片焦点');
    await waitFor(ready);
    radio('pi').click();
    await waitFor(() => radio('pi').checked && document.querySelector('.model-settings select')?.value === 'preview/pi-model');
    assert(document.activeElement === radio('pi'), '保存成功保留卡片焦点');
    assert(!document.querySelector('.model-settings')?.textContent.includes('检查 Codex 版本'), 'Pi 不显示 Codex 检查入口');
    assert(document.querySelector('.agent-settings').textContent.includes('生图渠道独立配置'), '生图和会话来源独立展示');
    assert(document.querySelector('.settings-center-content').scrollWidth <= document.querySelector('.settings-center-content').clientWidth + 1, '窄屏不横向溢出');
    // Given Pi is selected, management follows it without a duplicate generation model panel.
    assert(!document.querySelector('.agent-generation-settings'), '不再显示重复生图模型区');
    await waitFor(() => document.querySelector('.agent-cli-settings h3')?.textContent === 'Pi CLI');
    assert(document.querySelectorAll('.agent-management-target h3').length === 1 && cliTitle() === 'Pi CLI', '仅保留跟随卡片的CLI标题');
    await waitFor(() => ready() && [...document.querySelectorAll('.agent-cli-settings button')].some(button => button.textContent === '一键安装 Pi'));
    const install = [...document.querySelectorAll('.agent-cli-settings button')].find(button => button.textContent === '一键安装 Pi');
    assert(install, 'Pi 缺失时提供一键安装');
    install.click();
    await waitFor(() => document.querySelector('.agent-cli-settings [role="alert"]'));
    assert(radio('pi').checked, '安装失败保留逆向 Agent');
    await waitFor(ready);
    [...document.querySelectorAll('.agent-cli-settings button')].find(button => button.textContent === '一键安装 Pi').click();
    await waitFor(() => document.querySelector('.agent-cli-settings').textContent.includes('0.60.0'));
    await waitFor(ready);
    const check = () => [...document.querySelectorAll('.agent-cli-settings button')].find(button => button.textContent === '重新检测并检查更新');
    check().click();
    await waitFor(() => document.querySelector('.agent-settings > .model-settings .primary').disabled);
    await waitFor(() => [...document.querySelectorAll('.agent-cli-settings button')].some(button => button.textContent === '一键升级至 0.61.0'));
    [...document.querySelectorAll('.agent-cli-settings button')].find(button => button.textContent === '一键升级至 0.61.0').click();
    await waitFor(() => document.querySelector('.agent-cli-settings .settings-version-pair strong')?.textContent === '0.61.0');
    await waitFor(ready);
    document.querySelector('.agent-settings > .model-settings .primary').click();
    await waitFor(() => check()?.disabled);
    await waitFor(() => check() && !check().disabled);
    await waitFor(verified);
    primary().click();
    await waitFor(() => document.querySelector('.model-settings [role="alert"]'));
    assert(!verified(), '相同配置再次验证失败，不显示旧成功');
    choose(model(), 'preview/pi-draft'); await waitFor(() => model().value === 'preview/pi-draft');
    choose(model(), 'preview/pi-model'); await waitFor(() => model().value === 'preview/pi-model');
    assert(!verified(), '修改草稿再返回失败配置不能恢复旧对勾');
    primary().click(); await waitFor(verified);
    primary().click();
    await waitFor(() => document.querySelector('.model-settings [role="alert"]'));
    assert(!verified(), '请求失败不得沿用上一次completed目录');
    choose(model(), 'preview/pi-draft'); await waitFor(() => model().value === 'preview/pi-draft');
    choose(model(), 'preview/pi-model'); await waitFor(() => model().value === 'preview/pi-model');
    assert(!verified(), '请求失败后切换草稿不能伪造成功');
    primary().click(); await waitFor(verified);
    document.querySelector('.model-heading button').click();
    await waitFor(() => primary()?.getAttribute('aria-disabled') === 'false' && !verified());
    assert(document.querySelector('.settings-model-feature strong').textContent === '尚未选择模型', '刷新发现账号或CLI上下文失信时清除成功');
    // Old recovery links focus the current CLI and never silently save another Agent.
    await recover('cli');
    await waitFor(() => document.activeElement === document.querySelector('.agent-management-target'));
    assert(cliTitle() === 'Pi CLI' && radio('pi').checked, 'Codex恢复不暗改当前Pi卡片和管理');
    assert(document.querySelector('.agent-management-target').textContent.includes('请先选择上方的 Codex 卡片'), '不同恢复对象明确引导选择Codex');
    await recover('pi-cli');
    await waitFor(() => !document.querySelector('.agent-management-target .settings-info'));
    assert(cliTitle() === 'Pi CLI' && radio('pi').checked, 'Pi恢复保持一致');
    // Reopen starts a delayed Pi status read; quickly selecting Codex must isolate that reply.
    document.querySelector('[aria-label="关闭设置"]').click();
    await waitFor(() => !document.querySelector('.settings-center'));
    await open(); await waitFor(ready);
    radio('codex').click();
    await waitFor(() => radio('codex').checked && cliTitle() === 'Codex CLI');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert(cliTitle() === 'Codex CLI' && radio('codex').checked && model().value === 'preview-vision', '迟到Pi状态不覆盖Codex管理或模型');
    await waitFor(ready); radio('pi').click();
    await waitFor(() => radio('pi').checked && ready());

    assert(![...document.querySelectorAll('.settings-center-nav button')].some(button => button.textContent === 'Codex 与更新'), 'CLI 管理已并入插件模型');
    document.querySelector('[aria-label="关闭设置"]').click();
    await waitFor(() => !document.querySelector('.settings-center'));
    await open();
    await waitFor(() => ready() && radio('pi').checked);
    assert(document.querySelector('.model-settings select')?.value === 'preview/pi-model', '重开读取保存的 Agent 及独立模型');
  }
  document.documentElement.dataset.agentSettingsRegression = 'passed';
  document.querySelector('#preview-notice').textContent = 'Agent 设置回归：PASS';
} catch (error) {
  document.documentElement.dataset.agentSettingsRegression = 'failed';
  document.querySelector('#preview-notice').textContent = `Agent 设置回归：FAIL · ${error.message}`;
  console.error(error);
}
