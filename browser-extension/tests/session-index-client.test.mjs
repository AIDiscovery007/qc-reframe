import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { createSessionIndexClient } from "../bridge/session-index-client.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "reframe-index-worker-"));
  const client = createSessionIndexClient({ directory });
  t.after(async () => { await client.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  return { directory, client };
}
const meta = (id, title = "小说创作") => ({ id, title, updatedAt: 1, archived: false });

test("real worker supports async CRUD, search and FIFO visibility", async t => {
  const { client } = await fixture(t);
  const put = client.put(meta("a"), [{ text: "林夏走在海边" }]);
  const get = client.get("a");
  assert.ok(put instanceof Promise); assert.equal(client.busy, true);
  assert.deepEqual(await put, meta("a")); assert.deepEqual(await get, meta("a"));
  assert.deepEqual(await client.list(), [meta("a")]);
  const found = await client.search({ query: "海边" });
  assert.equal(found.data[0].id, "a"); assert.equal(found.data[0].match, "content");
  await client.remove(["a"]); assert.equal(await client.get("a"), undefined);
  await client.put(meta("b"), ["另一部小说"]); await client.clear();
  assert.deepEqual(await client.list(), []); assert.equal(client.busy, false);
});

test("worker request errors preserve safe status and do not poison later operations", async t => {
  const { client, directory } = await fixture(t);
  await assert.rejects(client.put(meta("a"), [null]), error => error.status === 400 && !error.message.includes(directory));
  await assert.rejects(client.search({ query: "x".repeat(201) }), { status: 400 });
  await assert.rejects(client.put(meta("large"), ["x".repeat(1_000_000)]), { status: 413, code: "CONTENT_LIMIT" });
  await client.put(meta("a"), ["有效正文"]);
  assert.equal((await client.get("a")).id, "a");
  assert.equal(client.eval, undefined); assert.equal(client.request, undefined);
});

test("64 outstanding operations are bounded and close drains all accepted operations", async t => {
  const { client, directory } = await fixture(t);
  const accepted = Array.from({ length: 64 }, (_, i) => client.put(meta(`a${i}`), ["正文"]));
  await assert.rejects(client.list(), { status: 429 });
  const closed = client.close(); assert.equal(client.close(), closed);
  await assert.rejects(client.list(), { status: 503 });
  await Promise.all(accepted); await closed; assert.equal(client.busy, false);
  const reopened = createSessionIndexClient({ directory });
  try { assert.equal((await reopened.list()).length, 64); } finally { await reopened.close(); }
});

test("lazy close is safe and never permits a later operation", async () => {
  const client = createSessionIndexClient({ directory: "/unused-private-path" });
  const closed = client.close(); assert.equal(client.close(), closed); await closed;
  await assert.rejects(client.list(), { status: 503 }); assert.equal(client.busy, false);
});

test("initialization failure settles every queued request without exposing its path or retrying", async t => {
  const { directory } = await fixture(t);
  const file = join(directory, "private-file"); await writeFile(file, "not a directory");
  const client = createSessionIndexClient({ directory: file });
  const results = await Promise.allSettled([client.list(), client.get("a"), client.search({ query: "猫" })]);
  for (const result of results) {
    assert.equal(result.status, "rejected"); assert.equal(result.reason.status, 503);
    assert.equal(result.reason.message.includes(file), false);
  }
  await assert.rejects(client.list(), { status: 503 }); await client.close(); assert.equal(client.busy, false);
});

for (const kind of ["exit", "error"]) test(`worker ${kind} settles queued requests and close remains safe`, async t => {
  const original = Worker.prototype.postMessage;
  let worker;
  t.mock.method(Worker.prototype, "postMessage", function(...args) { worker = this; return original.apply(this, args); });
  const { client } = await fixture(t);
  const pending = Promise.allSettled([client.list(), client.get("a")]);
  if (kind === "exit") await worker.terminate();
  else worker.emit("error", new Error("private/path/secret"));
  for (const result of await pending) {
    assert.equal(result.status, "rejected"); assert.equal(result.reason.status, 503);
    assert.equal(result.reason.message.includes("secret"), false);
  }
  await assert.rejects(client.list(), { status: 503 }); await client.close(); assert.equal(client.busy, false);
});

test("real worker rejects non-whitelisted methods", async t => {
  const { directory } = await fixture(t);
  const worker = new Worker(new URL("../bridge/session-index-worker.mjs", import.meta.url), { workerData: { directory }, stdout: true, stderr: true });
  worker.stdout.resume(); worker.stderr.resume(); t.after(() => worker.terminate());
  const reply = new Promise(resolve => worker.once("message", resolve));
  worker.postMessage({ id: 1, method: "constructor", args: ["arbitrary-code"] });
  assert.deepEqual(await reply, { id: 1, error: { status: 400, message: "无效的索引操作" } });
});

test("long indexing work leaves the bridge event loop available", async t => {
  const { client } = await fixture(t);
  await client.list();
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  try {
    await client.put(meta("long"), ["海边小说与人物情节".repeat(8000)]);
    await client.search({ query: "海边" });
  } finally { clearInterval(timer); }
  assert.ok(ticks > 0, "main event loop should run while SQLite worker processes the request");
});
