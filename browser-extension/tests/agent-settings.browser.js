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
    const manage = document.querySelector('.agent-management-target select');
    assert(manage.value === 'pi', '正常选择后管理目标跟随逆向 Agent');
    // Given a Pi model draft, updating only Codex must preserve the draft.
    await waitFor(ready);
    const choose = (select, value) => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); };
    choose(document.querySelector('.agent-settings > .model-settings select'), 'preview/pi-draft');
    choose(manage, 'codex');
    await waitFor(() => [...document.querySelectorAll('.agent-cli-settings button')].some(button => button.textContent === '一键升级至 0.101.0'));
    [...document.querySelectorAll('.agent-cli-settings button')].find(button => button.textContent === '一键升级至 0.101.0').click();
    await waitFor(() => document.querySelector('.agent-cli-settings .settings-version-pair strong')?.textContent === '0.101.0' && ready());
    assert(document.querySelector('.agent-settings > .model-settings select')?.value === 'preview/pi-draft', '管理非当前 Agent 不丢失逆向模型草稿');
    choose(document.querySelector('.agent-settings > .model-settings select'), 'preview/pi-model');
    choose(manage, 'pi');
    await waitFor(() => document.querySelector('.agent-cli-settings h3')?.textContent === 'Pi CLI' && [...document.querySelectorAll('.agent-cli-settings button')].some(button => button.textContent === '一键安装 Pi'));
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
    // When entering the legacy CLI recovery, inspect Codex without selecting it for reverse work.
    await chrome.runtime.sendMessage({ type: 'alchemy:open-workspace', view: 'settings', section: 'cli', context: { mode: 'recreate' } });
    await waitFor(() => document.querySelector('.agent-management-target select')?.value === 'codex' && document.querySelector('.agent-cli-settings h3')?.textContent === 'Codex CLI');
    assert(radio('pi').checked, '旧 CLI 恢复只查看 Codex，不切换逆向 Agent');
    // A delayed Pi status response cannot overwrite the subsequently opened Codex panel.
    await chrome.runtime.sendMessage({ type: 'alchemy:open-workspace', view: 'settings', section: 'pi-cli', context: { mode: 'recreate' } });
    await waitFor(() => document.querySelector('.agent-cli-settings h3')?.textContent === 'Pi CLI');
    await chrome.runtime.sendMessage({ type: 'alchemy:open-workspace', view: 'settings', section: 'cli', context: { mode: 'recreate' } });
    await waitFor(() => document.querySelector('.agent-cli-settings h3')?.textContent === 'Codex CLI');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert(document.querySelector('.agent-cli-settings h3')?.textContent === 'Codex CLI' && radio('pi').checked, '迟到 Pi 状态不覆盖 Codex 管理或逆向选择');

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
