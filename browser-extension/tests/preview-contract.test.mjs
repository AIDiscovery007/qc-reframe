import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createSessionSearch } from "../bridge/session-search.mjs";

let server, script, baseURL;
before(async () => {
  server = spawn(process.execPath, ["agent-tool/preview.mjs"], {
    cwd: new URL("../../", import.meta.url), env: { ...process.env, PREVIEW_PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise((resolve, reject) => {
    let output = "", errors = "";
    server.stderr.on("data", chunk => { errors += chunk; });
    server.once("error", reject);
    server.once("exit", code => reject(new Error(`preview exited ${code}: ${errors}`)));
    server.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
  });
  baseURL = url;
  const response = await fetch(`${url}/preview.js`);
  assert.equal(response.status, 200);
  script = await response.text();
});
after(async () => { if (server && server.exitCode === null) { const stopped = once(server, "exit"); server.kill(); await stopped; } });

function preview(search = "?state=session&sessionIndex=error", pathname = "/workspace.html") {
  const storage = () => {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  };
  const context = { location: new URL(`http://127.0.0.1${pathname}${search}`), URLSearchParams, structuredClone, crypto,
    localStorage: storage(), sessionStorage: storage(), addEventListener() {}, document: { querySelector() { return null; } }, setTimeout, clearTimeout };
  runInNewContext(script, context);
  return context.chrome.runtime;
}

test("preview and production preserve title search when the private content index fails, and both recover after clear", async t => {
  const runtime = preview();
  const directory = await mkdtemp(join(tmpdir(), "reframe-preview-contract-"));
  await writeFile(join(directory, "sessions.sqlite"), "corrupt index");
  const store = createSessionSearch({ directory, reader: { busy: false, close() {}, request: async method => {
    assert.equal(method, "thread/list");
    return { data: [{ id: "11111111-1111-4111-8111-111111111111", name: "小说", updatedAt: 1 }], nextCursor: null };
  } } });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const adapters = [
    { list: options => store.list(options), index: action => store.index(action) },
    { list: options => send({ type: "alchemy:sessions-list", ...options }), index: action => send({ type: "alchemy:sessions-index", action }) },
  ];
  async function send(message) {
    const response = await runtime.sendMessage(message);
    if (response.error) throw new Error(response.error);
    return response.value;
  }
  for (const adapter of adapters) {
    const title = await adapter.list({ scope: "title", searchTerm: "小说" });
    assert.ok(title.data.length);
    assert.equal(title.index.state, "partial");
    assert.match(title.index.error, /标题搜索仍可使用/);
    await assert.rejects(adapter.list({ scope: "content", searchTerm: "小说" }));
    await assert.rejects(adapter.index("status"));
    assert.equal((await adapter.index("clear")).state, "empty");
    const empty = await adapter.list({ scope: "content", searchTerm: "小说" });
    assert.equal(empty.index.state, "empty");
    assert.equal(empty.data.length, 0);
    assert.ok((await adapter.list({ scope: "title", searchTerm: "小说" })).data.length);
  }
});

test("preview uses production operation permissions on one-shot and connected requests", async () => {
  const runtime = preview("?state=session", "/content-preview");
  assert.match((await runtime.sendMessage({ type: "alchemy:sessions-list" })).error, /无效请求/);
  assert.match((await runtime.sendMessage({ type: "alchemy:sessions-index", action: "clear" })).error, /无效请求/);
  for (const type of ["alchemy:sessions-list", "alchemy:query", "constructor"]) {
    const port = runtime.connect({ name: "alchemy:request" });
    const reply = new Promise(resolve => port.onMessage.addListener(resolve));
    port.postMessage({ type, path: "/health" });
    assert.match((await reply).error, /无效请求/);
    port.disconnect();
  }
  assert.equal((await runtime.sendMessage({ type: "alchemy:state" })).ok, true);
});


test("root preview serves built entries, gallery images and browser regression scripts", async () => {
  for (const page of ["popup.html", "workspace.html"]) {
    const response = await fetch(`${baseURL}/${page}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /src="\/preview.js"/);
    const assets = [...html.matchAll(/(?:src|href)="([^" ]+\.(?:js|css))"/g)].map(match => match[1]);
    assert.ok(assets.length > 1);
    for (const asset of assets) assert.equal((await fetch(new URL(asset, baseURL))).status, 200, asset);
  }
  for (const [path, type] of [["thumb/0", "image/webp"], ["original/0", "image/png"], ["original/9", "image/svg+xml"]]) {
    const response = await fetch(`${baseURL}/gallery-fixture/${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), type);
    assert.ok((await response.arrayBuffer()).byteLength > 100);
  }
  for (const name of ["settings-recovery", "generation-actions", "auto-style", "creation-context"]) {
    const response = await fetch(`${baseURL}/${name}-regression.js`);
    assert.equal(response.status, 200, name);
    assert.match(response.headers.get("content-type"), /javascript/);
    assert.ok((await response.text()).length > 100);
  }
});
