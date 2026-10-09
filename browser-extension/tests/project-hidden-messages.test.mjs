import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as operationPolicy from "../lib/operation-policy.ts";

const compiled = ts.transpileModule(await readFile(new URL("../entrypoints/background.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const projectId = "a".repeat(64), image = "data:image/png;base64,AAAA";
const sender = { id: "test", url: "chrome-extension://test/workspace.html" };
const contentSender = { id: "test", frameId: 0, tab: { id: 1, windowId: 1, url: "https://example.com/" } };

function background(local = { preferences: { token: "private-token" } }) {
  const session = {}, calls = [], tabMessages = [], runtimeMessages = [], accessLevels = [], storageReads = [];
  let listener, hidden = false, offline = false;
  const area = data => ({
    get: async key => { storageReads.push(key); return structuredClone(data); },
    set: async value => Object.assign(data, structuredClone(value)),
    remove: async key => { delete data[key]; },
    setAccessLevel: async value => { accessLevels.push(value.accessLevel); },
  });
  const browser = {
    storage: { local: area(local), session: area(session) },
    runtime: { id: "test", getURL: path => `chrome-extension://test${path}`, sendMessage: async message => runtimeMessages.push(message), onConnect: { addListener() {} }, onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
    contextMenus: { onClicked: { addListener() {} } },
    tabs: { query: async () => [{ id: 1 }, { id: 2 }], sendMessage: async (id, message) => { if (id === 2) throw new Error("no content script"); tabMessages.push(message); }, create: async () => {} },
  };
  const bridge = async (path, token, body) => {
    calls.push({ path, token, body: structuredClone(body) });
    if (offline) throw new Error("offline");
    if (path === "/projects/visibility") { hidden = body.hidden; return { updatedIds: body.ids, hidden, revision: "new" }; }
    if (path.startsWith("/health")) return { hiddenProjectIds: hidden ? [projectId] : [] };
    if (path.startsWith("/jobs/")) return { projectId };
    const projectPath = /^\/projects\/([a-f0-9]{64})(\/reference)?$/.exec(path);
    if (projectPath?.[2]) return { id: "reference", projectId: projectPath[1], image, sourceUrl: "" };
    if (projectPath) return { id: projectPath[1], hidden: projectPath[1] === projectId && hidden };
    if (path === "/projects" && body) return { id: projectId, hidden, created: false };
    return [];
  };
  runInNewContext(compiled, {
    exports: {}, defineBackground: fn => fn(), crypto, URLSearchParams, TextEncoder, console,
    require: name => ({
      "../lib/reminder-background": { startReminderService: () => ({ wake: async () => {}, projectsChanged: async () => {} }) },
      "wxt/browser": { browser }, "../lib/bridge": { bridge },
      "../lib/operation-policy": operationPolicy,
      "../lib/capture": { captureImage: async () => ({ image, capture: "original" }) },
    })[name],
  });
  return {
    local, session, calls, tabMessages, runtimeMessages, accessLevels, storageReads,
    set hidden(value) { hidden = value; }, set offline(value) { offline = value; },
    send(message, from = sender) { return new Promise(resolve => { if (listener(message, from, resolve) !== true) resolve(undefined); }); },
  };
}

test("hidden project visibility defaults off, reaches every list, and survives only the browser session", async () => {
  const bg = background();
  assert.equal((await bg.send({ type: "alchemy:state" })).value.preferences.showHiddenProjects, false);
  assert.equal((await bg.send({ type: "alchemy:show-hidden-projects", show: true })).value, true);
  for (const path of ["/projects", "/jobs", "/health"])
    await bg.send({ type: "alchemy:query", path });
  await bg.send({ type: "alchemy:projects", page: 2, q: "模板", status: "unstarted" });
  assert.ok(bg.calls.every(call => new URL(call.path, "http://local").searchParams.get("includeHidden") === "true"));
  const query = new URL(bg.calls.at(-1).path, "http://local").searchParams;
  assert.equal(query.get("page"), "2");
  assert.equal(query.get("status"), "unstarted");
  assert.equal(query.get("q"), "模板");
  assert.equal(bg.local.preferences.showHiddenProjects, undefined);
  assert.equal((await background(bg.local).send({ type: "alchemy:state" })).value.preferences.showHiddenProjects, false);
  await bg.send({ type: "alchemy:show-hidden-projects", show: false });
  await bg.send({ type: "alchemy:query", path: "/jobs" });
  assert.equal(bg.calls.at(-1).path, "/jobs");
});

test("visibility messages reject malformed or untrusted input before any bridge write", async () => {
  const bg = background();
  for (const message of [
    { type: "alchemy:show-hidden-projects", show: "true" },
    { type: "alchemy:set-project-hidden", ids: [], hidden: true },
    { type: "alchemy:set-project-hidden", ids: ["../secret"], hidden: true },
    { type: "alchemy:set-project-hidden", ids: [projectId], hidden: 1 },
    { type: "alchemy:query", path: "/jobs?includeHidden=true" },
  ]) assert.match((await bg.send(message)).error, /无效|有效/);
  const message = { type: "alchemy:set-project-hidden", ids: [projectId], hidden: true };
  assert.equal(await bg.send(message, { ...sender, id: "foreign" }), undefined);
  assert.equal(await bg.send(message, { ...contentSender, frameId: 1 }), undefined);
  assert.equal(bg.calls.length, 0);
  assert.equal((await bg.send(message, contentSender)).value.hidden, true);
  assert.equal(bg.calls[0].path, "/projects/visibility");
  assert.equal(bg.calls[0].token, "private-token");
});

test("gallery messages validate metadata queries and derive hidden access from the session", async () => {
  const bg = background();
  const message = { type: "alchemy:gallery", offset: 96, limit: 96, search: "花园", projectId, ratio: "portrait", sort: "oldest", includeHidden: true };
  assert.equal((await bg.send(message)).ok, true);
  let query = new URL(bg.calls.at(-1).path, "http://local");
  assert.equal(query.pathname, "/gallery");
  assert.equal(query.searchParams.get("includeHidden"), null);
  assert.equal(query.searchParams.get("offset"), "96");
  assert.equal(query.searchParams.get("search"), "花园");
  assert.equal(bg.calls[0].token, "private-token");
  await bg.send({ type: "alchemy:show-hidden-projects", show: true });
  await bg.send(message);
  query = new URL(bg.calls.at(-1).path, "http://local");
  assert.equal(query.searchParams.get("includeHidden"), "true");
  const count = bg.calls.length;
  for (const invalid of [{ offset: -1 }, { limit: 101 }, { search: 5 }, { projectId: "../secret" }, { ratio: "wide" }, { sort: "random" }])
    assert.match((await bg.send({ ...message, ...invalid })).error, /无效/);
  assert.equal(await bg.send(message, { ...sender, id: "foreign" }), undefined);
  assert.equal(await bg.send(message, { ...contentSender, frameId: 1 }), undefined);
  assert.equal(bg.calls.length, count);
});

test("hiding conceals the selected project without deleting the selection and showing restores it", async () => {
  const bg = background({ preferences: { token: "private-token" }, selection: { id: "selected", projectId, image } });
  await bg.send({ type: "alchemy:set-project-hidden", ids: ["b".repeat(64)], hidden: true });
  assert.equal(bg.local.selection.projectId, projectId);
  await bg.send({ type: "alchemy:set-project-hidden", ids: [projectId], hidden: true });
  assert.equal(bg.local.selection.projectId, projectId);
  assert.equal((await bg.send({ type: "alchemy:state" })).value.selection, undefined);
  await bg.send({ type: "alchemy:show-hidden-projects", show: true });
  assert.equal((await bg.send({ type: "alchemy:state" })).value.selection.projectId, projectId);
  await bg.send({ type: "alchemy:show-hidden-projects", show: false });
  assert.equal(bg.local.selection.projectId, projectId);
  assert.equal((await bg.send({ type: "alchemy:state" })).value.selection, undefined);
});

test("hiding a project cannot erase a different project opened concurrently", async () => {
  const bg = background({ preferences: { token: "private-token" }, selection: { id: "selected", projectId, image } });
  const otherId = "b".repeat(64);
  const [hidden, opened] = await Promise.all([
    bg.send({ type: "alchemy:set-project-hidden", ids: [projectId], hidden: true }),
    bg.send({ type: "alchemy:open-project", id: otherId }),
  ]);
  assert.equal(hidden.value.hidden, true);
  assert.equal(opened.value.projectId, otherId);
  assert.equal(bg.local.selection.projectId, otherId);
  assert.equal((await bg.send({ type: "alchemy:state" })).value.selection.projectId, otherId);
});

test("closing the hidden-project toggle preserves a concurrently opened visible project", async () => {
  const bg = background({ preferences: { token: "private-token" }, selection: { id: "selected", projectId, image } });
  bg.hidden = true;
  await bg.send({ type: "alchemy:show-hidden-projects", show: true });
  const otherId = "b".repeat(64);
  await Promise.all([
    bg.send({ type: "alchemy:show-hidden-projects", show: false }),
    bg.send({ type: "alchemy:open-project", id: otherId }),
  ]);
  assert.equal(bg.local.selection.projectId, otherId);
  assert.equal((await bg.send({ type: "alchemy:state" })).value.selection.projectId, otherId);
});

test("restored selections follow server-side visibility changes and remain concealed while offline", async () => {
  const bg = background({ preferences: { token: "private-token" }, selection: { id: "selected", projectId, image } });
  assert.equal((await bg.send({ type: "alchemy:state" })).value.selection.image, image);
  bg.hidden = true;
  assert.equal((await bg.send({ type: "alchemy:state" })).value.selection, undefined);
  await bg.send({ type: "alchemy:show-hidden-projects", show: true });
  assert.equal((await bg.send({ type: "alchemy:state" })).value.selection.image, image);
  await bg.send({ type: "alchemy:show-hidden-projects", show: false });
  bg.offline = true;
  assert.equal((await bg.send({ type: "alchemy:state" })).value.selection, undefined);
  bg.offline = false;
  bg.hidden = false;
  assert.equal((await bg.send({ type: "alchemy:state" })).value.selection.image, image);
});

test("opening or uploading the same hidden reference cannot bypass the eye toggle", async () => {
  const bg = background({ preferences: { token: "private-token" }, selection: { id: "old", image } });
  bg.hidden = true;
  for (const message of [
    { type: "alchemy:open-project", id: projectId },
    { type: "alchemy:upload-reference", image },
  ]) {
    assert.match((await bg.send(message)).error, /已隐藏/);
    assert.equal(bg.local.selection.id, "old");
  }
  assert.match((await bg.send({ type: "alchemy:ensure-project", id: "old" })).error, /已隐藏/);
  assert.equal(bg.local.selection, undefined, "pairing a previously captured hidden image must conceal that selection");
  await bg.send({ type: "alchemy:show-hidden-projects", show: true });
  assert.equal((await bg.send({ type: "alchemy:open-project", id: projectId })).value.image, image);
});

test("legacy selections without project ids are checked through their migrated job", async () => {
  const bg = background({ preferences: { token: "private-token" }, selection: { id: "legacy", jobId: "00000000-0000-0000-0000-000000000001", image } });
  bg.hidden = true;
  assert.equal((await bg.send({ type: "alchemy:state" })).value.selection, undefined);
  assert.equal(bg.calls[0].path, "/jobs/00000000-0000-0000-0000-000000000001");
});

test("web selection conceals a duplicate hidden image and collecting it preserves the current project", async () => {
  const bg = background({ preferences: { token: "private-token" }, selection: { id: "old", projectId: "b".repeat(64), image } });
  bg.hidden = true;
  const target = { src: "https://example.com/image.png" };
  assert.equal((await bg.send({ type: "alchemy:collect", target }, contentSender)).value.created, false);
  assert.equal(bg.local.selection.id, "old");
  assert.equal(bg.tabMessages.length, 0);
  await bg.send({ type: "alchemy:select", target }, contentSender);
  assert.match(bg.local.selection.error, /已隐藏/);
  assert.equal(bg.local.selection.image, undefined);
  assert.equal(bg.local.selection.projectId, undefined);
  assert.equal(bg.session.showHiddenProjects, undefined);
  assert.ok(!bg.calls.some(call => call.path === "/projects/visibility"));
});

test('public motion messages preserve trusted storage and notify extension pages and reachable content scripts', async () => {
  const bg = background({ preferences: { token: 'private-token' }, motionPreference: 'full' });
  const read = await bg.send({ type: 'alchemy:get-motion-preference' }, contentSender);
  assert.equal(read.value, 'full');
  assert.deepEqual(bg.storageReads, ['motionPreference']);
  assert.deepEqual(bg.accessLevels, ['TRUSTED_CONTEXTS']);
  const saved = await bg.send({ type: 'alchemy:set-motion-preference', preference: 'reduce', token: 'injected' }, contentSender);
  assert.equal(saved.ok, true);
  assert.equal(bg.local.motionPreference, 'reduce');
  assert.equal(bg.local.preferences.token, 'private-token');
  assert.equal(bg.tabMessages.length, 1);
  assert.equal(bg.runtimeMessages.length, 1);
  for (const message of [...bg.tabMessages, ...bg.runtimeMessages])
    assert.equal(JSON.stringify(message), '{"type":"alchemy:motion-changed"}');
  assert.equal(bg.calls.length, 0);
});

test('motion messages reject untrusted senders and invalid values without changing storage', async () => {
  const bg = background();
  const message = { type: 'alchemy:set-motion-preference', preference: 'full' };
  for (const from of [{ ...sender, id: 'foreign' }, { ...contentSender, frameId: 1 }, { id: 'test', url: 'https://example.com/' }])
    assert.equal(await bg.send(message, from), undefined);
  for (const preference of [undefined, true, 'invalid', { token: 'secret' }])
    assert.match((await bg.send({ ...message, preference })).error, /无效/);
  assert.equal(bg.local.motionPreference, undefined);
  assert.equal((await bg.send({ type: 'alchemy:get-motion-preference' })).value, 'system');
  assert.equal(bg.runtimeMessages.length, 0);
  assert.equal(bg.tabMessages.length, 0);
});

// Run the real hook query through the background validator: the unselected project is not an ID.
test("gallery hook default filters reach the bridge without an empty project ID", async () => {
  const bg = background(), timers = [], effects = [], exports = {};
  const hook = ts.transpileModule(await readFile(new URL("../entrypoints/workspace/useGallery.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(hook, { exports, setTimeout: fn => { timers.push(fn); return 1; }, clearTimeout() {}, require: name => name === "react" ? {
    useState: value => [value, () => {}], useRef: value => ({ current: value }), useEffect: fn => effects.push(fn),
  } : { request: async message => { const reply = await bg.send(message); if (reply.error) throw new Error(reply.error); return reply.value; } } });
  exports.default({ search: "", projectId: "", ratio: "all", sort: "newest" }, true, "r1", false);
  effects.forEach(fn => fn());
  await Promise.all(timers.map(fn => fn()));
  assert.equal(bg.calls.length, 1);
  const url = new URL(bg.calls[0].path, "http://local");
  assert.equal(url.pathname, "/gallery");
  assert.equal(url.searchParams.has("projectId"), false);
  assert.equal(url.searchParams.get("limit"), "96");
});


test("project path and version choices persist independently and expose no private storage", async () => {
  const bg = background(), other = "b".repeat(64);
  const older = "11111111-1111-4111-8111-111111111111", newer = "22222222-2222-4222-8222-222222222222";
  const save = (id, mode, versions) => bg.send({ type: "alchemy:save-project-view", projectId: id, view: { mode, versions } });
  await Promise.all([save(projectId, "recreate", { recreate: older, style: newer }), save(other, "reenact", { reenact: newer })]);
  await save(other, "style", { reenact: newer, style: "new" });
  const views = (await background(bg.local).send({ type: "alchemy:project-views" })).value;
  assert.equal(views[projectId].mode, "recreate");
  assert.equal(views[projectId].versions.recreate, older);
  assert.equal(views[projectId].versions.style, newer);
  assert.equal(views[other].mode, "style");
  assert.equal(views[other].versions.reenact, newer);
  assert.equal(views[other].versions.style, "new");
  assert.deepEqual(Object.keys(views).sort(), [projectId, other]);
  assert.equal(bg.local.preferences.token, "private-token");
  assert.equal(bg.local.preferences.mode, undefined, "project choices must not mutate global mode");
  for (const view of [{ mode: "invalid", versions: {} }, { mode: "style", versions: { style: "../bad" } }, { mode: "style", versions: { unknown: "new" } }, { mode: "style", versions: [] }])
    assert.match((await bg.send({ type: "alchemy:save-project-view", projectId, view })).error, /无效/);
  assert.equal(await bg.send({ type: "alchemy:project-views" }, { ...sender, id: "foreign" }), undefined);
});

test('user starts a batch from the workspace without changing the current selection', async () => {
  // Given a saved selection, When the workspace checks and submits a batch, Then only batch endpoints are called.
  const selection = { id: 'current-input', projectId: 'b'.repeat(64) };
  const bg = background({ preferences: { token: 'private-token' }, selection });
  const projects = [{ projectId, inputRevision: 3 }];
  assert.equal((await bg.send({ type: 'alchemy:batch-preview', projects })).ok, true);
  const body = { requestId: '11111111-1111-4111-8111-111111111111', projects, language: 'en', aspectRatio: { width: 3, height: 4 } };
  assert.equal((await bg.send({ type: 'alchemy:batch-start', ...body })).ok, true);
  assert.deepEqual(bg.calls.map(call => call.path), ['/batches/preview', '/batches']);
  assert.deepEqual(bg.calls[1].body, body);
  assert.deepEqual(bg.local.selection, selection);
  assert.equal(bg.calls[1].token, 'private-token');
});

test('user batch operations reject web content and malformed requests before bridge access', async () => {
  // Given a content-script sender or malformed input, When requesting batch work, Then no bridge request is sent.
  const bg = background();
  const valid = { requestId: '11111111-1111-4111-8111-111111111111', projects: [{ projectId, inputRevision: 0 }], language: 'zh' };
  for (const type of ['alchemy:batch-preview', 'alchemy:batch-start', 'alchemy:batches', 'alchemy:batch-cancel'])
    assert.equal(await bg.send({ type, ...valid }, contentSender), undefined);
  for (const fields of [{ projects: [] }, { projects: [{ projectId: '../x', inputRevision: 0 }] }, { projects: [{ projectId, inputRevision: -1 }] }, { projects: Array(25).fill(valid.projects[0]) }, { requestId: '../x' }, { language: 'xx' }, { aspectRatio: { width: 0, height: 1 } }])
    assert.match((await bg.send({ type: 'alchemy:batch-start', ...valid, ...fields })).error, /无效|有效/);
  assert.match((await bg.send({ type: 'alchemy:batch-cancel', id: '../x' })).error, /无效/);
  assert.equal(bg.calls.length, 0);
});

test('user batch list follows hidden-project scope and cancellation targets the explicit batch item', async () => {
  // Given hidden projects enabled, When listing and cancelling, Then the trusted scope and explicit target reach the bridge.
  const bg = background();
  await bg.send({ type: 'alchemy:show-hidden-projects', show: true });
  await bg.send({ type: 'alchemy:batches' });
  assert.equal(bg.calls.at(-1).path, '/batches?includeHidden=true');
  const id = '11111111-1111-4111-8111-111111111111';
  await bg.send({ type: 'alchemy:batch-cancel', id, projectId });
  assert.equal(bg.calls.at(-1).path, `/batches/${id}/cancel`);
  assert.deepEqual(bg.calls.at(-1).body, { projectId });
});
