import { browser } from "wxt/browser";

const DRAFT_TTL = 24 * 60 * 60 * 1000;

// Quick-panel drafts and workspace handoffs live only in session storage. One queue
// serializes every write so rapid input and simultaneous panels cannot reorder drafts.
export function createDraftStore() {
  // Serialize session writes so rapid input and simultaneous panels cannot reorder drafts.
  let sessionWrite: Promise<unknown> = Promise.resolve();
  const sessionTask = <T,>(action: () => Promise<T>) => {
    const task = sessionWrite.catch(() => {}).then(action);
    sessionWrite = task;
    return task;
  };
  const storeDraft = (key: string, value: Record<string, any>, transferFrom?: string) => {
    return sessionTask(async () => {
      const all = await browser.storage.session.get(null);
      for (const [storedKey, item] of Object.entries(all)) {
        if (!storedKey.startsWith("quick:") && !storedKey.startsWith("workspace:")) continue;
        const createdAt = (item as { createdAt?: number })?.createdAt;
        if (!createdAt || Date.now() - createdAt > DRAFT_TTL) {
          await browser.storage.session.remove(storedKey); delete all[storedKey];
        }
      }
      const original = transferFrom ? all[transferFrom] as Record<string, any> | undefined : undefined;
      const shared = original?.handoff ? all[original.handoff] as Record<string, any> | undefined : original;
      if (shared?.draft && value.draft) {
        const draft = { ...shared.draft, ...value.draft };
        for (const name of ["multiSubjectDrafts", "subjectDrafts", "instructions", "versions", "promptDrafts"])
          draft[name] = { ...shared.draft[name], ...value.draft[name] };
        value.draft = draft;
      }
      const changes = { [key]: value, ...(transferFrom ? { [transferFrom]: { createdAt: value.createdAt, handoff: key } } : {}) };
      if (transferFrom) value.source = transferFrom;
      if (new TextEncoder().encode(JSON.stringify({ ...all, ...changes })).length > 9 * 1024 * 1024)
        throw new Error("临时草稿空间不足，请先在已打开的工作台保存草稿");
      await browser.storage.session.set(changes);
    });
  };
  const consumeHandoff = (key: string) => {
    return sessionTask(async () => {
      const value = (await browser.storage.session.get(key))[key] as Record<string, any> | undefined;
      if (value?.source) {
        const quick = (await browser.storage.session.get(value.source))[value.source] as { handoff?: string } | undefined;
        // Transfer ownership without ever storing two copies of the image payload.
        if (quick?.handoff === key) await browser.storage.session.set({ [key]: null, [value.source]: { ...value, source: undefined } });
      }
      await browser.storage.session.remove(key);
      return value && Date.now() - value.createdAt <= DRAFT_TTL ? value : undefined;
    });
  };
  // A quick draft may point at the workspace handoff that took ownership of its payload.
  const readQuick = (key: string) => sessionTask(async () => {
    let value = (await browser.storage.session.get(key))[key] as Record<string, any> | undefined;
    if (value?.handoff) value = (await browser.storage.session.get(value.handoff))[value.handoff] as Record<string, any> | undefined;
    if (value && Date.now() - value.createdAt <= DRAFT_TTL) return value;
    await browser.storage.session.remove(key);
    return;
  });
  return { store: storeDraft, consume: consumeHandoff, readQuick };
}
