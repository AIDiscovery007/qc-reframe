import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withCodex } from "./codex-rpc.mjs";

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const summary = thread => ({ id: thread.id, title: (thread.name || thread.preview || "未命名会话").slice(0, 300), updatedAt: thread.updatedAt });
export function sessionIds(value, required = false) {
  if (!Array.isArray(value) || value.length > 5 || value.some(id => typeof id !== "string" || !uuid.test(id)))
    throw fail("请选择最多 5 个有效的本机会话");
  const ids = [...new Set(value.map(id => id.toLowerCase()))];
  if (required && !ids.length) throw fail("请先选择对话会话");
  return ids;
}

export function createSessionStore({ cwd, dataDir, run = withCodex }) {
  const operate = (signal, action) => run({ cwd, signal, timeoutMs: 120_000, maxResponseBytes: 24 * 1024 * 1024 }, request => {
    let responseBytes = 0;
    return action(async (method, params) => {
      const response = await request(method, params);
      responseBytes += Buffer.byteLength(JSON.stringify(response));
      if (responseBytes > 24 * 1024 * 1024) throw fail("所选会话读取数据超过 24 MB，未截断正文；请减少选择的会话后重试", 413);
      return response;
    });
  });
  async function readMetadata(request, id) {
    const { thread } = await request("thread/read", { threadId: id, includeTurns: false });
    if (thread?.id !== id || !Number.isFinite(thread.updatedAt) || thread.ephemeral)
      throw fail("会话不可读取，请刷新列表后重新选择", 409);
    if (thread.parentThreadId || (typeof thread.source === "object" && thread.source?.subAgent))
      throw fail("请选择完整的主会话，不支持子代理会话");
    return thread;
  }
  return {
    list(options = {}, signal) {
      if (Object.keys(options).some(key => !["searchTerm", "cursor", "archived"].includes(key)) ||
        (options.searchTerm !== undefined && (typeof options.searchTerm !== "string" || options.searchTerm.length > 200)) ||
        (options.cursor !== undefined && (typeof options.cursor !== "string" || !options.cursor || options.cursor.length > 4096)) ||
        (options.archived !== undefined && typeof options.archived !== "boolean")) throw fail("无效的会话查询");
      return operate(signal, async request => {
        const result = await request("thread/list", { limit: 30, sortKey: "updated_at", modelProviders: [],
          sourceKinds: ["cli", "vscode", "appServer", "exec", "unknown"], archived: false, ...options });
        if (!Array.isArray(result.data)) throw fail("Codex 会话列表格式不兼容，请更新 CLI", 503);
        return { data: result.data.filter(thread => uuid.test(thread.id) && !thread.ephemeral).map(summary), nextCursor: result.nextCursor || null };
      });
    },
    metadata(ids, signal) {
      return operate(signal, async request => {
        const sources = [];
        for (const id of sessionIds(ids)) sources.push(summary(await readMetadata(request, id)));
        return sources;
      });
    },
    capture(sources, { jobId, signal }) {
      if (!uuid.test(jobId)) throw fail("无效任务编号");
      sessionIds(sources.map(source => source.id), true);
      return operate(signal, async request => {
        const messages = [];
        let characters = 0, attachmentCount = 0, pages = 0;
        const append = (threadId, turns, paginated) => {
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
              characters += text.length;
              if (characters > 120_000) throw fail("所选会话正文超过 120000 字符，尚未读取完整；请减少选择的会话后重试", 413);
              messages.push({ threadId, turnId: turn.id, itemId: item.id, role: item.type === "userMessage" ? "user" : "assistant", text });
            }
          }
        };
        for (const source of sources) {
          signal?.throwIfAborted();
          const messageStart = messages.length;
          const metadata = await readMetadata(request, source.id);
          if (metadata.updatedAt !== source.updatedAt) throw fail("所选会话已更新，请重新选择后重试", 409);
          if (metadata.historyMode === "paginated") {
            let cursor;
            const seen = new Set(), turnIds = new Set();
            do {
              if (++pages > 200) throw fail("所选会话超过 200 页，未截断正文；请减少选择的会话后重试", 413);
              signal?.throwIfAborted();
              const page = await request("thread/turns/list", { threadId: source.id, limit: 50, sortDirection: "asc", itemsView: "full", ...(cursor ? { cursor } : {}) });
              if (!Array.isArray(page.data) || !(page.nextCursor === null || (typeof page.nextCursor === "string" && page.nextCursor.length))) throw fail("会话分页格式不兼容", 503);
              for (const turn of page.data) {
                if (turnIds.has(turn.id)) throw fail("会话分页发生变化，请重新选择后重试", 409);
                turnIds.add(turn.id);
              }
              append(source.id, page.data, true);
              cursor = page.nextCursor;
              if (cursor && (typeof cursor !== "string" || seen.has(cursor))) throw fail("会话分页游标无效", 503);
              seen.add(cursor);
            } while (cursor);
          } else {
            const { thread } = await request("thread/read", { threadId: source.id, includeTurns: true });
            if (!Array.isArray(thread?.turns)) throw fail("会话正文格式不兼容", 503);
            append(source.id, thread.turns, false);
          }
          if (messages.length === messageStart) throw fail("所选会话中有会话没有可用于创作的文字正文，请重新选择");
          if ((await readMetadata(request, source.id)).updatedAt !== source.updatedAt) throw fail("会话在读取期间已更新，请重新选择后重试", 409);
        }
        if (!messages.length) throw fail("所选会话没有可用于创作的文字正文");
        signal?.throwIfAborted();
        const snapshot = { version: 1, jobId, sources, capturedAt: new Date().toISOString(), messageCount: messages.length, attachmentCount, messages };
        snapshot.hash = createHash("sha256").update(JSON.stringify({ sources, messages, attachmentCount })).digest("hex");
        await writeFile(join(dataDir, `${jobId}-session-context.json`), JSON.stringify(snapshot), { flag: "wx", mode: 0o600 });
        signal?.throwIfAborted();
        return snapshot;
      });
    },
  };
}
