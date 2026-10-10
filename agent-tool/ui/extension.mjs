import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceState, fingerprint } from './inventory.mjs';
import { validationWindow } from './build.mjs';

const require = createRequire(new URL('../../browser-extension/package.json', import.meta.url));
const { chromium } = require('playwright');
const sharp = require('sharp');
const defaultExtension = fileURLToPath(new URL('../../browser-extension/.output/chrome-mv3/', import.meta.url));
const hostSelector = 'html > div[data-motion]';
const hostHTML = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Reframe isolated extension fixture</title>
<style>html{background:#edf2f5;color:#07131d;font:16px Arial}body{margin:32px}
button{background:rgb(237,51,159)!important;color:rgb(7,13,29)!important;font:23px Arial!important;border:3px solid #07131d!important;border-radius:0!important;padding:8px!important}
#sentinel{position:static!important;display:block!important;width:240px!important;height:54px!important;margin:0 0 20px!important}
#fixture-image{display:block;width:480px;height:420px;object-fit:contain}</style>
<button id="sentinel" class="app panel">Host sentinel</button><img id="fixture-image" src="/image.png" alt="Synthetic geometry fixture" width="480" height="420"></html>`;

async function buildState(extensionPath) {
  const stamp = JSON.parse(await readFile(join(extensionPath, '../ui-build.json'), 'utf8').catch(() => { throw new Error('缺少 UI 构建指纹；先运行 node agent-tool/ui.mjs verify，再运行 extension。'); }));
  const [source, buildHash] = await Promise.all([sourceState(), fingerprint(extensionPath)]);
  if (stamp.sourceHash !== source.hash || stamp.buildHash !== buildHash) throw new Error('源码或构建与 UI 指纹不符；先运行 node agent-tool/ui.mjs verify 重新构建，再运行 extension。');
  return { sourceHash: source.hash, buildHash, revision: source.revision, dirty: source.dirty };
}

function markdownReport(report) {
  const cell = value => (typeof value === 'string' ? value : JSON.stringify(value)).replaceAll('|', '\\|').replaceAll('\n', ' ');
  return `# Isolated real-extension verification\n\nStatus: **${report.status}**\n\n` +
    `Chromium ${report.environment.chromium || 'not launched'}; temporary profile removed: ${report.environment.profileRemoved}; production bundle modified: false.\n\n` +
    '| Check | Status | Target | Actual |\n| --- | --- | --- | --- |\n' +
    report.checks.map(item => `| ${item.ruleId} | ${item.status} | ${cell(item.target)} | ${cell(item.actual)} |`).join('\n') +
    '\n\n## Evidence\n\n' + Object.entries(report.evidence).filter(([key]) => key !== 'directory').map(([key, path]) => `- [${key}](${path})`).join('\n') +
    '\n\n## Uncovered\n\n' + report.uncovered.map(item => `- ${item}`).join('\n') + '\n';
}

// This server is also the browser's HTTP proxy. It NEVER forwards a request.
async function fixtureServer(image, blocked) {
  let origin;
  const sockets = new Set();
  const server = createServer((request, response) => {
    let target;
    try { target = new URL(request.url, origin); }
    catch { response.writeHead(400); response.end(); return; }
    if (target.origin !== origin) {
      blocked.push({ method: request.method, target: target.origin });
      response.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      response.end(JSON.stringify({ error: 'Blocked by isolated UI fixture proxy' }));
      return;
    }
    if (request.method !== 'GET' || !['/', '/image.png', '/favicon.ico'].includes(target.pathname)) {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { 'Content-Type': target.pathname === '/image.png' ? 'image/png' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(target.pathname === '/image.png' ? image : target.pathname === '/' ? hostHTML : '');
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {}); // Browser cancellation commonly resets denied proxy connections.
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (request, socket) => {
    blocked.push({ method: 'CONNECT', target: request.url });
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, sockets };
}

// This probe sees only the page's public host via ordinary DOM hit-testing.
function visibleHostControls(selector) {
  const host = document.querySelector(selector), box = document.getElementById('fixture-image').getBoundingClientRect(), hits = [];
  for (let y = box.top + 4; y < box.bottom; y += 8) for (let x = box.left + 4; x < box.right; x += 8) if (document.elementFromPoint(x, y) === host) hits.push({ x, y });
  return hits.length ? { x: hits.reduce((sum, point) => sum + point.x, 0) / hits.length, y: hits.reduce((sum, point) => sum + point.y, 0) / hits.length, samples: hits.length } : false;
}

async function changedPixels(first, second) {
  const a = await sharp(first).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(second).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) throw new Error('Screenshot dimensions changed during the interaction');
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 3) if (Math.abs(a.data[i] - b.data[i]) > 20 || Math.abs(a.data[i + 1] - b.data[i + 1]) > 20 || Math.abs(a.data[i + 2] - b.data[i + 2]) > 20) changed++;
  return changed;
}

async function sentinel(page) {
  return page.evaluate(() => {
    const button = document.getElementById('sentinel'), style = getComputedStyle(button);
    return { color: style.color, background: style.backgroundColor, fontSize: style.fontSize, radius: style.borderRadius,
      width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height,
      styleSheets: document.styleSheets.length, leakedToken: getComputedStyle(document.documentElement).getPropertyValue('--yellow').trim() };
  });
}

/** Requires Playwright's Chromium and an existing MV3 build. Never rebuilds or changes the extension bundle. */
export function verifyExtension(options = {}) { return validationWindow('extension', () => runExtension(options)); }

async function runExtension({ progress = () => {}, extensionPath = defaultExtension } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'reframe-ui-extension-'));
  const profile = join(directory, 'profile');
  const pageErrors = [];
  const report = { status: 'failed', checks: [], evidence: { directory }, uncovered: [
    'Closed Shadow DOM internals, exact inner geometry and the identity of its focused element are not inspected.',
    'The extension popup is opened as its real extension URL; the browser toolbar/action popup chrome is not exercised.',
    'The panel is opened through its existing alchemy:show message; image capture, pairing, projects, bridge and model execution are not covered.',
    'Fresh temporary Chromium profile only; existing user profiles and installed-extension upgrade behavior are not covered.',
  ], environment: { platform: process.platform, arch: process.arch, node: process.version, channel: 'chromium', headless: true,
    extensionPath, locale: 'zh-CN', timezone: 'Asia/Taipei', viewport: { width: 1100, height: 820 }, dpr: 1, motion: 'reduce',
    productionBundleModified: false, profile, network: 'Deny-forward localhost HTTP proxy; implicit loopback bypass disabled; no real bridge/model access', blockedRequests: [] } };
  let context, server, sockets, host, beforeState, closing, current = 'UI-EXTENSION-BUILD', interrupted, traceStarted = false;
  const closeBrowser = () => closing ??= context?.close().catch(() => {});
  const check = (ruleId, target, actual, expected, passed) => {
    report.checks.push({ ruleId, target, actual, expected, status: passed ? 'passed' : 'failed' });
    if (!passed) throw new Error(`${ruleId}: ${target}`);
  };
  const interrupt = signal => {
    interrupted = signal;
    report.status = 'failed';
    report.environment.interrupted = signal;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    void closeBrowser();
  };
  const signals = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, () => interrupt(signal)]));
  for (const [signal, handler] of Object.entries(signals)) process.on(signal, handler);
  const deadline = setTimeout(() => { interrupted = '45 second deadline'; void closeBrowser(); }, 45000);
  const screenshot = async (page, key) => {
    const path = join(directory, `${key}.png`);
    const buffer = await page.screenshot({ path, animations: 'disabled' });
    report.evidence[key] = path;
    return buffer;
  };
  try {
    beforeState = await buildState(extensionPath);
    if (interrupted) throw new Error(interrupted);
    report.environment.before = beforeState;
    check(current, 'Build and source fingerprints before launch', beforeState, 'Current source and unchanged stamped build', true);
    current = 'UI-EXTENSION-LOAD';
    const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
    if (manifest.manifest_version !== 3 || !manifest.background?.service_worker || !manifest.action?.default_popup) throw new Error('Expected an MV3 build with a service worker and popup');
    report.environment.extensionVersion = manifest.version;
    const image = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="420"><rect width="480" height="420" fill="#d5e4df"/><circle cx="190" cy="190" r="100" fill="#649794"/><path d="M70 340H410V370H70Z" fill="#bd7358"/></svg>')).png().toBuffer();
    const fixture = await fixtureServer(image, report.environment.blockedRequests);
    server = fixture.server;
    sockets = fixture.sockets;
    report.environment.fixtureOrigin = fixture.origin;
    progress('真实扩展：启动隔离 Chromium，网络只允许自己的合成宿主页。');
    // Official recipe: playwright.dev/docs/chrome-extensions. No Chrome user profile is reused.
    // <-loopback> is Chromium's documented test-only subtraction of implicit proxy bypass rules.
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, timeout: 20000, viewport: report.environment.viewport,
      locale: 'zh-CN', timezoneId: 'Asia/Taipei', deviceScaleFactor: 1, reducedMotion: 'reduce',
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
        `--proxy-server=${fixture.origin}`, '--proxy-bypass-list=<-loopback>', '--disable-quic'],
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    });
    if (interrupted) throw new Error(interrupted);
    context.setDefaultTimeout(10000);
    context.on('page', page => page.on('pageerror', error => pageErrors.push({ page: page.url(), message: error.message })));
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false }); traceStarted = true;
    report.environment.chromium = context.browser()?.version();
    const worker = context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension://')) ?? await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extensionId = new URL(worker.url()).hostname;
    const loaded = await worker.evaluate(() => ({ id: chrome.runtime.id, version: chrome.runtime.getManifest().version }));
    report.environment.extensionId = extensionId;
    check(current, 'Actual MV3 service worker', loaded, { id: extensionId, version: manifest.version }, loaded.id === extensionId && loaded.version === manifest.version);
    // Only this disposable profile's public motion preference is seeded. No pairing token or business data.
    await worker.evaluate(() => chrome.storage.local.set({ motionPreference: 'reduce' }));
    current = 'UI-EXTENSION-NETWORK';
    const blockedOrigin = fixture.origin.replace('127.0.0.1', '127.0.0.2');
    const blockedStatus = await worker.evaluate(async url => (await fetch(`${url}/isolation-probe`)).status, blockedOrigin);
    check(current, 'Loopback HTTP is intercepted, never forwarded', blockedStatus, 403,
      blockedStatus === 403 && report.environment.blockedRequests.some(request => request.target === blockedOrigin));
    const httpsBlocked = await worker.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, blockedOrigin.replace('http:', 'https:'));
    check(current, 'HTTPS CONNECT is rejected by the local proxy', httpsBlocked, true, httpsBlocked && report.environment.blockedRequests.some(request => request.method === 'CONNECT' && request.target === new URL(blockedOrigin).host));
    current = 'UI-EXTENSION-POPUP';
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/${manifest.action.default_popup}`);
    await popup.locator('.app').waitFor({ state: 'visible' });
    const popupState = await popup.evaluate(() => ({ token: getComputedStyle(document.querySelector('.app')).getPropertyValue('--yellow').trim(), sheets: document.styleSheets.length, text: document.body.innerText }));
    check(current, 'Production popup loads styles and unpaired UI', { token: popupState.token, sheets: popupState.sheets, unpaired: popupState.text.includes('本机未连接') }, 'Brand token, stylesheet and unpaired state', !!popupState.token && popupState.sheets > 0 && popupState.text.includes('本机未连接'));
    const settings = popup.getByRole('button', { name: '设置', exact: true });
    await settings.click();
    const firstState = await settings.getAttribute('aria-expanded');
    await settings.press('Enter');
    const secondState = await settings.getAttribute('aria-expanded');
    check(current, 'Real click and Enter toggle connection settings', { firstState, secondState }, 'Opposite aria-expanded states', ['true', 'false'].includes(firstState) && firstState !== secondState);
    await screenshot(popup, 'popup');
    current = 'UI-EXTENSION-CLOSED-SHADOW';
    host = await context.newPage();
    await host.goto(fixture.origin);
    await host.locator(hostSelector).waitFor({ state: 'attached' });
    const hostState = await host.locator(hostSelector).evaluate(element => ({ closed: element.shadowRoot === null, motion: element.dataset.motion, position: getComputedStyle(element).position }));
    check(current, 'Manifest content script injects a closed host', hostState, { closed: true, motion: 'reduce', position: 'fixed' }, hostState.closed && hostState.motion === 'reduce' && hostState.position === 'fixed');
    const before = await sentinel(host);
    check(current, 'Strong host styles and document stylesheets are isolated', before, 'One host stylesheet, no leaked --yellow, expected sentinel styles',
      before.styleSheets === 1 && !before.leakedToken && before.background === 'rgb(237, 51, 159)' && before.color === 'rgb(7, 13, 29)' && before.fontSize === '23px' && before.radius === '0px' && before.width === 240 && before.height === 54);
    await screenshot(host, 'host');
    progress('真实扩展：service worker、popup 与 closed Shadow host 已加载，验证真实点击及 Escape 焦点恢复。');
    current = 'UI-EXTENSION-MENU';
    await host.locator('#fixture-image').hover();
    const triggerHandle = await host.waitForFunction(visibleHostControls, hostSelector);
    const trigger = await triggerHandle.jsonValue(); await triggerHandle.dispose();
    const collapsed = await screenshot(host, 'menu-collapsed');
    await host.mouse.click(trigger.x, trigger.y);
    await host.waitForFunction(selector => document.activeElement === document.querySelector(selector), hostSelector);
    const opened = await screenshot(host, 'menu-open');
    const openSamples = (await host.evaluate(visibleHostControls, hostSelector)).samples;
    const openedPixels = await changedPixels(collapsed, opened);
    check(current, 'Trusted coordinate click opens image controls under strong page button styles', { trigger, changedPixels: openedPixels, openSamples }, 'Visible menu change and more hit-testable control area', openedPixels > 100 && openSamples > trigger.samples + 20);
    await host.keyboard.press('Escape');
    const escaped = await screenshot(host, 'menu-escape');
    const escapeSamples = (await host.evaluate(visibleHostControls, hostSelector)).samples;
    const closedPixels = await changedPixels(opened, escaped);
    await host.keyboard.press('ArrowDown');
    const reopened = await screenshot(host, 'menu-keyboard-reopen');
    const reopenSamples = (await host.evaluate(visibleHostControls, hostSelector)).samples;
    const reopenedPixels = await changedPixels(escaped, reopened);
    check(current, 'Escape closes controls and the restored trigger accepts ArrowDown', { closedPixels, reopenedPixels, escapeSamples, reopenSamples }, 'Visible close/reopen and matching hit-testable area', closedPixels > 100 && reopenedPixels > 100 && escapeSamples === trigger.samples && reopenSamples > escapeSamples + 20);
    await host.keyboard.press('Escape');
    current = 'UI-EXTENSION-FOCUS';
    await host.locator('#sentinel').click();
    const beforePanel = await screenshot(host, 'panel-before');
    const response = await worker.evaluate(async origin => {
      const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
      if (!tab?.id) throw new Error('Fixture tab not found');
      return chrome.tabs.sendMessage(tab.id, { type: 'alchemy:show' });
    }, fixture.origin);
    await host.waitForFunction(selector => document.activeElement === document.querySelector(selector), hostSelector);
    const panelOpen = await screenshot(host, 'panel-open');
    const panelOpenedPixels = await changedPixels(beforePanel, panelOpen);
    check(current, 'Existing runtime command opens the real panel and transfers focus into its host', { response, changedPixels: panelOpenedPixels }, 'Acknowledged command and visible panel', response?.ok === true && panelOpenedPixels > 1000);
    await host.keyboard.press('Escape');
    await host.locator('#sentinel').evaluate(element => { if (document.activeElement !== element) throw new Error('Escape did not restore host-page focus'); });
    const panelClosed = await screenshot(host, 'panel-closed');
    const panelClosedPixels = await changedPixels(panelOpen, panelClosed);
    check(current, 'Escape closes panel and restores the original host button focus', { focused: 'sentinel', changedPixels: panelClosedPixels }, 'Visible close and exact host focus restoration', panelClosedPixels > 1000);
    const after = await sentinel(host);
    check('UI-EXTENSION-CLOSED-SHADOW', 'Host styles remain unchanged after interactions', after, before, JSON.stringify(after) === JSON.stringify(before));
    check('UI-EXTENSION-PAGE-ERROR', 'Uncaught errors in extension and fixture pages', pageErrors, [], pageErrors.length === 0);
    report.status = 'passed';
  } catch (error) {
    if (!report.checks.some(check => check.ruleId === current && check.status === 'failed')) report.checks.push({ ruleId: current, target: 'Extension verification', status: 'failed', expected: 'Check completes', actual: interrupted || error.message });
    if (host && !host.isClosed()) await screenshot(host, 'failure').catch(() => {});
  } finally {
    clearTimeout(deadline);
    if (context) {
      if (traceStarted) {
        try { const path = join(directory, 'trace.zip'); await context.tracing.stop({ path }); report.evidence.trace = path; }
        catch (error) { report.environment.traceError = error.message; }
      }
      await closeBrowser();
    }
    if (server) { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    try { await rm(profile, { recursive: true, force: true }); report.environment.profileRemoved = true; }
    catch (error) { report.environment.profileRemoved = false; report.environment.cleanupError = error.message; }
    report.environment.browserClosed = !context?.browser()?.isConnected();
    report.environment.serverClosed = !server?.listening;
    const cleaned = report.environment.profileRemoved && report.environment.browserClosed && report.environment.serverClosed;
    report.checks.push({ ruleId: 'UI-EXTENSION-CLEANUP', target: 'Browser, temporary profile and fixture server', status: cleaned ? 'passed' : 'failed', expected: 'All released', actual: { profileRemoved: report.environment.profileRemoved, browserClosed: report.environment.browserClosed, serverClosed: report.environment.serverClosed } });
    if (!cleaned) report.status = 'failed';
    report.environment.interrupted = interrupted || null;
    report.environment.pageErrors = pageErrors;
    if (interrupted) report.status = 'failed';
    if (beforeState) {
      try {
        const after = await buildState(extensionPath);
        report.environment.after = after;
        check('UI-EXTENSION-BUILD', 'Build and source fingerprints after cleanup', after, beforeState, after.sourceHash === beforeState.sourceHash && after.buildHash === beforeState.buildHash);
      } catch (error) {
        report.status = 'failed';
        if (!report.checks.some(item => item.ruleId === 'UI-EXTENSION-BUILD' && item.status === 'failed')) report.checks.push({ ruleId: 'UI-EXTENSION-BUILD', target: 'Fingerprints after cleanup', status: 'failed', expected: beforeState, actual: error.message });
      }
    }
    report.evidence.report = join(directory, 'report.json');
    report.evidence.markdown = join(directory, 'report.md');
    report.reportPath = report.evidence.report;
    report.summaryPath = report.evidence.markdown;
    try {
      let savedSignal;
      do {
        savedSignal = interrupted;
        report.environment.interrupted = interrupted || null;
        if (interrupted) report.status = 'failed';
        await writeFile(report.evidence.report, JSON.stringify(report, null, 2));
        await writeFile(report.evidence.markdown, markdownReport(report));
      } while (savedSignal !== interrupted); // A signal during either write must also reach the persisted report.
    } finally {
      for (const [signal, handler] of Object.entries(signals)) process.removeListener(signal, handler);
    }
  }
  return report;
}
