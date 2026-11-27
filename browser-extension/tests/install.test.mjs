import test from "node:test";
import assert from "node:assert/strict";
import { execFile, fork, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { endianness, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge } from "../bridge/server.mjs";
import { EXTENSION_ID } from "../lib/extension-identity.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function installation(t, copyRoot = false) {
  const dir = await mkdtemp(join(tmpdir(), "alchemy install "));
  let installRoot = root;
  if (copyRoot) {
    installRoot = join(dir, "installation");
    await mkdir(join(installRoot, ".output/chrome-mv3"), { recursive: true });
    for (const path of ["package.json", "scripts", "bridge", "lib", ".agents", ".output/chrome-mv3/manifest.json"])
      await cp(join(root, path), join(installRoot, path), { recursive: true });
    await symlink(join(root, "node_modules"), join(installRoot, "node_modules"), "dir");
  }
  const codex = join(dir, "codex-test");
  await writeFile(codex, '#!/usr/bin/env node\nconsole.log("codex-cli test");\n', { mode: 0o700 });
  const env = { ...process.env, ALCHEMY_DATA_DIR: dir, ALCHEMY_PORT: String(await unusedPort()),
    ALCHEMY_APP_SUPPORT_DIR: join(dir, "app support"),
    CODEX_BIN: codex, CODEX_HOME: join(dir, "codex-home") };
  delete env.ALCHEMY_SKILL_PATH;
  const run = (command, ...args) => exec(process.execPath, [join(installRoot, "scripts/manage.mjs"), command, ...args], { env, timeout: 15000 });
  t.after(async () => { await run("stop").catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  return { dir, env, run, installRoot };
}

const nativeHostName = "com.qc.reframe";
const browserProfiles = { chrome: "Google/Chrome", codex: "OpenAI/Codex" };
const registrationPath = (env, browser) => join(env.ALCHEMY_APP_SUPPORT_DIR, browserProfiles[browser], "NativeMessagingHosts", `${nativeHostName}.json`);
function nativeFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const size = Buffer.alloc(4);
  size[endianness() === "LE" ? "writeUInt32LE" : "writeUInt32BE"](body.length);
  return Buffer.concat([size, body]);
}
async function registeredLauncher(t) {
  const installationState = await installation(t, true);
  installationState.env.ALCHEMY_EXTENSION_ID = "b".repeat(32);
  await installationState.run("native-install", "codex");
  const manifestPath = registrationPath(installationState.env, "codex");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return { ...installationState, manifestPath, manifest };
}
async function nativeRequest(installationState, { origin = `chrome-extension://${"b".repeat(32)}/`, bytes = nativeFrame({ action: "ensure-start" }), fragment = false, env = installationState.env } = {}) {
  const child = spawn(installationState.manifest.path, [origin], { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
  const output = [], errors = [];
  child.stdout.on("data", data => output.push(data));
  child.stderr.on("data", data => errors.push(data));
  child.stdin.on("error", () => {}); // A rejected caller can close before consuming its request.
  const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
  try {
    if (fragment) {
      for (const part of [bytes.subarray(0, 2), bytes.subarray(2, 7), bytes.subarray(7)]) {
        child.stdin.write(part); await new Promise(resolve => setTimeout(resolve, 10));
      }
      child.stdin.end();
    } else child.stdin.end(bytes);
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null, "native host must exit within its own bounded lifetime");
    const buffer = Buffer.concat(output);
    assert.ok(buffer.length >= 4, `native host should return one framed response (exit ${code}, stderr ${Buffer.concat(errors).toString()})`);
    const length = buffer[endianness() === "LE" ? "readUInt32LE" : "readUInt32BE"](0);
    assert.equal(length, buffer.length - 4, "stdout must contain exactly one JSON frame and no command logs");
    return JSON.parse(buffer.subarray(4).toString("utf8"));
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
}
// Another installation that still exists: its registered launcher file is on disk.
async function liveForeignRegistration(f) {
  const launcher = join(f.dir, "another install/runtime/native-launcher");
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(launcher, "#!/bin/sh\n# QC-Reframe installation: \"/another-install\"\n", { mode: 0o700 });
  return JSON.stringify({ name: nativeHostName, type: "stdio", path: launcher, allowed_origins: [] });
}

test("user registers and removes only their own Codex launcher without touching project data", { skip: process.platform === "win32" }, async t => {
  // Given a spaced installation path, When installing twice, Then the host has exact allowed origins and a runnable path.
  const f = await registeredLauncher(t);
  const before = await readFile(f.manifestPath, "utf8");
  await f.run("native-install", "codex");
  assert.equal(await readFile(f.manifestPath, "utf8"), before);
  assert.equal(f.manifest.name, nativeHostName);
  assert.equal(f.manifest.type, "stdio");
  assert.equal(f.manifest.path, resolve(f.manifest.path));
  assert.ok((await stat(f.manifest.path)).mode & 0o100);
  assert.deepEqual(new Set(f.manifest.allowed_origins), new Set([`chrome-extension://${EXTENSION_ID}/`, `chrome-extension://${"b".repeat(32)}/`]));
  const preserved = join(f.dir, "project-keep.json");
  await writeFile(preserved, '{"keep":true}');
  await f.run("native-uninstall", "codex");
  await assert.rejects(readFile(f.manifestPath), { code: "ENOENT" });
  await assert.rejects(readFile(f.manifest.path), { code: "ENOENT" });
  assert.equal(await readFile(preserved, "utf8"), '{"keep":true}');
  await f.run("native-uninstall", "codex");
});

for (const artifact of ["launcher", "manifest"]) test(`user retains the valid native ${artifact} when a registration update write fails`, { skip: process.platform === "win32" }, async t => {
  // Given an owned, valid registration, fail after a partial filesystem write during an update.
  const f = await registeredLauncher(t), target = artifact === "launcher" ? f.manifest.path : f.manifestPath;
  const before = await readFile(target, "utf8"), entries = await readdir(dirname(target));
  const fault = join(f.dir, "fail-native-write.mjs");
  await writeFile(fault, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const write = fs.promises.writeFile;
fs.promises.writeFile = async (path, data, options) => {
  const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString() : "";
  let manifest = false; try { manifest = JSON.parse(text).name === "com.qc.reframe"; } catch {}
  if (${JSON.stringify(artifact)} === "launcher" ? text.startsWith("#!/bin/sh\\n# QC-Reframe installation:") : manifest) {
    await write(path, text.slice(0, Math.max(1, text.length >> 1)), options);
    throw Object.assign(new Error("INJECTED_NATIVE_WRITE_FAILURE"), { code: "EIO" });
  }
  return write(path, data, options);
};
syncBuiltinESMExports();
`);
  f.env.ALCHEMY_EXTENSION_ID = "c".repeat(32);
  await assert.rejects(exec(process.execPath, ["--import", fault, join(f.installRoot, "scripts/manage.mjs"), "native-install", "codex"], { env: f.env, timeout: 15000 }), error => /INJECTED_NATIVE_WRITE_FAILURE/.test(error.stderr));
  // Then the previous file remains complete, temporary writes are removed, and a normal retry recovers.
  assert.equal(await readFile(target, "utf8"), before);
  assert.deepEqual(await readdir(dirname(target)), entries);
  await f.run("native-install", "codex");
  assert.ok(JSON.parse(await readFile(f.manifestPath, "utf8")).allowed_origins.includes(`chrome-extension://${"c".repeat(32)}/`));
});

for (const registration of ["foreign", "empty", "invalid"]) test(`user cannot overwrite or uninstall an unowned ${registration} native host registration`, { skip: process.platform === "win32" }, async t => {
  const f = await installation(t, true);
  const path = registrationPath(f.env, "codex");
  await mkdir(dirname(path), { recursive: true });
  const foreign = registration === "empty" ? "" : registration === "invalid" ? "{" : await liveForeignRegistration(f);
  await writeFile(path, foreign);
  for (const command of ["native-install", "native-uninstall"]) {
    await assert.rejects(f.run(command, "codex"), error => /其他|另一|属于|冲突/.test(error.stderr));
    assert.equal(await readFile(path, "utf8"), foreign);
  }
});

test("user opens concurrent windows and the registered launcher starts one service without CLI probes", { skip: process.platform === "win32" }, async t => {
  const f = await registeredLauncher(t), cliMarker = join(f.dir, "cli-called");
  await writeFile(f.env.CODEX_BIN, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(cliMarker)}, 'called'); process.exit(99);\n`, { mode: 0o700 });
  // A browser may have no shell PATH or may inherit unrelated configuration; the installed launcher owns its location.
  const browserEnv = { ...f.env, PATH: "", ALCHEMY_DATA_DIR: join(f.dir, "wrong-data"), ALCHEMY_PORT: String(await unusedPort()) };
  const results = await Promise.all([nativeRequest(f, { fragment: true, env: browserEnv }), nativeRequest(f, { env: browserEnv }), nativeRequest(f, { env: browserEnv })]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
  await assert.rejects(readFile(cliMarker), { code: "ENOENT" });
  const health = JSON.parse((await f.run("status")).stdout);
  const token = (await readFile(join(f.dir, "config/token"), "utf8")).trim();
  assert.equal(health.service, "qc-alchemy");
  assert.equal(health.managed, true);
  assert.deepEqual(await nativeRequest(f), { ok: true });
  assert.equal(JSON.parse((await f.run("status")).stdout).instanceId, health.instanceId);
  assert.equal((await readFile(join(f.dir, "config/token"), "utf8")).trim(), token);
  assert.ok(!JSON.stringify(results).includes(token));
  await f.run("native-uninstall", "codex");
  assert.equal(JSON.parse((await f.run("status")).stdout).instanceId, health.instanceId);
});

for (const scenario of ["foreign-origin", "extra-command", "unknown-action", "bad-json", "oversize", "partial-eof"]) test(`user remains offline when the native host receives ${scenario}`, { skip: process.platform === "win32" }, async t => {
  const f = await registeredLauncher(t), request = {};
  if (scenario === "foreign-origin") request.origin = `chrome-extension://${"c".repeat(32)}/`;
  if (scenario === "extra-command") request.bytes = nativeFrame({ action: "ensure-start", command: "echo bad" });
  if (scenario === "unknown-action") request.bytes = nativeFrame({ action: "restart" });
  if (scenario === "bad-json") { request.bytes = nativeFrame("invalid"); request.bytes[4] = 0; }
  if (scenario === "oversize") {
    request.bytes = Buffer.alloc(4);
    request.bytes[endianness() === "LE" ? "writeUInt32LE" : "writeUInt32BE"](1024 * 1024);
  }
  if (scenario === "partial-eof") request.bytes = nativeFrame({ action: "ensure-start" }).subarray(0, 7);
  const response = await nativeRequest(f, request);
  assert.equal(response.ok, false);
  assert.equal(typeof response.error, "string");
  await assert.rejects(f.run("status"), error => /未运行/.test(error.stdout));
  await assert.rejects(readFile(join(f.dir, "config/token")), { code: "ENOENT" });
});

test("user receives a bounded error for an occupied port or held startup lock without replacing anything", { skip: process.platform === "win32" }, async t => {
  const f = await registeredLauncher(t);
  const other = createServer((_request, response) => { response.writeHead(401); response.end("occupied"); });
  other.listen(Number(f.env.ALCHEMY_PORT), "127.0.0.1"); await once(other, "listening");
  try {
    const result = await nativeRequest(f);
    assert.equal(result.ok, false);
    assert.match(result.error, /占用/);
    assert.equal((await fetch(`http://127.0.0.1:${f.env.ALCHEMY_PORT}/health`)).status, 401);
  } finally { await new Promise(resolve => other.close(resolve)); }
  await mkdir(join(f.dir, "runtime/start.lock"), { recursive: true });
  const blocked = await nativeRequest(f);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /启动|锁|超时/);
  await assert.rejects(f.run("status"), error => /未运行/.test(error.stdout));
});

for (const via of ["start", "launcher"]) test(`user upgrades in place and ${via === "start" ? "npm start" : "opening Reframe"} replaces the older running service`, { skip: process.platform === "win32" }, async t => {
  // Given this installation's managed service is running when its files are upgraded to a newer version.
  const f = await registeredLauncher(t);
  await f.run("start");
  const before = JSON.parse((await f.run("status")).stdout);
  const token = (await readFile(join(f.dir, "config/token"), "utf8")).trim();
  const newer = "99.0.0";
  for (const file of ["package.json", ".output/chrome-mv3/manifest.json"]) {
    const path = join(f.installRoot, file);
    await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), version: newer }, null, 2) + "\n");
  }
  // When the user starts the service again, or opens Reframe and the launcher wakes it.
  if (via === "start") assert.match((await f.run("start")).stdout, new RegExp(`停止旧版本服务 ${before.version.replaceAll(".", "\\.")}`));
  else assert.deepEqual(await nativeRequest(f), { ok: true });
  // Then the new version runs as a fresh managed instance and keeps the pairing.
  const after = JSON.parse((await f.run("status")).stdout);
  assert.equal(after.version, newer);
  assert.equal(after.managed, true);
  assert.notEqual(after.instanceId, before.instanceId);
  assert.equal((await readFile(join(f.dir, "config/token"), "utf8")).trim(), token);
});

