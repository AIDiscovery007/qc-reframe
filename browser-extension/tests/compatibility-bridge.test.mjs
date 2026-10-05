import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createBridge, decodeImage } from "../bridge/server.mjs";

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=";
const input = { mode: "recreate", image };
const result = { title: "Test", promptZh: "海边", promptEn: "Seaside", negativePrompt: "", observations: [], uncertainties: [] };
const post = body => ({ method: "POST", body: JSON.stringify(body) });

async function setup(t, status = "supported", probe, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "reframe-compat-http-"));
  const skillPath = join(dir, "SKILL.md");
  await writeFile(skillPath, "---\nname: alchemy\n---\nTest");
  const report = { checkedAt: "2026-10-05T00:00:00.000Z", features: Object.fromEntries(["models", "reverse", "generation", "sessions"].map(key => [key, { status }])) };
  const calls = [], probes = [];
  const cliState = { installed: true, version: "0.1.0", updateAvailable: true };
  const app = await createBridge({ dataDir: dir, skillPath, generationSkillPath: skillPath,
    compatibility: { snapshot: () => structuredClone(report), getCompatibility: async options => { probes.push(options); return probe ? probe() : structuredClone(report); } },
    cli: { busy: false, close() {}, peek: () => cliState, status: async () => cliState, check: async () => { calls.push("cli-check"); return cliState; } },
    models: { busy: false, selectedModel: "mock", close() {}, selection: () => ({ model: "mock", provider: "mock" }), invalidate: async () => {},
      list: async () => { calls.push("models-list"); return { models: [] }; },
      refresh: async () => { calls.push("models-refresh"); return {}; }, start: async () => { calls.push("models-verify"); return {}; } },
    sessions: { busy: false, close() {}, resetReader() { calls.push("sessions-reset"); },
      list: async () => { calls.push("sessions-list"); return { data: [], nextCursor: null }; },
      index: async action => { calls.push(`index-${action}`); return { state: "empty" }; } },
    agent: async () => { calls.push("reverse"); return result; },
    generator: async () => { calls.push("generation"); return decodeImage(image); },
    ...overrides,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const request = (path, options = {}) => fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
    ...options, headers: { Authorization: `Bearer ${app.token}`, "Content-Type": "application/json" },
  });
  const block = feature => { report.features[feature] = { status: "unsupported", message: `当前 Codex CLI 不支持${feature}接口，请检查更新。` }; };
  const wait = async id => {
    for (let i = 0; i < 100; i++) {
      const job = await (await request(`/jobs/${id}`)).json();
      if (job.status === "completed" && !(job.generations || []).some(item => item.status === "running")
        && (await (await request("/health")).json()).active === 0) return job;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail("mock task did not complete");
  };
  const start = async () => {
    const response = await request("/jobs", post(input));
    assert.equal(response.status, 202);
    const job = await response.json();
    await wait(job.id);
    return job.id;
  };
  return { dir, report, calls, probes, request, block, wait, start };
}

async function rejected(response) {
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.recovery, "cli");
  assert.match(body.error, /不支持/);
}

test("unsupported model and session APIs stop before execution while independent features stay available", async t => {
  const f = await setup(t);
  f.block("models");
  await rejected(await f.request("/models"));
  await rejected(await f.request("/models/refresh", post({})));
  await rejected(await f.request("/models/verify", post({ model: "mock" })));
  assert.equal((await f.request("/sessions/list", post({}))).status, 200);
  assert.deepEqual(f.calls, ["sessions-list"]);
  f.report.features.models.status = "supported";
  f.block("sessions");
  await rejected(await f.request("/sessions/list", post({})));
  await rejected(await f.request("/sessions/index", post({ action: "refresh" })));
  assert.equal((await f.request("/models")).status, 200);
  assert.deepEqual(f.calls, ["sessions-list", "models-list"]);
  assert.deepEqual(await readdir(join(f.dir, "records")), []);
});

test("unsupported reverse writes no project or job; unsupported generation leaves completed work unchanged", async t => {
  const f = await setup(t);
  f.block("reverse");
  await rejected(await f.request("/jobs", post(input)));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(join(f.dir, "records")), []);
  assert.deepEqual(await readdir(join(f.dir, "images")), []);
  f.report.features.reverse.status = "supported";
  const id = await f.start();
  const record = join(f.dir, "records", `${id}.json`);
  const before = await readFile(record, "utf8");
  const files = await readdir(join(f.dir, "records"));
  f.block("generation");
  await rejected(await f.request(`/jobs/${id}/generations`, post({ language: "zh" })));
  assert.equal(await readFile(record, "utf8"), before);
  assert.deepEqual(await readdir(join(f.dir, "records")), files);
  assert.deepEqual(f.calls, ["reverse"]);
});

