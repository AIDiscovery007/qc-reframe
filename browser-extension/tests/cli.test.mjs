import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { createCliManager, inspectCodex, latestRelease, newerVersion, runCliCommand } from "../bridge/cli.mjs";
import { createBridge } from "../bridge/server.mjs";
import { readModelContext } from "../bridge/model-context.mjs";

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "reframe-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return realpath(dir);
}
async function executable(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return path;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const compatibility = { snapshot: () => ({ features: {} }), async getCompatibility() { return this.snapshot(); } };
async function settled(manager) {
  for (let i = 0; i < 100 && manager.busy; i++) await tick();
  assert.equal(manager.busy, false);
  return manager.status();
}
function mockManager(overrides = {}) {
  let version = "0.1.0";
  const commands = [];
  const manager = createCliManager({
    inspect: async () => ({ installed: true, version, executable: "/prefix/bin/codex", source: "npm", manager: "/prefix/bin/npm", prefix: "/prefix", managerEnv: {} }),
    latest: async () => "0.2.0",
    run: async (file, args) => { commands.push([file, args]); version = "0.2.0"; },
    ...overrides,
  });
  return { manager, commands, setVersion: value => { version = value; } };
}

test("version checks avoid lexical sorting and never downgrade newer or prerelease installations", () => {
  assert.equal(newerVersion("0.100.0", "0.99.9"), true);
  assert.equal(newerVersion("0.99.9", "0.100.0"), false);
  assert.equal(newerVersion("0.100.0", "0.100.0-alpha.1"), true);
  assert.equal(newerVersion("0.100.0", "0.101.0-alpha.1"), false);
  assert.equal(newerVersion("invalid", "0.1.0"), false);
});

test("installation detection follows actual executable and proves matching npm prefix/runtime", { skip: process.platform === "win32" }, async t => {
  const dir = await directory(t);
  const binary = await executable(join(dir, "lib/node_modules/@openai/codex/bin/codex.js"));
  await executable(join(dir, "bin/node"));
  await writeFile(join(dir, "lib/node_modules/@openai/codex/package.json"), JSON.stringify({ name: "@openai/codex" }));
  const link = join(dir, "bin/codex");
  await symlink(binary, link);
  const calls = [];
  const run = async (file, args, options) => { calls.push({ file, args, options }); return args[0] === "--version" ? "codex-cli 0.100.0" : dir; };
  const state = await inspectCodex({ env: { CODEX_BIN: link, PATH: "/other/bin" }, run });
  assert.equal(state.source, "npm");
  assert.equal(state.executable, link);
  assert.equal(state.manager, join(dir, "bin/npm"));
  assert.equal(state.version, "0.100.0");
  assert.ok(calls[1].options.env.PATH.startsWith(join(dir, "bin")));
  const mismatched = await inspectCodex({ env: { CODEX_BIN: link }, run: async (file, args) => args[0] === "--version" ? "codex-cli 0.100.0" : "/another/prefix" });
  assert.equal(mismatched.source, "custom");
  assert.equal(mismatched.manager, undefined);
});

test("App, custom and missing installations never acquire an automatic updater", async t => {
  const dir = await directory(t);
  const app = await executable(join(dir, "Codex.app/Contents/Resources/codex"));
  const custom = await executable(join(dir, "custom/codex"));
  const run = async () => "codex-cli 0.100.0";
  assert.equal((await inspectCodex({ env: { CODEX_BIN: app }, run })).source, "app");
  assert.equal((await inspectCodex({ env: { CODEX_BIN: custom }, run })).source, "custom");
  const absent = await inspectCodex({ env: { CODEX_BIN: join(dir, "missing") }, run });
  assert.equal(absent.installed, false);
  const manager = createCliManager({ inspect: async () => absent, latest: () => assert.fail("missing CLI must not query latest") });
  await assert.rejects(manager.update(), /未找到/);
});

test("standalone detection validates package metadata and requires a stable self-updating entrypoint", async t => {
  const dir = await directory(t);
  const root = join(dir, "packages/standalone/releases/0.159.2-aarch64-apple-darwin");
  const binary = await executable(join(root, "bin/codex"));
  const metadata = join(root, "codex-package.json");
  const pkg = { layoutVersion: 1, version: "0.159.2", target: "aarch64-apple-darwin", variant: "codex", entrypoint: "bin/codex" };
  await writeFile(metadata, JSON.stringify(pkg));
  await mkdir(join(dir, "bin"));
  const link = join(dir, "bin/codex");
  await symlink(binary, link);
  const run = async (_file, args) => args[0] === "--version" ? "codex-cli 0.159.2" : "Usage: codex update [OPTIONS]";
  const info = await inspectCodex({ env: { CODEX_BIN: link }, run });
  assert.equal(info.source, "standalone");
  assert.equal(info.manager, link);
  assert.equal(info.managerEnv.CODEX_HOME, dir);
  assert.equal(info.managerEnv.CODEX_INSTALL_DIR, join(dir, "bin"));
  assert.equal(info.managerEnv.CODEX_NON_INTERACTIVE, "1");
  const pinned = await inspectCodex({ env: { CODEX_BIN: binary }, run });
  assert.equal(pinned.source, "standalone");
  assert.equal(pinned.manager, undefined);
  const unsupported = await inspectCodex({ env: { CODEX_BIN: link }, run: async (_file, args) => args[0] === "--version" ? "codex-cli 0.159.2" : "Usage: codex [OPTIONS]" });
  assert.equal(unsupported.manager, undefined);
  await writeFile(metadata, JSON.stringify({ ...pkg, version: "0.1.0" }));
  assert.equal((await inspectCodex({ env: { CODEX_BIN: link }, run })).source, "custom");
});

test("standalone upgrades invoke only the detected codex update and revalidate the effective version", async () => {
  let version = "0.159.2", refreshed = 0;
  const commands = [];
  const manager = createCliManager({
    inspect: async () => ({ installed: true, version, executable: "/stable/bin/codex", source: "standalone", manager: "/stable/bin/codex", managerEnv: { CODEX_NON_INTERACTIVE: "1" } }),
    latest: async () => "0.160.0",
    run: async (file, args, options) => { commands.push([file, args]); assert.equal(options.env.CODEX_NON_INTERACTIVE, "1"); version = "0.160.0"; },
    onUpdated: async () => { refreshed++; },
  });
  assert.equal((await manager.check()).command, "'/stable/bin/codex' update");
  await manager.update();
  assert.equal((await settled(manager)).operation.status, "completed");
  assert.deepEqual(commands, [["/stable/bin/codex", ["update"]]]);
  assert.equal(refreshed, 1);
});

test("standalone checks use the official stable release and reject draft or invalid versions", async () => {
  const fetcher = body => async url => {
    assert.equal(url, "https://api.github.com/repos/openai/codex/releases/latest");
    return { ok: true, json: async () => body };
  };
  assert.equal(await latestRelease("standalone", fetcher({ tag_name: "rust-v0.160.0", draft: false, prerelease: false })), "0.160.0");
  for (const body of [{ tag_name: "invalid" }, { tag_name: "rust-v0.160.0", draft: true }, { tag_name: "rust-v0.160.0", prerelease: true }])
    await assert.rejects(latestRelease("standalone", fetcher(body)), /版本号/);
});

test("unmanaged installations compare stable CLI versions without allowing automatic updates", async () => {
  let time = Date.now();
  const manager = createCliManager({ now: () => time, inspect: async () => ({ installed: true, version: "0.1.0", source: "custom", executable: "/custom/codex" }), latest: async () => "0.2.0" });
  const before = await manager.check();
  time += 1000;
  const after = await manager.check();
  assert.notEqual(before.detectedAt, after.detectedAt);
  assert.ok(after.checkedAt);
  assert.equal(after.updateAvailable, true);
  assert.equal(after.comparisonReference, "npm-stable");
  assert.equal(after.instructions.loginCommand, "'/custom/codex' login");
  assert.equal(after.command, null);
  assert.equal(after.canUpdate, false);
  await assert.rejects(manager.update());
});

test("upgrade waits for follow-up checks and distinguishes their failure from installation failure", async () => {
  let rejectRefresh;
  const { manager } = mockManager({ onUpdated: () => new Promise((_, reject) => { rejectRefresh = reject; }) });
  await manager.update();
  await tick();
  assert.equal(manager.busy, true);
  assert.equal((await manager.status()).operation.status, "running");
  rejectRefresh(new Error("model catalog unavailable"));
  const result = await settled(manager);
  assert.equal(result.version, "0.2.0");
  assert.equal(result.operation.status, "failed");
  assert.equal(result.operation.stage, "Codex 已升级，复检未完成");
  assert.match(result.operation.error, /model catalog unavailable/);
});

test("partial installations always settle with synchronous or rejecting follow-up callbacks", async () => {
  for (const onUpdated of [() => {}, () => { throw new Error("reset failed"); }, async () => { throw new Error("refresh failed"); }]) {
    const partial = mockManager({ run: async () => { partial.setVersion("0.1.5"); throw new Error("install failed"); }, onUpdated });
    await partial.manager.update();
    const result = await settled(partial.manager);
    assert.equal(result.operation.status, "failed");
    assert.match(result.operation.error, /install failed/);
    assert.ok(result.operation.finishedAt);
  }
});

test("only explicit rechecks clear finished upgrade results and preserve a new check error", async () => {
  let time = Date.now(), offline = false;
  const { manager } = mockManager({ now: () => time, run: async () => { throw new Error("install failed"); },
    latest: async () => { if (offline) throw new Error("offline"); return "0.2.0"; } });
  await manager.update();
  assert.equal((await settled(manager)).operation.status, "failed");
  time += 86_400_001;
  await manager.status();
  await tick();
  assert.equal((await manager.status()).operation.status, "failed", "background checks retain upgrade history");
  assert.equal((await manager.check()).operation, undefined, "explicit successful check clears the stale failure");
  await manager.update();
  await settled(manager);
  offline = true;
  const result = await manager.check();
  assert.equal(result.operation, undefined);
  assert.match(result.checkError, /检查更新失败/);
});

test("a concurrent manual check cannot clear an upgrade started by its shared precheck", async () => {
  let releaseCheck, releaseUpdate;
  const { manager, setVersion } = mockManager({ latest: () => new Promise(resolve => { releaseCheck = resolve; }),
    run: async () => { await new Promise(resolve => { releaseUpdate = resolve; }); setVersion("0.2.0"); } });
  const update = manager.update();
  await tick();
  const check = manager.check();
  releaseCheck("0.2.0");
  await Promise.all([update, check]);
  assert.equal((await manager.status()).operation.status, "running");
  assert.equal(manager.busy, true);
  assert.equal((await manager.check()).operation.status, "running", "checking during an update leaves it intact");
  releaseUpdate();
  assert.equal((await settled(manager)).operation.status, "completed");
});

test("Homebrew detection proves the Caskroom prefix and only runs the matching brew", { skip: process.platform === "win32" }, async t => {
  const dir = await directory(t);
  const binary = await executable(join(dir, "Caskroom/codex/0.1.0/codex"));
  const info = await inspectCodex({ env: { CODEX_BIN: binary }, run: async (file, args) => args[0] === "--version" ? "codex-cli 0.1.0" : dir });
  assert.equal(info.source, "homebrew");
  let version = "0.1.0";
  const commands = [];
  const manager = createCliManager({ inspect: async () => ({ ...info, version }), latest: async () => "0.2.0", run: async (file, args) => { commands.push([file, args]); if (args[0] === "upgrade") version = "0.2.0"; } });
  await manager.update();
  assert.equal((await settled(manager)).operation.status, "completed");
  assert.deepEqual(commands, [[join(dir, "bin/brew"), ["update"]], [join(dir, "bin/brew"), ["upgrade", "--cask", "codex"]]]);
});

test("updates use fixed commands, stay busy, reject duplicates and refresh models only after effective version changes", async () => {
  let release, resets = 0;
  const { manager, setVersion } = mockManager({ run: async (file, args) => {
    assert.equal(file, "/prefix/bin/npm");
    assert.deepEqual(args, ["install", "--global", "--prefix", "/prefix", "@openai/codex@latest", "--registry=https://registry.npmjs.org"]);
    await new Promise(resolve => { release = resolve; });
    setVersion("0.2.0");
  }, onUpdated: async () => { resets++; } });
  const before = await manager.check();
  assert.equal(before.canUpdate, true);
  const running = await manager.update();
  assert.equal(running.operation.status, "running");
  assert.equal(running.canUpdate, false);
  await assert.rejects(manager.update(), /正在升级/);
  release();
  const done = await settled(manager);
  assert.equal(done.version, "0.2.0");
  assert.equal(done.operation.status, "completed");
  assert.equal(resets, 1);
});

test("offline check and ineffective upgrades cannot claim success; partial updates invalidate model trust", async () => {
  const offline = mockManager({ latest: async () => { throw new Error("secret registry token"); } }).manager;
  const state = await offline.check();
  assert.equal(state.canUpdate, false);
  assert.ok(!state.checkError.includes("secret"));
  const unchanged = mockManager({ run: async () => {} }).manager;
  await unchanged.update();
  assert.equal((await settled(unchanged)).operation.status, "failed");
  let resets = 0;
  const partial = mockManager({ run: async () => { partial.setVersion("0.1.5"); throw new Error("install failed"); }, onUpdated: async () => { resets++; } });
  await partial.manager.update();
  assert.equal((await settled(partial.manager)).operation.status, "failed");
  assert.equal(resets, 1);
});

test("subprocess failures redact stderr and terminate a hung process", async () => {
  await assert.rejects(runCliCommand(process.execPath, ["-e", 'console.error("SECRET_TOKEN");process.exit(1)']), error => !error.message.includes("SECRET_TOKEN"));
  await assert.rejects(runCliCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 30 }), /超时/);
});

