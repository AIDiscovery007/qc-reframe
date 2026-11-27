import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { endianness, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EXTENSION_ID, EXTENSION_PUBLIC_KEY } from "../lib/extension-identity.mjs";
import { packageRuntime, runtimeArchive } from "../scripts/package-runtime.mjs";
import { installerSigningKey, signChecksums } from "../scripts/sign-release.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const skip = process.platform === "win32";

let packaged;
// One package per run; every installer scenario downloads the same bytes.
async function releaseArchive() {
  packaged ??= (async () => packageRuntime(await mkdtemp(join(tmpdir(), "qc-reframe-package-"))))();
  return packaged;
}

async function unusedPort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

// The released package changed into another version, optionally with a manage command that fails, as a broken release would.
async function variant(version, failingCommand) {
  const work = await mkdtemp(join(tmpdir(), "qc-reframe-variant-"));
  await exec("tar", ["-xzf", await releaseArchive(), "-C", work]);
  const top = join(work, "qc-reframe");
  await writeFile(join(top, "runtime-package.json"), JSON.stringify({ version }, null, 2) + "\n");
  const manifest = JSON.parse(await readFile(join(top, "package.json"), "utf8"));
  await writeFile(join(top, "package.json"), JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  const extension = join(top, ".output/chrome-mv3/manifest.json");
  await writeFile(extension, JSON.stringify({ ...JSON.parse(await readFile(extension, "utf8")), version }));
  if (failingCommand) {
    const manage = join(top, "scripts/manage.mjs");
    await writeFile(manage, `if (process.argv[2] === ${JSON.stringify(failingCommand)}) { console.error("${failingCommand} fails in this release"); process.exit(1); }\n${await readFile(manage, "utf8")}`);
  }
  const archive = join(work, runtimeArchive);
  await exec("tar", ["-czf", archive, "-C", work, "qc-reframe"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return archive;
}

// A machine with Chrome, a stand-in Codex CLI, a release mirror on 127.0.0.1 and an npm that
// installs dependencies by linking this checkout's node_modules instead of using the network.
// The mirror's releases are signed with a test key that replaces the release key in the installer it runs.
async function machine(t, { checksum } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "qc-reframe install "));
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const shipped = await readFile(join(root, "scripts/install.sh"), "utf8");
  const script = shipped.replace(/^(\s*local signing_key=)"[^"]*"$/m, `$1"${publicKey}"`);
  assert.notEqual(script, shipped, "the installer embeds one release signing key");
  // What the mirror serves; `signature` is "valid", "invalid" (signed over other bytes) or "missing".
  const release = { signature: "valid" };
  const publish = async archive => {
    release.bytes = await readFile(archive);
    release.sums = `${checksum ?? createHash("sha256").update(release.bytes).digest("hex")}  ${runtimeArchive}\n`;
  };
  await publish(await releaseArchive());
  const requests = [];
  const mirror = createServer((request, response) => {
    requests.push(request.url);
    const signature = release.signature === "valid" ? signChecksums(release.sums, keys.privateKey.export({ format: "pem", type: "pkcs8" }), installerSigningKey(script))
      : release.signature === "invalid" ? sign(null, Buffer.from("other bytes"), keys.privateKey).toString("base64") + "\n" : undefined;
    const body = { [`/${runtimeArchive}`]: release.bytes, "/SHA256SUMS": release.sums, "/SHA256SUMS.sig": signature }[request.url];
    response.writeHead(body ? 200 : 404).end(body);
  }).listen(0, "127.0.0.1");
  await once(mirror, "listening");
  const bin = join(dir, "bin");
  await mkdir(bin);
  const calls = join(dir, "npm-calls.jsonl");
  const npmExec = join(dir, "npm-exec.cjs");
  await writeFile(npmExec, `const fs = require("node:fs"), path = require("node:path");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "ci") { fs.rmSync("node_modules", { recursive: true, force: true }); fs.symlinkSync(${JSON.stringify(join(root, "node_modules"))}, "node_modules", "dir"); }
`);
  await writeFile(join(bin, "npm"), `#!/usr/bin/env node
const args = process.argv.slice(2), command = args[0] === "run" ? args[1] : args[0];
const run = require("node:child_process").spawnSync(process.execPath, ["scripts/manage.mjs", command], { stdio: "inherit", env: { ...process.env, npm_execpath: ${JSON.stringify(npmExec)} } });
process.exit(run.status ?? 1);
`, { mode: 0o755 });
  // Commands that fail partway: a copy that stops after package.json as when the disk fills, the same copy killed with its
  // installer as when the terminal closes, and a move of package.json that fails as when a file cannot be renamed.
  const faults = { copyFails: join(dir, "failing-cp"), copyKilled: join(dir, "killed-cp"), moveFails: join(dir, "failing-mv") };
  for (const [fault, folder] of Object.entries(faults)) {
    await mkdir(folder);
    if (fault === "moveFails") await writeFile(join(folder, "mv"), '#!/bin/sh\ncase "$1" in */package.json) exit 1 ;; esac\nexec /bin/mv "$@"\n', { mode: 0o755 });
    else await writeFile(join(folder, "cp"), `#!/bin/sh\n/bin/cp "\${2%.}package.json" "$3"\n${fault === "copyKilled" ? "kill -9 $PPID\n" : ""}exit 1\n`, { mode: 0o755 });
  }
  const codex = join(dir, "codex-test");
  await writeFile(codex, '#!/usr/bin/env node\nconsole.log("codex-cli test");\n', { mode: 0o700 });
  // A UTF-8 locale, as in users' terminals: the bash that macOS ships then reads non-ASCII bytes as part of a variable name.
  const env = { ...process.env, LC_ALL: "en_US.UTF-8", PATH: `${bin}:${process.env.PATH}`, HOME: join(dir, "home"), TMPDIR: dir,
    QC_REFRAME_BASE_URL: `http://127.0.0.1:${mirror.address().port}`, QC_REFRAME_DIR: join(dir, "Q C Reframe"),
    ALCHEMY_PORT: String(await unusedPort()), ALCHEMY_APP_SUPPORT_DIR: join(dir, "app support"),
    CODEX_BIN: codex, CODEX_HOME: join(dir, "codex-home") };
  for (const key of ["ALCHEMY_DATA_DIR", "ALCHEMY_SKILL_PATH", "ALCHEMY_EXTENSION_ID", "QC_REFRAME_VERSION"]) delete env[key];
  await mkdir(join(env.ALCHEMY_APP_SUPPORT_DIR, "Google/Chrome"), { recursive: true });
  const installDir = env.QC_REFRAME_DIR;
  const manage = (...args) => exec(process.execPath, [join(installDir, "scripts/manage.mjs"), ...args], { cwd: installDir, env, timeout: 15000 });
  t.after(async () => {
    await manage("stop").catch(() => {});
    mirror.close();
    await rm(dir, { recursive: true, force: true });
  });
  // Feed the script through stdin, exactly as `curl … | bash` does.
  const install = async ({ fault, env: extra = {} } = {}) => {
    const runEnv = { ...env, ...extra, ...(fault ? { PATH: `${faults[fault]}:${env.PATH}` } : {}) };
    const child = spawn("bash", [], { env: runEnv, cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.stdin.end(script);
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    const [code] = await once(child, "close");
    clearTimeout(timer);
    return { code, stdout, stderr };
  };
  const npmCalls = async () => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const health = async () => JSON.parse((await manage("status")).stdout);
  const upgradeResult = async () => JSON.parse(await readFile(join(installDir, ".local/runtime/upgrade-result.json"), "utf8"));
  return { dir, env, installDir, install, manage, health, npmCalls, requests, release, publish, upgradeResult };
}

test("release runtime package carries the built extension, service and skill without sources or local data", { skip }, async () => {
  // Given the current extension build, When the release runtime package is made.
  const archive = await releaseArchive();
  const entries = (await exec("tar", ["-tzf", archive])).stdout.split("\n").filter(Boolean).map(entry => entry.replace(/\/$/, ""));
  // Then it has everything setup, start and the launcher read, under one top-level folder.
  for (const required of ["runtime-package.json", "package.json", "package-lock.json", ".output/chrome-mv3/manifest.json",
    "bridge/server.mjs", "scripts/manage.mjs", "scripts/native-host.mjs", "scripts/install.sh", "lib/extension-identity.mjs",
    "lib/image-size.mjs", ".agents/skills/alchemy/SKILL.md", "docs/INSTALL_WITH_CODEX.md"])
    assert.ok(entries.includes(`qc-reframe/${required}`), `missing ${required}`);
  assert.ok(entries.every(entry => entry === "qc-reframe" || entry.startsWith("qc-reframe/")));
  // And no sources, tests, build tools, keys, dependencies or local data.
  const leaked = entries.filter(entry => /^qc-reframe\/(entrypoints|components|tests|node_modules|\.local|\.keys)(\/|$)|\.(ts|tsx|pem)$|scripts\/(icons|package-runtime)\.mjs$|\._/.test(entry));
  assert.deepEqual(leaked, []);
  const unpacked = await mkdtemp(join(tmpdir(), "qc-reframe-unpacked-"));
  try {
    await exec("tar", ["-xzf", archive, "-C", unpacked]);
    const top = join(unpacked, "qc-reframe");
    assert.deepEqual(JSON.parse(await readFile(join(top, "runtime-package.json"), "utf8")), { version });
    const manifest = JSON.parse(await readFile(join(top, ".output/chrome-mv3/manifest.json"), "utf8"));
    assert.equal(manifest.version, version);
    assert.equal(manifest.key, EXTENSION_PUBLIC_KEY);
    assert.ok((await stat(join(top, "scripts/install.sh"))).mode & 0o100, "installer stays executable");
  } finally { await rm(unpacked, { recursive: true, force: true }); }
});

test("user installs with one command and only has to load the extension", { skip, timeout: 90000 }, async t => {
  // Given a machine with Chrome, Node and npm, and no QC-Reframe folder yet.
  const m = await machine(t);
  // When the user pipes the installer into bash.
  const result = await m.install();
  // Then it verifies, installs runtime dependencies only, registers Chrome's launcher and starts the service.
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await m.npmCalls(), [["ci", "--omit=dev", "--ignore-scripts"]]);
  const health = await m.health();
  assert.equal(health.ready, true);
  assert.equal(health.version, version);
  // And its offline start command needs no data-folder override, because it uses the installation's own .local.
  assert.equal(health.installDir, await realpath(m.installDir));
  assert.equal(health.dataDir, undefined);
  const registration = JSON.parse(await readFile(join(m.env.ALCHEMY_APP_SUPPORT_DIR, "Google/Chrome/NativeMessagingHosts/com.qc.reframe.json"), "utf8"));
  // npm runs scripts from the physical folder, so the launcher records that spelling.
  assert.ok(registration.path.startsWith(join(await realpath(m.installDir), ".local")));
  // And the only step left is loading the printed extension folder, which carries the fixed key.
  assert.match(result.stdout, /chrome:\/\/extensions/);
  assert.ok(result.stdout.includes(join(m.installDir, ".output/chrome-mv3")));
  const manifest = JSON.parse(await readFile(join(m.installDir, ".output/chrome-mv3/manifest.json"), "utf8"));
  assert.equal(manifest.key, EXTENSION_PUBLIC_KEY);
});

test("user reruns the installer to upgrade and keeps projects, pairing and their own files", { skip, timeout: 120000 }, async t => {
  // Given a running installation with a pairing token, project data, a user note and a file the old package owned.
  const m = await machine(t);
  assert.equal((await m.install()).code, 0);
  const before = await m.health();
  const token = await readFile(join(m.installDir, ".local/config/token"), "utf8");
  await writeFile(join(m.installDir, ".local/records/kept.json"), "{}\n");
  await writeFile(join(m.installDir, "my-notes.txt"), "mine\n");
  await writeFile(join(m.installDir, "bridge/removed-in-new-version.mjs"), "\n");
  // When the installer runs again.
  const result = await m.install();
  // Then the old service was stopped and replaced, the package files are current, and user data is untouched.
  assert.equal(result.code, 0, result.stderr);
  const after = await m.health();
  assert.equal(after.ready, true);
  assert.notEqual(after.instanceId, before.instanceId);
  assert.equal(await readFile(join(m.installDir, ".local/config/token"), "utf8"), token);
  assert.equal(await readFile(join(m.installDir, ".local/records/kept.json"), "utf8"), "{}\n");
  assert.equal(await readFile(join(m.installDir, "my-notes.txt"), "utf8"), "mine\n");
  await assert.rejects(stat(join(m.installDir, "bridge/removed-in-new-version.mjs")), { code: "ENOENT" });
  await assert.rejects(stat(join(m.installDir, ".qc-reframe-previous")), { code: "ENOENT" });
});

test("user whose first install was interrupted mid-copy reruns the installer and finishes", { skip, timeout: 90000 }, async t => {
  // Given a first install whose copy stopped after one file.
  const m = await machine(t);
  const interrupted = await m.install({ fault: "copyFails" });
  assert.notEqual(interrupted.code, 0);
  assert.match(interrupted.stderr, /重新运行安装命令即可/);
  // When the user reruns the installer, Then it recognises its own partial folder and completes.
  const result = await m.install();
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await m.health()).ready, true);
  await assert.rejects(stat(join(m.installDir, ".qc-reframe-install-pending")), { code: "ENOENT" });
});