test("unknown compatibility allows real routes to decide, including reverse and generation", async t => {
  const f = await setup(t, "unknown");
  assert.equal((await f.request("/models")).status, 200);
  assert.equal((await f.request("/sessions/list", post({}))).status, 200);
  const id = await f.start();
  assert.equal((await f.request(`/jobs/${id}/generations`, post({ language: "zh" }))).status, 202);
  const job = await f.wait(id);
  assert.equal(job.generations[0].status, "completed");
  assert.deepEqual(f.calls, ["models-list", "sessions-list", "reverse", "generation"]);
});

test("CLI status returns the report and explicit check forces a fresh probe and resets the idle reader", async t => {
  const f = await setup(t);
  assert.deepEqual((await (await f.request("/cli/status")).json()).compatibility, f.report);
  assert.deepEqual(f.probes, [undefined]);
  const checked = await f.request("/cli/check", post({}));
  assert.equal(checked.status, 200);
  assert.deepEqual((await checked.json()).compatibility, f.report);
  assert.deepEqual(f.probes, [undefined, { force: true }]);
  assert.deepEqual(f.calls, ["cli-check", "sessions-reset"]);
});

test("health returns the cached snapshot without waiting for an unresolved compatibility probe", async t => {
  const f = await setup(t, "unknown", () => new Promise(() => {}));
  const response = await f.request("/health", { signal: AbortSignal.timeout(1_000) });
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.serviceReady, true);
  assert.deepEqual(health.compatibility, f.report);
  assert.equal(f.probes.length, 1);
});

test("unsupported sessions preserve local index status and clear without probing CLI again", async t => {
  const f = await setup(t);
  f.block("sessions");
  for (const action of ["status", "clear"]) {
    const response = await f.request("/sessions/index", post({ action }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, "empty");
  }
  assert.deepEqual(f.calls, ["index-status", "index-clear"]);
  assert.deepEqual(f.probes, []);
});

test("a slow session compatibility probe does not block cancellation or permit CLI upgrades", async t => {
  let slow = false, releaseProbe, entered;
  const probing = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, "supported", () => slow ? new Promise(resolve => { releaseProbe = resolve; entered(); }) : f.report, {
    agent: async ({ signal }) => { await once(signal, "abort"); throw new Error("cancelled"); },
  });
  const job = await (await f.request("/jobs", post(input))).json();
  slow = true;
  const reading = f.request("/sessions/list", post({}));
  await probing;
  try {
    const cancelled = await f.request(`/jobs/${job.id}/cancel`, { ...post({}), signal: AbortSignal.timeout(1_500) });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).status, "cancelled");
    assert.equal((await f.request("/cli/update", { ...post({}), signal: AbortSignal.timeout(1_500) })).status, 409);
    assert.ok(!f.calls.includes("sessions-list"));
  } finally { releaseProbe(f.report); await reading; }
  assert.ok(f.calls.includes("sessions-list"));
});

test("session timeout cancels waiting for a shared compatibility probe and skips the late read", async t => {
  let slow = true, releaseProbe;
  const f = await setup(t, "supported", () => slow ? new Promise(resolve => { releaseProbe = resolve; }) : f.report, { sessionReadTimeoutMs: 30 });
  const response = await f.request("/sessions/list", { ...post({}), signal: AbortSignal.timeout(1_500) });
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /超时/);
  // Reader accounting is released before the shared probe finishes.
  slow = false;
  try {
    const refreshed = await f.request("/models/refresh", { ...post({}), signal: AbortSignal.timeout(1_500) });
    assert.equal(refreshed.status, 200);
  } finally { releaseProbe(f.report); }
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!f.calls.includes("sessions-list"));
});

test("session input rechecks project revision after a slow compatibility probe", async t => {
  let releaseProbe, entered;
  const probing = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, "supported", () => new Promise(resolve => { releaseProbe = resolve; entered(); }), {
    sessions: { busy: false, close() {}, metadata: async ids => ids.map(id => ({ id, title: "Mock", updatedAt: 1 })) },
  });
  const project = await (await f.request("/projects", post({ image }))).json();
  const path = `/projects/${project.id}/input`;
  const reading = f.request(path, post({ mode: "session", instruction: "late", expectedRevision: project.inputRevision, sessionIds: ["12345678-1234-1234-1234-123456789abc"] }));
  await probing;
  try {
    const updated = await f.request(path, { ...post({ mode: "recreate", instruction: "keep current edit", expectedRevision: project.inputRevision }), signal: AbortSignal.timeout(1_500) });
    assert.equal(updated.status, 200);
  } finally { releaseProbe(f.report); }
  const rejected = await reading;
  assert.equal(rejected.status, 409);
  assert.match((await rejected.json()).error, /其他窗口更新/);
  assert.equal((await (await f.request(`/projects/${project.id}/reference`)).json()).inputs.recreate.instruction, "keep current edit");
});