test("CLI routes authenticate, reject command injection, serialize against tasks and lock every inference route", async t => {
  const dir = await directory(t);
  let releaseUpdate;
  const { manager: cli, setVersion } = mockManager({ run: async () => { await new Promise(resolve => { releaseUpdate = resolve; }); setVersion("0.2.0"); } });
  let modelBusy = true;
  const models = { get busy() { return modelBusy; }, selectedModel: null, close() {} };
  const app = await createBridge({ dataDir: dir, models, cli, compatibility, allowShutdown: true });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => { releaseUpdate?.(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Authorization: `Bearer ${app.token}`, "Content-Type": "application/json" };
  const post = (path, body = {}) => fetch(url + path, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await fetch(url + "/cli/status")).status, 401);
  assert.equal((await fetch(url + "/cli/status", { headers: { ...headers, Origin: "https://evil.test" } })).status, 403);
  assert.equal((await post("/cli/update", { command: "rm" })).status, 400);
  assert.equal((await post("/cli/update")).status, 409);
  modelBusy = false;
  assert.equal((await post("/cli/update")).status, 202);
  assert.equal((await (await fetch(url + "/health", { headers })).json()).cliBusy, true);
  for (const path of ["/jobs", "/models/verify", "/models/refresh", "/shutdown", "/cli/update"]) assert.equal((await post(path)).status, 409, path);
  assert.equal((await fetch(url + "/models", { headers })).status, 409);
  releaseUpdate();
  assert.equal((await settled(cli)).operation.status, "completed");
});

