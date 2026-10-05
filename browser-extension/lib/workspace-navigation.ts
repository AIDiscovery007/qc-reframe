import { browser } from "wxt/browser";

let queue: Promise<unknown> = Promise.resolve();

export function openWorkspace(params: URLSearchParams, sourceTab?: number) {
  const next = queue.catch(() => {}).then(async () => {
    const base = browser.runtime.getURL('/workspace.html');
    // Extension contexts identify our pages even when tabs URL access is restricted.
    const [allTabs, contexts] = await Promise.all([
      browser.tabs.query({}),
      Promise.resolve().then(() => browser.runtime.getContexts({ contextTypes: ["TAB"], frameIds: [0] })).catch(() => undefined),
    ]);
    const urls = new Map(contexts?.map(context => [context.tabId, context.documentUrl]));
    const tabs = allTabs.map(tab => ({ ...tab, url: tab.url || urls.get(tab.id!) })).filter(tab =>
      (tab.pendingUrl || tab.url)?.split(/[?#]/)[0] === base && tab.id != null);
    tabs.sort((a, b) => Number(b.id === sourceTab) - Number(a.id === sourceTab)
      || Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const tab = tabs[0];
    if (!tab && !contexts && allTabs.some(item => !item.pendingUrl && !item.url)) throw new Error("无法确认已打开的工作台，请重新加载扩展后重试");
    if (!tab) { await browser.tabs.create({ url: `${base}?${params}` }); return; }
    // Only change the fragment: keep the live React tree and any unsaved drafts.
    params.set('request', crypto.randomUUID());
    await browser.tabs.update(tab.id!, { active: true, url: `${(tab.pendingUrl || tab.url)!.split('#')[0]}#workspace=${params}` });
    await browser.windows.update(tab.windowId, { focused: true });
  });
  queue = next;
  return next;
}
