import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const code = ts.transpileModule(await readFile(new URL("../lib/export-simulation.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function fixture() {
  let clock = 0, next = 0;
  const tasks = new Map(), exports = {};
  runInNewContext(code, { exports, setTimeout(fn, delay) { tasks.set(++next, { fn, at: clock + delay }); return next; }, clearTimeout: id => tasks.delete(id) });
  return { ...exports, tasks, tick(time) {
    clock += time;
    for (const [id, task] of [...tasks].sort((a, b) => a[1].at - b[1].at)) if (task.at <= clock && tasks.delete(id)) task.fn();
  } };
}
test("simulation reports progress within 200ms and completes from its task result at 1.2 seconds", async () => {
  const view = fixture(), controller = new AbortController(), updates = [];
  let result;
  const task = view.simulateLocalExport(controller.signal, value => updates.push(value)).then(value => { result = value; });
  assert.deepEqual(updates, [0]); view.tick(200); assert.equal(updates.at(-1), 17);
  view.tick(999); await Promise.resolve(); assert.equal(result, undefined); assert.equal(updates.at(-1), 83);
  view.tick(1); await task; assert.equal(result.files, 3); assert.equal(updates.at(-1), 100); assert.equal(view.tasks.size, 0);
});
test("cancel removes all scheduled work and cannot emit late completion", async () => {
  const view = fixture(), controller = new AbortController(), updates = [];
  const task = view.simulateLocalExport(controller.signal, value => updates.push(value));
  view.tick(400); controller.abort(); const count = updates.length;
  await assert.rejects(task, { name: "AbortError" }); view.tick(2000);
  assert.equal(updates.length, count); assert.equal(view.tasks.size, 0);
});
test("cancel then immediate replay leaves only the latest task alive", async () => {
  const view = fixture(), first = new AbortController(), second = new AbortController(), updates = [];
  const previous = view.simulateLocalExport(first.signal, value => updates.push(`old:${value}`));
  view.tick(200); first.abort(); const rejected = assert.rejects(previous);
  const latest = view.simulateLocalExport(second.signal, value => updates.push(`new:${value}`));
  view.tick(1200); assert.equal((await latest).files, 3); await rejected;
  assert.equal(updates.includes("old:100"), false); assert.equal(updates.at(-1), "new:100"); assert.equal(view.tasks.size, 0);
});
test("already cancelled tasks schedule nothing", async () => {
  const view = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(view.simulateLocalExport(controller.signal, () => assert.fail("unexpected progress")));
  assert.equal(view.tasks.size, 0);
});
