import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const build = new URL("../.output/chrome-mv3/", import.meta.url);

test("shared component styles ship inside the shadow-root bundle instead of the host page", async () => {
  const content = await readFile(new URL("content-scripts/content.js", build), "utf8");
  const manifest = JSON.parse(await readFile(new URL("manifest.json", build), "utf8"));
  const pageStyles = (await Promise.all((manifest.content_scripts || []).flatMap(rule => rule.css || []).map(path => readFile(new URL(path, build), "utf8")))).join("\n");
  for (const selector of [".multi-subject-form", ".subject-filmstrip", ".image-viewer-stage", ".generation-ratio", ".image-file-actions", ".task-center"]) {
    assert.ok(content.includes(selector), `${selector} must be in the inline panel stylesheet`);
    assert.ok(!pageStyles.includes(selector), `${selector} must not leak onto visited pages`);
  }
});

test("WebGL generation engine is split out of injected content and initial UI bundles", async () => {
  const content = await readFile(new URL("content-scripts/content.js", build), "utf8");
  assert.ok(!content.includes("THREE.WebGLRenderer"), "every visited page must not load Three.js");
  const files = await readdir(new URL("chunks/", build));
  const chunks = await Promise.all(files.filter(name => name.endsWith('.js')).map(async name => ({ name, text: await readFile(new URL(`chunks/${name}`, build), 'utf8') })));
  const engines = chunks.filter(chunk => chunk.text.includes('THREE.WebGLRenderer'));
  assert.equal(engines.length, 1);
  const entry = chunks.find(chunk => chunk.name.startsWith('workspace-'));
  const dynamicImports = [...entry.text.matchAll(/import\((["'`])([^"'`]+)\1\)/g)].map(match => match[2]);
  assert.ok(dynamicImports.includes(`./${engines[0].name}`), 'only the workspace lazily loads the engine');
  for (const page of ['popup.html', 'workspace.html']) {
    assert.ok(!(await readFile(new URL(page, build), 'utf8')).includes(engines[0].name), 'engine must not be eagerly preloaded');
  }
});

test("model messages stay authenticated in background and only reach allowed endpoints", async () => {
  const calls = [];
  const { handlers } = await background(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ selected: null, models: [] }) };
  });
  const sender = { id: "test", frameId: 0, url: "https://pinterest.com/", tab: { id: 4 } };
  const send = message => new Promise(resolve => handlers.message(message, sender, resolve));
  assert.equal((await send({ type: "alchemy:query", path: "/models" })).ok, true);
  assert.equal((await send({ type: "alchemy:models-refresh" })).ok, true);
  assert.equal((await send({ type: "alchemy:model-verify", model: "vision-model" })).ok, true);
  assert.ok(calls.every(c => c.options.headers.Authorization === "Bearer test"));
  assert.ok(calls[0].url.endsWith("/models"));
  assert.ok(calls[1].url.endsWith("/models/refresh"));
  assert.deepEqual(JSON.parse(calls[2].options.body), { model: "vision-model" });
  assert.ok((await send({ type: "alchemy:model-verify", model: 42 })).error);
  assert.ok((await send({ type: "alchemy:query", path: "/models/../../token" })).error);
  assert.equal(calls.length, 3);
});

test("local Codex session listing is extension-only and cannot use generic query endpoints", async () => {
  const calls = [];
  const { handlers } = await background(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ data: [], nextCursor: null }) };
  });
  const workspace = { id: "test", url: "chrome-extension://test/workspace.html" };
  const content = { id: "test", frameId: 0, url: "https://pinterest.com/", tab: { id: 4 } };
  const send = (message, sender = workspace) => new Promise(resolve => handlers.message(message, sender, resolve));
  const message = { type: "alchemy:sessions-list", searchTerm: "小说", archived: true, cursor: "next-page", scope: "content", token: "forged", path: "/private", transcript: "forged body" };
  for (const sender of [content, { ...content, frameId: 1 }, { ...workspace, id: "other" }, { ...workspace, url: "chrome-extension://test.evil/workspace.html" }, { id: "test" }])
    assert.equal(handlers.message(message, sender, () => assert.fail("untrusted session listing reply")), undefined);
  assert.equal(calls.length, 0);
  for (const sender of [workspace, { ...workspace, url: "chrome-extension://test/popup.html" }])
    assert.equal((await send(message, sender)).ok, true);
  assert.ok(calls.every(call => call.url.endsWith("/sessions/list") && call.options.headers.Authorization === "Bearer test"));
  assert.deepEqual(JSON.parse(calls[0].options.body), { searchTerm: "小说", archived: true, cursor: "next-page", scope: "content" });
  for (const sender of [workspace, content]) for (const path of ["/sessions", "/sessions/list", "/sessions/known-session", "/jobs/../sessions/list"])
    assert.match((await send({ type: "alchemy:query", path }, sender)).error, /无效/);
  assert.equal(calls.length, 2, "generic query cannot bypass the dedicated session source check");
});

test("local index operations are extension-only and strip client paths and content", async () => {
  const calls = [];
  const { handlers } = await background(async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ state: "building" }) }; });
  const workspace = { id: "test", url: "chrome-extension://test/workspace.html" };
  const content = { id: "test", frameId: 0, url: "https://pinterest.com/", tab: { id: 4 } };
  const message = { type: "alchemy:sessions-index", action: "refresh", path: "/private", text: "forged" };
  assert.equal(handlers.message(message, content, () => assert.fail("untrusted index reply")), undefined);
  const result = await new Promise(resolve => handlers.message(message, workspace, resolve));
  assert.equal(result.ok, true); assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/sessions/index")); assert.deepEqual(JSON.parse(calls[0].options.body), { action: "refresh" });
  const rejected = await new Promise(resolve => handlers.message({ type: "alchemy:query", path: "/sessions/index" }, content, resolve));
  assert.match(rejected.error, /无效/); assert.equal(calls.length, 1);
});

test("session input and reverse messages forward chosen IDs with persisted reference and revision only", async () => {
  const projectId = "a".repeat(64), calls = [];
  const sessionIds = ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"];
  const reference = { id: "input-8", projectId, image: "saved-reference", inputRevision: 8, inputVersions: { session: "new" }, inputs: { session: { instruction: "为定稿配图", sessions: sessionIds.map(id => ({ id, title: "示例", updatedAt: 1 })) } } };
  const { handlers, chrome } = await background(async (url, options) => {
    calls.push({ url, options });
    const value = url.endsWith("/jobs") ? { id: "new-job", projectId, mode: "session", instruction: "为定稿配图", stage: "started" } : reference;
    return { ok: true, json: async () => value };
  });
  const storage = { preferences: { token: "secret", mode: "recreate" }, selection: { id: "input-7", projectId, inputRevision: 7 } };
  chrome.storage.local.get = async () => storage;
  chrome.storage.local.set = async value => Object.assign(storage, value);
  const sender = { id: "test", url: "chrome-extension://test/workspace.html" };
  const send = message => new Promise(resolve => handlers.message(message, sender, resolve));
  const forged = { transcript: "untrusted transcript", sessionContext: { messages: ["forged"] }, path: "/private", token: "forged" };
  const saved = await send({ type: "alchemy:update-project-input", projectId, expectedRevision: 7, mode: "session", sessionIds, instruction: "为定稿配图", ...forged });
  assert.equal(saved.ok, true);
  assert.deepEqual(JSON.parse(calls[0].options.body), { expectedRevision: 7, mode: "session", sessionIds, instruction: "为定稿配图" });
  assert.equal(storage.selection.inputRevision, 8);
  assert.equal(storage.selection.inputs, undefined, "local storage must not duplicate server inputs");
  const started = await send({ type: "alchemy:start", projectId, id: "input-8", inputRevision: 8, mode: "session", sessionIds, instruction: "为定稿配图", image: "forged-image", ...forged });
  assert.equal(started.ok, true);
  const submitted = calls.findLast(call => call.url.endsWith("/jobs"));
  assert.deepEqual(JSON.parse(submitted.options.body), { image: "saved-reference", mode: "session", sessionIds, instruction: "为定稿配图", projectId, inputRevision: 8 });
  assert.equal(submitted.options.headers.Authorization, "Bearer secret");
  assert.equal(started.value.job.mode, "session");
  const count = calls.filter(call => call.url.endsWith("/jobs")).length;
  assert.match((await send({ type: "alchemy:start", projectId, mode: "session", sessionIds, inputRevision: 7 })).error, /已在其他窗口更新/);
  assert.equal(calls.filter(call => call.url.endsWith("/jobs")).length, count);
});

test("session lane and its version survive project-view saving and explicit workspace handoff", async () => {
  const { handlers, chrome, tabs, sessionStorage } = await background(() => assert.fail("workspace handoff must not read sessions or start inference"));
  const projectId = "a".repeat(64), jobId = "00000000-0000-0000-0000-000000000001";
  const storage = { preferences: { token: "secret", mode: "style" }, selection: { id: "input-3", projectId, inputRevision: 3 } };
  chrome.storage.local.get = async () => storage;
  chrome.storage.local.set = async value => Object.assign(storage, value);
  const workspace = { id: "test", url: "chrome-extension://test/workspace.html" };
  const content = { id: "test", frameId: 0, url: "https://pinterest.com/", tab: { id: 4 } };
  const send = (message, sender = workspace) => new Promise(resolve => handlers.message(message, sender, resolve));
  assert.equal((await send({ type: "alchemy:save-project-view", projectId, view: { mode: "session", versions: { session: jobId }, inputRevision: 3 } })).ok, true);
  assert.equal(storage[`projectView:${projectId}`].mode, "session");
  assert.equal((await send({ type: "alchemy:mode", mode: "session" })).ok, true);
  assert.equal(storage.preferences.mode, "session");
  const context = { mode: "session", selection: storage.selection };
  const draft = { versions: { [`${projectId}:session`]: jobId }, instructions: { [`${projectId}:session:${jobId}`]: "创作要求" } };
  for (const explicit of [false, true]) {
    assert.equal((await send({ type: "alchemy:open-workspace", ...(explicit ? { context, draft } : {}) }, content)).ok, true);
    const id = new URL(tabs.at(-1).url).searchParams.get("handoff");
    assert.equal(sessionStorage[`workspace:${id}`].mode, "session");
    const restored = (await send({ type: "alchemy:workspace-handoff", id })).value;
    assert.equal(restored.mode, "session");
    assert.equal(restored.selection.projectId, projectId);
    assert.equal(restored.selection.inputRevision, 3);
    if (explicit) assert.deepEqual(restored.draft, draft);
    assert.equal(sessionStorage[`workspace:${id}`], undefined);
  }
  assert.equal(JSON.stringify(sessionStorage).includes("secret"), false);
});

test("deleting projects validates ids and clears only the deleted active selection after success", async () => {
  const id = "a".repeat(64), other = "b".repeat(64);
  let fail = false;
  const calls = [];
  const { handlers, chrome } = await background(async (url, options) => {
    calls.push({ url, options });
    return { ok: !fail, json: async () => fail ? { error: "任务正在执行" } : { deletedIds: JSON.parse(options.body).ids } };
  });
  const storage = { preferences: { token: "secret" }, selection: { id, projectId: id, image: "saved image", jobId: "saved job" } };
  chrome.storage.local.get = async () => storage;
  chrome.storage.local.remove = async (key) => { delete storage[key]; };
  const sender = { id: "test", frameId: 0, url: "https://pinterest.com/", tab: { id: 4 } };
  const send = (ids) => new Promise((resolve) => handlers.message({ type: "alchemy:delete-projects", ids }, sender, resolve));
  for (const ids of [[], [id, "../token"], null, [7], Array(1001).fill(id)]) assert.ok((await send(ids)).error);
  assert.equal(calls.length, 0);
  assert.equal((await send([other])).ok, true);
  assert.equal(storage.selection.projectId, id);
  fail = true;
  assert.match((await send([id])).error, /任务正在执行/);
  assert.equal(storage.selection.image, "saved image");
  fail = false;
  assert.equal((await send([id])).ok, true);
  assert.equal(storage.selection, undefined);
  assert.ok(calls.every((call) => call.url.endsWith("/projects/delete") && call.options.headers.Authorization === "Bearer secret"));
  assert.equal(handlers.message({ type: "alchemy:delete-projects", ids: [id] }, { ...sender, id: "other" }, () => assert.fail("untrusted reply")), undefined);
});