test("user whose upgrade was interrupted mid-copy reruns the installer and keeps their data", { skip, timeout: 120000 }, async t => {
  // Given a working installation whose upgrade was killed mid-copy, after its service was stopped and its files moved aside.
  const m = await machine(t);
  assert.equal((await m.install()).code, 0);
  const token = await readFile(join(m.installDir, ".local/config/token"), "utf8");
  await writeFile(join(m.installDir, "my-notes.txt"), "mine\n");
  const interrupted = await m.install({ fault: "copyKilled" });
  assert.notEqual(interrupted.code, 0);
  await assert.rejects(stat(join(m.installDir, "runtime-package.json")), { code: "ENOENT" });
  // When the user reruns the installer, Then it completes the upgrade and the service runs with the same data.
  const result = await m.install();
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await m.health()).ready, true);
  assert.equal(await readFile(join(m.installDir, ".local/config/token"), "utf8"), token);
  assert.equal(await readFile(join(m.installDir, "my-notes.txt"), "utf8"), "mine\n");
  for (const leftover of [".qc-reframe-install-pending", ".qc-reframe-previous"]) await assert.rejects(stat(join(m.installDir, leftover)), { code: "ENOENT" });
});

test("user's download fails verification and nothing is installed", { skip, timeout: 60000 }, async t => {
  // Given a mirror whose checksum does not match the downloaded package.
  const m = await machine(t, { checksum: "0".repeat(64) });
  // When the installer runs, Then it stops before writing the installation folder.
  const result = await m.install();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /校验失败，未改动任何文件/);
  await assert.rejects(stat(m.installDir), { code: "ENOENT" });
  assert.deepEqual(await m.npmCalls(), []);
});

