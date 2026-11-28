import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge, decodeImage } from "../bridge/server.mjs";

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=";
const result = { title: "batch", promptZh: "一只猫", promptEn: "A cat", negativePrompt: "", observations: [], uncertainties: [] };

async function waitFor(read) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("batch did not settle");
}

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "reframe-admission-"));
  const skillPath = join(dir, "SKILL.md");
  await writeFile(skillPath, "Synthetic test skill");
  const reverse = [], generation = [];
  const models = { busy: false, selectedModel: "test", selection: () => ({ model: "test" }), invalidate: async () => {}, close() {} };
  const manager = () => ({ busy: false, status: async () => ({}), close() {} });
  const app = await createBridge({
    dataDir: dir, skillPath, models, piModels: models,
    cli: manager(), piCli: manager(), sessions: { busy: false, close() {} },
    compatibility: { getCompatibility: async () => ({}), snapshot: () => ({}) },
    generationContext: async () => ({ model: "image-test", provider: "fixture", codexGeneration: true }),
    agent: async args => { reverse.push(args); return result; },
    generator: async args => { generation.push(args); return decodeImage(image); },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, body, options = {}) => {
    const response = await fetch(url + path, {
      ...options, method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${app.token}`, "Content-Type": "application/json", ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    try {
      await waitFor(async () => !(await request("/health")).body.active &&
        (await request("/batches")).body.every(batch => batch.items.every(item => !["queued", "running"].includes(item.status))));
    } finally {
      app.server.closeAllConnections();
      await new Promise(resolve => app.server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });
  const project = await request("/projects", { image });
  assert.equal(project.status, 200);
  const payload = { requestId: "admission", language: "en", projects: [{ projectId: project.body.id, inputRevision: project.body.inputRevision }] };
  return { ...app, dir, reverse, generation, request, payload };
}

function observeRequest(server, marker) {
  const received = Promise.withResolvers();
  const listener = (req, res) => {
    if (req.headers["x-admission-test"] !== marker) return;
    server.off("request", listener);
    received.resolve(res);
  };
  server.on("request", listener);
  return received.promise;
}

// Pause only the first real batches.json commit; all task/storage code stays real.
function pauseCommit(path, afterRename = false) {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const rename = fs.promises.rename;
  let intercepted = false;
  fs.promises.rename = async (source, target) => {
    if (target !== path || intercepted) return rename(source, target);
    intercepted = true;
    const snapshot = JSON.parse(await readFile(source, "utf8"));
    if (afterRename) await rename(source, target);
    entered.resolve(snapshot);
    await release.promise;
    if (!afterRename) await rename(source, target);
  };
  syncBuiltinESMExports();
  return {
    entered: entered.promise, release: () => release.resolve(),
    restore() { release.resolve(); fs.promises.rename = rename; syncBuiltinESMExports(); },
  };
}

async function completed(s) {
  return waitFor(async () => {
    const batches = await s.request("/batches");
    assert.equal(batches.status, 200);
    const batch = batches.body[0];
    return batch?.items.every(item => item.status === "completed") && !(await s.request("/health")).body.active && batch;
  });
}

const identity = batch => ({ id: batch.id, jobs: batch.items.map(item => item.jobId) });

// Queued jobs are intentionally hidden until their job records exist.
function assertAcceptedIdentity(batch, frozen) {
  assert.equal(batch.id, frozen.id);
  assert.deepEqual(batch.items.map(item => item.projectId), frozen.items.map(item => item.projectId));
  batch.items.forEach((item, index) => {
    if (item.jobId !== undefined) assert.equal(item.jobId, frozen.items[index].jobId);
  });
}

for (const conflict of [false, true]) {
  test(`user concurrent batch retry ${conflict ? "rejects changed options without extra work" : "recovers the same tasks without duplicate work"}`, { timeout: 10_000 }, async t => {
    // Given the original batch has not committed, When another same-key request arrives,
    // Then identical input recovers its IDs and changed input conflicts; neither duplicates execution.
    const s = await setup(t), path = join(s.dir, "records", "batches.json");
    const commit = pauseCommit(path);
    let first, second;
    try {
      first = s.request("/batches", s.payload);
      const pending = await commit.entered;
      assert.equal(s.reverse.length, 0, "no model execution before durable admission");
      const received = observeRequest(s.server, "retry");
      second = s.request("/batches", conflict ? { ...s.payload, language: "zh" } : s.payload, { headers: { "x-admission-test": "retry" } });
      await received;
      commit.release();
      const [accepted, retried] = await Promise.all([first, second]);
      assert.equal(accepted.status, 202);
      assertAcceptedIdentity(accepted.body, pending[0]);
      assert.equal(retried.status, conflict ? 409 : 202);
      if (!conflict) assertAcceptedIdentity(retried.body, pending[0]);
      const final = await completed(s);
      assert.deepEqual(identity(final), identity(pending[0]));
      assert.equal(final.language, "en");
      const saved = JSON.parse(await readFile(path, "utf8"));
      assert.equal(saved.length, 1);
      assert.deepEqual(identity(saved[0]), identity(final));
      assert.equal(s.reverse.length, 1);
      assert.equal(s.generation.length, 1);
      assert.equal(s.generation[0].prompt, "A cat\n\nMatch the aspect ratio of the reference: 1:1 (width:height).", "automatic batch size follows the reference ratio");
    } finally {
      commit.restore();
      await Promise.allSettled([first, second]);
    }
  });
}

test("user recovers a committed batch after losing its acceptance response without replaying models", { timeout: 10_000 }, async t => {
  // Given the batch has been renamed onto disk but 202 has not been sent,
  // When its client disconnects and later retries, Then work continues and returns the original IDs.
  const s = await setup(t), path = join(s.dir, "records", "batches.json");
  const commit = pauseCommit(path, true), controller = new AbortController();
  let submitted;
  try {
    const received = observeRequest(s.server, "lost-response");
    submitted = s.request("/batches", s.payload, { signal: controller.signal, headers: { "x-admission-test": "lost-response" } }).catch(error => error);
    const response = await received, snapshot = await commit.entered;
    assert.equal(response.headersSent, false);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), snapshot);
    const closed = once(response, "close");
    controller.abort();
    assert.equal((await submitted).name, "AbortError");
    await closed;
    commit.release();
    const final = await completed(s);
    assert.deepEqual(identity(final), identity(snapshot[0]));
    assert.equal(s.reverse.length, 1);
    assert.equal(s.generation.length, 1);
    assert.equal(s.reverse[0].signal.aborted, false);
    assert.equal(s.generation[0].signal.aborted, false);
    const retried = await s.request("/batches", s.payload);
    assert.equal(retried.status, 202);
    assert.deepEqual(identity(retried.body), identity(final));
    assert.equal((await s.request("/batches")).body.length, 1);
    assert.equal(s.reverse.length, 1);
    assert.equal(s.generation.length, 1);
  } finally {
    controller.abort(); commit.restore();
    await submitted;
  }
});