test("generation messages keep credentials in background and constrain job endpoints", async () => {
  const calls = [];
  const { handlers } = await background(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ status: "running" }) };
  });
  const sender = { id: "test", frameId: 0, url: "https://www.pinterest.com/", tab: { id: 4 } };
  const send = (message) => new Promise((resolve) => handlers.message(message, sender, resolve));
  const id = "00000000-0000-0000-0000-000000000001";
  const generationId = "00000000-0000-0000-0000-000000000002";
  assert.equal((await send({ type: "alchemy:generate", id, language: "en" })).ok, true);
  assert.deepEqual(JSON.parse(calls[0].options.body), { language: "en" });
  assert.equal(calls[0].options.headers.Authorization, "Bearer test");
  assert.ok(calls[0].url.endsWith(`/jobs/${id}/generations`));
  const subjectImage = "data:image/png;base64,iVBORw==";
  assert.equal((await send({ type: "alchemy:generate", id, language: "zh", subjectImage })).ok, true);
  assert.deepEqual(JSON.parse(calls[1].options.body), { language: "zh", subjectImage });
  assert.equal((await send({ type: "alchemy:generation-image", id, generationId })).ok, true);
  assert.ok(calls[2].url.endsWith(`/${generationId}/image`));
  assert.equal((await send({ type: "alchemy:generation-cancel", id, generationId })).ok, true);
  assert.ok(calls[3].url.endsWith(`/${generationId}/cancel`));
  for (const message of [
    { type: "alchemy:generate", id: "../token", language: "en" },
    { type: "alchemy:generate", id, language: "bad" },
    ...[null, "", 42, "file:///tmp/subject.png", "data:image/svg+xml;base64,PHN2Zz4=", `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`]
      .map((subjectImage) => ({ type: "alchemy:generate", id, language: "zh", subjectImage })),
    { type: "alchemy:generation-image", id, generationId: "../../token" },
  ]) assert.ok((await send(message)).error);
  assert.equal(calls.length, 4);
});

test("generation ratio messages only forward bounded numeric width and height", async () => {
  const calls = [];
  const { handlers } = await background(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ status: "running" }) };
  });
  const sender = { id: "test", frameId: 0, url: "https://www.pinterest.com/", tab: { id: 4 } };
  const id = "00000000-0000-0000-0000-000000000001";
  const send = aspectRatio => new Promise(resolve => handlers.message({ type: "alchemy:generate", id, language: "zh", aspectRatio }, sender, resolve));
  for (const ratio of [null, "16:9", [], {}, { width: 16 }, { width: "16", height: 9 }, { width: NaN, height: 9 },
    { width: Infinity, height: 9 }, { width: 0, height: 1 }, { width: 1.5, height: 1 }, { width: 10001, height: 1000 },
    { width: 1, height: 21 }, { width: 21, height: 1 }, { width: 16, height: 9, prompt: "override" }]) assert.ok((await send(ratio)).error);
  assert.equal(calls.length, 0);
  for (const aspectRatio of [{ width: 16, height: 9 }, { width: 10000, height: 1000 }, { width: 1, height: 20 }, { width: 20, height: 1 }]) {
    assert.equal((await send(aspectRatio)).ok, true);
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), { language: "zh", aspectRatio });
    assert.equal(calls.at(-1).options.headers.Authorization, "Bearer test");
  }
});

test("built extension uses a popup without declaring unsupported native side panels", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", build), "utf8"),
  );
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.side_panel, undefined);
  assert.ok(!manifest.permissions.includes("sidePanel"));
  assert.ok(!manifest.web_accessible_resources?.some((rule) => rule.resources.includes("popup.html")));
  assert.ok(!manifest.web_accessible_resources?.some((rule) => rule.resources.includes("workspace.html")));
  assert.ok(
    (await readFile(new URL("popup.html", build), "utf8")).includes("root"),
  );
  assert.ok((await readFile(new URL("workspace.html", build), "utf8")).includes("root"));
});

test("project messages restore a template and start only the explicitly chosen lane", async () => {
  const id = "a".repeat(64);
  const calls = [];
  const reference = { id, projectId: id, image: "saved-template", sourceUrl: "https://example.com/template", capture: "original" };
  const { handlers, chrome } = await background(async (url, options) => {
    calls.push({ url, options });
    const value = url.endsWith("/reference") ? reference : url.endsWith("/jobs") ? { id: "new-job", projectId: id, mode: "recreate", stage: "started" } : { id, jobs: [] };
    return { ok: true, json: async () => value };
  });
  const storage = { preferences: { token: "secret", mode: "style" }, selection: { id: "old", image: "old-template" } };
  chrome.storage.local.get = async () => storage;
  chrome.storage.local.set = async (value) => Object.assign(storage, value);
  const sender = { id: "test", frameId: 0, url: "https://www.pinterest.com/", tab: { id: 4 } };
  const send = (message) => new Promise(resolve => handlers.message(message, sender, resolve));
  assert.equal((await send({ type: "alchemy:query", path: "/projects" })).ok, true);
  assert.equal((await send({ type: "alchemy:open-project", id })).value.image, "saved-template");
  assert.equal(storage.selection.projectId, id);
  assert.equal(storage.selection.jobId, undefined);
  assert.ok(calls.every(call => !call.options.body), "opening a project does not start a model task");
  await send({ type: "alchemy:mode", mode: "reenact" });
  assert.equal(storage.selection.reenact, undefined, "mode selection must not copy another lane's subject");
  await send({ type: "alchemy:start", projectId: id, mode: "recreate", image: "untrusted-image" });
  const body = JSON.parse(calls.findLast(call => call.url.endsWith("/jobs")).options.body);
  assert.equal(body.image, "saved-template");
  assert.equal(body.projectId, id);
  assert.equal(body.mode, "recreate");
  assert.equal(storage.selection.jobId, undefined, "stored current input must not become a historical job snapshot");
  storage.selection = { id: "other-selection", projectId: "b".repeat(64), image: "other-template" };
  const independent = await send({ type: "alchemy:start", projectId: id, mode: "recreate" });
  assert.equal(independent.value.job.projectId, id);
  assert.equal(storage.selection.id, "other-selection", "submitting another project's job must not replace the selected project");
  const before = calls.length;
  for (const message of [
    { type: "alchemy:open-project", id: "../../token" },
    { type: "alchemy:project-reference", id: "a" },
    { type: "alchemy:query", path: `/projects/${id}/reference` },
    { type: "alchemy:query", path: "/projects/../token" },
    { type: "alchemy:start", projectId: "../../token", mode: "recreate" },
  ]) assert.match((await send(message)).error, /无效/);
  assert.equal(calls.length, before);
});

async function background(fetch = async () => ({ ok: true, json: async () => ({ status: "running" }) }), globals = {}) {
  const handlers = {};
  const messages = [];
  const tabs = [];
  const sessionStorage = {};
  const reminderStorage = {};
  const chrome = {
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    alarms: { create: async () => {}, onAlarm: { addListener() {} } },
    runtime: {
      id: "test",
      getContexts: async () => [],
      getURL: (path) => `chrome-extension://test${path}`,
      onConnect: { addListener: fn => { handlers.connect = fn; } },
      onInstalled: {
        addListener: (fn) => {
          handlers.installed = fn;
        },
      },
      onMessage: {
        addListener: (fn) => {
          handlers.message = fn;
        },
      },
    },
    storage: {
      onChanged: { addListener() {} },
      session: {
        set: async (value) => Object.assign(sessionStorage, structuredClone(value)),
        get: async (key) => key === null ? structuredClone(sessionStorage) : ({ [key]: structuredClone(sessionStorage[key]) }),
        remove: async (key) => { delete sessionStorage[key]; },
      },
      local: {
        setAccessLevel: async () => {},
        remove: async key => { delete reminderStorage[key]; },
        get: async () => ({
          ...reminderStorage,
          preferences: { token: "test" },
          selection: { id: "old", jobId: "active" },
        }),
        set: async (value) => {
          Object.assign(reminderStorage, value);
          if ("selection" in value) handlers.selection = value.selection;
        },
      },
    },
    contextMenus: {
      removeAll: async () => {},
      create: () => {},
      onClicked: {
        addListener: (fn) => {
          handlers.menu = fn;
        },
      },
    },
    tabs: {
      query: async () => [],
      sendMessage: async (_tabId, message) => {
        messages.push(message);
      },
      create: async (tab) => {
        tabs.push(tab);
      },
    },
  };
  runInNewContext(await readFile(new URL("background.js", build), "utf8"), {
    chrome,
    console,
    crypto,
    AbortSignal, AbortController,
    TextEncoder,
    URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: (url, options) => String(url).includes("/task-feed") ? Promise.resolve({ ok: true, json: async () => ({ revision: "test", tasks: [] }) }) : fetch(url, options),
    ...globals,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof handlers.message, "function");
  return { handlers, messages, tabs, chrome, sessionStorage };
}

test("background starts and opens results when sidePanel API is absent", async () => {
  const { handlers, messages, tabs, chrome } = await background();
  const send = () =>
    new Promise((resolve) =>
      handlers.message(
        {
          type: "alchemy:select",
          target: { src: "https://example.com/image.png" },
        },
        {
          id: "test",
          frameId: 0,
          tab: { id: 1, windowId: 1, url: "https://example.com/" },
        },
        resolve,
      ),
    );
  assert.equal((await send()).ok, true);
  assert.equal(messages[0].type, "alchemy:hide");
  assert.equal(messages.at(-1).type, "alchemy:show");
  assert.equal(handlers.selection.jobId, undefined);
  assert.match(handlers.selection.error, /原图无法读取/);
  chrome.tabs.sendMessage = async () => {
    throw new Error("No content script");
  };
  assert.equal((await send()).ok, true);
  assert.ok(tabs[0].url.startsWith("chrome-extension://test/workspace.html?handoff="));
});

for (const alreadyOpen of [true, false]) test(`unavailable webpage panel hands each selection to one workspace (existing=${alreadyOpen})`, async () => {
  let projectId = 'a'.repeat(64);
  const { handlers, chrome, tabs, sessionStorage } = await background(async url => {
    if (url.endsWith('/projects')) return { ok: true, json: async () => ({ id: projectId }) };
    if (url.endsWith('/reference')) return { ok: true, json: async () => ({ id: projectId, projectId, image: 'data:image/png;base64,iVBORw==', inputRevision: 2 }) };
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
  }, {
    Blob, Uint8Array, btoa,
    createImageBitmap: async () => ({ width: 320, height: 400, close() {} }),
    OffscreenCanvas: class {
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { return new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }); }
    },
  });
  const live = alreadyOpen ? [{ id: 20, windowId: 3, url: 'chrome-extension://test/workspace.html' }] : [];
  const updates = [], stored = { preferences: { token: 'test' }, [`projectView:${projectId}`]: { mode: 'recreate' } };
  chrome.storage.local.get = async () => stored;
  chrome.storage.local.set = async value => Object.assign(stored, value);
  chrome.tabs.sendMessage = async () => { throw new Error('No receiving content script'); };
  chrome.tabs.query = async () => live;
  chrome.tabs.create = async tab => { tabs.push(tab); live.push({ ...tab, id: 20, windowId: 3 }); };
  chrome.tabs.update = async (id, update) => { assert.equal(id, 20); updates.push(update); Object.assign(live[0], update); };
  chrome.windows = { update: async () => {} };
  const sender = { id: 'test', frameId: 0, tab: { id: 4, windowId: 1, url: 'https://example.com' } };
  for (const next of ['a', 'b', 'a']) {
    projectId = next.repeat(64);
    const reply = await new Promise(resolve => handlers.message({ type: 'alchemy:select', target: { src: 'https://example.com/image.png' } }, sender, resolve));
    assert.equal(reply.ok, true);
    const url = new URL(live[0].url), params = url.hash ? new URLSearchParams(url.hash.slice('#workspace='.length)) : url.searchParams;
    const handoff = sessionStorage['workspace:' + params.get('handoff')];
    assert.equal(handoff.selection.projectId, projectId);
    assert.equal(handoff.selection.id, stored.selection.id);
    assert.equal(handoff.selection.inputRevision, 2);
    assert.equal(handoff.mode, next === 'a' ? 'recreate' : 'style');
  }
  assert.equal(tabs.length, alreadyOpen ? 0 : 1);
  assert.equal(updates.length, alreadyOpen ? 3 : 2);
  chrome.tabs.update = async () => { throw new Error('workspace unavailable'); };
  const reply = await new Promise(resolve => handlers.message({ type: 'alchemy:select', target: { src: 'https://example.com/image.png' } }, sender, resolve));
  assert.match(reply.error, /workspace unavailable/);
  assert.equal(tabs.length, alreadyOpen ? 0 : 1);
});

