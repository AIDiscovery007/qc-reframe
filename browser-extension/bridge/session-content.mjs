const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const sessionSummary = thread => ({ id: thread.id, title: (thread.name || thread.preview || "未命名会话").slice(0, 300), updatedAt: thread.updatedAt });
export async function readSessionMetadata(request, id) {
  const { thread } = await request("thread/read", { threadId: id, includeTurns: false });
  if (thread?.id !== id || !Number.isFinite(thread.updatedAt) || thread.ephemeral)
    throw fail("会话不可读取，请刷新列表后重新选择", 409);
  if (thread.parentThreadId || (typeof thread.source === "object" && thread.source?.subAgent))
    throw fail("请选择完整的主会话，不支持子代理会话");
  return thread;
}
// Shared text policy for creative snapshots and the private search index.
export async function readSessionContent(request, source, { signal, budget = { characters: 0, pages: 0 }, maxCharacters = 120_000, maxPages = 200, allowEmpty = false } = {}) {
  const messages = [];
  let attachmentCount = 0;
  const append = (turns, paginated) => {
    for (const turn of turns) {
      if (!Array.isArray(turn.items) || (turn.itemsView !== undefined && turn.itemsView !== "full") || (paginated && turn.itemsView !== "full")) throw fail("会话正文未完整读取，请更新 CLI 后重试", 503);
      for (const item of turn.items) {
        let text;
        if (item.type === "userMessage") {
          if (!Array.isArray(item.content)) throw fail("会话正文格式不兼容", 503);
          attachmentCount += item.content.filter(part => part.type !== "text").length;
          text = item.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        } else if (item.type === "agentMessage" && (item.phase == null || item.phase === "final_answer")) text = item.text;
        if (typeof text !== "string" || !text.trim()) continue;
        budget.characters += text.length;
        if (budget.characters > maxCharacters) throw fail(`所选会话正文超过 ${maxCharacters} 字符，尚未读取完整；请减少选择的会话后重试`, 413);
        messages.push({ threadId: source.id, turnId: turn.id, itemId: item.id, role: item.type === "userMessage" ? "user" : "assistant", text });
      }
    }
  };
  signal?.throwIfAborted();
  const metadata = await readSessionMetadata(request, source.id);
  if (metadata.updatedAt !== source.updatedAt) throw fail("所选会话已更新，请重新选择后重试", 409);
  if (metadata.historyMode === "paginated") {
    let cursor;
    const seen = new Set(), turnIds = new Set();
    do {
      if (++budget.pages > maxPages) throw fail(`所选会话超过 ${maxPages} 页，未截断正文；请减少选择的会话后重试`, 413);
      signal?.throwIfAborted();
      const page = await request("thread/turns/list", { threadId: source.id, limit: 50, sortDirection: "asc", itemsView: "full", ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data) || !(page.nextCursor === null || (typeof page.nextCursor === "string" && page.nextCursor.length))) throw fail("会话分页格式不兼容", 503);
      for (const turn of page.data) {
        if (turnIds.has(turn.id)) throw fail("会话分页发生变化，请重新选择后重试", 409);
        turnIds.add(turn.id);
      }
      append(page.data, true);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw fail("会话分页游标无效", 503);
      seen.add(cursor);
    } while (cursor);
  } else {
    const { thread } = await request("thread/read", { threadId: source.id, includeTurns: true });
    if (!Array.isArray(thread?.turns)) throw fail("会话正文格式不兼容", 503);
    append(thread.turns, false);
  }
  if (!allowEmpty && !messages.length) throw fail("所选会话中有会话没有可用于创作的文字正文，请重新选择");
  if ((await readSessionMetadata(request, source.id)).updatedAt !== source.updatedAt) throw fail("会话在读取期间已更新，请重新选择后重试", 409);
  signal?.throwIfAborted();
  return { messages, attachmentCount };
}
