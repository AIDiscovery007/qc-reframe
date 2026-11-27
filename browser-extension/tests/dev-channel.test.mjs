import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { endianness, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge } from "../bridge/server.mjs";
import { connectionOrigins } from "../bridge/connection.mjs";
import { buildChannel, channels, serviceChannel } from "../lib/channel.mjs";
import { startCommand } from "../lib/start-command.ts";
import wxtConfig from "../wxt.config.ts";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const idFromKey = key => createHash("sha256").update(Buffer.from(key, "base64"))
  .digest("hex").slice(0, 32).replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)));
const origin = id => `chrome-extension://${id}`;

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

// One Native Messaging exchange with a registered launcher, as the browser performs it for the given extension.
async function launch(path, id) {
  const child = spawn(path, [`${origin(id)}/`], { cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"] });
  const output = [];
  child.stdout.on("data", data => output.push(data));
  child.stdin.on("error", () => {});
  const body = Buffer.from(JSON.stringify({ action: "ensure-start" }));
  const size = Buffer.alloc(4);
  size[endianness() === "LE" ? "writeUInt32LE" : "writeUInt32BE"](body.length);
  child.stdin.end(Buffer.concat([size, body]));
  await once(child, "close");
  return JSON.parse(Buffer.concat(output).subarray(4).toString());
}

// A copied installation with both builds' manifests, a fake Codex CLI and isolated launcher folders.
async function checkout(t, { runtimePackage = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "reframe dev channel "));
  const installRoot = join(dir, "installation");
  for (const path of ["package.json", "scripts", "bridge", "lib", ".agents"])
    await cp(join(root, path), join(installRoot, path), { recursive: true });
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  for (const channel of Object.values(channels)) {
    await mkdir(join(installRoot, channel.outputDir), { recursive: true });
    await writeFile(join(installRoot, channel.outputDir, "manifest.json"), JSON.stringify({ version, key: channel.publicKey }));
  }
  if (runtimePackage) await writeFile(join(installRoot, "runtime-package.json"), JSON.stringify({ version }));
  await symlink(join(root, "node_modules"), join(installRoot, "node_modules"), "dir");
  const codex = join(dir, "codex-test");
  await writeFile(codex, '#!/usr/bin/env node\nconsole.log("codex-cli test");\n', { mode: 0o700 });
  const env = { ...process.env, ALCHEMY_DATA_DIR: join(dir, "data"), ALCHEMY_APP_SUPPORT_DIR: join(dir, "app support"),
    CODEX_BIN: codex, CODEX_HOME: join(dir, "codex-home"), IMAGEGEN_SKILL_PATH: join(dir, "missing-imagegen.md") };
  for (const key of ["ALCHEMY_SKILL_PATH", "ALCHEMY_EXTENSION_ID", "ALCHEMY_CHANNEL", "ALCHEMY_PORT"]) delete env[key];
  const ports = { release: await unusedPort(), dev: await unusedPort() };
  const manage = (channel, command, ...args) => exec(process.execPath,
    [join(installRoot, "scripts/manage.mjs"), ...(channel === "dev" ? ["--dev"] : []), command, ...args],
    { env: { ...env, ALCHEMY_PORT: String(ports[channel]) }, timeout: 15000 });
  // The service answering on a channel's port with this data folder's token, or null when none does.
  const health = async channel => {
    try {
      const token = (await readFile(join(env.ALCHEMY_DATA_DIR, "config/token"), "utf8")).trim();
      return await (await fetch(`http://127.0.0.1:${ports[channel]}/health`, { headers: { Authorization: `Bearer ${token}` } })).json();
    } catch { return null; }
  };
  t.after(async () => {
    for (const channel of ["dev", "release"]) await manage(channel, "stop").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, env, installRoot, ports, manage, health };
}

test("user's dev build has its own fixed extension ID, port and launcher, distinct from the release", async () => {
  // Given the published public keys, Chromium derives the fixed IDs each build will load with.
  for (const channel of Object.values(channels)) assert.equal(idFromKey(channel.publicKey), channel.extensionId);
  // Then the release identity is unchanged and the dev identity differs in every shared resource.
  assert.deepEqual(
    { port: channels.release.port, hostName: channels.release.hostName, outputDir: channels.release.outputDir },
    { port: 43187, hostName: "com.qc.reframe", outputDir: ".output/chrome-mv3" });
  assert.deepEqual(
    { port: channels.dev.port, hostName: channels.dev.hostName, outputDir: channels.dev.outputDir },
    { port: 43197, hostName: "com.qc.reframe.dev", outputDir: ".output/chrome-mv3-dev" });
  for (const field of ["extensionId", "publicKey", "port", "hostName", "outputDir", "launcherFile", "shortName"])
    assert.notEqual(channels.dev[field], channels.release[field], field);
  // And WXT's development mode builds the dev extension; every other mode builds the release.
  assert.equal(buildChannel("development"), channels.dev);
  for (const mode of ["production", undefined, "test"]) assert.equal(buildChannel(mode), channels.release);
  // And a service runs as dev only when asked explicitly; anything unknown is refused rather than guessed.
  assert.equal(serviceChannel(undefined), channels.release);
  assert.equal(serviceChannel(""), channels.release);
  assert.equal(serviceChannel("release"), channels.release);
  assert.equal(serviceChannel("dev"), channels.dev);
  for (const invalid of ["Dev", "development", "beta"]) assert.throws(() => serviceChannel(invalid), /ALCHEMY_CHANNEL/);
});

test("user builds the dev extension and its manifest carries the dev key and name", async () => {
  // Given the WXT configuration, when it resolves the manifest for each build mode.
  const manifestFor = mode => typeof wxtConfig.manifest === "function" ? wxtConfig.manifest({ mode, browser: "chrome", manifestVersion: 3, command: "build" }) : wxtConfig.manifest;
  const release = await manifestFor("production");
  const dev = await manifestFor("development");
  // Then each build carries its own key, so the two can be loaded side by side and told apart.
  assert.equal(release.key, channels.release.publicKey);
  assert.equal(release.short_name, "QC-Reframe");
  assert.equal(dev.key, channels.dev.publicKey);
  assert.equal(dev.short_name, channels.dev.shortName);
  assert.match(dev.name, /Dev/);
  // And permissions are identical: the dev build is the same product, not a broader one.
  assert.deepEqual(dev.permissions, release.permissions);
  assert.deepEqual(dev.host_permissions, release.host_permissions);
});

test("user's dev service connects only the dev extension and the release service only the release", async t => {
  // Given a release and a dev service over separate data folders.
  const connect = async (channel, id) => {
    const dir = await mkdtemp(join(tmpdir(), "reframe-channel-connection-"));
    await writeFile(join(dir, "token"), "private-token");
    const app = await createBridge({ dataDir: dir, skillPath: join(dir, "missing-skill"), extensionId: "", channel });
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    t.after(async () => { app.server.closeAllConnections(); await new Promise(done => app.server.close(done)); await rm(dir, { recursive: true, force: true }); });
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/connection`, {
      method: "POST", headers: { Origin: origin(id), "Content-Type": "application/json" }, body: "{}" });
    return response.status;
  };
  // When each extension asks each service for the connection.
  // Then only the matching pair connects; the other extension never receives the token.
  assert.equal(await connect(channels.dev, channels.dev.extensionId), 200);
  assert.equal(await connect(channels.dev, channels.release.extensionId), 403);
  assert.equal(await connect(channels.release, channels.release.extensionId), 200);
  assert.equal(await connect(channels.release, channels.dev.extensionId), 403);
  // And an explicitly approved extra ID is added to the channel's own ID, never to the other channel's.
  assert.deepEqual(connectionOrigins("b".repeat(32), channels.dev), new Set([origin(channels.dev.extensionId), origin("b".repeat(32))]));
});

test("user runs the dev service from a source checkout and its health and start command say dev", { skip: process.platform === "win32" }, async t => {
  // Given a source checkout with a dev build.
  const f = await checkout(t);
  // When the dev service is started.
  await f.manage("dev", "start");
  // Then it reports the dev channel on its own port, and the offline hint restarts the dev service, not the release one.
  const health = await f.health("dev");
  assert.equal(health.channel, "dev");
  assert.equal(health.ready, true);
  assert.equal(await f.health("release"), null);
  assert.equal(startCommand({ installDir: "/Users/me/qc-reframe" }, "dev"), "cd '/Users/me/qc-reframe' && npm run dev:start");
  assert.equal(startCommand({ installDir: "/Users/me/qc-reframe" }), "cd '/Users/me/qc-reframe' && npm start");
  // And dev:status and dev:stop manage that same service.
  assert.match((await f.manage("dev", "status")).stdout, /"channel": "dev"/);
  await f.manage("dev", "stop");
  assert.equal(await f.health("dev"), null);
});

test("user cannot point a second service at a data folder another channel is already using", { skip: process.platform === "win32" }, async t => {
  // Given the release channel of a checkout running on the checkout's data folder.
  const f = await checkout(t);
  await f.manage("release", "start");
  const before = await f.health("release");
  // When the dev service is started on the same data folder.
  // Then it is refused with the command that frees the folder, and the running service is untouched.
  await assert.rejects(f.manage("dev", "start"), error => /npm stop/.test(error.stderr) && /数据目录/.test(error.stderr));
  assert.equal(await f.health("dev"), null);
  assert.equal((await f.health("release")).instanceId, before.instanceId);
  // And the same holds the other way round.
  await f.manage("release", "stop");
  await f.manage("dev", "start");
  await assert.rejects(f.manage("release", "start"), error => /npm run dev:stop/.test(error.stderr));
  assert.equal(await f.health("release"), null);
  assert.equal((await f.health("dev")).channel, "dev");
});

test("user cannot use dev commands in a release install", { skip: process.platform === "win32" }, async t => {
  // Given a one-command install, which ships only the release build.
  const f = await checkout(t, { runtimePackage: true });
  // When a dev command is run there.
  // Then it is refused before anything is created or started.
  for (const command of ["start", "setup", "native-install"]) {
    const args = command === "native-install" ? ["codex"] : [];
    await assert.rejects(f.manage("dev", command, ...args), error => /源码仓库/.test(error.stderr));
  }
  assert.equal(await f.health("dev"), null);
  await assert.rejects(readFile(join(f.env.ALCHEMY_DATA_DIR, "config/token")), { code: "ENOENT" });
});

test("user registers the dev launcher beside the release launcher and it wakes the dev service", { skip: process.platform === "win32" }, async t => {
  // Given a checkout whose release launcher is already registered for Codex.
  const f = await checkout(t);
  await f.manage("release", "native-install", "codex");
  const hosts = join(f.env.ALCHEMY_APP_SUPPORT_DIR, "OpenAI/Codex/NativeMessagingHosts");
  const releaseRegistration = await readFile(join(hosts, "com.qc.reframe.json"), "utf8");
  // When the dev launcher is registered.
  await f.manage("dev", "native-install", "codex");
  // Then it has its own name, executable and allowed extension, and the release registration is unchanged.
  const dev = JSON.parse(await readFile(join(hosts, "com.qc.reframe.dev.json"), "utf8"));
  assert.equal(dev.name, "com.qc.reframe.dev");
  assert.equal(dev.path, join(f.env.ALCHEMY_DATA_DIR, "runtime", channels.dev.launcherFile));
  assert.deepEqual(dev.allowed_origins, [`${origin(channels.dev.extensionId)}/`]);
  assert.equal(await readFile(join(hosts, "com.qc.reframe.json"), "utf8"), releaseRegistration);
  // When the dev extension opens with the dev service stopped, its launcher starts the dev service and only that.
  assert.deepEqual(await launch(dev.path, channels.dev.extensionId), { ok: true });
  assert.equal((await f.health("dev")).channel, "dev");
  assert.equal(await f.health("release"), null);
  // And the release launcher refuses the dev extension.
  const release = JSON.parse(releaseRegistration);
  assert.equal((await launch(release.path, channels.dev.extensionId)).ok, false);
  assert.equal(await f.health("release"), null);
  // And removing the dev launcher leaves the release launcher working.
  await f.manage("dev", "stop");
  await f.manage("dev", "native-uninstall", "codex");
  await assert.rejects(readFile(join(hosts, "com.qc.reframe.dev.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(hosts, "com.qc.reframe.json"), "utf8"), releaseRegistration);
  assert.deepEqual(await launch(release.path, channels.release.extensionId), { ok: true });
  assert.equal((await f.health("release")).channel, "release");
});
