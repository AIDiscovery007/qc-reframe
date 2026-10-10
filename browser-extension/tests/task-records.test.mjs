import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, rename, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskRecords } from "../bridge/task-records.mjs";

const jobFor = () => ({ id: "10000000-0000-0000-0000-000000000001", projectId: "project", status: "running", createdAt: "2026-01-01T00:00:00.000Z" });

test('user sees which failed image saves remain recoverable after a service restart', async t => {
  // Given one memory-only result and one stored image, When restarting, Then only the stored image offers local save recovery and neither is regenerated.
  const dir = await directory(t), job = { ...jobFor(), status: 'completed', generations: [
    { id: 'memory', status: 'failed', resultSavePending: true, prompt: 'unchanged' },
    { id: 'disk', status: 'failed', resultSavePending: true, imageAsset: 'asset' },
  ] };
  await writeFile(join(dir, `${job.id}.json`), JSON.stringify(job));
  const records = await createTaskRecords({ dataDir: dir, onCommit: () => {} });
  const restored = records.jobs.get(job.id).generations;
  assert.equal(restored[0].resultSavePending, undefined);
  assert.match(restored[0].error, /重启.*未写入磁盘/);
  assert.equal(restored[0].prompt, 'unchanged');
  assert.deepEqual(restored[1], job.generations[1]);
});
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "reframe-task-records-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("failed writes preserve the previous record, suppress committed feed and block image collection", async t => {
  const dir = await directory(t), snapshots = [];
  const records = await createTaskRecords({ dataDir: dir, onCommit: (_, snapshot) => snapshots.push(snapshot) });
  const job = jobFor(), path = join(dir, `${job.id}.json`);
  await records.save(job);
  const old = await readFile(path, "utf8");
  await rename(path, `${path}.backup`);
  await mkdir(path);
  job.status = "completed";
  await assert.rejects(records.save(job));
  assert.equal(await readFile(`${path}.backup`, "utf8"), old);
  assert.equal(snapshots.length, 1);
  assert.equal(records.canCollect, false);
  await rm(path, { recursive: true });
  await rename(`${path}.backup`, path);
  await records.save(job);
  assert.equal(records.canCollect, true);
  assert.equal(snapshots.at(-1).status, "completed");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), snapshots.at(-1));
});

test("queued commits freeze their own snapshot and publish only after their rename", async t => {
  const dir = await directory(t), published = [];
  const records = await createTaskRecords({ dataDir: dir, onCommit: (_, snapshot) => published.push(snapshot) });
  const job = jobFor();
  const first = records.save(job);
  job.status = "cancelled";
  const second = records.save(job);
  assert.equal(records.canCollect, false);
  await Promise.all([first, second]);
  assert.deepEqual(published.map(job => job.status), ["running", "cancelled"]);
  assert.equal(records.canCollect, true);
  assert.equal(JSON.parse(await readFile(join(dir, `${job.id}.json`))).status, "cancelled");
});

test("restart commits interruption recovery before publishing and preserves completed snapshots", async t => {
  const dir = await directory(t), job = jobFor();
  job.status = "completed";
  job.result = { promptZh: "unchanged" };
  job.generations = [{ id: "generation", status: "running" }, { id: "old", status: "completed", imageAsset: "immutable" }];
  await writeFile(join(dir, `${job.id}.json`), JSON.stringify(job));
  await writeFile(join(dir, "20000000-0000-0000-0000-000000000002.json"), "broken JSON");
  const published = [];
  const records = await createTaskRecords({ dataDir: dir, onCommit: (_, snapshot) => published.push(snapshot) });
  assert.equal(records.jobs.size, 1);
  assert.equal(published.length, 1);
  assert.equal(published[0].status, "completed");
  assert.equal(published[0].generations[0].status, "failed");
  assert.deepEqual(published[0].generations[1], job.generations[1]);
  assert.deepEqual(published[0].result, job.result);
  assert.deepEqual(JSON.parse(await readFile(join(dir, `${job.id}.json`))), published[0]);
});

test("a recovery commit failure aborts startup without publishing or discarding the interrupted record", async t => {
  const { default: fs } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const dir = await directory(t), job = jobFor(), path = join(dir, `${job.id}.json`);
  await writeFile(path, JSON.stringify(job));
  const rename = fs.promises.rename;
  fs.promises.rename = async (source, target) => {
    if (target === path) throw Object.assign(new Error("recovery disk failure"), { code: "EIO" });
    return rename(source, target);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(createTaskRecords({ dataDir: dir, onCommit: () => assert.fail("uncommitted recovery was published") }), /recovery disk failure/);
    assert.deepEqual(JSON.parse(await readFile(path)), job);
  } finally {
    fs.promises.rename = rename;
    syncBuiltinESMExports();
  }
});

test("restart terminates a persisted pending continuation without replaying or discarding its prompt", async t => {
  const dir = await directory(t), job = { ...jobFor(), status: "completed", result: { promptZh: "saved" }, autoGeneration: { status: "pending", language: "zh" } };
  await writeFile(join(dir, `${job.id}.json`), JSON.stringify(job));
  const records = await createTaskRecords({ dataDir: dir, onCommit: () => {} });
  const restored = records.jobs.get(job.id);
  assert.equal(restored.status, "completed");
  assert.deepEqual(restored.result, job.result);
  assert.equal(restored.autoGeneration.status, "failed");
  assert.match(restored.autoGeneration.error, /重启/);
  assert.equal(restored.generations, undefined);
  assert.deepEqual(JSON.parse(await readFile(join(dir, `${job.id}.json`))), restored);
});
