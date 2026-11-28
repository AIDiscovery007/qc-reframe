// Run after build: npm run preview, then /workspace.html?state=library&upgradeRegression=<flow>.
// Exercises the real React bundle with the preview's synthetic upgrade replies; nothing contacts GitHub,
// runs an installer or reloads the extension.
const flow = new URLSearchParams(location.search).get("upgradeRegression");
const waitFor = async (predicate, message = "等待界面状态超时") => {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const assert = (value, message) => { if (!value) throw new Error(message); };
const active = () => document.querySelector('.settings-center-nav [aria-current="page"]')?.textContent;
const card = () => document.querySelector('section[aria-label="升级 QC-Reframe"]');
const status = () => card()?.querySelector(".settings-operation-status")?.textContent || "";
const button = label => [...(card()?.querySelectorAll("button") || [])].find(item => item.textContent === label);
const confirmDialog = () => document.querySelector('dialog[aria-labelledby="upgrade-title"]');
const reloads = () => Number(document.documentElement.dataset.previewExtensionReloads || 0);
const sidebarHint = () => [...document.querySelectorAll(".connection-state .text-button")].find(item => ["新版本", "需重新加载"].includes(item.textContent));
const highlights = () => [...(card()?.querySelectorAll(".settings-release-notes li") || [])].map(item => item.textContent);
const openConnection = () => chrome.runtime.sendMessage({ type: "alchemy:open-workspace", view: "settings", section: "connection", context: { mode: "style" } });

// Scenario: user upgrades from the settings page
//   Given a newer release, an idle service and the connection settings
//   When the user confirms the upgrade
//   Then the card follows the upgrade and asks the extension to reload; cancelling the dialog changes nothing
async function upgrade({ outcome }) {
  await waitFor(() => button("升级到 0.1.19") && !button("升级到 0.1.19").disabled, "缺少可用的升级按钮");
  assert(card().querySelector(".settings-version-pair")?.textContent.replace(/\s/g, "") === "0.1.18→0.1.19", "应显示当前与最新版本");
  const notes = [...card().querySelectorAll("a")].find(item => item.textContent === "查看更新说明");
  assert(notes?.href === "https://github.com/AIDiscovery007/qc-reframe/releases/tag/v0.1.19" && notes.target === "_blank" && notes.rel.includes("noreferrer"), "更新说明应在新标签打开 Release 页面");
  assert(highlights().join("|") === "主动检查更新|新版本提醒", "应显示这一版的更新内容");
  button("升级到 0.1.19").click();
  await waitFor(() => confirmDialog()?.open, "升级前应确认");
  assert(confirmDialog().textContent.includes("未保存的编辑会丢失") && confirmDialog().textContent.includes("自动恢复 0.1.18"), "确认框应说明影响与回滚");
  assert(document.activeElement?.textContent === "取消", "确认框应先聚焦取消");
  document.activeElement.click();
  await waitFor(() => !confirmDialog().open, "取消后应关闭确认框");
  assert(document.querySelector(".settings-center") && reloads() === 0 && !status().includes("正在升级"), "取消不应开始升级");
  button("升级到 0.1.19").click();
  await waitFor(() => confirmDialog()?.open);
  [...confirmDialog().querySelectorAll("button")].find(item => item.textContent === "开始升级").click();
  await waitFor(() => status().includes("正在升级到 0.1.19"), "应显示升级进度");
  assert(button("正在升级…")?.disabled && card().querySelector('input[role="switch"]').disabled, "升级期间不应重复提交或改设置");
  if (outcome === "upgraded") {
    await waitFor(() => reloads() === 1 && status().includes("已升级到 0.1.19，正在重新加载扩展"), "成功后应重新加载扩展");
  } else {
    await waitFor(() => card().querySelector('[role="alert"]')?.textContent.includes("初始化"), "回滚后应说明失败阶段");
    assert(card().querySelector('[role="alert"]').textContent.includes("已恢复 0.1.18"), "回滚后应说明已恢复的版本");
    assert(reloads() === 0, "回滚后不应重新加载扩展");
    await waitFor(() => button("升级到 0.1.19") && !button("升级到 0.1.19").disabled, "回滚后应允许重试");
  }
}

try {
  await waitFor(() => document.querySelector(".connection-state")?.textContent.includes("已连接"));
  if (["available", "reload", "skip"].includes(flow)) {
    await waitFor(() => sidebarHint(), "侧栏应提示新版本或重新加载");
    assert(sidebarHint().textContent === (flow === "reload" ? "需重新加载" : "新版本"), "侧栏提示文案不符");
    sidebarHint().click();
  } else {
    await openConnection();
  }
  await waitFor(() => active() === "本机连接" && card(), "应打开本机连接设置");
  if (flow === "available" || flow === "narrow") await upgrade({ outcome: "upgraded" });
  else if (flow === "failed") await upgrade({ outcome: "rolled_back" });
  else if (flow === "reload") {
    await waitFor(() => status().includes("本机服务已是 0.1.19，扩展仍在运行 0.1.18"), "应说明扩展版本落后");
    assert(!button("升级到 0.1.19"), "需要重新加载时不应再提供升级");
    button("重新加载扩展").click();
    await waitFor(() => reloads() === 1, "应请求重新加载扩展");
  } else if (flow === "blocked") {
    await waitFor(() => button("升级到 0.1.19"));
    assert(button("升级到 0.1.19").disabled, "服务拒绝时升级按钮应禁用");
    assert(status().includes("请等待当前任务"), "应显示服务给出的原因");
  } else if (flow === "check-failed") {
    await waitFor(() => card().querySelector('[role="alert"]')?.textContent.includes("无法检查更新"), "应显示检查失败");
    button("检查更新").click();
    await waitFor(() => button("正在检查…")?.disabled, "检查中应禁用按钮");
    await waitFor(() => button("检查更新"), "检查结束后应恢复按钮");
    assert(card().querySelector('[role="alert"]')?.textContent.includes("无法检查更新"), "仍失败时应保留提示");
  } else if (flow === "found") {
    // Scenario: user checks for updates from settings and sees what is new
    //   Given the card says the installation is current
    //   When the user clicks 检查更新 and GitHub has 0.1.19
    //   Then the card shows 0.1.18 → 0.1.19, the highlights and an enabled upgrade
    await waitFor(() => status().includes("已是最新正式版本") && button("检查更新"), "应先显示已是最新");
    assert(button("检查更新").className.includes("secondary"), "检查更新应是明显的按钮");
    button("检查更新").click();
    await waitFor(() => button("升级到 0.1.19") && !button("升级到 0.1.19").disabled, "检查后应提供升级");
    assert(card().textContent.includes("发现新版本 0.1.19") && status().includes("QC-Reframe v0.1.19 已发布"), "应说明发现的新版本");
    assert(card().querySelector(".settings-version-pair")?.textContent.replace(/\s/g, "") === "0.1.18→0.1.19", "应显示当前与最新版本");
    assert(highlights().join("|") === "主动检查更新|新版本提醒", "应显示更新内容");
    assert(button("跳过此版本"), "应可跳过此版本");
  } else if (flow === "skip") {
    // Scenario: user skips a release from settings and can still upgrade to it
    //   Given 0.1.19 is offered and pointed out in the sidebar
    //   When the user clicks 跳过此版本
    //   Then the sidebar stops pointing it out and the upgrade stays available
    await waitFor(() => button("跳过此版本"), "应提供跳过此版本");
    button("跳过此版本").click();
    await waitFor(() => card().textContent.includes("不再提醒 0.1.19"), "应确认已跳过");
    await waitFor(() => !sidebarHint(), "跳过后侧栏不应再提示新版本");
    assert(!button("跳过此版本") && status().includes("已跳过此版本的提醒"), "跳过后应说明仍可升级");
    assert(button("升级到 0.1.19") && !button("升级到 0.1.19").disabled, "跳过后仍可升级");
  } else if (flow === "current") {
    await waitFor(() => status().includes("已是最新正式版本"), "应说明已是最新");
    assert(!button("升级到 0.1.19") && !sidebarHint(), "已是最新时不应提供升级");
    button("检查更新").click();
    await waitFor(() => card().textContent.includes("已是最新正式版本（0.1.18）"), "手动检查应给出结果");
    const toggle = card().querySelector('input[role="switch"]');
    assert(toggle.checked, "默认开启自动检查");
    assert(toggle.closest("label").textContent === "自动检查并提醒新版本", "开关应说明会提醒新版本");
    toggle.click();
    await waitFor(() => !card().querySelector('input[role="switch"]').checked && !card().querySelector('input[role="switch"]').disabled, "应能关闭自动检查");
    await new Promise(resolve => setTimeout(resolve, 5500));
    assert(!card().querySelector('input[role="switch"]').checked, "关闭后重新读取仍应保持关闭");
  } else throw new Error(`未知场景 ${flow}`);
  document.querySelector("#preview-notice").textContent = `插件内升级回归：PASS · ${flow}`;
  document.documentElement.dataset.upgradeRegression = "passed";
} catch (error) {
  document.querySelector("#preview-notice").textContent = `插件内升级回归：FAIL · ${flow} · ${error.message}`;
  document.documentElement.dataset.upgradeRegression = "failed";
  console.error(error);
}