test("user pointing the installer at a folder of their own is refused before anything is downloaded", { skip, timeout: 60000 }, async t => {
  // Given the chosen folder already holds the user's own files.
  const m = await machine(t);
  await mkdir(m.installDir);
  await writeFile(join(m.installDir, "notes.txt"), "keep\n");
  // When the installer runs, Then it refuses, downloads nothing and leaves the folder as it was.
  const result = await m.install();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /不是 QC-Reframe 运行包安装目录，未改动任何文件/);
  assert.deepEqual(m.requests, []);
  assert.deepEqual(await readdir(m.installDir), ["notes.txt"]);
  assert.equal(await readFile(join(m.installDir, "notes.txt"), "utf8"), "keep\n");
});

test("user's installer refuses checksums that do not carry the release signature", { skip, timeout: 90000 }, async t => {
  // Given a mirror whose SHA256SUMS signature was made over other bytes.
  const m = await machine(t);
  m.release.signature = "invalid";
  // When the installer runs, Then it stops before writing anything, whatever the options.
  const forged = await m.install();
  assert.notEqual(forged.code, 0);
  assert.match(forged.stderr, /签名校验失败，未改动任何文件/);
  await assert.rejects(stat(m.installDir), { code: "ENOENT" });
  // And when a signature is required, as for upgrades from the extension, a release without one is refused too.
  m.release.signature = "missing";
  const unsigned = await m.install({ env: { QC_REFRAME_REQUIRE_SIGNATURE: "1" } });
  assert.notEqual(unsigned.code, 0);
  assert.match(unsigned.stderr, /发布签名.*未改动任何文件/);
  await assert.rejects(stat(m.installDir), { code: "ENOENT" });
  assert.deepEqual(await m.npmCalls(), []);
  // But a user installing an older, unsigned release by hand is told only the checksum was verified.
  const older = await m.install();
  assert.equal(older.code, 0, older.stderr);
  assert.match(older.stdout, /没有发布签名，只校验了 SHA-256/);
});

