import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createBridge, decodeImage } from "../bridge/server.mjs";
import { createSessionStore } from "../bridge/sessions.mjs";
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=";
const sid = "11111111-1111-4111-8111-111111111111";
const result = { title: "会话作品", observations: [], promptZh: "海边少女", promptEn: "Girl by the sea", negativePrompt: "", uncertainties: [] };
const post = body => ({ method: "POST", body: JSON.stringify(body) });
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "reframe-session-http-"));
  const skillPath = join(dir, "SKILL.md"); await writeFile(skillPath, "---\nname: alchemy\n---\nTest");
  let app;
  const calls = [], generations = [];
  const sessions = createSessionStore({ dataDir: join(dir, "records"), cwd: dir, run: async ({ signal }, action) => action(async (method, params) => {
    if (method === "thread/list") return { data: [{ id: sid, name: "小说", updatedAt: 1 }], nextCursor: null };
    if (method === "thread/read") return options.metadata ? options.metadata(signal, params) : { thread: { id: params.threadId, name: "小说", updatedAt: 1, historyMode: "paginated" } };
    if (options.page) return options.page(signal);
    return { data: [{ id: "t1", itemsView: "full", items: [{ type: "userMessage", id: "u1", content: [{ type: "text", text: "PRIVATE_STORY_BODY" }] }] }], nextCursor: null };
  }) });
  async function start() {
    app = await createBridge({ dataDir: dir, skillPath, generationContext: async () => ({ model: 'mock', provider: 'fixture', reasoningEffort: 'low', codexGeneration: true }), generationSkillPath: skillPath, sessions, sessionReadTimeoutMs: options.sessionReadTimeoutMs,
      models: { busy: false, selection: () => ({ model: "mock", provider: "mock" }), invalidate: async () => {}, close() {} },
      cli: { busy: false, close() {}, status: async () => ({}), check: options.cliCheck },
      agent: async args => { calls.push(args); return options.agent ? options.agent(args) : result; },
      generator: async args => { generations.push(args); return { ...decodeImage(image) }; },
    });
    app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  }
  async function stop() { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); }
  await start();
  t.after(async () => { await stop(); await rm(dir, { force: true, recursive: true }); });
  const request = (path, options = {}) => fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { ...options,
    headers: { Authorization: `Bearer ${app.token}`, "Content-Type": "application/json", ...options.headers } });
  const wait = async (id, status) => {
    for (let i = 0; i < 100; i++) {
      const job = await (await request(`/jobs/${id}`)).json();
      const health = await (await request("/health")).json();
      if (job.status === status && health.active === 0) return job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`job did not reach ${status}`);
  };
  return { dir, request, wait, calls, generations, restart: async () => { await stop(); await start(); } };
}
test("authenticated whole-session input, private job capture, generation, restart and deletion", async t => {
  const { request, dir, calls, generations, wait, restart } = await setup(t);
  assert.equal((await request("/sessions/list", { ...post({}), headers: { Authorization: "" } })).status, 401);
  assert.equal((await request("/sessions/list", post({ path: "/private" }))).status, 400);
  const list = await (await request("/sessions/list", post({}))).json(); assert.equal(list.data[0].id, sid);
  const project = await (await request("/projects", post({ image }))).json();
  const saveBody = { mode: "session", instruction: "为小说配图", expectedRevision: 0, sessionIds: [sid, sid] };
  const saved = await (await request(`/projects/${project.id}/input`, post(saveBody))).json();
  assert.equal(saved.inputs.session.sessions.length, 1); assert.equal(saved.inputVersions.session, "new");
  assert.equal((await request(`/projects/${project.id}/input`, post(saveBody))).status, 409);
  const response = await request("/jobs", post({ mode: "session", image, instruction: "为小说配图", projectId: project.id, inputRevision: saved.inputRevision, sessionIds: [sid] }));
  assert.equal(response.status, 202); const started = await response.json();
  const job = await wait(started.id, "completed");
  assert.equal(job.sessionContext.messageCount, 1); assert.equal(job.sessionContext.messages, undefined);
  assert.equal(calls[0].sessionContext.messages[0].text, "PRIVATE_STORY_BODY");
  const persisted = await readFile(join(dir, "records", `${job.id}.json`), "utf8"); assert.equal(persisted.includes("PRIVATE_STORY_BODY"), false);
  const snapshotPath = join(dir, "records", `${job.id}-session-context.json`);
  assert.ok((await readFile(snapshotPath, "utf8")).includes("PRIVATE_STORY_BODY"));
  const restored = await (await request(`/jobs/${job.id}/reference`)).json(); assert.equal(restored.sessions[0].id, sid);
  assert.equal((await request(`/jobs/${job.id}/generations`, post({ language: "zh", subjectImage: image }))).status, 400);
  assert.equal((await request(`/jobs/${job.id}/generations`, post({ language: "zh" }))).status, 202);
  await wait(job.id, "completed"); assert.equal(generations[0].mode, "session"); assert.ok(generations[0].imagePath); assert.equal(generations[0].subjectImagePath, undefined);
  await restart();
  const afterRestart = await (await request(`/jobs/${job.id}`)).json(); assert.equal(afterRestart.sessionContext.hash, job.sessionContext.hash); await access(snapshotPath);
  const reference = await (await request(`/projects/${project.id}/reference`)).json();
  const cleared = await (await request(`/projects/${project.id}/input`, post({ ...saveBody, expectedRevision: reference.inputRevision, sessionIds: [] }))).json();
  assert.deepEqual(cleared.inputs.session.sessions, []); assert.equal(cleared.inputVersions.session, "new");
  assert.equal((await request("/projects/delete", post({ ids: [project.id] }))).status, 200);
  await assert.rejects(access(snapshotPath));
});
test("rejects empty start, non-session IDs and session subject input", async t => {
  const { request, calls } = await setup(t);
  for (const body of [
    { mode: "session", sessionIds: [] }, { mode: "recreate", sessionIds: [sid] },
    { mode: "session", sessionIds: [sid], reenact: { subjectImage: image } },
  ]) assert.equal((await request("/jobs", post({ image, instruction: "test", ...body }))).status, 400);
  assert.equal(calls.length, 0);
});
test("read failure after 202 never enters agent or writes partial snapshot", async t => {
  const { request, wait, calls, dir } = await setup(t, { page: async () => { throw new Error("正文读取失败"); } });
  const response = await request("/jobs", post({ mode: "session", image, instruction: "test", sessionIds: [sid] }));
  assert.equal(response.status, 202); const job = await response.json();
  const failed = await wait(job.id, "failed"); assert.match(failed.error, /正文读取失败/); assert.equal(calls.length, 0);
  await assert.rejects(access(join(dir, "records", `${job.id}-session-context.json`)));
});
test("cancel pending read aborts it and never invokes agent", async t => {
  let readStarted; const ready = new Promise(resolve => { readStarted = resolve; });
  const { request, wait, calls } = await setup(t, { page: signal => new Promise((resolve, reject) => {
    readStarted(); signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  }) });
  const response = await request("/jobs", post({ mode: "session", image, instruction: "test", sessionIds: [sid] }));
  const job = await response.json(); await ready;
  assert.equal((await request(`/jobs/${job.id}/cancel`, post({}))).status, 200);
  await wait(job.id, "cancelled"); assert.equal(calls.length, 0);
});
for (const destination of ["input", "job"]) test(`pending session metadata releases mutation lock and rechecks revision (${destination})`, { timeout: 3000 }, async t => {
  const ready = Promise.withResolvers(), metadata = Promise.withResolvers();
  const { request, wait } = await setup(t, {
    metadata: async () => { ready.resolve(); await metadata.promise; return { thread: { id: sid, name: "小说", updatedAt: 1, historyMode: "paginated" } }; },
    agent: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })),
  });
  const running = await (await request("/jobs", post({ mode: "recreate", image }))).json();
  const projectPath = `/projects/${running.projectId}`;
  const target = destination === "input" ? `${projectPath}/input` : "/jobs";
  const body = destination === "input" ? { expectedRevision: 1 } : { projectId: running.projectId, inputRevision: 1, image };
  const pending = request(target, post({ ...body, mode: "session", instruction: "test", sessionIds: [sid] }));
  await ready.promise;
  try {
    assert.equal((await request(`/jobs/${running.id}/cancel`, { ...post({}), signal: AbortSignal.timeout(500) })).status, 200);
    await wait(running.id, "cancelled");
    assert.equal((await request(`${projectPath}/input`, { ...post({ expectedRevision: 1, mode: "recreate", instruction: "newer edit" }), signal: AbortSignal.timeout(500) })).status, 200);
  } finally { metadata.resolve(); }
  assert.equal((await pending).status, 409);
  const reference = await (await request(`${projectPath}/reference`)).json();
  assert.equal(reference.inputRevision, 2); assert.equal(reference.inputs.session, undefined);
  assert.equal((await (await request("/jobs")).json()).length, 1);
});
for (const destination of ["input", "job"]) test(`disconnect cancels session metadata and writes no input or job (${destination})`, { timeout: 3000 }, async t => {
  const ready = Promise.withResolvers(), aborted = Promise.withResolvers();
  const { request } = await setup(t, { metadata: signal => new Promise((resolve, reject) => {
    ready.resolve(); signal.addEventListener("abort", () => { aborted.resolve(); reject(new Error("aborted")); }, { once: true });
  }) });
  const project = await (await request("/projects", post({ image }))).json();
  const controller = new AbortController();
  const body = destination === "input" ? { expectedRevision: 0 } : { projectId: project.id, inputRevision: 0, image };
  const target = destination === "input" ? `/projects/${project.id}/input` : "/jobs";
  const pending = request(target, { ...post({ ...body, mode: "session", instruction: "test", sessionIds: [sid] }), signal: controller.signal });
  const rejected = assert.rejects(pending, /abort/i);
  await ready.promise;
  assert.equal((await request("/cli/update", post({}))).status, 409);
  controller.abort(); await rejected; await aborted.promise;
  const reference = await (await request(`/projects/${project.id}/reference`)).json();
  assert.equal(reference.inputRevision, 0); assert.equal(reference.inputs, undefined);
  assert.deepEqual(await (await request("/jobs")).json(), []);
});

