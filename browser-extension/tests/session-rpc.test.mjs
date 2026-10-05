import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { createSessionReader } from "../bridge/session-rpc.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function setup(t, behavior = () => {}, options = {}) {
  const processes = [], messages = [];
  const reader = createSessionReader({ requestTimeoutMs: 500, idleTimeoutMs: 500, ...options, spawnProcess() {
    const proc = new EventEmitter(); processes.push(proc);
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kills = [];
    proc.send = message => proc.stdout.write(JSON.stringify(message) + "\n");
    proc.stdin = new Writable({ write(chunk, encoding, callback) {
      const message = JSON.parse(chunk.toString()); messages.push(message);
      queueMicrotask(() => {
        if (message.method === "initialize" && !options.manualInit) proc.send({ id: 0, result: {} });
        else behavior(message, proc);
      });
      callback();
    } });
    proc.kill = signal => { proc.kills.push(signal || "SIGTERM"); queueMicrotask(() => proc.emit("exit", 0)); };
    return proc;
  } });
  t.after(() => reader.close());
  return { reader, processes, messages };
}

test("reuses initialization and only allows three read methods", async t => {
  const { reader, processes, messages } = setup(t, (message, proc) => {
    if (message.id) proc.send({ id: message.id, result: { method: message.method } });
  });
  for (const method of ["thread/list", "thread/read", "thread/turns/list"])
    assert.equal((await reader.request(method, {})).method, method);
  assert.equal(processes.length, 1);
  assert.equal(messages.filter(x => x.method === "initialize").length, 1);
  assert.equal(messages[0].params.capabilities.experimentalApi, true);
  assert.equal(messages.filter(x => x.method === "initialized").length, 1);
  for (const method of ["turn/start", "thread/resume", "thread/archive", "initialize"])
    await assert.rejects(reader.request(method, {}), { code: "METHOD_NOT_ALLOWED" });
  assert.equal(reader.busy, false);
});

test("cancellation rejects one caller, discards its late reply and preserves concurrent reads", async t => {
  const { reader, processes, messages } = setup(t);
  const abort = new AbortController();
  const first = reader.request("thread/read", { threadId: "a" }, abort.signal);
  const rejected = assert.rejects(first, { code: "ABORT_ERR" });
  const second = reader.request("thread/list", {});
  await tick(); abort.abort(); await rejected;
  assert.equal(reader.busy, true);
  const [one, two] = messages.filter(x => x.id > 0);
  processes[0].send({ id: two.id, result: "second" });
  assert.equal(await second, "second"); assert.deepEqual(processes[0].kills, []);
  processes[0].send({ id: one.id, result: "cancelled private content" });
  assert.equal(reader.busy, false);
});

test("cancelled orphan retains slot and deadline, then resets connection without retrying peers", async t => {
  const { reader, processes } = setup(t, () => {}, { requestTimeoutMs: 40 });
  const abort = new AbortController();
  const first = reader.request("thread/read", {}, abort.signal);
  const rejected = assert.rejects(first, { code: "ABORT_ERR" });
  const peer = reader.request("thread/list", {});
  const timedOut = assert.rejects(peer, { code: "TIMEOUT" });
  await tick(); abort.abort(); await rejected; await timedOut;
  assert.ok(processes[0].kills.length); assert.equal(reader.busy, false);
  const next = reader.request("thread/list", {}); await tick();
  assert.equal(processes.length, 2);
  processes[1].send({ id: 3, result: "reconnected" }); assert.equal(await next, "reconnected");
});

test("bounded concurrency and queue: cancelled queued requests never reach the child", async t => {
  const { reader, processes, messages } = setup(t, () => {}, { maxConcurrent: 2, maxQueued: 2 });
  const one = reader.request("thread/list", {}); await tick();
  const two = reader.request("thread/list", {});
  const abort = new AbortController();
  const queued = reader.request("thread/read", {}, abort.signal);
  const rejected = assert.rejects(queued, { code: "ABORT_ERR" });
  const four = reader.request("thread/list", {});
  await assert.rejects(reader.request("thread/read", {}), { code: "QUEUE_FULL" });
  await tick(); assert.equal(messages.filter(x => x.id > 0).length, 2);
  abort.abort(); await rejected;
  processes[0].send({ id: 1, result: 1 }); assert.equal(await one, 1);
  await tick(); assert.deepEqual(messages.filter(x => x.id > 0).map(x => x.id), [1, 2, 4]);
  processes[0].send({ id: 2, result: 2 }); processes[0].send({ id: 4, result: 4 });
  assert.deepEqual(await Promise.all([two, four]), [2, 4]);
});

test("initialization cancellation is isolated; close settles initializing and queued requests", async t => {
  const { reader, processes, messages } = setup(t, () => {}, { manualInit: true });
  const abort = new AbortController();
  const one = reader.request("thread/list", {}, abort.signal);
  const rejected = assert.rejects(one, { code: "ABORT_ERR" });
  const two = reader.request("thread/list", {});
  abort.abort(); await rejected;
  processes[0].send({ id: 0, result: {} }); await tick();
  assert.deepEqual(messages.filter(x => x.id > 0).map(x => x.id), [2]);
  const closed = assert.rejects(two, { code: "CONNECTION_CLOSED" }); reader.close(); await closed;
  await assert.rejects(reader.request("thread/list", {}), { code: "CONNECTION_CLOSED" });
  const other = setup(t, () => {}, { manualInit: true });
  const waiting = assert.rejects(other.reader.request("thread/list", {}), { code: "CONNECTION_CLOSED" });
  other.reader.close(); await waiting;
});