test("reruns the current or historical image with the explicitly selected mode", async () => {
  const submitted = [];
  const oldJob = "00000000-0000-0000-0000-000000000001";
  const projectId = "a".repeat(64);
  const historical = { id: oldJob, projectId, jobId: oldJob, image: "historical-image", capture: "original", sourceUrl: "https://example.com/old" };
  const { handlers, chrome } = await background(async (url, options) => {
    if (url.endsWith(`/jobs/${oldJob}/reference`)) return { ok: true, json: async () => historical };
    if (url.endsWith(`/projects/${projectId}/reference`)) return { ok: true, json: async () => ({ id: `input-${submitted.length}`, projectId, image: "durable-current-image", inputRevision: submitted.length, inputs: { style: { subjectImage: "large-subject" } } }) };
    assert.ok(url.endsWith("/jobs"));
    submitted.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ id: `new-${submitted.length}`, projectId, mode: submitted.at(-1).mode, instruction: submitted.at(-1).instruction, status: "running", stage: "started" }) };
  });
  const storage = { preferences: { token: "secret", mode: "style" }, selection: { id: "current", image: "current-image", sourceUrl: "https://example.com/current", capture: "original" } };
  chrome.storage.local.get = async () => storage;
  chrome.storage.local.set = async (value) => Object.assign(storage, value);
  const sender = { id: "test", frameId: 0, url: "https://www.pinterest.com/", tab: { id: 4, windowId: 1 } };
  const send = (message) => new Promise(resolve => handlers.message(message, sender, resolve));
  const current = await send({ type: "alchemy:start", id: "current", mode: "recreate", instruction: "保留构图，移除文字" });
  assert.equal(current.value.job.mode, "recreate");
  assert.equal(submitted[0].image, "current-image");
  assert.equal(submitted[0].mode, "recreate");
  assert.equal(submitted[0].instruction, "保留构图，移除文字");
  assert.equal(current.value.selection.instruction, "保留构图，移除文字");
  assert.equal(storage.selection.id, "input-1");
  assert.equal(storage.selection.inputs, undefined);
  assert.equal(storage.selection.jobId, undefined);
  const restored = await send({ type: "alchemy:reference", id: oldJob });
  assert.equal(restored.value.image, "historical-image");
  assert.equal(storage.selection.id, "input-1", "opening history must not replace the current image");
  const rerun = await send({ type: "alchemy:start", id: oldJob, referenceJobId: oldJob, mode: "recreate" });
  assert.equal(rerun.value.job.id, "new-2");
  assert.equal(submitted[1].image, "historical-image");
  assert.equal(submitted[1].mode, "recreate");
  assert.equal(submitted[1].sourceUrl, historical.sourceUrl);
  assert.notEqual(storage.selection.id, "current");
  assert.match((await send({ type: "alchemy:reference", id: "../../token" })).error, /无效/);
  assert.match((await send({ type: "alchemy:start", id: "current", mode: "style" })).error, /已变化/);
  const reenact = { subjectImage: "subject-image", basePrompt: "edited prompt", promptSourceJobId: oldJob };
  const replay = await send({ type: "alchemy:start", referenceJobId: oldJob, mode: "reenact", reenact });
  assert.equal(replay.value.job.mode, "reenact");
  assert.deepEqual(submitted[2].reenact, reenact);
  assert.equal(submitted[2].image, "historical-image");
  assert.equal(replay.value.selection.reenact.subjectImage, "subject-image");
  assert.equal(storage.selection.reenact, undefined);
  const withoutInputs = await send({ type: "alchemy:start", id: storage.selection.id, mode: "reenact" });
  assert.match(withoutInputs.error, /主体图/);
  assert.equal(submitted.length, 3);
  const transfer = { subjectImage: "style-subject", basePrompt: "Keep the subject structure; transfer only rendering." };
  const style = await send({ type: "alchemy:start", referenceJobId: oldJob, mode: "style", reenact: transfer });
  assert.equal(style.value.job.mode, "style");
  assert.deepEqual(submitted[3].reenact, transfer);
  assert.equal(submitted[3].image, "historical-image");
  assert.equal(style.value.selection.reenact.subjectImage, "style-subject");
  assert.match((await send({ type: "alchemy:start", id: storage.selection.id, mode: "style", reenact: { basePrompt: "missing subject" } })).error, /主体图/);
  assert.equal(submitted.length, 4);
  const generic = await send({ type: "alchemy:start", id: storage.selection.id, mode: "style", instruction: "只提取配色" });
  assert.equal(submitted[4].instruction, "只提取配色");
  assert.equal(generic.value.selection.instruction, "只提取配色");
  assert.equal(submitted[4].reenact, undefined, "generic extraction must not receive stale subject inputs");
  assert.equal(storage.selection.reenact, undefined);
  await send({ type: "alchemy:start", id: storage.selection.id, mode: "recreate", reenact: transfer });
  assert.equal(submitted[5].instruction, undefined, "omitting instructions must not reuse the previous path's instruction");
  for (const mode of ["style", "recreate", "reenact", "multi-reenact"]) {
    for (const instruction of [null, 42, {}, "x".repeat(20001)])
      assert.match((await send({ type: "alchemy:start", id: storage.selection.id, mode, instruction })).error, /任务指令/);
  }
  assert.equal(submitted.length, 6, "invalid instructions must not reach the bridge");
  assert.equal(submitted[5].reenact, undefined, "recreation uses only the reference even if subject inputs are supplied");
});

test("page panel can read results without receiving the pairing token", async () => {
  const { handlers, chrome } = await background();
  chrome.storage.local.get = async () => ({
    preferences: { token: "private-token", mode: "style" },
    selection: { id: "image", image: "data:image/png;base64,test", jobId: "active", reenact: { subjectImage: "subject", basePrompt: "prompt" } },
  });
  const sender = { id: "test", frameId: 0, url: "https://www.pinterest.com/", tab: { id: 4, windowId: 1 } };
  const send = (message) => new Promise(resolve => handlers.message(message, sender, resolve));
  const state = (await send({ type: "alchemy:state" })).value;
  assert.equal(state.preferences.paired, true);
  assert.equal(state.preferences.token, undefined);
  assert.equal(state.selection.image, "data:image/png;base64,test");
  const unchanged = (await send({ type: "alchemy:state", selectionId: "image", selectionJobId: "active" })).value;
  assert.equal(unchanged.selection.image, undefined);
  assert.equal(unchanged.selection.reenact, undefined);
  assert.equal(unchanged.selection.jobId, "active");
  const changed = (await send({ type: "alchemy:state", selectionId: "image", selectionJobId: "previous" })).value;
  assert.equal(changed.selection.reenact.subjectImage, "subject", "new jobs must restore the new pair of images");
  assert.equal((await send({ type: "alchemy:query", path: "/jobs/active" })).value.status, "running");
  assert.match((await send({ type: "alchemy:query", path: "https://example.com" })).error, /无效/);
  assert.match((await send({ type: "alchemy:mode", mode: "unknown" })).error, /无效/);
  assert.equal(handlers.message({ type: "alchemy:state" }, { ...sender, id: "another-extension" }, () => assert.fail("untrusted reply")), undefined);
  assert.equal(handlers.message({ type: "alchemy:state" }, { ...sender, frameId: 1 }, () => assert.fail("iframe reply")), undefined);
});

for (const mode of ["style", "reenact", "recreate"]) test(`hover in ${mode} mode selects another template while the previous task is active`, async () => {
  const calls = [];
  const { handlers, chrome } = await background(async (url) => {
    calls.push(url);
    if (url.endsWith("/projects")) return { ok: true, json: async () => ({ id: "a".repeat(64), jobs: [] }) };
    if (url.endsWith("/reference")) return { ok: true, json: async () => ({ id: "a".repeat(64), projectId: "a".repeat(64), image: "data:image/png;base64,iVBORw==", inputRevision: 2, inputs: { style: { subjectImage: "stored-subject" } } }) };
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
  }, {
    Blob, Uint8Array, btoa,
    createImageBitmap: async () => ({ width: 320, height: 400, close() {} }),
    OffscreenCanvas: class {
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { return new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }); }
    },
  });
  const storage = { preferences: { token: "test", mode }, selection: { id: "previous", jobId: "active", projectId: "b".repeat(64) } };
  chrome.storage.local.get = async () => storage;
  chrome.storage.local.set = async (value) => Object.assign(storage, value);
  const sender = { id: "test", frameId: 0, tab: { id: 4, windowId: 1, url: "https://example.com" } };
  const reply = await new Promise(resolve => handlers.message({ type: "alchemy:select", target: { src: "https://example.com/template.png" } }, sender, resolve));
  assert.equal(reply.ok, true);
  assert.equal(storage.selection.error, undefined);
  assert.match(storage.selection.image, /^data:image\/png;base64,/);
  assert.equal(storage.selection.jobId, undefined);
  assert.match(storage.selection.stage, /参考模板/);
  assert.equal(storage.selection.projectId, "a".repeat(64));
  assert.equal(storage.selection.inputRevision, 2);
  assert.equal(storage.selection.inputs, undefined);
  assert.deepEqual(calls, ["https://example.com/template.png", "http://127.0.0.1:43187/projects", `http://127.0.0.1:43187/projects/${"a".repeat(64)}/reference`]);
});