test("user upgrading from the extension gets exactly the requested release, and the outcome is recorded", { skip, timeout: 120000 }, async t => {
  // Given a running installation, and a newer release on the mirror.
  const m = await machine(t);
  assert.equal((await m.install()).code, 0);
  const before = await m.health();
  await m.publish(await variant("9.9.9"));
  const upgrade = version => m.install({ env: { QC_REFRAME_VERSION: version, QC_REFRAME_REQUIRE_SIGNATURE: "1" } });
  // When the upgrade asked for another version than the package holds, Then nothing changes and the refusal is recorded.
  const mismatch = await upgrade("9.9.8");
  assert.notEqual(mismatch.code, 0);
  assert.match(mismatch.stderr, /9\.9\.9.*不是请求的 9\.9\.8.*未改动任何文件/);
  assert.equal((await m.health()).instanceId, before.instanceId);
  assert.deepEqual({ ...await m.upgradeResult(), at: undefined }, { version: "9.9.8", from: version, outcome: "failed", stage: "verify", at: undefined });
  // When the upgrade asks for the version the package holds, Then the new version runs and the success is recorded.
  const result = await upgrade("9.9.9");
  assert.equal(result.code, 0, result.stderr);
  const after = await m.health();
  assert.equal(after.version, "9.9.9");
  assert.equal(after.ready, true);
  const recorded = await m.upgradeResult();
  assert.deepEqual({ ...recorded, at: undefined }, { version: "9.9.9", from: version, outcome: "upgraded", stage: null, at: undefined });
  assert.ok(Date.parse(recorded.at) > 0);
  for (const leftover of [".qc-reframe-install-pending", ".qc-reframe-previous"]) await assert.rejects(stat(join(m.installDir, leftover)), { code: "ENOENT" });
});

