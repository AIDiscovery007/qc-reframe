import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionSearch } from "../bridge/session-search.mjs";
const id = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reframe-search-"));
  const calls = [], sources = new Map([[id, { id, name: "创作", updatedAt: 1, archived: false, text: "海边少女与灯塔" }]]);
  let clock = 100000, failure, hold;
  const reader = { busy: false, close() {}, reset() {}, request: async (method, params, signal) => {
    calls.push({ method, params }); signal?.throwIfAborted();
    if (hold) await hold(method, signal);
    if (failure?.(method, params)) throw new Error("private failure detail");
    if (method === "thread/list") return { data: [...sources.values()].filter(item => item.archived === params.archived), nextCursor: null };
    const source = sources.get(params.threadId);
    if (!source) throw new Error("missing");
    if (method === "thread/read") return { thread: { ...source, historyMode: "paginated" } };
    return { data: [{ id: "t1", itemsView: "full", items: [
      { id: "u", type: "userMessage", content: [{ type: "text", text: source.text }] },
      { id: "a", type: "agentMessage", phase: "final_answer", text: source.finalText ?? "定稿：夜色中的灯塔" },
      { type: "agentMessage", phase: "commentary", text: "COMMENTARY_SECRET" },
      { type: "commandExecution", aggregatedOutput: "TOOL_SECRET" },
    ] }], nextCursor: null };
  } };
  const store = createSessionSearch({ directory, reader, now: () => clock, ...options });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const finish = async () => { for (let i = 0; i < 300; i++) { const status = await store.index("status"); if (status.state !== "building") return status; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail("sync did not finish"); };
  return { store, calls, sources, directory, finish, advance: value => { clock += value; }, fail: value => { failure = value; }, hold: value => { hold = value; } };
}
test("title cache is bounded by TTL/query and never reads body; validation remains synchronous", async t => {
  const { store, calls, advance } = await fixture(t);
  assert.throws(() => store.list({ path: "/private" }));
  const a = await store.list({ searchTerm: "创作" }); a.data[0].title = "mutated";
  assert.equal((await store.list({ searchTerm: " 创作 " })).data[0].title, "创作");
  assert.equal(calls.length, 1); advance(15000);
  await store.list({ searchTerm: "创作" }); await store.list({ archived: true });
  assert.equal(calls.length, 3); assert.ok(calls.every(call => call.method === "thread/list"));
  const controller = new AbortController(); controller.abort(); assert.throws(() => store.list({}, controller.signal));
  store.resetReader(); await store.list({ searchTerm: "创作" }); assert.equal(calls.length, 4);
});
test("explicit local indexing reads complete active+archived conversations and returns only snippets", async t => {
  const { store, calls, sources, finish } = await fixture(t);
  assert.equal((await store.list({ scope: "content" })).index.state, "empty"); assert.equal(calls.length, 0);
  sources.set(second, { id: second, name: "归档", updatedAt: 2, archived: true, text: "远方灯塔" });
  assert.equal((await store.index("refresh")).state, "building"); assert.equal((await finish()).state, "ready");
  const result = await store.list({ scope: "content", searchTerm: "少女 灯塔" });
  assert.equal(result.data.length, 1); assert.equal(result.data[0].match, "content");
  assert.match(result.data[0].snippet, /少女/); assert.equal(result.data[0].text, undefined);
  assert.equal((await store.list({ scope: "content", searchTerm: "灯塔", archived: true })).data[0].id, second);
  for (const searchTerm of ["TOOL_SECRET", "COMMENTARY_SECRET"]) assert.equal((await store.list({ scope: "content", searchTerm })).data.length, 0);
  assert.ok(calls.every(call => ["thread/list", "thread/read", "thread/turns/list"].includes(call.method)));
});
test("incremental refresh removes deleted sources, refreshes archive/content and drops unreadable changed text", async t => {
  const { store, sources, finish, fail, advance } = await fixture(t);
  await store.index("refresh"); await finish(); advance(10000);
  sources.get(id).updatedAt++; sources.get(id).text = "新的故事"; sources.get(id).archived = true;
  await store.index("refresh"); await finish();
  assert.equal((await store.list({ scope: "content", searchTerm: "少女", archived: true })).data.length, 0);
  assert.equal((await store.list({ scope: "content", searchTerm: "故事", archived: true })).data.length, 1);
  sources.get(id).updatedAt++; fail(method => method === "thread/turns/list");
  await store.index("refresh"); const partial = await finish(); assert.equal(partial.state, "partial"); assert.equal(partial.failed, 1);
  assert.equal((await store.list({ scope: "content", searchTerm: "故事", archived: true })).data.length, 0);
  fail(undefined); await store.index("refresh"); await finish(); sources.clear();
  await store.index("refresh"); assert.equal((await finish()).indexed, 0);
});
test("failed inventory cannot prune existing sources and errors do not leak transcript details", async t => {
  const { store, finish, fail } = await fixture(t);
  await store.index("refresh"); await finish();
  fail((method, params) => method === "thread/list" && params.archived);
  await store.index("refresh"); const state = await finish();
  assert.equal(state.state, "partial"); assert.equal(state.indexed, 1); assert.ok(!JSON.stringify(state).includes("private failure"));
});
test("clear cancels a running read, blocks concurrent rebuild, and cannot be repopulated by late completion", async t => {
  const { store, hold, finish } = await fixture(t);
  const started = Promise.withResolvers(), blocked = Promise.withResolvers();
  hold(async (method, signal) => { if (method === "thread/turns/list") { started.resolve(); await blocked.promise; signal.throwIfAborted(); } });
  await store.index("refresh"); await started.promise;
  const clearing = store.index("clear");
  await assert.rejects(store.index("refresh"), /清除/);
  blocked.resolve(); assert.equal((await clearing).state, "empty"); assert.equal((await finish()).indexed, 0);
  assert.equal((await store.list({ scope: "content", searchTerm: "少女" })).data.length, 0);
});
test("content queries trigger stale refresh after five minutes and daily audit checks unchanged metadata", async t => {
  const { store, sources, finish, advance } = await fixture(t);
  await store.index("refresh"); await finish(); sources.get(id).text = "改写的情节";
  advance(86400001); await store.list({ scope: "content", searchTerm: "情节" }); await finish();
  assert.equal((await store.list({ scope: "content", searchTerm: "情节" })).data.length, 1);
});

