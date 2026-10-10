// Real Enter/Tab input; synthetic preview messages observe requests without replacing UI actions.
export async function checkEndToEndKeyboard(page, scenario) {
  const checks = [], which = scenario.flowKeyboardCase, popup = scenario.surface === 'popup';
  const legacy = which === 'legacy', failure = which.includes('failure'), moving = which.startsWith('tab'), switching = which.startsWith('project');
  const record = (target, expected, actual) => checks.push({ ruleId: 'UI-BEHAVIOR', target,
    status: JSON.stringify(actual) === JSON.stringify(expected) ? 'passed' : 'failed', expected, actual });
  const controls = popup ? '.quick-submit-actions' : '.canvas-primary-actions';
  const mode = page.getByRole('combobox', { name: '逆向模式', exact: true });
  await page.waitForFunction(() => {
    const mode = document.querySelector('[aria-label="逆向模式"]');
    const reverse = document.querySelector('.quick-submit-actions .text-button, .canvas-generate');
    return mode && !mode.disabled && reverse && !reverse.disabled && reverse.getAttribute('aria-disabled') !== 'true';
  });
  await mode.selectOption('recreate');
  const chain = page.getByRole('button', { name: '逆向并生图', exact: true });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '逆向并生图' && !button.disabled && button.getAttribute('aria-disabled') !== 'true'));
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.endToEndKeyboard = { started: 0, settled: 0, jobId: null };
    chrome.runtime.sendMessage = async message => {
      if (message.type !== 'alchemy:start') return send(message);
      window.endToEndKeyboard.started++;
      try {
        const response = await send(message);
        window.endToEndKeyboard.jobId = response.value?.job?.id;
        return response;
      } finally { window.endToEndKeyboard.settled++; }
    };
  });
  const reverse = page.locator(popup ? '.quick-submit-actions .text-button' : '.canvas-generate').first();
  await reverse.focus(); await page.keyboard.press('Tab');
  record('native Tab reaches the continuous action after independent reverse', true, await chain.evaluate(node => node === document.activeElement));
  // If Tab order regresses, still exercise Enter on the intended action and retain the failed check.
  await chain.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.endToEndKeyboard.started === 1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  record('Enter submission retains focus on a reachable action', true, await page.evaluate(selector => {
    const node = document.activeElement;
    return !!node?.closest(selector) && node.tagName === 'BUTTON' && node.checkVisibility() && !node.disabled;
  }, controls));
  // A second real Enter while aria-disabled must not issue a duplicate request.
  await page.keyboard.press('Enter');
  record('pending Enter cannot submit twice', 1, await page.evaluate(() => window.endToEndKeyboard.started));
  const settings = page.getByRole('button', { name: popup ? '设置' : '设置中心', exact: true });
  if (moving) {
    let tabs = 0;
    // The stable settings control survives task and result rendering. Use actual Tab traversal,
    // including a possible browser-boundary step, rather than programmatic focus for this case.
    do { await page.keyboard.press('Tab'); tabs++; }
    while (tabs < 40 && !await settings.evaluate(node => node === document.activeElement));
    record('native Tab can leave submission for a stable control', true, await settings.evaluate(node => node === document.activeElement));
    record('user Tab precedes the delayed response', 0, await page.evaluate(() => window.endToEndKeyboard.settled));
  } else if (switching) {
    if (popup) await page.evaluate(() => chrome.runtime.sendMessage({ type: 'alchemy:open-project', id: 'b'.repeat(64) }));
    else await page.evaluate(() => { location.hash = 'workspace=' + new URLSearchParams({ task: '44444444-4444-4444-8444-444444444444', request: crypto.randomUUID() }); });
    await page.getByRole('heading', { name: '另一个空白项目', exact: true }).waitFor();
    await settings.focus();
    record('external project navigation precedes the delayed response', 0, await page.evaluate(() => window.endToEndKeyboard.settled));
  }
  await page.waitForFunction(() => window.endToEndKeyboard.settled === 1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (moving || switching) {
    record('late response does not steal the focus chosen by the user', true, await settings.evaluate(node => node === document.activeElement));
    if (switching) {
      record('late response preserves the newly opened project', true, await page.getByRole('heading', { name: '另一个空白项目', exact: true }).isVisible());
      record('late failure is not shown in the new project', false, await page.getByText('示例：逆向提交失败，请重试', { exact: false }).isVisible());
    }
  } else if (failure) {
    await page.getByText('示例：逆向提交失败，请重试', { exact: false }).first().waitFor();
    record('submission failure leaves focus on the retry action', true, await chain.evaluate(node => node === document.activeElement && !node.disabled && node.getAttribute('aria-disabled') !== 'true'));
    await page.keyboard.press('Shift+Tab');
    record('native Shift+Tab reaches independent reverse after failure', true, await reverse.evaluate(node => node === document.activeElement));
  } else {
    if (legacy) {
      await page.getByText('本机服务尚未支持连续生图，本次已提交仅逆向', { exact: false }).first().waitFor();
      record('legacy acceptance keeps reverse-only semantics with no automatic generation',
        { status: 'running', automatic: false, generations: 0 }, await page.evaluate(async () => {
          const { value } = await chrome.runtime.sendMessage({ type: 'alchemy:query', path: '/jobs/' + window.endToEndKeyboard.jobId });
          return { status: value.status, automatic: !!value.autoGeneration, generations: value.generations?.length || 0 };
        }));
    }
    const cancel = page.getByRole('button', { name: popup ? '取消' : '取消流程', exact: true });
    await cancel.waitFor();
    record('the running cancel action retains keyboard focus', true, await cancel.evaluate(node => node === document.activeElement));
    await page.keyboard.press('Enter');
    await page.waitForFunction(async legacy => {
      const { value } = await chrome.runtime.sendMessage({ type: 'alchemy:query', path: '/jobs/' + window.endToEndKeyboard.jobId });
      return legacy ? value?.status === 'cancelled' && !value.autoGeneration && !value.generations?.length : value?.autoGeneration?.status === 'cancelled';
    }, legacy);
    await chain.waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    record('keyboard cancellation returns to the original action without BODY focus', true, await chain.evaluate(node => node === document.activeElement && !node.disabled));
    await page.keyboard.press('Shift+Tab');
    record('native Shift+Tab still reaches independent reverse after cancellation', true, await reverse.evaluate(node => node === document.activeElement));
  }
  // Stop successful background fixtures after observing focus; this is cleanup, not UI coverage.
  if (!failure) await page.evaluate(async () => {
    const id = window.endToEndKeyboard.jobId;
    if (id) await chrome.runtime.sendMessage({ type: 'alchemy:cancel', id });
  });
  return checks;
}