test("prompt edits are validated, authenticated and limited to prompt fields", async () => {
  const calls = [];
  const { handlers } = await background(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ status: "completed" }) };
  });
  const sender = { id: "test", frameId: 0, url: "https://pinterest.com/", tab: { id: 4 } };
  const send = message => new Promise(resolve => handlers.message(message, sender, resolve));
  const id = "00000000-0000-0000-0000-000000000001";
  const edits = { promptZh: "修改后的中文", promptEn: "Edited prompt", negativePrompt: "" };
  assert.equal((await send({ type: "alchemy:save-prompt", id, ...edits, title: "ignored" })).ok, true);
  assert.ok(calls[0].url.endsWith(`/jobs/${id}/prompt`));
  assert.equal(calls[0].options.headers.Authorization, "Bearer test");
  assert.deepEqual(JSON.parse(calls[0].options.body), edits);
  for (const invalid of [{ id: "../token" }, { promptZh: " " }, { promptEn: null }, { negativePrompt: 42 }, { promptEn: "x".repeat(20001) }])
    assert.ok((await send({ type: "alchemy:save-prompt", id, ...edits, ...invalid })).error);
  assert.equal(calls.length, 1);
  assert.equal(handlers.message({ type: "alchemy:save-prompt", id, ...edits }, { ...sender, id: "other" }, () => assert.fail("untrusted reply")), undefined);
});

test("workspace handoff preserves drafts only in session storage and is consumed only by extension pages", async () => {
  const { handlers, chrome, tabs, sessionStorage } = await background(() => assert.fail("opening workspace must not call bridge"));
  const selection = { id: "selected", projectId: "a".repeat(64), image: "saved-reference" };
  chrome.storage.local.get = async () => ({ preferences: { token: "private-token", mode: "style" }, selection, [`projectView:${selection.projectId}`]: { mode: "reenact", versions: {} } });
  chrome.storage.local.set = async () => assert.fail("drafts must not be saved to local storage");
  const content = { id: "test", frameId: 0, url: "https://pinterest.com/", tab: { id: 4 } };
  const workspace = { id: "test", url: "chrome-extension://test/workspace.html" };
  const send = (message, sender = content) => new Promise(resolve => handlers.message(message, sender, resolve));
  const draft = { activeJobId: "saved-job", subject: { subjectImage: "subject-draft", basePrompt: "edited instruction" }, promptDraft: { promptZh: "未保存中文", promptEn: "unsaved prompt", negativePrompt: "blur" } };
  assert.equal((await send({ type: "alchemy:open-workspace", draft, url: "https://untrusted.example/", path: "/other.html" })).ok, true);
  const url = new URL(tabs[0].url);
  assert.equal(url.protocol, "chrome-extension:");
  assert.equal(url.host, "test");
  assert.equal(url.pathname, "/workspace.html");
  const id = url.searchParams.get("handoff");
  assert.match(id, /^[\da-f-]{36}$/);
  assert.equal(url.searchParams.size, 1, "drafts and credentials must not appear in the URL");
  const expected = { source: "quick:tab:4", mode: "reenact", selection: { id: selection.id, projectId: selection.projectId, sourceUrl: "", capture: undefined, inputRevision: undefined }, draft, createdAt: sessionStorage[`workspace:${id}`].createdAt };
  assert.equal(typeof expected.createdAt, "number");
  assert.deepEqual(sessionStorage[`workspace:${id}`], expected);
  assert.ok(!JSON.stringify(sessionStorage).includes("saved-reference"), "handoff must not duplicate the durable reference image");
  assert.ok(!JSON.stringify(sessionStorage).includes("private-token"));
  for (const sender of [content, { ...workspace, id: "other" }, { ...workspace, url: "chrome-extension://test.evil/workspace.html" }])
    assert.equal(handlers.message({ type: "alchemy:workspace-handoff", id }, sender, () => assert.fail("untrusted handoff read")), undefined);
  assert.ok(sessionStorage[`workspace:${id}`], "rejected readers must not consume a draft");
  const restored = await send({ type: "alchemy:workspace-handoff", id }, workspace);
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.value, expected);
  assert.equal(sessionStorage[`workspace:${id}`], undefined);
  assert.equal((await send({ type: "alchemy:workspace-handoff", id }, workspace)).value, undefined, "handoff is one use");
  assert.ok((await send({ type: "alchemy:workspace-handoff", id: "../preferences" }, workspace)).error);
  assert.equal(handlers.message({ type: "alchemy:open-workspace", draft }, { ...content, id: "other" }, () => assert.fail("untrusted workspace open")), undefined);
  assert.equal(tabs.length, 1);
});

test("workspace rejects invalid drafts and removes a handoff if opening the tab fails", async () => {
  const { handlers, chrome, tabs, sessionStorage } = await background();
  const sender = { id: "test", url: "chrome-extension://test/popup.html" };
  const send = message => new Promise(resolve => handlers.message(message, sender, resolve));
  for (const draft of [null, "text", 7, { prompt: "x".repeat(8 * 1024 * 1024) }, { prompt: "图".repeat(3 * 1024 * 1024) }])
    assert.ok((await send({ type: "alchemy:open-workspace", draft })).error);
  assert.equal(tabs.length, 0);
  assert.equal(Object.keys(sessionStorage).length, 0);
  chrome.tabs.create = async () => { throw new Error("Cannot open tab"); };
  assert.match((await send({ type: "alchemy:open-workspace", draft: { subject: "unsaved" } })).error, /Cannot open tab/);
  assert.equal(Object.keys(sessionStorage).filter(key => key.startsWith("workspace:")).length, 0, "failed opens must not leave orphaned handoffs");
  assert.equal(sessionStorage["quick:popup"].draft.subject, "unsaved", "the source draft stays recoverable");
});

test("reference uploads validate image input and register an authenticated project without starting inference", async () => {
  const calls = [];
  let fail = false;
  const projectId = "c".repeat(64);
  const { handlers, chrome } = await background(async (url, options) => {
    calls.push({ url, options });
    return { ok: !fail, json: async () => fail ? { error: "Cannot save image" } : url.endsWith("/reference")
      ? { id: "current-input", projectId, image: "data:image/png;base64,Y3VycmVudA==", sourceUrl: "", inputRevision: 4, inputs: { style: { subjectImage: "stored-subject" } } } : { id: projectId } };
  });
  const storage = { preferences: { token: "private-token", mode: "style" }, selection: { id: "old" } };
  chrome.storage.local.get = async () => storage;
  chrome.storage.local.set = async value => Object.assign(storage, value);
  const sender = { id: "test", url: "chrome-extension://test/workspace.html" };
  const send = message => new Promise(resolve => handlers.message(message, sender, resolve));
  for (const image of [undefined, null, 42, "", "file:///tmp/photo.png", "https://example.com/photo.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,not valid!", `data:image/png;base64,${"A".repeat(6 * 1024 * 1024)}`])
    assert.ok((await send({ type: "alchemy:upload-reference", image })).error);
  assert.equal(calls.length, 0);
  const image = "data:image/png;base64,iVBORw==";
  fail = true;
  assert.match((await send({ type: "alchemy:upload-reference", image })).error, /Cannot save image/);
  assert.equal(storage.selection.id, "old", "failed upload preserves the selected project");
  fail = false;
  const result = await send({ type: "alchemy:upload-reference", image, sourceUrl: "file:///private", projectId: "forged" });
  assert.equal(result.ok, true);
  assert.equal(result.value.projectId, projectId);
  assert.equal(storage.selection.image, "data:image/png;base64,Y3VycmVudA==", "reusing an existing project restores its adjusted current input");
  assert.equal(storage.selection.jobId, undefined);
  assert.equal(storage.selection.sourceUrl, "");
  assert.equal(result.value.inputs.style.subjectImage, "stored-subject");
  assert.equal(storage.selection.inputs, undefined);
  assert.equal(storage.selection.inputRevision, 4);
  assert.ok(calls.every(call => call.url.startsWith("http://127.0.0.1:43187/projects") && call.options.headers.Authorization === "Bearer private-token"));
  assert.deepEqual(JSON.parse(calls[1].options.body), { image, sourceUrl: "", capture: "original" });
  storage.preferences.token = "";
  assert.match((await send({ type: "alchemy:upload-reference", image })).error, /配对码/);
  assert.equal(calls.length, 3);
  assert.equal(handlers.message({ type: "alchemy:upload-reference", image }, { ...sender, id: "other" }, () => assert.fail("untrusted upload")), undefined);
});

test("CLI management messages expose only fixed authenticated endpoints and never forward shell input", async () => {
  const calls = [];
  const { handlers, chrome } = await background(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ status: "ready" }) };
  });
  const sender = { id: "test", url: "chrome-extension://test/workspace.html" };
  const send = message => new Promise(resolve => handlers.message(message, sender, resolve));
  assert.equal((await send({ type: "alchemy:query", path: "/cli/status" })).ok, true);
  for (const type of ["alchemy:cli-check", "alchemy:cli-update"])
    assert.equal((await send({ type, command: "arbitrary shell input", args: ["--unsafe"], path: "/token", url: "https://external.example/", token: "forged" })).ok, true);
  assert.deepEqual(calls.map(call => call.url), ["http://127.0.0.1:43187/cli/status", "http://127.0.0.1:43187/cli/check", "http://127.0.0.1:43187/cli/update"]);
  assert.deepEqual(calls.map(call => call.options.method), ["GET", "POST", "POST"]);
  assert.equal(calls[0].options.body, undefined);
  for (const call of calls.slice(1)) assert.deepEqual(JSON.parse(call.options.body), {});
  assert.ok(calls.every(call => call.options.headers.Authorization === "Bearer test"));
  for (const path of ["/cli", "/cli/check", "/cli/update", "/cli/status?command=whoami", "/cli/status/../../token", "/cli/execute", "http://127.0.0.1:43187/cli/status"])
    assert.ok((await send({ type: "alchemy:query", path })).error);
  assert.equal(handlers.message({ type: "alchemy:cli-execute", command: "anything" }, sender, () => assert.fail("unknown CLI command reply")), undefined);
  for (const type of ["alchemy:cli-check", "alchemy:cli-update"])
    assert.equal(handlers.message({ type }, { ...sender, id: "other" }, () => assert.fail("untrusted CLI reply")), undefined);
  chrome.storage.local.get = async () => ({});
  assert.match((await send({ type: "alchemy:cli-update" })).error, /配对码/);
  assert.equal(calls.length, 3);
});

test("generation comparison references validate both IDs and retain authentication in the background", async () => {
  const calls = [];
  const { handlers } = await background(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ image: "reference-snapshot", subjectImage: "subject-snapshot" }) };
  });
  const sender = { id: "test", url: "chrome-extension://test/workspace.html" };
  const send = message => new Promise(resolve => handlers.message(message, sender, resolve));
  const id = "00000000-0000-0000-0000-000000000001";
  const generationId = "00000000-0000-0000-0000-000000000002";
  const result = await send({ type: "alchemy:generation-reference", id, generationId, path: "/token" });
  assert.equal(result.value.subjectImage, "subject-snapshot");
  assert.equal(calls[0].url, `http://127.0.0.1:43187/jobs/${id}/generations/${generationId}/reference`);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test");
  for (const invalid of [undefined, null, 42, "../token", `${generationId}/image`, "not-a-job"])
    for (const key of ["id", "generationId"])
      assert.ok((await send({ type: "alchemy:generation-reference", id, generationId, [key]: invalid })).error);
  assert.equal(handlers.message({ type: "alchemy:generation-reference", id, generationId }, { ...sender, id: "other" }, () => assert.fail("untrusted generation reply")), undefined);
  assert.equal(calls.length, 1);
});


