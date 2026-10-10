// Production settings with preview messages; all CLI and model operations are synthetic.
export async function checkAgentSettings(page, scenario, capture) {
  const checks = [], state = scenario.settingsUi;
  const record = (ok, target, expected, actual) => checks.push({ ruleId: 'UI-EXAMPLE-STATE', status: ok ? 'passed' : 'failed', target, expected, actual });
  const geometry = async target => {
    const actual = await page.locator(target).evaluate(node => {
      const content = node.closest('.settings-center-content'), bounds = content.getBoundingClientRect();
      return { overflow: content.scrollWidth - content.clientWidth, width: node.getBoundingClientRect().width,
        escaped: [...node.querySelectorAll('button, select, code, .settings-agent-card, [role="alert"]')].filter(child => {
          const box = child.getBoundingClientRect();
          return box.width && (box.left < bounds.left - 1 || box.right > bounds.right + 1);
        }).map(child => child.tagName) };
    });
    record(actual.overflow <= 1 && !actual.escaped.length && actual.width >= 250, target, 'readable >=250px content, no horizontal overflow or escaped controls', actual);
  };
  await page.waitForFunction(() => document.querySelector('.connection-state')?.textContent.includes('已连接'));
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'alchemy:open-workspace', view: 'settings', section: 'models', context: { mode: 'recreate' } }));
  await page.locator('.model-settings').waitFor();
  if (state === 'loading') {
    record(await page.locator('.model-settings').getAttribute('aria-busy') === 'true', 'model loading', 'busy and explicit loading text', await page.locator('.settings-model-feature').innerText());
  } else {
    await page.waitForFunction(() => document.querySelector('.model-settings')?.getAttribute('aria-busy') === 'false');
    await page.waitForFunction(() => document.querySelector('.agent-cli-settings .settings-chip')?.textContent !== '检测中');
  }
  record(await page.locator('.agent-management-target h3').count() === 1, 'single CLI heading', 'one CLI heading without a duplicate management title', await page.locator('.agent-management-target h3').allTextContents());
  record(!(await page.locator('.agent-cli-settings').innerText()).includes('功能接口检查通过'), 'quiet compatibility success', 'normal compatibility success text omitted', await page.locator('.agent-cli-settings > p').allTextContents());
  await geometry('.agent-settings > .model-settings');
  await capture('model');
  await page.locator('.settings-model-fields').scrollIntoViewIfNeeded();
  await capture('form');
  const radio = page.locator('input[name="reverse-agent"][value="pi"]');
  if (['wide', 'narrow'].includes(state)) {
    await radio.focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('input[value="pi"][name="reverse-agent"]')?.checked && document.querySelector('.model-settings select')?.value === 'preview/pi-model');
    record(await radio.evaluate(node => document.activeElement === node), 'Agent keyboard selection', 'Space saves Pi and preserves radio focus', await radio.isChecked());
    record(await radio.evaluate(node => getComputedStyle(node.closest('label')).boxShadow !== 'none'), 'Agent focus', 'visible inset focus on card', await radio.evaluate(node => getComputedStyle(node.closest('label')).boxShadow));
    await page.waitForFunction(() => document.querySelector('.model-settings .primary')?.getAttribute('aria-disabled') === 'false');
    const primary = page.locator('.model-settings .primary');
    await primary.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.model-settings .primary')?.textContent.includes('正在验证'));
    record(await primary.evaluate(node => document.activeElement === node && node.getAttribute('aria-disabled') === 'true'), 'verification focus', 'busy primary keeps keyboard focus and blocks duplicates', await primary.innerText());
    await page.waitForFunction(() => document.querySelector('.model-settings .primary')?.getAttribute('aria-disabled') === 'false');
    record((await primary.innerText()).includes('已验证'), 'verified configuration', 'successful Pi configuration shows a checkmark and 已验证', await primary.innerText());
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'alchemy:open-workspace', view: 'settings', section: 'cli', context: { mode: 'recreate' } }));
    const management = page.locator('.agent-management-target');
    await page.waitForFunction(() => document.activeElement === document.querySelector('.agent-management-target'));
    record(await management.evaluate(node => document.activeElement === node && node.tabIndex === -1 && node.getAttribute('role') === 'group'), 'management recovery focus', 'legacy CLI recovery focuses named current management group', await management.getAttribute('aria-label'));
    record(await radio.isChecked() && (await page.locator('.agent-cli-settings h3').innerText()) === 'Pi CLI', 'management follows Agent', 'Codex recovery preserves selected Pi and points to Codex card', await page.locator('.agent-management-target').innerText());
    await page.keyboard.press('Tab');
    record(await page.locator('.agent-cli-settings .primary').evaluate(node => document.activeElement === node), 'management tab order', 'Tab reaches current Agent install action', await page.locator('.agent-cli-settings .primary').innerText());
    await page.locator('input[name="reverse-agent"][value="codex"]').focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('.agent-cli-settings h3')?.textContent === 'Codex CLI');
    record((await management.getAttribute('aria-label')) === 'Codex CLI 管理' && await management.locator('h3').count() === 1, 'management heading', 'card selection updates single CLI heading and accessible group name', await management.locator('h3').innerText());
  }
  await page.locator('.agent-management-target').scrollIntoViewIfNeeded();
  await geometry('.agent-management-target');
  const panel = page.locator('.agent-cli-settings');
  if (['updating', 'installing'].includes(state)) {
    record(await panel.getAttribute('aria-busy') === 'true' && await panel.getByRole('button').first().isDisabled(), 'CLI running', 'explicit busy state, operations disabled', await panel.locator('.settings-operation-status').innerText());
  } else if (state === 'missing') {
    record(await panel.getByRole('link', { name: '查看 Codex 安装说明' }).isVisible(), 'CLI missing', 'official installation action', await panel.innerText());
  } else if (state === 'failed') {
    record(await panel.getByRole('alert').isVisible(), 'CLI failure', 'visible failure and enabled retry', await panel.getByRole('alert').innerText());
    record(await panel.getByRole('button', { name: '重新检测并检查更新' }).isEnabled(), 'CLI retry', 'enabled', 'enabled');
  } else if (state === 'custom') {
    record(await panel.locator('.primary').count() === 0 && (await panel.innerText()).includes('原安装方式'), 'unmanaged CLI', 'original-channel instructions, no automatic update', await panel.innerText());
  }
  await capture('management');
  if (state === 'narrow') {
    await panel.locator('summary').click();
    await panel.locator('code').first().scrollIntoViewIfNeeded();
    await geometry('.agent-management-target');
    await capture('long-path');
  }
  return checks;
}
