import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withCodex } from "./codex-rpc.mjs";
import { readSessionMetadata as readMetadata, readSessionContent, sessionSummary as summary } from "./session-content.mjs";
import { createSessionSearch } from "./session-search.mjs";

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
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
  const search = createSessionSearch({ cwd, directory: join(dataDir, "..", "cache", "session-search"),
    ...(run !== withCodex ? { reader: { request: (method, params, signal) => operate(signal, request => request(method, params)), close() {}, busy: false } } : {}) });
  return {
    list: (options, signal) => search.list(options, signal),
    index: action => search.index(action),
    get busy() { return search.busy; },
    close: () => search.close(),
    resetReader: () => search.resetReader(),
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
        let attachmentCount = 0;
        const budget = { characters: 0, pages: 0 };
        for (const source of sources) {
          const content = await readSessionContent(request, source, { signal, budget });
          messages.push(...content.messages);
          attachmentCount += content.attachmentCount;
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