test("paged project reads encode filters, retain authentication and reject unbounded requests", async () => {
  const calls = [];
  const { handlers, chrome } = await background(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ items: [], revision: "revision 2/&" }) };
  });
  const sender = { id: "test", url: "chrome-extension://test/workspace.html" };
  const send = message => new Promise(resolve => handlers.message(message, sender, resolve));
  const id = "a".repeat(64);
  assert.equal((await send({ type: "alchemy:projects", page: 3, limit: 24, q: "水彩 & /token?", status: "unstarted", token: "forged", path: "/token" })).ok, true);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/projects");
  assert.equal(url.searchParams.get("page"), "3");
  assert.equal(url.searchParams.get("limit"), "24");
  assert.equal(url.searchParams.get("q"), "水彩 & /token?");
  assert.equal(url.searchParams.get("status"), "unstarted");
  assert.equal((await send({ type: "alchemy:project", id, revision: "revision 2/&" })).ok, true);
  const detail = new URL(calls[1].url);
  assert.equal(detail.pathname, `/projects/${id}`);
  assert.equal(detail.searchParams.get("revision"), "revision 2/&");
  for (const message of [
    ...[0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1].map(page => ({ type: "alchemy:projects", page })),
    ...[0, -1, 101, 2.5, "24", null].map(limit => ({ type: "alchemy:projects", limit })),
    ...[null, {}, 42, "x".repeat(201)].map(q => ({ type: "alchemy:projects", q })),
    ...[null, "", "started", 42, {}].map(status => ({ type: "alchemy:projects", status })),
    ...[null, 42, "../token", "a".repeat(63)].map(id => ({ type: "alchemy:project", id })),
    ...[null, 42, {}, "x".repeat(101)].map(revision => ({ type: "alchemy:project", id, revision })),
    { type: "alchemy:query", path: "/projects?page=1&limit=1000000" },
  ]) assert.ok((await send(message)).error);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.options.method === "GET" && call.options.headers.Authorization === "Bearer test"));
  assert.equal(handlers.message({ type: "alchemy:projects" }, { ...sender, id: "other" }, () => assert.fail("untrusted page reply")), undefined);
  chrome.storage.local.get = async () => ({});
  assert.match((await send({ type: "alchemy:projects" })).error, /配对码/);
  assert.equal(calls.length, 2);
});

test("thumbnail reads constrain project and generation endpoints without exposing credentials", async () => {
  const calls = [];
  const { handlers } = await background(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ image: "thumbnail" }) };
  });
  const sender = { id: "test", frameId: 0, url: "https://pinterest.com/", tab: { id: 4 } };
  const send = message => new Promise(resolve => handlers.message(message, sender, resolve));
  const projectId = "b".repeat(64), id = "00000000-0000-0000-0000-000000000001", generationId = "00000000-0000-0000-0000-000000000002";
  assert.equal((await send({ type: "alchemy:project-thumbnail", id: projectId })).value.image, "thumbnail");
  assert.equal((await send({ type: "alchemy:project-thumbnail", id: projectId, reference: true })).ok, true);
  assert.equal((await send({ type: "alchemy:generation-thumbnail", id, generationId, path: "/token", token: "forged" })).ok, true);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname + new URL(call.url).search), [
    `/projects/${projectId}/thumbnail`, `/projects/${projectId}/thumbnail?reference=1`, `/jobs/${id}/generations/${generationId}/thumbnail`,
  ]);
  for (const message of [
    ...[null, "../token", id].map(id => ({ type: "alchemy:project-thumbnail", id })),
    ...[null, "true", 1].map(reference => ({ type: "alchemy:project-thumbnail", id: projectId, reference })),
    ...[null, 42, "../token", `${generationId}/image`].flatMap(invalid => [
      { type: "alchemy:generation-thumbnail", id: invalid, generationId },
      { type: "alchemy:generation-thumbnail", id, generationId: invalid },
    ]),
    { type: "alchemy:query", path: `/projects/${projectId}/thumbnail` },
  ]) assert.ok((await send(message)).error);
  assert.ok(calls.every(call => call.options.method === "GET" && call.options.headers.Authorization === "Bearer test"));
  for (const type of ["alchemy:project-thumbnail", "alchemy:generation-thumbnail"])
    assert.equal(handlers.message({ type, id: projectId }, { ...sender, id: "other" }, () => assert.fail("untrusted thumbnail reply")), undefined);
  assert.equal(calls.length, 3);
});

test("local image actions accept only saved IDs and fixed actions from trusted extension UI", async () => {
  const calls = [];
  const { handlers } = await background(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true }) };
  });
  const id = "00000000-0000-0000-0000-000000000001";
  const generationId = "00000000-0000-0000-0000-000000000002";
  const message = { type: "alchemy:generation-file-action", id, generationId, action: "open", path: "/tmp/ignored.png" };
  const workspace = { id: "test", url: "chrome-extension://test/workspace.html" };
  const content = { id: "test", frameId: 0, url: "https://example.com", tab: { id: 4 } };
  const send = (value, sender = workspace) => new Promise(resolve => handlers.message(value, sender, resolve));
  assert.equal((await send(message)).ok, true);
  assert.equal((await send({ ...message, action: "reveal" }, content)).ok, true);
  assert.deepEqual(calls.map(call => call.url), ["open", "reveal"].map(action => `http://127.0.0.1:43187/jobs/${id}/generations/${generationId}/${action}`));
  for (const { options } of calls) {
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer test");
    assert.equal(options.body, "{}");
  }
  for (const value of [{ id: "../token" }, { generationId: 42 }, { action: "open/../../token" }, { action: "delete" }])
    assert.ok((await send({ ...message, ...value })).error);
  for (const sender of [{ ...workspace, id: "other" }, { ...content, frameId: 2 }, { id: "test", url: "https://example.com" }])
    assert.equal(handlers.message(message, sender, () => assert.fail("untrusted message")), undefined);
  assert.equal(calls.length, 2);
});


test("collecting images persists projects without replacing the current selection or opening UI", async () => {
  const calls = [];
  let created = true, fail = false;
  const { handlers, chrome, messages, tabs } = await background(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/projects")) return { ok: !fail, json: async () => fail ? { error: "保存失败" } : { id: "a".repeat(64), created } };
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
  }, {
    Blob, Uint8Array, btoa,
    createImageBitmap: async () => ({ width: 320, height: 400, close() {} }),
    OffscreenCanvas: class {
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { return new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }); }
    },
  });
  const storage = { preferences: { token: "test" }, selection: { id: "previous", projectId: "b".repeat(64), jobId: "active" } };
  chrome.storage.local.get = async () => storage;
  chrome.storage.local.set = async () => assert.fail("collect must not change current UI state");
  const sender = { id: "test", frameId: 0, tab: { id: 4, windowId: 1, url: "https://example.com" } };
  const message = { type: "alchemy:collect", target: { src: "https://example.com/template.png" } };
  const send = () => new Promise(resolve => handlers.message(message, sender, resolve));
  assert.equal((await send()).value.created, true);
  created = false;
  assert.equal((await send()).value.created, false);
  const parallel = await Promise.all([send(), send(), send()]);
  assert.ok(parallel.every(reply => reply.ok && reply.value.projectId === "a".repeat(64)), "independent collection requests must not share the selection lock");
  fail = true;
  const failed = await send();
  assert.match(failed.error, /保存失败/);
  assert.equal(failed.ok, undefined);
  const count = calls.length;
  storage.preferences.token = "";
  assert.match((await send()).error, /连接本机服务/);
  assert.equal(calls.length, count, "unpaired collection must not read the image or claim success");
  assert.equal(storage.selection.id, "previous");
  assert.equal(messages.length, 0);
  assert.equal(tabs.length, 0);
  assert.ok(calls.filter(call => call.options?.method === "POST").every(call => call.url.endsWith("/projects")));
  for (const untrusted of [{ ...sender, id: "other" }, { ...sender, frameId: 1 }, { id: "test", url: "chrome-extension://test/popup.html" }])
    assert.equal(handlers.message(message, untrusted, () => assert.fail("untrusted collection reply")), undefined);
  storage.preferences.token = "test";
  const feedback = [];
  let finish;
  chrome.tabs.sendMessage = async (_, message) => { feedback.push(message); if (message.state === "error") finish(); };
  await new Promise(resolve => { finish = resolve; handlers.menu({ menuItemId: "alchemy-collect", srcUrl: message.target.src }, sender.tab); });
  assert.deepEqual(feedback.map(message => message.state), ["saving", "error"]);
  assert.match(feedback[1].error, /保存失败/);
  fail = false;
  chrome.tabs.sendMessage = async (_, message) => { feedback.push(message); if (message.state === "saved") finish(); };
  await new Promise(resolve => { finish = resolve; handlers.menu({ menuItemId: "alchemy-collect", srcUrl: message.target.src }, sender.tab); });
  assert.equal(feedback.at(-1).created, false);
  assert.ok(feedback.every(message => message.type === "alchemy:collect-feedback"));
  assert.equal(tabs.length, 0);
});

for (const scenario of ["saved", "moved", "screenshot-error"]) test(`collection screenshot fallback preserves capture identity and UI state: ${scenario}`, async () => {
  const calls = [], events = [], draws = [];
  let closed = false, rectangleReads = 0;
  const captureId = "capture-selected-element";
  const bounds = { x: 20, y: 30, width: 200, height: 300, viewportWidth: 800, viewportHeight: 600 };
  const { handlers, chrome, tabs } = await background(async (url, options) => {
    calls.push({ url, options });
    if (url === "https://example.com/private.png") throw new Error("resource needs site credentials");
    if (url.endsWith("/projects")) return { ok: true, json: async () => ({ id: "c".repeat(64), created: true }) };
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
  }, {
    Blob, Uint8Array, btoa,
    createImageBitmap: async () => ({ width: 1600, height: 1200, close() { closed = true; } }),
    OffscreenCanvas: class {
      constructor(width, height) { this.width = width; this.height = height; }
      getContext() { return { drawImage: (...args) => draws.push(args.slice(1)) }; }
      async convertToBlob() { return new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }); }
    },
  });
  chrome.storage.local.set = async () => assert.fail("screenshot collection must not replace selection");
  chrome.tabs.query = async () => [{ id: 4 }];
  chrome.tabs.sendMessage = async (tabId, message) => {
    assert.equal(tabId, 4);
    events.push(message);
    if (message.type === "alchemy:rect") {
      assert.equal(message.captureId, captureId);
      assert.equal(message.src, "https://example.com/private.png");
      rectangleReads++;
      return { ...bounds, x: bounds.x + (scenario === "moved" && rectangleReads === 2 ? 20 : 0) };
    }
  };
  chrome.tabs.captureVisibleTab = async (windowId) => {
    assert.equal(windowId, 1);
    const visibility = events.filter(message => message.type === "alchemy:capture-visibility");
    assert.equal(visibility.at(-1)?.hidden, true, "the overlay must be hidden before taking a screenshot");
    assert.equal(visibility.at(-1)?.captureId, captureId);
    if (scenario === "screenshot-error") throw new Error("screenshot permission denied");
    return "data:image/png;base64,iVBORw==";
  };
  const sender = { id: "test", frameId: 0, tab: { id: 4, windowId: 1, url: "https://example.com/" } };
  const reply = await new Promise(resolve => handlers.message({ type: "alchemy:collect", target: { src: "https://example.com/private.png", captureId, rect: bounds } }, sender, resolve));
  const visibility = events.filter(message => message.type === "alchemy:capture-visibility");
  assert.deepEqual(visibility.map(message => message.hidden), [true, false], "every screenshot attempt must restore overlay visibility");
  assert.ok(visibility.every(message => message.captureId === captureId));
  assert.equal(rectangleReads, scenario === "screenshot-error" ? 1 : 2);
  assert.equal(tabs.length, 0);
  assert.ok(events.every(message => ["alchemy:rect", "alchemy:capture-visibility"].includes(message.type)), "collection must not open or close the panel");
  const posts = calls.filter(call => call.options?.method === "POST");
  if (scenario === "saved") {
    assert.equal(reply.ok, true);
    assert.equal(posts.length, 1);
    assert.equal(JSON.parse(posts[0].options.body).capture, "screenshot");
    assert.deepEqual(draws, [[40, 60, 400, 600, 0, 0, 400, 600]], "only the target region is saved");
    assert.equal(closed, true);
  } else {
    assert.equal(reply.ok, undefined);
    assert.match(reply.error, scenario === "moved" ? /位置发生变化/ : /screenshot permission denied/);
    assert.equal(posts.length, 0, "changed or failed screenshots must not be registered");
    assert.equal(draws.length, 0);
  }
});

