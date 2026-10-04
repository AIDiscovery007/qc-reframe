import { browser } from "wxt/browser";

let queue: Promise<unknown> = Promise.resolve();

export function openWorkspace(params: URLSearchParams, sourceTab?: number) {
  const next = queue.catch(() => {}).then(async () => {
    const base = browser.runtime.getURL('/workspace.html');
    const tabs = (await browser.tabs.query({ url: `${base}*` })).filter(tab =>
      (tab.pendingUrl || tab.url)?.split(/[?#]/)[0] === base && tab.id != null);
    tabs.sort((a, b) => Number(b.id === sourceTab) - Number(a.id === sourceTab)
      || Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const tab = tabs[0];
    if (!tab) { await browser.tabs.create({ url: `${base}?${params}` }); return; }
    // Only change the fragment: keep the live React tree and any unsaved drafts.
    params.set('request', crypto.randomUUID());
    await browser.tabs.update(tab.id!, { active: true, url: `${(tab.pendingUrl || tab.url)!.split('#')[0]}#workspace=${params}` });
    await browser.windows.update(tab.windowId, { focused: true });
  });
  queue = next;
  return next;
}