for (const scenario of ["busy", "terminal"]) test(`user's older ${scenario === "busy" ? "service running a task" : "terminal-started service"} keeps running when start cannot replace it`, { skip: process.platform === "win32" }, async t => {
  // Given an older QC-Reframe service on this installation's port that is mid-task, or was started from a terminal.
  const f = await installation(t, true);
  const calls = [];
  const old = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") return response.end(JSON.stringify({ service: "qc-alchemy", version: "0.0.1", ready: true, managed: scenario === "busy" }));
    if (request.method === "POST" && request.url === "/shutdown") {
      response.statusCode = 409;
      return response.end(JSON.stringify({ error: "任务或 Agent CLI 安装更新执行中，请等待完成后再停止服务。" }));
    }
    response.statusCode = 404; response.end("{}");
  });
  old.listen(Number(f.env.ALCHEMY_PORT), "127.0.0.1"); await once(old, "listening");
  try {
    // When the user starts the current version, Then start fails with the reason and the old service is untouched.
    await assert.rejects(f.run("start"), error => scenario === "busy"
      ? /旧版本服务 0\.0\.1 未停止.*执行中/.test(error.stderr)
      : /已运行 0\.0\.1.*原终端/.test(error.stderr));
    assert.equal(calls.includes("POST /shutdown"), scenario === "busy");
    assert.equal((await fetch(`http://127.0.0.1:${f.env.ALCHEMY_PORT}/health`)).status, 200);
    await assert.rejects(stat(join(f.dir, "runtime/start.lock")), { code: "ENOENT" });
  } finally { await new Promise(resolve => old.close(resolve)); }
});