test("multi-image messages preserve order and roles, enforce image bounds and keep bridge authentication", async () => {
  const calls = [];
  const id = "00000000-0000-0000-0000-000000000001";
  const projectId = "a".repeat(64);
  const { handlers, chrome } = await background(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith("/reference")
      ? { id: "selected", projectId, image: "saved-template", inputRevision: 1, inputs: { "multi-reenact": { subjects, instruction: "让人物拿着杯子" } } }
      : { id, projectId, mode: "multi-reenact", stage: "started" } };
  });
  const storage = { preferences: { token: "private-token", mode: "style" }, selection: { id: "selected", image: "saved-template" } };
  chrome.storage.local.get = async () => storage;
  chrome.storage.local.set = async value => Object.assign(storage, value);
  const sender = { id: "test", url: "chrome-extension://test/workspace.html" };
  const send = message => new Promise(resolve => handlers.message(message, sender, resolve));
  const subjects = [
    { id: "person", subjectImage: "data:image/png;base64,iVBORw==", role: "人物", detail: "保留五官" },
    { id: "cup", subjectImage: "data:image/jpeg;base64,/9j/", role: "物品", detail: "保留杯型" },
  ];
  assert.equal((await send({ type: "alchemy:mode", mode: "multi-reenact" })).ok, true);
  assert.equal(storage.preferences.mode, "multi-reenact");
  const start = { type: "alchemy:start", id: "selected", mode: "multi-reenact", reenact: { subjects, basePrompt: "让人物拿着杯子" } };
  const started = await send(start);
  assert.equal(started.ok, true);
  assert.deepEqual(JSON.parse(calls[0].options.body).reenact, start.reenact);
  assert.equal(started.value.selection.reenact.subjects[1].id, "cup");
  assert.equal(storage.selection.inputs, undefined, "restore image bytes from bridge instead of exhausting local storage quota");
  assert.equal(started.value.currentSelection.inputs["multi-reenact"].subjects.length, 2);
  const generate = { type: "alchemy:generate", id, language: "zh", subjects: [...subjects].reverse() };
  assert.equal((await send(generate)).ok, true);
  assert.deepEqual(JSON.parse(calls[2].options.body), { language: "zh", subjects: generate.subjects });
  assert.ok(calls.every(call => call.options.headers.Authorization === "Bearer private-token"));
  const invalidSubjects = [null, [], [subjects[0]], Array.from({ length: 7 }, (_, i) => ({ ...subjects[0], id: String(i) })),
    [subjects[0], subjects[0]], [subjects[0], { ...subjects[1], id: "../asset" }],
    [subjects[0], { ...subjects[1], subjectImage: "file:///private/image.png" }],
    [subjects[0], { ...subjects[1], subjectImage: `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64")}` }],
    [subjects[0], { ...subjects[1], subjectImage: "data:image/png;base64,abc" }],
    [subjects[0], { ...subjects[1], role: "invalid" }], [subjects[0], { ...subjects[1], detail: "x".repeat(2001) }],
  ];
  for (const subjects of invalidSubjects) {
    assert.ok((await send({ ...generate, subjects })).error);
    assert.ok((await send({ ...start, reenact: { subjects, basePrompt: "融合" } })).error);
  }
  assert.ok((await send({ ...generate, subjectImage: subjects[0].subjectImage })).error);
  assert.ok((await send({ ...start, reenact: { subjects, basePrompt: "x".repeat(20001) } })).error);
  assert.equal(calls.length, 3, "invalid inputs must not reach the bridge");
  assert.equal(handlers.message(generate, { ...sender, id: "other" }, () => assert.fail("untrusted generation")), undefined);
  const state = await send({ type: "alchemy:state", selectionId: storage.selection.id, selectionJobId: storage.selection.jobId });
  assert.equal(state.value.selection.reenact, undefined, "polling must not resend all images");
});

test("workspace handoff carries ordered multi-image drafts and rejects malformed entries", async () => {
  const { handlers, tabs, sessionStorage } = await background(() => assert.fail("handoff must not invoke inference"));
  const sender = { id: "test", url: "chrome-extension://test/popup.html" };
  const send = message => new Promise(resolve => handlers.message(message, sender, resolve));
  const subject = { id: "person", subjectImage: "data:image/png;base64,iVBORw==", role: "人物", detail: "五官" };
  const draft = { multiSubjectDrafts: { project: [subject, { ...subject, id: "pending", subjectImage: "" }] } };
  assert.equal((await send({ type: "alchemy:open-workspace", draft })).ok, true, "incomplete drafts remain transferable");
  const id = new URL(tabs[0].url).searchParams.get("handoff");
  assert.deepEqual(sessionStorage[`workspace:${id}`].draft, draft);
  assert.deepEqual((await send({ type: "alchemy:workspace-handoff", id })).value.draft, draft);
  for (const multiSubjectDrafts of [null, [], "invalid", { project: null }, { project: [{ ...subject, subjectImage: "file:///private" }] }])
    assert.ok((await send({ type: "alchemy:open-workspace", draft: { multiSubjectDrafts } })).error);
  assert.equal(tabs.length, 1);
});


test("explicit handoff pins source, mode and version despite another surface's selection", async () => {
  const { handlers, chrome, tabs, sessionStorage } = await background(() => assert.fail("handoff must not start tasks or read global project assets"));
  chrome.storage.local.get = async () => ({ preferences: { token: "secret", mode: "recreate" }, selection: { id: "B", projectId: "b".repeat(64) } });
  const sender = { id: "test", url: "chrome-extension://test/popup.html" };
  const send = message => new Promise(resolve => handlers.message(message, sender, resolve));
  for (const version of ["older-version", "shown-latest-version", "new"]) {
    const context = { mode: "style", selection: { id: "A", projectId: "a".repeat(64), sourceUrl: "https://example.com/a.png" } };
    const draft = { versions: { [`${context.selection.projectId}:style`]: version }, instructions: { [`${context.selection.projectId}:style:${version}`]: "unsaved" } };
    assert.equal((await send({ type: "alchemy:open-workspace", context, draft })).ok, true);
    const id = new URL(tabs.at(-1).url).searchParams.get("handoff");
    const stored = sessionStorage[`workspace:${id}`];
    assert.equal(stored.selection.id, "A");
    assert.equal(stored.mode, "style");
    assert.deepEqual(stored.draft.versions, draft.versions);
    assert.equal(stored.draft.instructions[`${context.selection.projectId}:style:${version}`], "unsaved");
  }
  assert.equal((await send({ type: "alchemy:open-workspace", context: { mode: "recreate", selection: null } })).ok, true);
  const id = new URL(tabs.at(-1).url).searchParams.get("handoff");
  assert.equal(sessionStorage[`workspace:${id}`].selection, null, "explicit empty source must not pick B");
  for (const context of [{ mode: "unknown", selection: null }, { mode: "style", selection: { id: "A", projectId: "../project" } }])
    assert.ok((await send({ type: "alchemy:open-workspace", context })).error);
});

test("quick drafts are session-only, source-isolated, ordered and retained on capacity failure", async () => {
  const { handlers, chrome, sessionStorage } = await background(() => assert.fail("draft storage must not call bridge"));
  chrome.storage.local.set = async () => assert.fail("drafts must not persist in project or local storage");
  const popup = { id: "test", url: "chrome-extension://test/popup.html" };
  const content = { id: "test", frameId: 0, url: "https://example.com/", tab: { id: 4 } };
  const send = (message, sender = popup) => new Promise(resolve => handlers.message(message, sender, resolve));
  const context = { mode: "style", selection: { id: "A", projectId: "a".repeat(64) } };
  const drafts = ["first", "latest"].map(text => ({ type: "alchemy:quick-draft", context, draft: { instructions: { A: text } } }));
  await Promise.all(drafts.map(message => send(message)));
  await send({ ...drafts[0], source: "popup" }, content);
  assert.equal((await send({ type: "alchemy:quick-draft" })).value.draft.instructions.A, "latest");
  assert.equal((await send({ type: "alchemy:quick-draft" }, content)).value.draft.instructions.A, "first");
  assert.equal((await send({ type: "alchemy:quick-draft" }, { ...content, tab: { id: 5 } })).value, undefined);
  const saved = structuredClone(sessionStorage["quick:popup"]);
  sessionStorage["workspace:occupied"] = { createdAt: Date.now(), draft: { text: "x".repeat(9 * 1024 * 1024) } };
  assert.match((await send(drafts[0])).error, /空间不足/);
  assert.deepEqual(sessionStorage["quick:popup"], saved);
  sessionStorage["workspace:occupied"].createdAt -= 25 * 60 * 60 * 1000;
  assert.equal((await send(drafts[0])).ok, true);
  assert.equal(sessionStorage["workspace:occupied"], undefined);
  sessionStorage["quick:popup"].createdAt -= 25 * 60 * 60 * 1000;
  assert.equal((await send({ type: "alchemy:quick-draft" })).value, undefined);
  assert.equal(sessionStorage["quick:popup"], undefined);
});


test("a large quick draft transfers without duplicate image storage and survives failed opening", async () => {
  const { handlers, chrome, tabs, sessionStorage } = await background(() => assert.fail("draft transfer must not call bridge"));
  const sender = { id: "test", url: "chrome-extension://test/popup.html" };
  const send = message => new Promise(resolve => handlers.message(message, sender, resolve));
  const context = { mode: "style", selection: { id: "A", projectId: "a".repeat(64) } };
  const draft = { subjectDrafts: { 'A:style': 'x'.repeat(5 * 1024 * 1024) }, instructions: { 'A:style:new': 'unsaved' } };
  assert.equal((await send({ type: "alchemy:quick-draft", context, draft })).ok, true);
  assert.equal((await send({ type: "alchemy:open-workspace", context, draft })).ok, true);
  assert.ok(JSON.stringify(sessionStorage).length < 6 * 1024 * 1024);
  assert.equal((await send({ type: "alchemy:quick-draft" })).value.draft.subjectDrafts['A:style'].length, draft.subjectDrafts['A:style'].length);
  const id = new URL(tabs[0].url).searchParams.get('handoff');
  const received = await send({ type: "alchemy:workspace-handoff", id });
  assert.deepEqual(received.value.draft, { ...draft, multiSubjectDrafts: {}, versions: {}, promptDrafts: {} });
  assert.ok(JSON.stringify(sessionStorage).length < 6 * 1024 * 1024);
  assert.equal(sessionStorage['quick:popup'].handoff, undefined);
  chrome.tabs.create = async () => { throw new Error('tab failed'); };
  assert.match((await send({ type: "alchemy:open-workspace", context, draft })).error, /tab failed/);
  assert.equal((await send({ type: "alchemy:quick-draft" })).value.draft.instructions['A:style:new'], 'unsaved');
  assert.equal(Object.keys(sessionStorage).filter(key => key.startsWith('workspace:')).length, 0);
});

