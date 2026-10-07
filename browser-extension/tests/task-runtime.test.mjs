import test from "node:test";
import assert from "node:assert/strict";
import { createTaskRuntime } from "../bridge/task-runtime.mjs";

const pending = () => Promise.withResolvers();
const jobFor = id => ({ id, projectId: "project", status: "running" });
const options = execute => ({ execute, completedStage: "完成", failedStage: "失败", modelSettings: {} });

test("cancelled work retains occupancy through late execution and final persistence", async () => {
  const execution = pending(), finalSave = pending(), saving = pending();
  let saves = 0, progressCount = 0, idleCount = 0;
  const job = jobFor("reverse");
  const runtime = createTaskRuntime({
    save: async () => { if (++saves === 2) { saving.resolve(); await finalSave.promise; } },
    onProgress: () => progressCount++, onIdle: async () => idleCount++, onFailure: async () => {},
  });
  const controller = runtime.reserve(job.id, job.projectId);
  let progress;
  const running = runtime.run(job, job, options(async context => {
    progress = context.progress;
    await execution.promise;
    return { result: "late result" };
  }));
  await runtime.cancel(job);
  assert.equal(controller.signal.aborted, true);
  assert.equal(job.status, "cancelled");
  assert.equal(runtime.busy, true);
  progress({ stage: "late progress" });
  assert.equal(progressCount, 0);
  execution.resolve();
  await saving.promise;
  assert.equal(runtime.count, 1);
  assert.equal(runtime.visibleCount(() => false), 0);
  assert.equal(runtime.busy, true);
  finalSave.resolve();
  await running;
  assert.equal(runtime.busy, false);
  assert.equal(job.result, undefined);
  assert.equal(idleCount, 1);
});

test("parallel generation and reverse execute independently, and readers block maintenance", async () => {
  const first = pending(), second = pending(), snapshots = [];
  const runtime = createTaskRuntime({ save: async job => snapshots.push(structuredClone(job)),
    onProgress: () => {}, onIdle: async () => {}, onFailure: async () => {} });
  const reverse = jobFor("reverse"), job = jobFor("prompt"), generation = jobFor("generation");
  job.generations = [generation];
  runtime.reserve(reverse.id, reverse.projectId);
  runtime.reserve(generation.id, job.projectId);
  const a = runtime.run(reverse, reverse, options(() => first.promise));
  const b = runtime.run(job, generation, options(() => second.promise));
  second.resolve({ imageAsset: "image" });
  await b;
  assert.equal(generation.status, "completed");
  assert.equal(reverse.status, "running");
  assert.equal(runtime.count, 1);
  first.reject(new Error("reverse failed"));
  await a;
  assert.equal(reverse.status, "failed");
  assert.equal(snapshots.length, 2);
  const release = runtime.read();
  assert.equal(runtime.count, 0);
  assert.equal(runtime.busy, true);
  release(); release();
  assert.equal(runtime.busy, false);
});

test("a failed completion commit becomes a persisted failure rather than apparent success", async () => {
  let writes = 0, persisted;
  const runtime = createTaskRuntime({ save: async job => {
    if (++writes === 1) throw new Error("disk failure");
    persisted = structuredClone(job);
  }, onProgress: () => {}, onIdle: async () => {}, onFailure: async () => assert.fail("storage failure is not a model failure") });
  const job = jobFor("reverse");
  runtime.reserve(job.id, job.projectId);
  await runtime.run(job, job, options(async () => ({ result: "generated" })));
  assert.equal(persisted.status, "failed");
  assert.match(persisted.error, /未能保存/);
  assert.equal(runtime.count, 0);
});
