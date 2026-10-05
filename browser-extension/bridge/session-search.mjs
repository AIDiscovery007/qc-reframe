import { createSessionReader } from "./session-rpc.mjs";
import { createSessionIndexClient } from "./session-index-client.mjs";
import { clearSessionIndexFiles } from "./session-index-files.mjs";
import { readSessionContent, sessionSummary } from "./session-content.mjs";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const listParams = { limit: 30, sortKey: "updated_at", modelProviders: [], sourceKinds: ["cli", "vscode", "appServer", "exec", "unknown"] };

export function createSessionSearch({ cwd, directory, reader = createSessionReader({ cwd }), now = Date.now, cacheMs = 15_000, refreshMs = 300_000, maxSessions = 5000, syncTimeoutMs = 600_000 }) {
  const cache = new Map();
  let database, opening, running, controller, clearing, closed = false, lastAudit = 0;
  let state = { state: "empty", indexed: 0, total: 0, failed: 0, updatedAt: null };
  const db = async () => {
    if (closed) throw fail("会话搜索已关闭", 503);
    if (clearing) throw fail("正在清除索引，请稍后重试", 409);
    if (!database) {
      database = createSessionIndexClient({ directory });
      opening = database.list().then(items => {
        if (items.length) state = { ...state, state: "stale", indexed: items.length, total: items.length };
      });
    }
    await opening;
    if (clearing) throw fail("正在清除索引，请稍后重试", 409);
    if (database.failed) throw fail("本地正文索引不可用，请清除索引后重新建立", 503);
    return database;
  };
  const status = () => ({ ...state });
  const readList = async (options, signal) => {
    const result = await reader.request("thread/list", { ...listParams, archived: false, ...options }, signal);
    if (!Array.isArray(result.data) || !(result.nextCursor == null || typeof result.nextCursor === "string")) throw fail("Codex 会话列表格式不兼容，请更新 CLI", 503);
    return { data: result.data.filter(thread => uuid.test(thread.id) && !thread.ephemeral && !thread.parentThreadId && !(typeof thread.source === "object" && thread.source?.subAgent)).map(sessionSummary), nextCursor: result.nextCursor || null };
  };
  const refresh = async () => {
    await db();
    if (clearing) throw fail("正在清除索引，请稍后重试", 409);
    if (running) return status();
    controller = new AbortController();
    const activeController = controller;
    const signal = activeController.signal;
    const timer = setTimeout(() => activeController.abort(), syncTimeoutMs);
    timer.unref?.();
    state = { ...state, state: "building", failed: 0, error: undefined };
    cache.clear();
    running = (async () => {
      const sources = new Map();
      // Do not prune until both active and archived inventories completed.
      for (const archived of [false, true]) {
        let cursor;
        const seen = new Set();
        do {
          const page = await readList({ archived, ...(cursor ? { cursor } : {}) }, signal);
          signal.throwIfAborted();
          for (const item of page.data) sources.set(item.id, { ...item, archived });
          if (sources.size > maxSessions) throw fail("会话数量超过本地索引上限，尚未完成同步", 413);
          cursor = page.nextCursor;
          if (cursor && (seen.has(cursor) || seen.size >= 400)) throw fail("会话列表分页未完成，请重试", 503);
          if (cursor) seen.add(cursor);
        } while (cursor);
      }
      signal.throwIfAborted();
      const existing = new Map((await database.list()).map(item => [item.id, item]));
      const removed = [...existing.keys()].filter(id => !sources.has(id));
      await database.remove(removed);
      for (const id of removed) existing.delete(id);
      state.total = sources.size;
      state.indexed = existing.size;
      const audit = now() - lastAudit >= 86_400_000 || !lastAudit;
      for (const source of [...sources.values()].sort((a, b) => b.updatedAt - a.updatedAt)) {
        signal.throwIfAborted();
        const old = existing.get(source.id);
        if (!audit && old && old.updatedAt === source.updatedAt && old.title === source.title && old.archived === source.archived && source.updatedAt * 1000 < (state.updatedAt || 0) - 2000) continue;
        try {
          let bytes = 0;
          const deadline = AbortSignal.timeout(120_000);
          const readSignal = AbortSignal.any([signal, deadline]);
          const content = await readSessionContent(async (method, params) => {
            const value = await reader.request(method, params, readSignal);
            bytes += Buffer.byteLength(JSON.stringify(value));
            if (bytes > 24 * 1024 * 1024) throw fail("会话数据超过读取上限", 413);
            return value;
          }, source, { signal: readSignal, maxCharacters: 1_000_000, allowEmpty: true });
          signal.throwIfAborted();
          await database.put(source, content.messages);
          existing.set(source.id, source);
        } catch (error) {
          signal.throwIfAborted();
          // A changed, unreadable source must not keep searchable obsolete text.
          await database.remove([source.id]);
          existing.delete(source.id);
          state.failed++;
          state.error = error.status ? error.message : "部分会话正文无法完整读取，请稍后更新索引。";
        }
        state.indexed = existing.size;
        // Yield between sessions so searches/cancellation remain responsive.
        await new Promise(resolve => setImmediate(resolve));
      }
      state = { ...state, indexed: existing.size, state: state.failed ? "partial" : "ready", updatedAt: now() };
      if (audit && !state.failed) lastAudit = now();
    })().catch(() => {
      if (!closed) state = { ...state, state: "partial", error: "索引同步未完成，当前结果仅覆盖已读取的会话；可重新更新。" };
    }).finally(() => { clearTimeout(timer); running = undefined; controller = undefined; cache.clear(); });
    return status();
  };
  return {
    get busy() { return !!running || !!clearing || !!database?.busy || reader.busy; },
    resetReader() { cache.clear(); reader.reset?.(); },
    async index(action) {
      if (!["refresh", "clear", "status"].includes(action)) throw fail("无效的索引操作");
      if (closed) throw fail("会话搜索已关闭", 503);
      if (action === "clear") {
        clearing ||= Promise.resolve().then(async () => {
          controller?.abort();
          await database?.terminate();
          await Promise.allSettled([running, opening]);
          database = undefined; opening = undefined;
          clearSessionIndexFiles(directory);
          cache.clear(); lastAudit = 0;
          state = { state: "empty", indexed: 0, total: 0, failed: 0, updatedAt: null };
        }).catch(error => {
          state = { ...state, state: "partial", error: "本地索引清除失败，请检查索引目录后重试。" };
          throw error;
        }).finally(() => { clearing = undefined; });
        await clearing;
        return status();
      }
      if (action === "refresh") return refresh();
      await db();
      return status();
    },
    list(options = {}, signal) {
      if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["searchTerm", "cursor", "archived", "scope"].includes(key)) ||
        (options.searchTerm !== undefined && (typeof options.searchTerm !== "string" || options.searchTerm.length > 200)) ||
        (options.cursor !== undefined && (typeof options.cursor !== "string" || !options.cursor || options.cursor.length > 4096)) ||
        (options.archived !== undefined && typeof options.archived !== "boolean") || (options.scope !== undefined && !["title", "content"].includes(options.scope))) throw fail("无效的会话查询");
      signal?.throwIfAborted();
      if (closed) throw fail("会话搜索已关闭", 503);
      return (async () => {
        const { scope, ...query } = options;
        if (scope === "content") {
          await db();
          if (state.state === "stale" || (state.state === "ready" && now() - state.updatedAt > refreshMs)) await refresh();
          const page = await database.search({ query: query.searchTerm || "", archived: query.archived || false, cursor: query.cursor });
          signal?.throwIfAborted();
          return { ...page, index: status() };
        }
        const key = JSON.stringify([query.searchTerm?.trim() || "", !!query.archived, query.cursor || ""]);
        let value = cache.get(key);
        if (!value || now() - value.time >= cacheMs) {
          const page = await readList({ ...query, searchTerm: query.searchTerm?.trim() || undefined }, signal);
          signal?.throwIfAborted();
          value = { time: now(), page }; cache.set(key, value);
          if (cache.size > 64) cache.delete(cache.keys().next().value);
        }
        if (scope) {
          try { await db(); }
          catch { if (!clearing && !closed) state = { ...state, state: "partial", error: "本地正文索引不可用，请清除索引后重新建立；标题搜索仍可使用。" }; }
        }
        signal?.throwIfAborted();
        return { ...structuredClone(value.page), ...(scope ? { index: status() } : {}) };
      })();
    },
    async close() {
      closed = true; controller?.abort(); reader.close();
      await Promise.allSettled([running, clearing, opening]);
      await database?.close(); cache.clear();
    },
  };
}