test("session readers wait for queued writes and handoff consumption is exactly once", async () => {
  const { handlers, chrome, tabs } = await background(() => assert.fail("session operations do not call bridge"));
  const sender = { id: "test", url: "chrome-extension://test/popup.html" };
  const send = message => new Promise(resolve => handlers.message(message, sender, resolve));
  const context = { mode: "style", selection: null };
  const originalSet = chrome.storage.session.set;
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  chrome.storage.session.set = async value => { entered(); await new Promise(resolve => { release = resolve; }); await originalSet(value); };
  const write = send({ type: "alchemy:quick-draft", context, draft: { instructions: { key: "latest" } } });
  await waiting;
  const read = send({ type: "alchemy:quick-draft" });
  release();
  await write;
  assert.equal((await read).value.draft.instructions.key, "latest");
  chrome.storage.session.set = originalSet;
  await send({ type: "alchemy:open-workspace", context, draft: { instructions: { key: "handoff" } } });
  const id = new URL(tabs[0].url).searchParams.get('handoff');
  const consumed = await Promise.all([send({ type: "alchemy:workspace-handoff", id }), send({ type: "alchemy:workspace-handoff", id })]);
  assert.equal(consumed.filter(item => item.value).length, 1);
});


test("all workspace entry points reuse a matching live tab and keep handoffs private", async () => {
  const { handlers, chrome, tabs, sessionStorage } = await background();
  const existing = { id: 20, windowId: 3, active: false, url: 'chrome-extension://test/workspace.html?keep=yes' };
  const updates = [], windows = [];
  chrome.tabs.query = async filter => filter.url ? [] : [{ id: 99, url: 'chrome-extension://test/workspace.html.backup' },
    { id: existing.id, windowId: existing.windowId, active: existing.active }];
  chrome.runtime.getContexts = async () => [{ tabId: existing.id, documentUrl: existing.url }];
  chrome.tabs.update = async (id, update) => { updates.push({ id, ...update }); Object.assign(existing, update); };
  chrome.windows = { update: async (id, update) => windows.push({ id, ...update }) };
  const popup = { id: 'test', url: 'chrome-extension://test/popup.html' };
  const send = (message, sender = popup) => new Promise(resolve => handlers.message(message, sender, resolve));
  for (const view of [undefined, 'settings', 'tasks']) {
    const draft = { instructions: { key: 'private draft' } };
    const sender = view === 'tasks' ? { id: 'test', frameId: 0, url: 'https://www.pinterest.com/', tab: { id: 8, url: 'https://www.pinterest.com/' } } : popup;
    assert.equal((await send({ type: 'alchemy:open-workspace', view, draft }, sender)).ok, true);
    const update = updates.at(-1), url = new URL(update.url), route = new URLSearchParams(url.hash.slice('#workspace='.length));
    assert.equal(update.id, 20); assert.equal(update.active, true); assert.equal(url.search, '?keep=yes');
    assert.equal(route.get('view'), view || null);
    assert.equal(sessionStorage['workspace:' + route.get('handoff')].draft.instructions.key, 'private draft');
    assert.ok(!update.url.includes('private'));
  }
  assert.equal(tabs.length, 0); assert.equal(windows.length, 3); assert.equal(windows[0].id, 3);
  chrome.tabs.update = async () => { throw new Error('activation failed'); };
  assert.match((await send({ type: 'alchemy:open-workspace', draft: { instructions: { key: 'recoverable' } } })).error, /activation failed/);
  assert.equal(sessionStorage['quick:popup'].draft.instructions.key, 'recoverable');
  assert.equal(tabs.length, 0);
  assert.match((await send({ type: 'alchemy:open-workspace', view: 'https://example.com' })).error, /无效工作台页面/);
});


test("plain workspace entry restores the selected project's path instead of the global mode", async () => {
  const { handlers, chrome, tabs, sessionStorage } = await background(() => assert.fail("navigation must not start tasks"));
  const projectId = "a".repeat(64);
  const stored = { preferences: { token: "secret", mode: "reenact" }, selection: { id: "selected", projectId },
    [`projectView:${projectId}`]: { mode: "recreate", versions: {} } };
  chrome.storage.local.get = async () => stored;
  const send = message => new Promise(resolve => handlers.message(message, { id: "test", url: "chrome-extension://test/popup.html" }, resolve));
  assert.equal((await send({ type: "alchemy:open-workspace" })).ok, true);
  const id = new URL(tabs.at(-1).url).searchParams.get("handoff");
  assert.equal(sessionStorage[`workspace:${id}`].mode, "recreate");
  delete stored[`projectView:${projectId}`];
  assert.equal((await send({ type: "alchemy:open-workspace" })).ok, true);
  const firstId = new URL(tabs.at(-1).url).searchParams.get("handoff");
  assert.equal(sessionStorage[`workspace:${firstId}`].mode, "style", "unvisited project must not inherit global mode");
});

test("existing project edits preserve identity, authenticate CAS and store only compact current selection", async () => {
  const projectId = "a".repeat(64), image = "data:image/png;base64,iVBORw==";
  const calls = [], writes = [];
  let fail = false, finish;
  const next = { id: "input-8", projectId, image, inputRevision: 8, inputVersions: { style: "new" }, inputs: { style: { subjectImage: image, instruction: "edited" } } };
  const { handlers, chrome } = await background(async (url, options) => {
    calls.push({ url, options });
    if (finish === null) await new Promise(resolve => { finish = resolve; });
    return { ok: !fail, json: async () => fail ? { error: "项目输入已变化" } : next };
  });
  const storage = { preferences: { token: "secret" }, selection: { id: "input-7", projectId, inputRevision: 7, image: "old" } };
  chrome.storage.local.get = async () => storage;
  chrome.storage.local.set = async value => { writes.push(value); Object.assign(storage, value); };
  const sender = { id: "test", url: "chrome-extension://test/workspace.html" };
  const send = message => new Promise(resolve => handlers.message(message, sender, resolve));
  const message = { type: "alchemy:update-project-input", projectId, expectedRevision: 7, mode: "style", referenceJobId: "00000000-0000-0000-0000-000000000001", image, subjectImage: image, instruction: "edited", path: "/projects", token: "forged" };
  for (const invalid of [{ projectId: "../private" }, { expectedRevision: -1 }, { expectedRevision: "7" }, { expectedRevision: 1.5 }, { mode: "unknown" }])
    assert.match((await send({ ...message, ...invalid })).error, /无效项目输入/);
  assert.equal(calls.length, 0);
  fail = true;
  assert.match((await send(message)).error, /项目输入已变化/);
  assert.equal(writes.length, 0);
  assert.equal(storage.selection.image, "old");
  fail = false;
  const result = await send(message);
  assert.equal(result.ok, true);
  assert.equal(result.value.inputs.style.subjectImage, image);
  assert.equal(storage.selection.id, "input-8");
  assert.equal(storage.selection.projectId, projectId);
  assert.equal(storage.selection.inputs, undefined);
  assert.equal(storage.selection.inputVersions.style, "new");
  assert.ok(calls.every(call => call.url.endsWith(`/projects/${projectId}/input`) && call.options.headers.Authorization === "Bearer secret"));
  assert.deepEqual(JSON.parse(calls[1].options.body), { expectedRevision: 7, referenceJobId: message.referenceJobId, mode: "style", image, subjectImage: image, instruction: "edited" });
  const writeCount = writes.length;
  finish = null;
  const pending = send(message);
  await new Promise(resolve => setImmediate(resolve));
  const callCount = calls.length;
  assert.match((await send(message)).error, /正在处理图片/);
  assert.equal(calls.length, callCount, "a pending save excludes another input transaction");
  storage.selection = { id: "newer-input", projectId, inputRevision: 9, image: "newer" };
  finish(); await pending;
  assert.equal(writes.length, writeCount, "an old save cannot overwrite a newer selection revision");
  storage.selection = { id: "other", projectId: "b".repeat(64), inputRevision: 1 };
  await send(message);
  assert.equal(writes.length, writeCount, "editing one workspace must not take over another selected project");
  assert.equal(handlers.message(message, { ...sender, id: "other" }, () => assert.fail("untrusted update")), undefined);
});

test("legacy ensure-project restores the current project reference without duplicating composition in storage", async () => {
  const projectId = "c".repeat(64), calls = [];
  let fail = false;
  const { handlers, chrome } = await background(async (url, options) => {
    calls.push({ url, options });
    return { ok: !fail, json: async () => fail ? { error: "保存失败" } : url.endsWith("/reference")
      ? { id: "durable-id", projectId, image: "adjusted-current-image", inputRevision: 3, inputs: { reenact: { subjectImage: "subject" } } }
      : { id: projectId } };
  });
  const storage = { preferences: { token: "secret" }, selection: { id: "legacy-selection", image: "original-image", sourceUrl: "https://example.com" } };
  chrome.storage.local.get = async () => storage;
  chrome.storage.local.set = async value => Object.assign(storage, value);
  const sender = { id: "test", url: "chrome-extension://test/popup.html" };
  const send = () => new Promise(resolve => handlers.message({ type: "alchemy:ensure-project", id: "legacy-selection" }, sender, resolve));
  fail = true;
  assert.match((await send()).error, /保存失败/);
  assert.equal(storage.selection.projectId, undefined);
  fail = false;
  const result = await send();
  assert.equal(result.ok, true);
  assert.equal(result.value.inputs.reenact.subjectImage, "subject");
  assert.equal(storage.selection.image, "adjusted-current-image");
  assert.equal(storage.selection.id, "legacy-selection");
  assert.equal(storage.selection.inputRevision, 3);
  assert.equal(storage.selection.inputs, undefined);
  assert.equal(calls.at(-1).url.endsWith(`/projects/${projectId}/reference`), true);
});

test("starting jobs distinguishes current and historical references and rejects obsolete or foreign inputs", async () => {
  const projectId = "a".repeat(64), jobId = "00000000-0000-0000-0000-000000000001";
  const current = { id: "input-7", projectId, image: "current-image", inputRevision: 7, inputs: { style: { subjectImage: "current-subject" } } };
  const historical = { id: jobId, projectId, image: "historical-image", capture: "original", sourceUrl: "https://example.com/old" };
  const posts = [];
  const { handlers, chrome } = await background(async (url, options) => {
    if (url.endsWith(`/projects/${projectId}/reference`)) return { ok: true, json: async () => current };
    if (url.endsWith(`/jobs/${jobId}/reference`)) return { ok: true, json: async () => historical };
    assert.ok(url.endsWith("/jobs"));
    posts.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ id: "new-job", projectId, mode: "recreate" }) };
  });
  const storage = { preferences: { token: "secret" }, selection: { ...current } };
  chrome.storage.local.get = async () => storage;
  chrome.storage.local.set = async value => Object.assign(storage, value);
  const sender = { id: "test", url: "chrome-extension://test/workspace.html" };
  const send = extra => new Promise(resolve => handlers.message({ type: "alchemy:start", id: current.id, projectId, mode: "recreate", inputRevision: 7, ...extra }, sender, resolve));
  assert.match((await send({ inputRevision: 6 })).error, /其他窗口更新/);
  assert.equal(posts.length, 0);
  const live = await send();
  assert.equal(live.ok, true);
  assert.equal(posts[0].image, "current-image");
  assert.equal(posts[0].inputRevision, 7);
  const replay = await send({ referenceJobId: jobId });
  assert.equal(replay.ok, true);
  assert.equal(posts[1].image, "historical-image");
  assert.equal(posts[1].projectId, projectId);
  assert.equal(posts[1].referenceJobId, jobId);
  assert.equal(replay.value.selection.image, "historical-image");
  assert.equal(replay.value.currentSelection.image, "current-image");
  assert.equal(storage.selection.image, "current-image");
  assert.equal(storage.selection.inputs, undefined);
  historical.projectId = "b".repeat(64);
  assert.match((await send({ referenceJobId: jobId })).error, /不属于当前项目/);
  assert.equal(posts.length, 2);
});

