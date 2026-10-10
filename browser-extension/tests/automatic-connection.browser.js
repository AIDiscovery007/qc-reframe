// Given an unpaired UI and an offline service, When the next health poll succeeds,
// Then connection recovers without a pairing form, forced navigation, or loss of settings.
const waitFor = async predicate => {
  const deadline = Date.now() + 18000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待自动连接超时");
    await new Promise(resolve => setTimeout(resolve, 30));
  }
};
const assert = (value, message) => { if (!value) throw new Error(message); };
try {
  const workspace = location.pathname.includes('workspace');
  await waitFor(() => document.querySelector('.error')?.textContent.includes('启动后将自动连接'));
  assert(!document.querySelector('.settings-center, .settings.card'), '首次缺少凭据不应强制打开设置');
  assert(!document.querySelector('#pair-token, .settings-pair-label'), '不应显示配对表单');
  document.querySelector(workspace ? '[aria-label="设置中心"]' : '[aria-label="设置"]').click();
  if (workspace) {
    await waitFor(() => document.querySelector('.settings-center'));
    [...document.querySelectorAll('.settings-center-nav button')].find(button => button.textContent === '界面与动效').click();
    await waitFor(() => document.querySelector('#appearance-title'));
    assert(!document.querySelector('.settings-center select').disabled, '断线时本地设置仍可用');
  }
  await waitFor(() => document.querySelector(workspace ? '.connection-state' : '.connection')?.textContent.includes('本机服务已连接'));
  if (workspace) assert(document.querySelector('.settings-center-nav [aria-current="page"]')?.textContent === '界面与动效', '恢复连接不得切走用户当前设置');
  assert(!document.querySelector('#pair-token'), '恢复连接后不出现重新配对入口');
  assert(!document.body.textContent.includes('如何获取配对码'), '轻量端也移除启动说明');
  document.documentElement.dataset.connectionRegression = 'passed';
  document.querySelector('#preview-notice').textContent = '自动连接回归：PASS · 首次断开 / 自动恢复 / 设置保留 / 无配对表单';
} catch (error) {
  document.documentElement.dataset.connectionRegression = 'failed';
  document.querySelector('#preview-notice').textContent = `自动连接回归：FAIL · ${error.message}`;
  console.error(error);
}