test("hung initialization is bounded even after all callers cancel", async t => {
  const { reader, processes } = setup(t, () => {}, { manualInit: true, requestTimeoutMs: 25 });
  const controller = new AbortController();
  const pending = assert.rejects(reader.request("thread/list", {}, controller.signal), { code: "ABORT_ERR" });
  controller.abort(); await pending; await sleep(50);
  assert.ok(processes[0].kills.length); assert.equal(reader.busy, false);
});

test("idle connection retires and unexpected exit settles all requests before reconnect", async t => {
  let respond = true;
  const { reader, processes } = setup(t, (message, proc) => {
    if (message.id && respond) proc.send({ id: message.id, result: {} });
  }, { idleTimeoutMs: 15 });
  await reader.request("thread/list", {}); await sleep(35);
  assert.ok(processes[0].kills.length);
  respond = false;
  const pending = assert.rejects(reader.request("thread/list", {}), { code: "CONNECTION_CLOSED" });
  const queued = assert.rejects(reader.request("thread/read", {}), { code: "CONNECTION_CLOSED" });
  await tick(); processes[1].emit("exit", 1); await Promise.all([pending, queued]);
  respond = true; await reader.request("thread/list", {}); assert.equal(processes.length, 3);
});

for (const event of ["error", "stdin", "stdout"]) test(`connection ${event} settles callers`, async t => {
  const { reader, processes } = setup(t);
  const pending = assert.rejects(reader.request("thread/list", {}), { code: "CONNECTION_CLOSED" });
  await tick(); const proc = processes[0];
  (event === "error" ? proc : proc[event]).emit("error", new Error("private stderr details"));
  await pending;
});

for (const malformed of ["oversize", "incomplete", "json", "approval", "tool"]) test(`rejects unsafe response: ${malformed}`, async t => {
  const { reader, processes } = setup(t, () => {}, { maxResponseBytes: 200 });
  const code = ["oversize", "incomplete"].includes(malformed) ? "RESPONSE_TOO_LARGE" : malformed === "json" ? "INVALID_RESPONSE" : "INTERACTIVE_REQUEST";
  const pending = assert.rejects(reader.request("thread/list", {}), { code });
  await tick(); const proc = processes[0];
  if (malformed === "oversize") proc.send({ id: 1, result: "x".repeat(250) });
  else if (malformed === "incomplete") { proc.stdout.write("x".repeat(150)); proc.stdout.write("x".repeat(150)); }
  else if (malformed === "json") proc.stdout.write("invalid\n");
  else proc.send({ id: "interaction", method: malformed === "tool" ? "item/tool/call" : "item/commandExecution/requestApproval", params: {} });
  await pending; assert.ok(proc.kills.length);
});

test("response errors preserve codes, fragmented UTF-8 is decoded only after a full line", async t => {
  const { reader, processes } = setup(t);
  const pending = reader.request("thread/list", {}); await tick();
  const bytes = Buffer.from(JSON.stringify({ id: 1, result: "中文" }) + "\n");
  for (const byte of bytes) processes[0].stdout.write(Buffer.from([byte]));
  assert.equal(await pending, "中文");
  const failed = assert.rejects(reader.request("thread/read", {}), { code: -32601 }); await tick();
  processes[0].send({ id: 2, error: { code: -32601, message: "unsupported" } }); await failed;
});

test("close terminates an actual child and settles its blocked request", { timeout: 4000 }, async t => {
  let child;
  const reader = createSessionReader({ requestTimeoutMs: 2000, spawnProcess: () => {
    child = spawn(process.execPath, ["-e", `require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.method==='initialize')process.stdout.write(JSON.stringify({id:0,result:{}})+'\\n')});process.on('SIGTERM',()=>{});`], { stdio: ["pipe", "pipe", "pipe"] });
    return child;
  } });
  t.after(() => reader.close());
  const pending = assert.rejects(reader.request("thread/list", {}), { code: "CONNECTION_CLOSED" });
  await sleep(150);
  const exited = new Promise(resolve => child.once("exit", resolve));
  reader.close(); await pending; await exited;
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("already cancelled requests never spawn a process", async t => {
  const { reader, processes } = setup(t);
  await assert.rejects(reader.request("thread/list", {}, AbortSignal.abort()), { code: "ABORT_ERR" });
  assert.equal(processes.length, 0); assert.equal(reader.busy, false);
});

test("synchronous spawn failure clears the queue and allows the next attempt", async t => {
  let attempts = 0;
  const reader = createSessionReader({ spawnProcess: () => { attempts++; throw new Error("unavailable"); } });
  t.after(() => reader.close());
  for (let i = 0; i < 2; i++) {
    await assert.rejects(reader.request("thread/list", {}), { code: "CONNECTION_CLOSED" });
    assert.equal(reader.busy, false);
  }
  assert.equal(attempts, 2);
});


test("reset releases the old connection and its requests, then uses a new child", async t => {
  const { reader, processes } = setup(t, () => {}, { maxConcurrent: 1 });
  const active = assert.rejects(reader.request("thread/list", {}), { code: "CONNECTION_CLOSED" });
  await tick();
  const queued = assert.rejects(reader.request("thread/read", {}), { code: "CONNECTION_CLOSED" });
  reader.reset(); await Promise.all([active, queued]);
  assert.ok(processes[0].kills.length); assert.equal(reader.busy, false);
  const next = reader.request("thread/list", {}); await tick();
  assert.equal(processes.length, 2);
  processes[1].send({ id: 3, result: "new binary connection" });
  assert.equal(await next, "new binary connection");
  reader.close(); reader.reset();
  await assert.rejects(reader.request("thread/list", {}), { code: "CONNECTION_CLOSED" });
  assert.equal(processes.length, 2);
});