test("user whose upgrade fails gets the working version back with its data", { skip, timeout: 180000 }, async t => {
  // Given a running installation with a pairing token, project data and a user note.
  const m = await machine(t);
  assert.equal((await m.install()).code, 0);
  const token = await readFile(join(m.installDir, ".local/config/token"), "utf8");
  await writeFile(join(m.installDir, ".local/records/kept.json"), "{}\n");
  await writeFile(join(m.installDir, "my-notes.txt"), "mine\n");
  const env = { QC_REFRAME_VERSION: "9.9.9", QC_REFRAME_REQUIRE_SIGNATURE: "1" };
  // When the new release cannot be set up, cannot start, cannot be copied in, or the old files cannot all be moved aside.
  const cases = [["setup", await variant("9.9.9", "setup")], ["start", await variant("9.9.9", "start")], ["replace", await variant("9.9.9"), "copyFails"], ["replace", await variant("9.9.9"), "moveFails"]];
  for (const [stage, archive, fault] of cases) {
    await m.publish(archive);
    const result = await m.install({ env, fault });
    // Then the previous version is restored and running again, with the same data and files.
    assert.notEqual(result.code, 0, stage);
    assert.match(result.stderr, new RegExp(`已恢复 ${version.replaceAll(".", "\\.")}`), result.stderr);
    const health = await m.health();
    assert.equal(health.version, version, stage);
    assert.equal(health.ready, true, stage);
    assert.equal(JSON.parse(await readFile(join(m.installDir, "runtime-package.json"), "utf8")).version, version);
    assert.equal(await readFile(join(m.installDir, ".local/config/token"), "utf8"), token);
    assert.equal(await readFile(join(m.installDir, ".local/records/kept.json"), "utf8"), "{}\n");
    assert.equal(await readFile(join(m.installDir, "my-notes.txt"), "utf8"), "mine\n");
    for (const leftover of [".qc-reframe-install-pending", ".qc-reframe-previous"]) await assert.rejects(stat(join(m.installDir, leftover)), { code: "ENOENT" }, stage);
    // And the extension can tell the user which step failed.
    assert.deepEqual({ ...await m.upgradeResult(), at: undefined }, { version: "9.9.9", from: version, outcome: "rolled_back", stage, at: undefined });
  }
});