test("a missing current image retains the revision needed to repair the same project", async () => {
  const id = "d".repeat(64), image = "data:image/png;base64,aW1hZ2U=";
  const { handlers, chrome } = await background(async (url, options) => {
    if (url.endsWith("/reference")) return { ok: false, json: async () => ({ error: "原图已丢失" }) };
    if (url.endsWith("/input")) {
      assert.equal(JSON.parse(options.body).expectedRevision, 7);
      return { ok: true, json: async () => ({ id: `${id}:8`, projectId: id, image, inputRevision: 8 }) };
    }
    return { ok: true, json: async () => ({ id, inputRevision: 7, inputVersions: { style: "new" }, jobs: [] }) };
  });
  const storage = { preferences: { token: "secret" } };
  chrome.storage.local.get = async () => storage;
  chrome.storage.local.set = async value => Object.assign(storage, value);
  const send = message => new Promise(resolve => handlers.message(message, { id: "test", url: "chrome-extension://test/popup.html" }, resolve));
  const opened = await send({ type: "alchemy:open-project", id });
  assert.equal(opened.value.inputRevision, 7);
  assert.match(opened.value.error, /原图已丢失/);
  const repaired = await send({ type: "alchemy:update-project-input", projectId: id, expectedRevision: opened.value.inputRevision, image, mode: "style", instruction: "修复参考图" });
  assert.equal(repaired.value.projectId, id);
  assert.equal(repaired.value.inputRevision, 8);
});

for (const failure of ['get', 'set']) test(`durable input save succeeds despite subsequent selection cache ${failure} failure`, async () => {
  const projectId = 'a'.repeat(64);
  let saved = false, cacheAttempted = false;
  const next = { id: 'input-8', projectId, inputRevision: 8, inputs: { style: { instruction: 'saved' } } };
  const { handlers, chrome } = await background(async url => {
    assert.ok(url.endsWith(`/projects/${projectId}/input`));
    saved = true;
    return { ok: true, json: async () => next };
  });
  chrome.storage.local.get = async key => {
    if (key === 'selection' && failure === 'get') { cacheAttempted = true; throw new Error('cache get failed'); }
    return { preferences: { token: 'secret' }, selection: { projectId, inputRevision: 7 } };
  };
  chrome.storage.local.set = async () => { cacheAttempted = true; throw new Error('cache set failed'); };
  const sender = { id: 'test', url: 'chrome-extension://test/workspace.html' };
  const message = { type: 'alchemy:update-project-input', projectId, expectedRevision: 7, mode: 'style', instruction: 'saved' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await new Promise(resolve => handlers.message(message, sender, resolve));
    assert.equal(saved, true);
    assert.equal(cacheAttempted, true);
    assert.equal(result.ok, true);
    assert.equal(result.value.inputRevision, 8);
    assert.equal(result.value.inputs.style.instruction, 'saved');
  }
});


test("service restart uses only the authenticated fixed endpoint and rejects untrusted senders", async () => {
  const calls = [];
  const { handlers } = await background(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ previousInstanceId: "old", restartId: "ticket" }) };
  });
  const sender = { id: "test", url: "chrome-extension://test/workspace.html" };
  const message = { type: "alchemy:service-restart", path: "/shutdown", command: "unexpected", dataDir: "/unexpected" };
  assert.equal(handlers.message(message, { ...sender, id: "other" }, () => assert.fail("untrusted reply")), undefined);
  assert.equal(calls.length, 0);
  const response = await new Promise(resolve => handlers.message(message, sender, resolve));
  assert.equal(response.value.restartId, "ticket");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/restart"));
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test");
  assert.deepEqual(JSON.parse(calls[0].options.body), {});
});

test("service restart explains an old bridge route and preserves actionable server failures", async () => {
  let error = "Not found";
  const { handlers } = await background(async () => ({ ok: false, json: async () => ({ error }) }));
  const send = () => new Promise(resolve => handlers.message({ type: "alchemy:service-restart" }, { id: "test", url: "chrome-extension://test/popup.html" }, resolve));
  assert.match((await send()).error, /npm stop.*npm start/);
  error = "任务执行中，请等待完成";
  assert.equal((await send()).error, error);
});

const clientCode = ts.transpileModule(await readFile(new URL('../lib/client.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function requestClock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    setTimeout(fn, delay) { timers.set(++id, { fn, at: now + delay }); return id; },
    clearTimeout(key) { timers.delete(key); },
    tick(ms) { now += ms; for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.fn(); } },
  };
}
function portClient(bg, clock, sender = { id: 'test', url: 'chrome-extension://test/workspace.html' }) {
  const event = () => {
    const listeners = new Set();
    return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: value => [...listeners].forEach(fn => fn(value)) };
  };
  const ports = [];
  const runtime = {
    sendMessage: message => new Promise(resolve => bg.handlers.message(message, sender, resolve)),
    connect({ name }) {
      let closed = false;
      const ui = { onMessage: event(), onDisconnect: event() };
      const worker = { name, sender, onMessage: event(), onDisconnect: event() };
      ui.postMessage = message => { if (!closed) worker.onMessage.emit(message); };
      worker.postMessage = message => { if (!closed) ui.onMessage.emit(message); };
      ui.disconnect = () => { if (!closed) { closed = true; worker.onDisconnect.emit(); } };
      worker.disconnect = () => { if (!closed) { closed = true; ui.onDisconnect.emit(); } };
      ports.push({ ui, worker }); bg.handlers.connect(worker); return ui;
    },
  };
  const exports = {};
  runInNewContext(clientCode, { exports, require: () => ({ browser: { runtime } }), DOMException, ...clock });
  return { request: exports.request, ports };
}
const flushRequest = () => new Promise(resolve => setImmediate(resolve));
const transportProject = 'a'.repeat(64);
const transportReference = { id: 'input-1', projectId: transportProject, image: 'reference', inputRevision: 1 };
const transportMessages = [
  { type: 'alchemy:sessions-list' },
  { type: 'alchemy:update-project-input', projectId: transportProject, expectedRevision: 1, mode: 'session', sessionIds: ['00000000-0000-0000-0000-000000000001'], instruction: '封面' },
  { type: 'alchemy:start', projectId: transportProject, id: 'input-1', inputRevision: 1, mode: 'session', sessionIds: ['00000000-0000-0000-0000-000000000001'], instruction: '封面' },
];
async function slowTransport() {
  const clock = requestClock(), pending = [];
  let writes = 0;
  const bg = await background(async (url, options) => {
    if (url.endsWith('/reference')) return { ok: true, json: async () => transportReference };
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      pending.push({ signal: options.signal, complete() {
        if (options.signal.aborted) return;
        const value = url.endsWith('/sessions/list') ? { data: [{ id: 'chosen', title: '小说', updatedAt: 1 }], nextCursor: null }
          : url.endsWith('/jobs') ? { id: 'job', mode: 'session', projectId: transportProject, stage: 'started' }
          : { ...transportReference, inputRevision: 2 };
        if (!url.endsWith('/sessions/list')) writes++;
        resolve({ ok: true, json: async () => value });
      } });
    });
  }, { AbortSignal: { any: AbortSignal.any, timeout(ms) {
    const controller = new AbortController(); clock.setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms); return controller.signal;
  } } });
  bg.chrome.storage.local.get = async () => ({ preferences: { token: 'test' }, selection: transportReference });
  return { ...portClient(bg, clock), clock, pending, bg, get writes() { return writes; } };
}

for (const message of transportMessages) {
  test(`${message.type} client→built background→HTTP accepts a 60-second read without the old 35-second failure`, async () => {
    const flow = await slowTransport();
    let settled = false;
    const result = flow.request(message).finally(() => { settled = true; });
    await flushRequest();
    assert.equal(flow.pending.length, 1);
    flow.ports[0].worker.postMessage({ pending: true });
    flow.clock.tick(60_000); await flushRequest();
    assert.equal(settled, false, 'the UI must still await the authoritative result');
    assert.equal(flow.pending[0].signal.aborted, false);
    flow.pending[0].complete();
    const value = await result;
    assert.ok(value);
    assert.equal(flow.writes, message.type === 'alchemy:sessions-list' ? 0 : 1);
  });
  test(`${message.type} HTTP deadline reaches UI and prevents the delayed read from writing`, async () => {
    const flow = await slowTransport();
    const result = assert.rejects(flow.request(message), /请求超时/);
    await flushRequest(); flow.clock.tick(120_000); await result;
    assert.equal(flow.pending[0].signal.aborted, true);
    flow.pending[0].complete(); await flushRequest();
    assert.equal(flow.writes, 0);
  });
  test(`${message.type} closing the UI port aborts HTTP before a delayed write`, async () => {
    const flow = await slowTransport();
    const result = assert.rejects(flow.request(message), /结果尚未确认/);
    await flushRequest();
    flow.ports[0].worker.disconnect(); await result;
    // A browser disconnection also reaches the worker side of the connection.
    flow.ports[0].worker.onDisconnect.emit();
    assert.equal(flow.pending[0].signal.aborted, true);
    flow.pending[0].complete(); await flushRequest();
    assert.equal(flow.writes, 0);
  });
}

test('cancelled session search aborts only its own HTTP request; a replacement gets its own result', async () => {
  const flow = await slowTransport(), controller = new AbortController();
  const first = assert.rejects(flow.request({ type: 'alchemy:sessions-list', searchTerm: '旧' }, controller.signal), { name: 'AbortError' });
  await flushRequest(); controller.abort(); await first;
  const second = flow.request({ type: 'alchemy:sessions-list', searchTerm: '新' });
  await flushRequest();
  assert.equal(flow.pending[0].signal.aborted, true);
  assert.equal(flow.pending[1].signal.aborted, false);
  flow.pending[0].complete(); flow.pending[1].complete();
  assert.equal((await second).data[0].title, '小说');
});

test('request port cannot let a content script query local sessions or invoke arbitrary actions', async () => {
  const flow = await slowTransport();
  const content = portClient(flow.bg, flow.clock, { id: 'test', frameId: 0, tab: { id: 1 }, url: 'https://example.com/' });
  await assert.rejects(content.request({ type: 'alchemy:sessions-list' }), /无效请求/);
  const port = flow.ports;
  assert.equal(port.length, 0);
  assert.equal(flow.pending.length, 0);
});


test("recovery opens the requested settings section with the unsaved workspace draft", async () => {
  const { handlers, tabs, sessionStorage } = await background(() => assert.fail("recovery navigation must not call Codex"));
  const send = message => new Promise(resolve => handlers.message(message, { id: "test", url: "chrome-extension://test/popup.html" }, resolve));
  for (const section of ["cli", "models", "connection"]) {
    const draft = { instructions: { key: "keep my pending edit" } };
    assert.equal((await send({ type: "alchemy:open-workspace", view: "settings", section, draft })).ok, true);
    const url = new URL(tabs.at(-1).url);
    assert.equal(url.searchParams.get("section"), section);
    assert.deepEqual(sessionStorage["workspace:" + url.searchParams.get("handoff")].draft.instructions, draft.instructions);
  }
  for (const input of [{ view: "settings", section: "invalid" }, { section: "cli" }, { view: "tasks", section: "models" }])
    assert.match((await send({ type: "alchemy:open-workspace", ...input })).error, /无效/);
});