test("user approves their separately loaded extension during setup and reconnects after restart without a code", { skip: process.platform === "win32" }, async t => {
  // Given a fixed browser extension ID approved by the local installer; npm is stubbed to avoid rebuilding shared files.
  const { dir, env, run } = await installation(t);
  env.ALCHEMY_EXTENSION_ID = "b".repeat(32);
  env.npm_execpath = join(dir, "npm-stub.mjs");
  await writeFile(env.npm_execpath, "process.exit(0);\n");
  await run("setup");
  const config = JSON.parse(await readFile(join(dir, "config/runtime.json"), "utf8"));
  assert.equal(config.ALCHEMY_EXTENSION_ID, env.ALCHEMY_EXTENSION_ID);
  delete env.ALCHEMY_EXTENSION_ID;
  // When the service starts and restarts using persisted runtime configuration.
  const tokens = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = await run("start");
    assert.match(started.stdout, /自动连接/);
    const response = await fetch(`http://127.0.0.1:${env.ALCHEMY_PORT}/connection`, { method: "POST",
      headers: { Origin: `chrome-extension://${config.ALCHEMY_EXTENSION_ID}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200);
    tokens.push((await response.json()).token);
    assert.ok(!started.stdout.includes(tokens.at(-1)));
    await run("stop");
  }
  // Then the previously approved extension connects both times using the same private credential.
  assert.equal(tokens[0], tokens[1]);
  assert.equal((await readFile(join(dir, "config/token"), "utf8")).trim(), tokens[0]);
});

async function setupWithStubbedNpm(t, { prebuilt = false } = {}) {
  const f = await installation(t, true);
  const calls = join(f.dir, "npm-calls.jsonl");
  f.env.npm_execpath = join(f.dir, "npm-stub.cjs");
  await writeFile(f.env.npm_execpath, `require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  if (prebuilt) await writeFile(join(f.installRoot, "runtime-package.json"), "{}\n");
  const npmCalls = async () => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { ...f, npmCalls };
}

test("user runs setup and the launcher is registered for each installed browser only", { skip: process.platform === "win32" }, async t => {
  // Given Chrome has a profile on this machine and Codex has never been opened.
  const f = await setupWithStubbedNpm(t);
  await mkdir(join(f.env.ALCHEMY_APP_SUPPORT_DIR, browserProfiles.chrome), { recursive: true });
  // When setup runs.
  const { stdout } = await f.run("setup");
  // Then Chrome can wake the service for the fixed extension ID, and no Codex folder is created.
  const manifest = JSON.parse(await readFile(registrationPath(f.env, "chrome"), "utf8"));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.ok((await stat(manifest.path)).mode & 0o100);
  await assert.rejects(stat(join(f.env.ALCHEMY_APP_SUPPORT_DIR, browserProfiles.codex)), { code: "ENOENT" });
  assert.match(stdout, /Chrome 本机启动器已注册/);
  assert.doesNotMatch(stdout, /Codex 本机启动器/);
  assert.match(stdout, new RegExp(`加载 .*${f.installRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("user's setup still completes when another installation owns the browser launcher", { skip: process.platform === "win32" }, async t => {
  // Given Chrome's launcher registration belongs to another installation that still exists.
  const f = await setupWithStubbedNpm(t);
  const path = registrationPath(f.env, "chrome");
  await mkdir(dirname(path), { recursive: true });
  const foreign = await liveForeignRegistration(f);
  await writeFile(path, foreign);
  // When setup runs, Then it finishes, says why Chrome was skipped, and leaves the other registration alone.
  const { stdout } = await f.run("setup");
  assert.match(stdout, /Chrome 本机启动器未注册：.*另一份安装/);
  assert.match(stdout, /初始化完成/);
  assert.equal(await readFile(path, "utf8"), foreign);
  assert.ok(JSON.parse(await readFile(join(f.dir, "config/runtime.json"), "utf8")));
});

test("user whose earlier installation folder was deleted gets the browser launcher back on setup", { skip: process.platform === "win32" }, async t => {
  // Given Chrome's launcher registration still points into an installation folder that no longer exists.
  const f = await setupWithStubbedNpm(t);
  const path = registrationPath(f.env, "chrome");
  await mkdir(dirname(path), { recursive: true });
  const dead = JSON.stringify({ name: nativeHostName, type: "stdio", path: join(f.dir, "deleted install/.local/runtime/native-launcher"), allowed_origins: [`chrome-extension://${"d".repeat(32)}/`] });
  await writeFile(path, dead);
  // When this installation is asked to remove it, Then the registration is not its own and stays.
  await assert.rejects(f.run("native-uninstall", "chrome"), error => /另一份安装/.test(error.stderr));
  assert.equal(await readFile(path, "utf8"), dead);
  // When setup runs, Then Chrome wakes this installation for the fixed extension instead.
  const { stdout } = await f.run("setup");
  assert.match(stdout, /Chrome 本机启动器已注册/);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.ok((await stat(manifest.path)).mode & 0o100);
  assert.match(await readFile(manifest.path, "utf8"), new RegExp(f.installRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("user removes the Chrome launcher and Codex keeps waking the same installation", { skip: process.platform === "win32" }, async t => {
  // Given both browsers registered by this installation.
  const f = await registeredLauncher(t);
  await f.run("native-install", "chrome");
  const chrome = registrationPath(f.env, "chrome");
  assert.equal(JSON.parse(await readFile(chrome, "utf8")).path, f.manifest.path);
  // When Chrome's launcher is removed, Then Codex's registration and the shared executable remain.
  await f.run("native-uninstall", "chrome");
  await assert.rejects(readFile(chrome), { code: "ENOENT" });
  assert.ok((await stat(f.manifest.path)).mode & 0o100);
  assert.deepEqual(await nativeRequest(f), { ok: true });
  // And removing the last registration also removes the executable.
  await f.run("native-uninstall", "codex");
  await assert.rejects(readFile(f.manifest.path), { code: "ENOENT" });
});

test("user installing the release runtime package gets runtime dependencies without a rebuild", { skip: process.platform === "win32" }, async t => {
  // Given an installation that came from the prebuilt release package.
  const f = await setupWithStubbedNpm(t, { prebuilt: true });
  // When setup runs, Then npm only installs runtime dependencies, without dev tools or install scripts.
  await f.run("setup");
  assert.deepEqual(await f.npmCalls(), [["ci", "--omit=dev", "--ignore-scripts"]]);
});

test("user setting up from a source checkout still installs and builds", { skip: process.platform === "win32" }, async t => {
  const f = await setupWithStubbedNpm(t);
  await f.run("setup");
  assert.deepEqual(await f.npmCalls(), [["ci"], ["run", "build"]]);
});

test("user mistypes an approved extension ID and setup preserves existing runtime configuration", { skip: process.platform === "win32" }, async t => {
  // Given existing private configuration, when an installer supplies an invalid allowlist ID.
  const { dir, env, run } = await installation(t);
  const saved = JSON.stringify({ CODEX_BIN: env.CODEX_BIN, ALCHEMY_EXTENSION_ID: "b".repeat(32) });
  await mkdir(join(dir, "config"));
  await writeFile(join(dir, "config/runtime.json"), saved);
  env.ALCHEMY_EXTENSION_ID = "*";
  await assert.rejects(run("setup"), error => /ALCHEMY_EXTENSION_ID/.test(error.stderr));
  // Then setup refuses before replacing the valid configuration or issuing a credential.
  assert.equal(await readFile(join(dir, "config/runtime.json"), "utf8"), saved);
  await assert.rejects(readFile(join(dir, "config/token")), { code: "ENOENT" });
  delete env.ALCHEMY_EXTENSION_ID;
});

test("bundled Alchemy runs without author's external files and has no dangling runtime references", async () => {
  const skillRoot = join(root, ".agents/skills/alchemy");
  const files = ["SKILL.md", ...(await readdir(join(skillRoot, "references"))).map(name => `references/${name}`)];
  assert.ok(!files.some(file => /source-index|casebook|evidence/.test(file)));
  for (const file of files) {
    const text = await readFile(join(skillRoot, file), "utf8");
    assert.ok(!/\/Users\/qiaochao|Xiaohongshu_Style_Extraction/.test(text));
    for (const [, link] of text.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g))
      if (!link.startsWith("https://")) await readFile(resolve(skillRoot, dirname(file), link));
  }
});

test("fresh local service starts detached, reuses pairing, stops and restarts without data loss", { skip: process.platform === "win32" }, async t => {
  const { dir, run } = await installation(t);
  const doctor = (await run("doctor")).stdout;
  assert.match(doctor, /Alchemy skill：就绪/);
  assert.doesNotMatch(doctor, /imagegen|IMAGEGEN_SKILL_PATH/, "built-in generation no longer depends on the imagegen skill");
  assert.match((await run("start")).stdout, /后台启动/);
  for (const directory of ["config", "records", "images", "logs", "runtime"]) assert.ok((await readdir(dir)).includes(directory));
  for (const file of ["token", "bridge.log", "model-settings.json", "runtime.json", "start.lock"]) assert.ok(!(await readdir(dir)).includes(file));
  const firstToken = (await readFile(join(dir, "config", "token"), "utf8")).trim();
  await writeFile(join(dir, "preserved-note.txt"), "user data");
  const again = await run("start");
  assert.match(again.stdout, /复用/);
  assert.ok(!again.stdout.includes(firstToken));
  assert.equal((await run("pair")).stdout.trim(), firstToken);
  const health = JSON.parse((await run("status")).stdout);
  assert.equal(health.version, JSON.parse(await readFile(join(root, "package.json"), "utf8")).version);
  assert.equal(health.service, "qc-alchemy");
  assert.equal(health.ready, true);
  assert.equal(health.managed, true);
  assert.ok(!(await readFile(join(dir, "logs", "bridge.log"), "utf8")).includes(firstToken));
  await run("stop");
  await assert.rejects(run("status"));
  await run("start");
  assert.equal((await readFile(join(dir, "config", "token"), "utf8")).trim(), firstToken);
  assert.equal(await readFile(join(dir, "preserved-note.txt"), "utf8"), "user data");
});

test("updated manager controls an old running service without moving data, then migrates on restart", { skip: process.platform === "win32" }, async t => {
  const { dir, env, run } = await installation(t);
  const token = "legacy-pairing";
  const version = JSON.parse(await readFile(join(root, "package.json"))).version;
  await writeFile(join(dir, "token"), token);
  await writeFile(join(dir, "runtime.json"), JSON.stringify({ CODEX_BIN: env.CODEX_BIN }));
  await writeFile(join(dir, "model-settings.json"), JSON.stringify({ model: "saved-model", accountKey: "test" }));
  const old = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/shutdown") {
      res.end('{"stopped":true}', () => { old.close(); old.closeIdleConnections(); });
      return;
    }
    res.end(JSON.stringify({ service: "qc-alchemy", version, ready: true, managed: true, active: 0 }));
  });
  old.listen(Number(env.ALCHEMY_PORT), "127.0.0.1");
  await once(old, "listening");
  t.after(() => { old.closeAllConnections(); old.close(); });
  assert.match((await run("start")).stdout, /复用/);
  assert.equal((await run("pair")).stdout.trim(), token);
  assert.equal(JSON.parse((await run("status")).stdout).ready, true);
  assert.ok(!(await readdir(dir)).includes("config"));
  await run("stop");
  await run("start");
  assert.equal((await run("pair")).stdout.trim(), token);
  assert.equal(JSON.parse((await run("status")).stdout).model, "saved-model");
  for (const file of ["token", "runtime.json", "model-settings.json"]) {
    await readFile(join(dir, "config", file));
    await assert.rejects(readFile(join(dir, file)), { code: "ENOENT" });
  }
});

test("startup refuses an unrelated listener without changing its files or stopping it", { skip: process.platform === "win32" }, async t => {
  const { dir, env, run } = await installation(t);
  const other = createServer((req, res) => { res.writeHead(401); res.end("other service"); });
  other.listen(Number(env.ALCHEMY_PORT), "127.0.0.1");
  await once(other, "listening");
  t.after(() => { other.closeAllConnections(); other.close(); });
  await assert.rejects(run("start"), error => /已被其他服务/.test(error.stderr));
  assert.ok(other.listening);
  assert.ok(!(await readdir(dir)).includes("token"));
});

test("doctor stays strict while startup permits managing missing and logged-out CLI", { skip: process.platform === "win32" }, async t => {
  const { env, run } = await installation(t);
  await writeFile(env.CODEX_BIN, '#!/usr/bin/env node\nconsole.log("not a compatible tool");\n');
  await assert.rejects(run("doctor"), error => /找不到 Codex CLI/.test(error.stderr));
  await writeFile(env.CODEX_BIN, '#!/usr/bin/env node\nconsole.log("codex-cli test");if(process.argv[2]==="login")process.exit(1);\n');
  await assert.rejects(run("doctor"), error => /尚未登录/.test(error.stderr));
  assert.match((await run("start")).stderr, /CLI 待处理/);
  assert.equal(JSON.parse((await run("status")).stdout).ready, true);
  await run("stop");
  await rm(env.CODEX_BIN);
  assert.match((await run("start")).stderr, /找不到 Codex CLI/);
  assert.equal(JSON.parse((await run("status")).stdout).ready, true);
});

for (const issue of ["missing", "logged-out", "old"]) test(`fresh setup builds with ${issue} CLI and preserves its configured path and user data`, { skip: process.platform === "win32" }, async t => {
  const { dir, env, run, installRoot } = await installation(t, true);
  await rm(join(installRoot, ".output"), { recursive: true });
  env.CODEX_BIN = join(dir, "user's codex $(unused)");
  if (issue !== "missing") await writeFile(env.CODEX_BIN, `#!/usr/bin/env node\nconsole.log("codex-cli 0.1.0");if(process.argv[2]===${JSON.stringify(issue === "logged-out" ? "login" : "app-server")})process.exit(1);\n`, { mode: 0o700 });
  const error = issue === "missing" ? /找不到 Codex CLI/ : issue === "logged-out" ? /尚未登录/ : /不支持 app-server/;
  await assert.rejects(run("doctor"), result => error.test(result.stderr));
  env.npm_execpath = join(dir, "fake-npm.mjs");
  await writeFile(env.npm_execpath, `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
appendFileSync('npm-calls.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'run') {
  mkdirSync('.output/chrome-mv3', { recursive: true });
  writeFileSync('.output/chrome-mv3/manifest.json', JSON.stringify({ version: JSON.parse(readFileSync('package.json')).version }));
}
`);
  await mkdir(join(dir, "config"), { recursive: true });
  await writeFile(join(dir, "config/token"), "preserved-pairing");
  await writeFile(join(dir, "preserved-note.txt"), "user data");
  const result = await run("setup");
  assert.match(result.stderr, error);
  assert.match(result.stderr, /扩展自动连接后.*插件模型/);
  const quoted = `'${env.CODEX_BIN.replaceAll("'", "'\"'\"'")}'`;
  assert.ok(result.stderr.includes(issue === "logged-out" ? `${quoted} login` : issue === "old" ? `${quoted} --version` : quoted));
  assert.deepEqual((await readFile(join(installRoot, "npm-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)), [["ci"], ["run", "build"]]);
  assert.equal(JSON.parse(await readFile(join(dir, "config/runtime.json"), "utf8")).CODEX_BIN, env.CODEX_BIN);
  assert.match((await run("start")).stdout, /后台启动/);
  assert.equal((await run("pair")).stdout.trim(), "preserved-pairing");
  assert.equal(await readFile(join(dir, "preserved-note.txt"), "utf8"), "user data");
});

for (const issue of ["node", "skill"]) test(`maintenance setup still rejects invalid ${issue} before invoking npm`, { skip: process.platform === "win32" }, async t => {
  const { dir, env, run } = await installation(t);
  env.npm_execpath = join(dir, "npm-must-not-run.mjs");
  await writeFile(env.npm_execpath, 'throw new Error("npm must not run");');
  if (issue === "skill") {
    env.ALCHEMY_SKILL_PATH = join(dir, "invalid-skill.md");
    await writeFile(env.ALCHEMY_SKILL_PATH, "name: wrong-skill");
  } else {
    const preload = join(dir, "old-node.cjs");
    await writeFile(preload, 'Object.defineProperty(process.versions, "node", { value: "22.14.0" });');
    env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  }
  await assert.rejects(run("setup"), result => (issue === "skill" ? /Alchemy skill 缺失或名称不匹配/ : /需要 Node.js 22.15/).test(result.stderr) && !result.stderr.includes("npm must not run"));
});

test("managed shutdown requires authentication and refuses while a model task is active", async t => {
  const dir = await mkdtemp(join(tmpdir(), "alchemy-shutdown-"));
  await writeFile(join(dir, "model-settings.json"), JSON.stringify({ model: "test-model", accountKey: "test" }));
  let finish;
  const app = await createBridge({ dataDir: dir, allowShutdown: true, restart: () => assert.fail("busy task must block restart"), agent: () => new Promise(resolve => { finish = resolve; }) });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Authorization: `Bearer ${app.token}`, "Content-Type": "application/json" };
  t.after(async () => { app.server.closeAllConnections(); app.server.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal((await fetch(`${url}/shutdown`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${url}/shutdown`, { method: "POST", headers: { ...headers, Origin: "https://example.com" } })).status, 403);
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=";
  const job = await fetch(`${url}/jobs`, { method: "POST", headers, body: JSON.stringify({ image, mode: "style" }) });
  assert.equal(job.status, 202);
  assert.equal((await fetch(`${url}/shutdown`, { method: "POST", headers })).status, 409);
  assert.equal((await fetch(`${url}/restart`, { method: "POST", headers })).status, 409);
  finish({ title: "test", observations: [], promptZh: "test", promptEn: "test", negativePrompt: "", uncertainties: [] });
  for (let i = 0; i < 100; i++) {
    if (!(await (await fetch(`${url}/health`, { headers })).json()).active) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const closed = once(app.server, "close");
  assert.equal((await fetch(`${url}/shutdown`, { method: "POST", headers })).status, 200);
  await closed;
});

test("plugin restart launches a new process on the same port with pairing, project inputs and runtime configuration intact", async t => {
  const { dir, env, run } = await installation(t);
  await run('start');
  const token = (await readFile(join(dir, 'config/token'), 'utf8')).trim();
  const url = `http://127.0.0.1:${env.ALCHEMY_PORT}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (path, body) => {
    const res = await fetch(url + path, { headers, method: body ? 'POST' : 'GET', body: body && JSON.stringify(body) });
    assert.equal(res.ok, true); return res.json();
  };
  const before = await call('/health');
  assert.equal(before.canRestart, true);
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=';
  const project = await call('/projects', { image });
  await call(`/projects/${project.id}/input`, { expectedRevision: 0, mode: 'style', instruction: 'saved input', subjectImage: image });
  const reference = await call(`/projects/${project.id}/reference`);
  const ticket = await call('/restart', {});
  let after;
  for (let i = 0; i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      const response = await fetch(`${url}/health`, { headers, signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (health.restartId === ticket.restartId) { after = health; break; }
    } catch {}
  }
  assert.ok(after, 'replacement service must become ready');
  assert.notEqual(after.instanceId, before.instanceId);
  assert.equal(after.ready, true);
  assert.equal(after.managed, true);
  assert.equal((await readFile(join(dir, 'config/token'), 'utf8')).trim(), token);
  assert.deepEqual(await call(`/projects/${project.id}/reference`), reference);
  const cli = await call('/cli/status');
  assert.equal(cli.executable, env.CODEX_BIN, 'custom runtime configuration survives the new process');
});


for (const failure of ['missing-build', 'mismatched-build', 'missing-skill-reference', 'startup-lock', 'legacy-lock']) {
  test(`restart preflight keeps the old ready instance when ${failure}`, async t => {
    const { dir, env, run, installRoot } = await installation(t, true);
    await run('start');
    const headers = { Authorization: `Bearer ${(await readFile(join(dir, 'config/token'), 'utf8')).trim()}` };
    const url = `http://127.0.0.1:${env.ALCHEMY_PORT}`;
    const health = async () => (await fetch(`${url}/health`, { headers })).json();
    const before = await health();
    const manifest = join(installRoot, '.output/chrome-mv3/manifest.json');
    if (failure === 'missing-build') await rm(manifest);
    if (failure === 'mismatched-build') await writeFile(manifest, JSON.stringify({ version: '0.0.0' }));
    if (failure === 'missing-skill-reference') {
      const skill = join(installRoot, '.agents/skills/alchemy/SKILL.md');
      await writeFile(skill, await readFile(skill, 'utf8') + '\n[Required](references/missing-test.md)\n');
    }
    const lock = join(dir, failure === 'legacy-lock' ? 'start.lock' : 'runtime/start.lock');
    if (failure.endsWith('lock')) await mkdir(lock);
    const response = await fetch(`${url}/restart`, { method: 'POST', headers });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /准备失败.*原服务仍在运行/);
    const after = await health();
    assert.equal(after.ready, true);
    assert.equal(after.instanceId, before.instanceId);
    if (failure.endsWith('lock')) assert.deepEqual(await readdir(lock), [], 'pre-existing locks are retained');
    if (failure !== 'startup-lock') assert.ok(!(await readdir(join(dir, 'runtime'))).includes('start.lock'), 'no new lock remains');
  });
}

for (const cancel of ['disconnect', 'SIGTERM', 'timeout']) {
  test(`prepared restart releases its lock after ${cancel}, with the old instance untouched`, async t => {
    const { dir, env, run } = await installation(t);
    await run('start');
    const before = JSON.parse((await run('status')).stdout);
    const manager = fork(join(root, 'scripts/manage.mjs'), ['restart-after', before.instanceId], {
      execArgv: [], env: { ...env, ALCHEMY_RESTART_ID: 'cancel-test' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    t.after(() => { if (manager.exitCode === null) manager.kill(); });
    const exited = once(manager, 'exit');
    assert.equal((await once(manager, 'message'))[0], 'ready');
    assert.deepEqual(await readdir(join(dir, 'runtime/start.lock')), []);
    if (cancel === 'disconnect') manager.disconnect();
    if (cancel === 'SIGTERM') manager.kill();
    await exited;
    assert.ok(!(await readdir(join(dir, 'runtime'))).includes('start.lock'));
    const after = JSON.parse((await run('status')).stdout);
    assert.equal(after.ready, true);
    assert.equal(after.instanceId, before.instanceId);
  });
}