test("user opening Reframe during an upgrade does not wake the half-replaced installation", { skip, timeout: 90000 }, async t => {
  // Given an installation whose upgrade has moved the previous version aside and stopped its service.
  const m = await machine(t);
  assert.equal((await m.install()).code, 0);
  await m.manage("stop");
  await mkdir(join(m.installDir, ".qc-reframe-previous"));
  const { path } = JSON.parse(await readFile(join(m.env.ALCHEMY_APP_SUPPORT_DIR, "Google/Chrome/NativeMessagingHosts/com.qc.reframe.json"), "utf8"));
  const launch = async () => {
    const child = spawn(path, [`chrome-extension://${EXTENSION_ID}/`], { cwd: m.dir, stdio: ["pipe", "pipe", "ignore"] });
    const output = [];
    child.stdout.on("data", data => output.push(data));
    const body = Buffer.from(JSON.stringify({ action: "ensure-start" }));
    const size = Buffer.alloc(4);
    size[endianness() === "LE" ? "writeUInt32LE" : "writeUInt32BE"](body.length);
    child.stdin.end(Buffer.concat([size, body]));
    await once(child, "close");
    return JSON.parse(Buffer.concat(output).subarray(4).toString());
  };
  // When Chrome asks the launcher to start the service, Then it refuses and says the upgrade will start it.
  const refused = await launch();
  assert.equal(refused.ok, false);
  assert.match(refused.error, /正在升级/);
  await assert.rejects(m.health());
  // And once the upgrade is finished, the launcher starts the service again.
  await rm(join(m.installDir, ".qc-reframe-previous"), { recursive: true });
  assert.equal((await launch()).ok, true);
  assert.equal((await m.health()).ready, true);
});

test("user's installer messages name their paths and versions in any terminal", async () => {
  // Given a terminal with a UTF-8 locale and macOS's bash 3.2, which reads the bytes of `，` after `$dir` as more of the name,
  // When the installer prints a message, Then every variable that touches non-ASCII text is braced, so the message
  // prints instead of the installer dying on an unbound variable before it records the outcome.
  const script = await readFile(join(root, "scripts/install.sh"), "utf8");
  const unbraced = script.split("\n").flatMap((line, index) => [...line.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7f])/g)].map(match => `${index + 1}: ${match[0]}`));
  assert.deepEqual(unbraced, []);
});

test("release checksums are signed only with the key the installer trusts", { skip }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "qc-reframe-sign-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "SHA256SUMS"), "0  qc-reframe-runtime.tar.gz\n");
  const signer = (env) => exec(process.execPath, [join(root, "scripts/sign-release.mjs"), join(dir, "SHA256SUMS")], { env: { ...process.env, ...env } });
  // Given no signing key, When the release is signed, Then it fails and says which secret is missing.
  await assert.rejects(signer({ RELEASE_SIGNING_KEY: "" }), /RELEASE_SIGNING_KEY/);
  // Given a key other than the one embedded in scripts/install.sh, Then signing fails instead of publishing an unverifiable release.
  const other = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
  await assert.rejects(signer({ RELEASE_SIGNING_KEY: other }), /不匹配/);
  // And the installer's embedded key is a valid Ed25519 public key.
  assert.equal(installerSigningKey(await readFile(join(root, "scripts/install.sh"), "utf8")).asymmetricKeyType, "ed25519");
});