for (const destination of ["input", "job"]) for (const cancellation of ["disconnect", "timeout"])
  test(`finished metadata cannot commit after ${cancellation} while waiting for mutation lock (${destination})`, { timeout: 3000 }, async t => {
    const ready = Promise.withResolvers(), metadata = Promise.withResolvers(), aborted = Promise.withResolvers();
    const locked = Promise.withResolvers(), unlock = Promise.withResolvers();
    const { request } = await setup(t, {
      sessionReadTimeoutMs: cancellation === "timeout" ? 100 : 2000,
      metadata: async signal => {
        signal.addEventListener("abort", aborted.resolve, { once: true });
        ready.resolve(); await metadata.promise;
        return { thread: { id: sid, name: "小说", updatedAt: 1 } };
      },
      cliCheck: async () => { locked.resolve(); await unlock.promise; return {}; },
    });
    const project = await (await request("/projects", post({ image }))).json();
    const controller = new AbortController();
    const target = destination === "input" ? `/projects/${project.id}/input` : "/jobs";
    const body = destination === "input" ? { expectedRevision: 0 } : { projectId: project.id, inputRevision: 0, image };
    const pending = request(target, { ...post({ ...body, mode: "session", instruction: "test", sessionIds: [sid] }), signal: controller.signal });
    const rejected = cancellation === "disconnect" ? assert.rejects(pending, /abort/i) : undefined;
    await ready.promise;
    const blocker = request("/cli/check", post({})); await locked.promise;
    try {
      metadata.resolve();
      await new Promise(resolve => setImmediate(resolve));
      if (cancellation === "disconnect") { controller.abort(); await rejected; }
      await aborted.promise;
    } finally { unlock.resolve(); }
    assert.equal((await blocker).status, 200);
    if (cancellation === "timeout") assert.equal((await pending).status, 504);
    const reference = await (await request(`/projects/${project.id}/reference`)).json();
    assert.equal(reference.inputRevision, 0); assert.equal(reference.inputs, undefined);
    assert.deepEqual(await (await request("/jobs")).json(), []);
  });