for (const feature of ["reverse", "generation"]) {
  test(`slow ${feature} probe leaves unrelated cancellation responsive and prevents CLI updates`, async t => {
    let slow = false, blockAgent = false, releaseProbe, entered;
    const probing = new Promise(resolve => { entered = resolve; });
    const f = await setup(t, "supported", () => slow ? new Promise(resolve => { releaseProbe = resolve; entered(); }) : f.report, {
      agent: async ({ signal }) => { if (blockAgent) { await once(signal, "abort"); throw new Error("cancelled"); } return result; },
    });
    const completed = await f.start();
    blockAgent = true;
    const running = await (await f.request("/jobs", post(input))).json();
    slow = true;
    const pending = f.request(feature === "reverse" ? "/jobs" : `/jobs/${completed}/generations`, post(feature === "reverse" ? input : { language: "zh" }));
    await probing;
    try {
      const cancelled = await f.request(`/jobs/${running.id}/cancel`, { ...post({}), signal: AbortSignal.timeout(1_500) });
      assert.equal(cancelled.status, 200);
      assert.equal((await cancelled.json()).status, "cancelled");
      assert.equal((await f.request("/cli/update", { ...post({}), signal: AbortSignal.timeout(1_500) })).status, 409);
    } finally { blockAgent = false; slow = false; releaseProbe(f.report); }
    const response = await pending;
    assert.equal(response.status, 202);
    const started = await response.json();
    await f.wait(feature === "reverse" ? started.id : completed);
  });

  test(`disconnected ${feature} request does not write after a late probe`, async t => {
    let slow = false, releaseProbe, entered;
    const probing = new Promise(resolve => { entered = resolve; });
    const f = await setup(t, "supported", () => slow ? new Promise(resolve => { releaseProbe = resolve; entered(); }) : f.report);
    const id = feature === "generation" ? await f.start() : undefined;
    const before = await readdir(join(f.dir, "records"));
    const controller = new AbortController();
    slow = true;
    const pending = f.request(id ? `/jobs/${id}/generations` : "/jobs", { ...post(id ? { language: "zh" } : input), signal: controller.signal });
    await probing;
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    slow = false;
    try {
      // Wait for the server to observe the closed socket, without completing the probe.
      let response;
      for (let i = 0; i < 100; i++) {
        response = await f.request("/models/refresh", { ...post({}), signal: AbortSignal.timeout(1_500) });
        if (response.status === 200) break;
        assert.equal(response.status, 409);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(response.status, 200);
    } finally { releaseProbe(f.report); }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await readdir(join(f.dir, "records")), before);
    assert.ok(!f.calls.includes("generation"));
    if (id) assert.equal((await (await f.request(`/jobs/${id}`)).json()).generations?.length || 0, 0);
    else assert.ok(!f.calls.includes("reverse"));
  });
}

test("reverse revalidates project revision after its compatibility probe", async t => {
  let releaseProbe, entered;
  const probing = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, "supported", () => new Promise(resolve => { releaseProbe = resolve; entered(); }));
  const project = await (await f.request("/projects", post({ image }))).json();
  const pending = f.request("/jobs", post({ ...input, projectId: project.id, inputRevision: project.inputRevision }));
  await probing;
  try {
    const update = await f.request(`/projects/${project.id}/input`, { ...post({ mode: "recreate", instruction: "new input", expectedRevision: project.inputRevision }), signal: AbortSignal.timeout(1_500) });
    assert.equal(update.status, 200);
  } finally { releaseProbe(f.report); }
  assert.equal((await pending).status, 409);
  assert.ok(!f.calls.includes("reverse"));
});

test("generation revalidates source existence after its compatibility probe", async t => {
  let slow = false, releaseProbe, entered;
  const probing = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, "supported", () => slow ? new Promise(resolve => { releaseProbe = resolve; entered(); }) : f.report);
  const id = await f.start();
  const job = await (await f.request(`/jobs/${id}`)).json();
  slow = true;
  const pending = f.request(`/jobs/${id}/generations`, post({ language: "zh" }));
  await probing;
  try {
    const deleted = await f.request("/projects/delete", { ...post({ ids: [job.projectId] }), signal: AbortSignal.timeout(1_500) });
    assert.equal(deleted.status, 200);
  } finally { releaseProbe(f.report); }
  assert.equal((await pending).status, 404);
  assert.ok(!f.calls.includes("generation"));
});