test("corrupt index preserves title searches and can be cleared and rebuilt without opening the old database", async t => {
  const { store, directory, finish } = await fixture(t);
  await writeFile(join(directory, "sessions.sqlite"), "invalid sqlite fixture");
  await writeFile(join(directory, "creative-snapshot.json"), "keep snapshot");
  const page = await store.list({ scope: "title" });
  assert.equal(page.data[0].id, id); assert.equal(page.index.state, "partial");
  assert.match(page.index.error, /标题搜索仍可使用/);
  await assert.rejects(store.list({ scope: "content" }));
  await assert.rejects(store.index("status"));
  await assert.rejects(store.index("refresh"));
  assert.equal((await store.index("clear")).state, "empty");
  assert.deepEqual(await readdir(directory), ["creative-snapshot.json"]);
  await store.index("refresh"); assert.equal((await finish()).state, "ready");
  assert.equal((await store.list({ scope: "content", searchTerm: "少女" })).data[0].id, id);
  assert.equal(await readFile(join(directory, "creative-snapshot.json"), "utf8"), "keep snapshot");
});

test("failed worker is disposed and a new worker rebuilds the index", async t => {
  let worker;
  const original = Worker.prototype.postMessage;
  t.mock.method(Worker.prototype, "postMessage", function (...args) { worker = this; return original.apply(this, args); });
  const { store, finish } = await fixture(t);
  await store.index("refresh"); await finish();
  const failed = worker;
  await failed.terminate();
  await assert.rejects(store.index("status"), { status: 503 });
  await assert.rejects(store.list({ scope: "content" }), { status: 503 });
  assert.equal((await store.index("clear")).state, "empty");
  await store.index("refresh"); assert.equal((await finish()).state, "ready");
  assert.notEqual(worker, failed);
  assert.equal((await store.list({ scope: "content", searchTerm: "灯塔" })).data[0].id, id);
});

test("clear during initial worker opening rejects the obsolete read and leaves no old database", async t => {
  const { store, directory } = await fixture(t);
  const reading = assert.rejects(store.list({ scope: "content" }));
  const clears = await Promise.all([store.index("clear"), store.index("clear")]);
  await reading;
  assert.ok(clears.every(item => item.state === "empty"));
  assert.deepEqual(await readdir(directory), []);
  assert.equal((await store.index("status")).state, "empty");
});

test("empty textual history can index its title without weakening creative capture requirements", async t => {
  const { store, sources, finish } = await fixture(t);
  sources.get(id).text = ""; sources.get(id).finalText = "";
  await store.index("refresh"); assert.equal((await finish()).state, "ready");
  assert.equal((await store.list({ scope: "content", searchTerm: "创作" })).data[0].match, "title");
  assert.equal((await store.list({ scope: "content", searchTerm: "TOOL_SECRET" })).data.length, 0);
});