for (const destination of ["input", "job"]) test(`metadata returning after deadline cannot commit (${destination})`, { timeout: 3000 }, async t => {
  const { request } = await setup(t, {
    sessionReadTimeoutMs: 30,
    metadata: signal => new Promise(resolve => signal.addEventListener("abort", () => {
      // A reader may finish successfully just as cancellation arrives.
      resolve({ thread: { id: sid, name: "小说", updatedAt: 1 } });
    }, { once: true })),
  });
  const project = await (await request("/projects", post({ image }))).json();
  const target = destination === "input" ? `/projects/${project.id}/input` : "/jobs";
  const body = destination === "input" ? { expectedRevision: 0 } : { projectId: project.id, inputRevision: 0, image };
  assert.equal((await request(target, post({ ...body, mode: "session", instruction: "test", sessionIds: [sid] }))).status, 504);
  const reference = await (await request(`/projects/${project.id}/reference`)).json();
  assert.equal(reference.inputRevision, 0); assert.equal(reference.inputs, undefined);
  assert.deepEqual(await (await request("/jobs")).json(), []);
});

test("local index API authenticates, validates actions and exposes only bounded search snippets", async t => {
  const { request, calls } = await setup(t);
  assert.equal((await request("/sessions/index", { ...post({ action: "refresh" }), headers: { Authorization: "" } })).status, 401);
  for (const body of [{ action: "unknown" }, { action: "refresh", directory: "/tmp" }, null])
    assert.equal((await request("/sessions/index", post(body))).status, 400);
  assert.equal((await (await request("/sessions/index", post({ action: "status" }))).json()).state, "empty");
  assert.equal((await request("/sessions/index", post({ action: "refresh" }))).status, 200);
  let state;
  for (let i = 0; i < 100; i++) {
    state = await (await request("/sessions/index", post({ action: "status" }))).json();
    if (state.state !== "building") break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(state.state, "ready");
  const found = await (await request("/sessions/list", post({ scope: "content", archived: true, searchTerm: "STORY" }))).json();
  assert.equal(found.data.length, 1); assert.equal(found.data[0].match, "content");
  assert.match(found.data[0].snippet, /PRIVATE_STORY_BODY/); assert.equal(found.data[0].messages, undefined);
  assert.equal(calls.length, 0, "indexing must not invoke inference");
  assert.equal((await (await request("/sessions/index", post({ action: "clear" }))).json()).state, "empty");
});
test("background indexing blocks CLI upgrades after the initiating HTTP request completes", async t => {
  const started = Promise.withResolvers();
  const { request } = await setup(t, { page: signal => new Promise((resolve, reject) => {
    started.resolve(); signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  }) });
  await request("/sessions/index", post({ action: "refresh" })); await started.promise;
  assert.equal((await request("/cli/update", post({}))).status, 409);
  assert.equal((await request("/models/refresh", post({}))).status, 409);
  assert.equal((await (await request("/sessions/index", post({ action: "clear" }))).json()).state, "empty");
});

test("session creation chains its captured prompt into generation without sending session text again", async t => {
  const { request, wait, calls, generations } = await setup(t);
  const response = await request("/jobs", post({ mode: "session", image, instruction: "为小说配图", sessionIds: [sid], generation: { language: "en" } }));
  assert.equal(response.status, 202);
  const submitted = await response.json(), job = await wait(submitted.id, "completed");
  assert.equal(job.autoGeneration.status, "started");
  assert.equal(job.generations[0].status, "completed");
  assert.equal(calls[0].sessionContext.messages[0].text, "PRIVATE_STORY_BODY");
  assert.equal(generations[0].prompt, result.promptEn);
  assert.equal(generations[0].sessionContext, undefined);
  assert.ok(generations[0].imagePath);
  assert.equal(generations[0].subjectImagePath, undefined);
});
