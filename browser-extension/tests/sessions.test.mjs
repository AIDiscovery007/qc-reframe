import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore, sessionIds } from "../bridge/sessions.mjs";
const id = "11111111-1111-4111-8111-111111111111", jobId = "22222222-2222-4222-8222-222222222222";
const source = { id, title: "小说", updatedAt: 1 };
const meta = { id, name: source.title, updatedAt: 1, historyMode: "paginated" };
const user = (text = "海边少女") => ({ type: "userMessage", id: "u", content: [{ type: "text", text }, { type: "localImage", path: "/private/not-read.png" }] });
const turn = (id, items) => ({ id, items, itemsView: "full" });
async function fixture(t, request) {
  const dir = await mkdtemp(join(tmpdir(), "reframe-sessions-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const calls = [];
  const store = createSessionStore({ dataDir: dir, cwd: "/repo", run: async (options, action) => {
    assert.equal(options.timeoutMs, 120000);
    return action(async (method, params) => { calls.push({ method, params }); return request(method, params); });
  } });
  return { store, dir, calls };
}
test("validates whole session IDs, deduplicates and permits clearing only draft input", () => {
  assert.deepEqual(sessionIds([id, id]), [id]); assert.deepEqual(sessionIds([]), []);
  for (const input of [undefined, ["/tmp/file"], ["bad"], Array(6).fill(id)]) assert.throws(() => sessionIds(input));
  assert.throws(() => sessionIds([], true));
});
test("list uses global explicit origins/providers, forwards opaque cursor, returns no transcript/path", async t => {
  const { store, calls } = await fixture(t, async () => ({ data: [{ ...meta, preview: "private", path: "/private" }], nextCursor: "opaque" }));
  assert.deepEqual(await store.list({ searchTerm: "小说", archived: true, cursor: "old" }), { data: [source], nextCursor: "opaque" });
  const { params } = calls[0]; assert.equal(params.cwd, undefined); assert.deepEqual(params.modelProviders, []); assert.ok(params.sourceKinds.includes("appServer")); assert.equal(params.cursor, "old");
  assert.throws(() => store.list({ path: "/private" }));
});
test("captures all pages in order, excludes tool/reasoning/commentary, records attachments and private immutable snapshot", async t => {
  const { store, dir, calls } = await fixture(t, async (method, params) => method === "thread/read" ? { thread: meta } : params.cursor
    ? { data: [turn("t2", [{ type: "agentMessage", id: "a", text: "故事正文", phase: "final_answer" }])], nextCursor: null }
    : { data: [turn("t1", [user(), { type: "agentMessage", text: "working", phase: "commentary" }, { type: "reasoning", content: ["private"] }, { type: "commandExecution", aggregatedOutput: "private" }])], nextCursor: "next" });
  const snap = await store.capture([source], { jobId });
  assert.deepEqual(snap.messages.map(m => m.text), ["海边少女", "故事正文"]); assert.equal(snap.attachmentCount, 1); assert.equal(snap.messageCount, 2);
  assert.equal(calls.filter(c => c.method === "thread/turns/list").length, 2);
  assert.ok(calls.every(c => !["thread/resume", "turn/start"].includes(c.method)));
  const file = join(dir, `${jobId}-session-context.json`); assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), snap);
  await assert.rejects(store.capture([source], { jobId }), /EEXIST/);
});
for (const scenario of ["changed", "changed-after", "summary", "cursor", "oversize", "empty", "unsupported", "timeout", "cancelled", "page-limit"]) test(`capture fails closed: ${scenario}`, async t => {
  let reads = 0; const controller = new AbortController();
  const { store, dir, calls } = await fixture(t, async method => {
    if (method === "thread/read") { reads++; return { thread: { ...meta, updatedAt: scenario === "changed" || (scenario === "changed-after" && reads > 1) ? 2 : 1 } }; }
    if (scenario === "unsupported" || scenario === "timeout") throw Object.assign(new Error(scenario), { code: scenario === "unsupported" ? -32601 : undefined });
    if (scenario === "cancelled") controller.abort();
    return { data: scenario === "empty" ? [] : [turn(`t${calls.length}`, [user(scenario === "oversize" ? "x".repeat(120001) : "text")])].map(t => scenario === "summary" ? { ...t, itemsView: "summary" } : t), nextCursor: scenario === "cursor" ? "repeat" : scenario === "page-limit" ? `c${calls.length}` : null };
  });
  await assert.rejects(store.capture([source], { jobId, signal: controller.signal }));
  assert.deepEqual(await readdir(dir), []);
  assert.ok(calls.every(c => c.params.includeTurns !== true), "paginated failure must not fall back to hydration");
});
test("legacy reads full turns only and partial multi-source failure leaves no snapshot", async t => {
  const otherId = "33333333-3333-4333-8333-333333333333";
  const { store, calls, dir } = await fixture(t, async (method, params) => {
    if (params.threadId === otherId) throw new Error("missing");
    return { thread: { ...meta, historyMode: "legacy", ...(params.includeTurns ? { turns: [turn("old", [user()])] } : {}) } };
  });
  await assert.rejects(store.capture([source, { ...source, id: otherId }], { jobId }), /missing/);
  assert.deepEqual(await readdir(dir), []);
  assert.equal(calls.some(c => c.method === "thread/turns/list"), false);
  assert.equal(calls.some(c => c.params.includeTurns === true), true);
});
test("each selected session needs text; unknown assistant phases never become content", async t => {
  const otherId = "33333333-3333-4333-8333-333333333333";
  const { store, dir } = await fixture(t, async (method, params) => method === "thread/read"
    ? { thread: { ...meta, id: params.threadId } }
    : { data: [turn("t", params.threadId === id ? [user()] : [{ type: "agentMessage", id: "a", text: "unknown phase", phase: "future_phase" }])], nextCursor: null });
  await assert.rejects(store.capture([source, { ...source, id: otherId }], { jobId }), /没有.*文字正文/);
  assert.deepEqual(await readdir(dir), []);
});
test("metadata rejects direct sub-agent IDs", async t => {
  const { store } = await fixture(t, async () => ({ thread: { ...meta, source: { subAgent: { thread_spawn: {} } } } }));
  await assert.rejects(store.metadata([id]), /子代理/);
});
test("legacy summary and missing pagination cursor both fail closed", async t => {
  const { store } = await fixture(t, async () => ({ thread: { ...meta, historyMode: "legacy", turns: [{ ...turn("t", [user()]), itemsView: "summary" }] } }));
  await assert.rejects(store.capture([source], { jobId }), /未完整/);
  const second = await fixture(t, async method => method === "thread/read" ? { thread: meta } : { data: [turn("t", [user()])] });
  await assert.rejects(second.store.capture([source], { jobId }), /分页格式/);
});
test("cumulative raw responses are bounded even when large tool outputs are excluded", async t => {
  const large = "x".repeat(13 * 1024 * 1024);
  const { store, dir } = await fixture(t, async (method, params) => method === "thread/read" ? { thread: meta }
    : { data: [turn(params.cursor || "first", [user(), { type: "commandExecution", aggregatedOutput: large }])], nextCursor: params.cursor ? null : "next" });
  await assert.rejects(store.capture([source], { jobId }), /24 MB/);
  assert.deepEqual(await readdir(dir), []);
});
test("same content has same hash across job IDs and timestamps, nullable legacy phase is retained", async t => {
  const { store } = await fixture(t, async method => method === "thread/read" ? { thread: meta }
    : { data: [turn("t", [{ type: "agentMessage", id: "a", text: "legacy answer", phase: null }])], nextCursor: null });
  const a = await store.capture([source], { jobId });
  const b = await store.capture([source], { jobId: "33333333-3333-4333-8333-333333333333" });
  assert.equal(a.hash, b.hash); assert.equal(a.messageCount, 1);
});
