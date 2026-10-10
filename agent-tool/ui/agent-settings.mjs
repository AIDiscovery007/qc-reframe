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
    await page.locator('.model-manage-link').focus(); await page.keyboard.press('Enter');
    record(await page.locator('.agent-management-target h3').first().evaluate(node => document.activeElement === node), 'management jump', 'keyboard focus follows management link', await page.locator('.agent-management-target select').inputValue());
    await page.keyboard.press('Tab');
    record(await page.locator('.agent-management-target select').evaluate(node => document.activeElement === node), 'management tab order', 'Tab enters management target', await page.locator('.agent-management-target select').inputValue());
    await page.locator('.agent-management-target select').selectOption('codex');
    await page.locator('.agent-cli-settings h3').filter({ hasText: 'Codex CLI' }).waitFor();
    record(await radio.isChecked(), 'independent management', 'managing Codex preserves Pi reverse selection', await radio.isChecked());
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