test("health stays responsive during CLI discovery and exposes the cached independent CLI state", async t => {
  const dir = await directory(t);
  let releaseDiscovery, checks = 0;
  const cli = createCliManager({ inspect: () => new Promise(resolve => { releaseDiscovery = resolve; }), latest: async () => { checks++; return "0.2.0"; } });
  const app = await createBridge({ dataDir: dir, cli, compatibility, models: { close() {} } });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const url = `http://127.0.0.1:${app.server.address().port}/health`;
  const headers = { Authorization: `Bearer ${app.token}` };
  const pending = await (await fetch(url, { headers })).json();
  assert.equal(pending.serviceReady, true);
  assert.equal(pending.skillReady, pending.ready);
  assert.equal(pending.cli, null);
  releaseDiscovery({ installed: true, version: "0.1.0", source: "custom", executable: "/custom/codex" });
  await tick();
  const ready = await (await fetch(url, { headers })).json();
  assert.equal(ready.cli.version, "0.1.0");
  assert.equal(ready.cli.updateAvailable, true);
  assert.equal(checks, 1);
  await fetch(url, { headers });
  assert.equal(checks, 1);
});

test("bridge upgrade wiring awaits model reset and resets sessions after refresh failure", { skip: process.platform === "win32" }, async t => {
  const dir = await directory(t);
  const prefix = join(dir, "fake-prefix"), bin = join(prefix, "bin");
  const packageRoot = join(prefix, "lib/node_modules/@openai/codex");
  const binary = await executable(join(packageRoot, "bin/codex.js"));
  const script = version => `#!${process.execPath}\nconsole.log('codex-cli ${version}');\n`;
  await writeFile(binary, script("0.1.0"));
  await mkdir(bin, { recursive: true });
  await symlink(binary, join(bin, "codex"));
  await symlink(process.execPath, join(bin, "node"));
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex" }));
  await writeFile(join(bin, "npm"), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nif (process.argv[2] === 'prefix') console.log(${JSON.stringify(prefix)}); else writeFileSync(${JSON.stringify(binary)}, ${JSON.stringify(script("0.2.0"))});\n`, { mode: 0o700 });
  const previous = process.env.CODEX_BIN, fetchOriginal = globalThis.fetch;
  process.env.CODEX_BIN = join(bin, "codex");
  t.after(() => { if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous; });
  t.mock.method(globalThis, "fetch", (url, options) => String(url).startsWith("https://registry.npmjs.org/")
    ? Promise.resolve({ ok: true, json: async () => ({ version: "0.2.0" }) }) : fetchOriginal(url, options));
  let rejectRefresh, resets = 0;
  const app = await createBridge({ dataDir: join(dir, "data"), compatibility, models: { reset: () => new Promise((_, reject) => { rejectRefresh = reject; }), close() {} },
    sessions: { resetReader() { resets++; }, close() {} } });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const url = `http://127.0.0.1:${app.server.address().port}`, headers = { Authorization: `Bearer ${app.token}`, "Content-Type": "application/json" };
  assert.equal((await fetch(url + "/cli/update", { method: "POST", headers, body: "{}" })).status, 202);
  for (let i = 0; i < 100 && !rejectRefresh; i++) await tick();
  assert.ok(rejectRefresh);
  assert.equal((await (await fetch(url + "/cli/status", { headers })).json()).operation.status, "running");
  rejectRefresh(new Error("catalog unavailable"));
  let result;
  for (let i = 0; i < 200; i++) {
    result = await (await fetch(url + "/cli/status", { headers })).json();
    if (result.operation.status !== "running") break;
    await tick();
  }
  assert.equal(result.operation.status, "failed");
  assert.equal(result.operation.stage, "Codex 已升级，复检未完成");
  assert.equal(resets, 1);
});

test("replacing a CLI at the same path invalidates existing account/model context", async t => {
  const dir = await directory(t);
  const file = await executable(join(dir, "codex"));
  const saved = process.env.CODEX_BIN;
  process.env.CODEX_BIN = file;
  try {
    const request = async method => method === "account/read" ? { account: { type: "apiKey" } } : { config: {} };
    const first = await readModelContext(request, dir);
    await writeFile(file, "changed CLI binary contents");
    const next = await readModelContext(request, dir);
    assert.notEqual(first.accountKey, next.accountKey);
  } finally { if (saved === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = saved; }
});

test("status checks updates in the background at most daily, including failed attempts", async () => {
  let attempts = 0, release, time = Date.now();
  const { manager } = mockManager({ now: () => time, latest: async () => {
    attempts++;
    await new Promise(resolve => { release = resolve; });
    throw new Error("offline");
  } });
  const initial = await manager.status();
  assert.equal(initial.latestVersion, null, "status returns while the network request is pending");
  assert.equal(attempts, 1);
  await manager.status();
  assert.equal(attempts, 1);
  release(); await tick();
  assert.match((await manager.status()).checkError, /检查更新失败/);
  time += 86_399_000;
  await manager.status();
  assert.equal(attempts, 1, "failures do not cause every polling request to retry");
  time += 1_001;
  await manager.status();
  assert.equal(attempts, 2);
  release(); await tick();
});

test("closing during the latest-version check cannot start a package manager afterwards", async () => {
  let release;
  const { manager, commands } = mockManager({ latest: () => new Promise(resolve => { release = resolve; }) });
  const pending = manager.update();
  await tick();
  manager.close();
  release("0.2.0");
  await assert.rejects(pending, /服务已停止/);
  assert.deepEqual(commands, []);
});

test("npm package upgrades invalidate model context even when the JS executable is unchanged", async t => {
  const dir = await directory(t);
  const root = join(dir, "lib/node_modules/@openai/codex");
  const binary = await executable(join(root, "bin/codex.js"));
  const saved = process.env.CODEX_BIN;
  process.env.CODEX_BIN = binary;
  const request = async method => method === "account/read" ? { account: { type: "apiKey" } } : { config: {} };
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.1.0" }));
    const before = await readModelContext(request, dir);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.2.0" }));
    assert.notEqual((await readModelContext(request, dir)).accountKey, before.accountKey);
  } finally { if (saved === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = saved; }
});
