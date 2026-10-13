import test from "node:test";
import assert from "node:assert/strict";
import { createEntryReader } from "../lib/creation-entry.ts";

const source = { id: "reference-A", projectId: "A", inputRevision: 4, sourceUrl: "", image: "source" };
const handoff = { mode: "style", selection: source, draft: { instructions: { "A:style:new": "unsaved" } } };
const reference = { ...source, image: "durable", inputs: { style: { instruction: "saved" } } };
const job = { id: "job-A", projectId: "A", mode: "style", generations: [{ id: "generation-A" }] };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(overrides = {}) {
  let revision = 1;
  const calls = [], deliveries = [];
  const reader = createEntryReader({
    revision: () => revision,
    request: async message => {
      calls.push(message);
      return overrides.request ? overrides.request(message) : message.type === "alchemy:workspace-handoff" ? handoff : reference;
    },
    query: async path => { calls.push(path); return overrides.query ? overrides.query(path) : job; },
  });
  return { reader, calls, deliveries, read: entry => reader.read(entry, value => deliveries.push(value)), navigate: () => ++revision };
}

test("handoff shows its source before durable input arrives, then restores only matching revisions", async () => {
  const disk = deferred();
  const f = fixture({ request: message => message.type === "alchemy:workspace-handoff" ? handoff : disk.promise });
  const read = f.read({ handoff: "ticket" });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.deliveries, [{ kind: "handoff-source", handoff }]);
  disk.resolve(reference); await read;
  assert.deepEqual(f.deliveries[1], { kind: "handoff", handoff, selection: reference, freshness: "fresh" });
  assert.deepEqual(f.calls, [{ type: "alchemy:workspace-handoff", id: "ticket" }, { type: "alchemy:project-reference", id: "A" }]);
});

test("a changed durable revision opens the latest reference without adopting old draft input", async () => {
  const latest = { ...reference, inputRevision: 5 };
  const f = fixture({ request: message => message.type === "alchemy:workspace-handoff" ? handoff : latest });
  await f.read({ handoff: "ticket" });
  assert.deepEqual(f.deliveries.at(-1), { kind: "handoff", handoff, selection: { ...latest, inputs: undefined }, freshness: "stale" });
  assert.equal(latest.inputs.style.instruction, "saved", "reader must not mutate durable data");
  assert.equal(handoff.draft.instructions["A:style:new"], "unsaved", "reader must not mutate caller draft");
});

test("legacy missing revisions match zero, while missing versus a newer revision stays stale", async () => {
  for (const inputRevision of [undefined, 0, 1]) {
    const old = { ...handoff, selection: { ...source, inputRevision: undefined } };
    const current = { ...reference, inputRevision };
    const f = fixture({ request: message => message.type === "alchemy:workspace-handoff" ? old : current });
    await f.read({ handoff: "ticket" });
    assert.equal(f.deliveries.at(-1).freshness, inputRevision === 1 ? "stale" : "fresh");
  }
});

test("an expired handoff reports recovery instructions without changing the selected project", async () => {
  const f = fixture({ request: () => undefined });
  await f.read({ handoff: "expired" });
  assert.deepEqual(f.deliveries, [{ kind: "error", message: "接续草稿已失效，请从快捷面板重新打开工作台" }]);
  assert.equal(f.calls.length, 1);
});

test("a failed reference read keeps source context with an error, never marks its draft restorable", async () => {
  const f = fixture({ request: message => {
    if (message.type === "alchemy:workspace-handoff") return handoff;
    throw new Error("reference unavailable");
  } });
  await f.read({ handoff: "ticket" });
  assert.deepEqual(f.deliveries.at(-1), { kind: "handoff", handoff, selection: { ...source, error: "reference unavailable" }, freshness: "unavailable" });
});

test("unsaved and empty handoffs keep their distinct states without requesting a project", async () => {
  for (const selection of [{ id: "unsaved", image: "temporary", sourceUrl: "" }, undefined]) {
    const value = { ...handoff, selection };
    const f = fixture({ request: () => value });
    await f.read({ handoff: "ticket" });
    assert.deepEqual(f.deliveries.at(-1), { kind: "handoff", handoff: value,
      selection: selection && { ...selection, error: "参考图尚未保存，请重新上传" }, freshness: "unavailable" });
    assert.equal(f.calls.length, 1);
  }
});

test("a reminder delivers the exact task and durable project input together", async () => {
  const f = fixture(); await f.read({ task: "job-A" });
  assert.deepEqual(f.calls, ["/jobs/job-A", { type: "alchemy:project-reference", id: "A" }]);
  assert.deepEqual(f.deliveries, [{ kind: "reminder", job, selection: reference }]);
});

test("reminder query and reference failures are visible without fabricating a successful selection", async () => {
  for (const stage of ["query", "reference"]) {
    const fail = () => { throw new Error(`${stage} unavailable`); };
    const f = fixture(stage === "query" ? { query: fail } : { request: fail });
    await f.read({ task: "job-A" });
    assert.deepEqual(f.deliveries, [{ kind: "error", message: `${stage} unavailable` }]);
  }
});

for (const entry of [{ handoff: "ticket" }, { task: "job-A" }]) {
  for (const stage of ["first", "reference"]) {
    for (const failure of [false, true]) {
      test(`${Object.keys(entry)[0]} ${stage} ${failure ? "failure" : "success"} cannot be adopted after A to B to A navigation`, async () => {
        const late = deferred(), reached = deferred();
        const delay = () => { reached.resolve(); return late.promise; };
        const f = fixture({
          query: () => stage === "first" ? delay() : job,
          request: message => {
            if (message.type === "alchemy:workspace-handoff") return stage === "first" ? delay() : handoff;
            return delay();
          },
        });
        const read = f.read(entry); await reached.promise;
        const count = f.deliveries.length;
        f.navigate(); f.navigate();
        if (failure) late.reject(new Error("old failure")); else late.resolve(stage === "reference" ? reference : "handoff" in entry ? handoff : job);
        await read;
        assert.equal(f.deliveries.length, count, "old response cannot emit selection or error");
        if (stage === "first") assert.equal(f.calls.length, 1, "superseded source cannot start a second read");
      });
    }
  }
}

test("unmount discards pending success and failure and prevents new reads", async () => {
  for (const failure of [false, true]) {
    const late = deferred();
    const f = fixture({ query: () => late.promise });
    const read = f.read({ task: "job-A" });
    f.reader.dispose();
    if (failure) late.reject(new Error("unmounted")); else late.resolve(job);
    await read; await f.read({ task: "job-B" });
    assert.deepEqual(f.deliveries, []);
    assert.equal(f.calls.length, 1);
  }
});
