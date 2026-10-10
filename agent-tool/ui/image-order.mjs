// Playwright keyboard input drives the production popup; preview messages only track save completion.
export async function checkImageOrderKeyboard(page, scenario) {
  const checks = [], which = scenario.keyboardCase;
  const record = (target, expected, actual) => checks.push({ ruleId: 'UI-BEHAVIOR', target,
    status: JSON.stringify(actual) === JSON.stringify(expected) ? 'passed' : 'failed', expected, actual });
  const subject = page.getByRole('button', { name: '查看主体图', exact: true });
  const versions = page.getByRole('combobox', { name: '提示词版本', exact: true });
  await subject.locator('img').waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="逆向模式"]')?.disabled);
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.imageOrderSaves = { started: 0, completed: 0 };
    chrome.runtime.sendMessage = async message => {
      const saving = message.type === 'alchemy:update-project-input';
      if (saving) window.imageOrderSaves.started++;
      try { return await send(message); }
      finally { if (saving) window.imageOrderSaves.completed++; }
    };
  });
  await subject.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[aria-label="查看主体图"]')?.getAttribute('aria-pressed') === 'true');
  const fresh = which === 'new', direction = fresh ? '图片前移' : '图片后移';
  const move = page.getByRole('button', { name: direction, exact: true });
  await move.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.imageOrderSaves.started === 1);
  if (which === 'failure') {
    // Saving disables mode/version navigation. Focus an enabled control without opening it.
    const settings = page.getByRole('button', { name: '设置', exact: true });
    await settings.focus();
    record('focus can move away from a pending reorder', true, await settings.evaluate(node => node === document.activeElement));
  } else if (which === 'late') {
    // Another window can change the global selection while this popup is saving.
    // Exercise that public message/polling path without bypassing disabled controls.
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'alchemy:open-project', id: 'b'.repeat(64) }));
    await page.getByRole('heading', { name: '另一个空白项目', exact: true }).waitFor();
    const reference = page.getByRole('button', { name: '查看参考图', exact: true });
    await reference.focus(); await page.keyboard.press('Enter');
    record('project switch really precedes the delayed response', 0, await page.evaluate(() => window.imageOrderSaves.completed));
  }
  await page.waitForFunction(() => window.imageOrderSaves.completed === 1);
  if (which === 'failure') await page.locator('.quick-workspace [role="alert"]').filter({ hasText: '保存失败' }).waitFor();
  else if (which !== 'late') await page.waitForFunction(() => document.querySelector('[aria-label="提示词版本"]')?.value === 'new');
  // Let React commit the async response and run its focus effects before observing.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const actual = await page.evaluate(() => ({
    selected: document.querySelector('.quick-filmstrip [aria-pressed="true"]')?.getAttribute('aria-label'),
    focused: document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName,
    version: document.querySelector('[aria-label="提示词版本"]')?.value,
    title: document.querySelector('.quick-heading h1')?.textContent,
    images: [...document.querySelectorAll('.quick-filmstrip button[aria-description]')].map(button => button.getAttribute('aria-label')),
    completed: window.imageOrderSaves.completed,
  }));
  if (which === 'late') {
    record('late response preserves the newly selected project and focus',
      { selected: '查看参考图', focused: '查看参考图', title: '另一个空白项目' },
      { selected: actual.selected, focused: actual.focused, title: actual.title });
  } else if (which === 'failure') {
    record('failure preserves original order and does not steal focus',
      { selected: '查看主体图', focused: '设置', images: ['查看主体图', '查看参考图'] },
      { selected: actual.selected, focused: actual.focused, images: actual.images });
  } else {
    record('successful keyboard reorder retains the selected image and focus',
      { selected: '查看主体图', focused: '查看主体图', version: 'new', images: fresh ? ['查看主体图', '查看参考图'] : ['查看参考图', '查看主体图'] },
      { selected: actual.selected, focused: actual.focused, version: actual.version, images: actual.images });
  }
  if (which === 'new' || which === 'history') {
    await page.keyboard.press('Tab');
    const next = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName);
    checks.push({ ruleId: 'UI-BEHAVIOR', target: 'native Tab after successful reorder',
      status: next && next !== 'BODY' ? 'passed' : 'skipped', expected: 'focus leaves the moved image without falling to BODY', actual: next,
      message: next && next !== 'BODY' ? 'One native Tab step observed; not a complete tab-order audit.' : 'This platform did not expose a next focused control; subsequent Tab navigation remains unverified.' });
  }
  return checks;
}
