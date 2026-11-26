import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EXTENSION_PUBLIC_KEY } from "../lib/extension-identity.mjs";
import { packageRuntime, runtimeArchive } from "../scripts/package-runtime.mjs";

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

// A machine with Chrome, a stand-in Codex CLI, a release mirror on 127.0.0.1 and an npm that
// installs dependencies by linking this checkout's node_modules instead of using the network.
async function machine(t, { checksum } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "qc-reframe install "));
  const archive = await releaseArchive();
  const bytes = await readFile(archive);
  const sums = `${checksum ?? createHash("sha256").update(bytes).digest("hex")}  ${runtimeArchive}\n`;
  const requests = [];
  const mirror = createServer((request, response) => {
    requests.push(request.url);
    const body = { [`/${runtimeArchive}`]: bytes, "/SHA256SUMS": sums }[request.url];
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
  const codex = join(dir, "codex-test");
  await writeFile(codex, '#!/usr/bin/env node\nconsole.log("codex-cli test");\n', { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(dir, "home"), TMPDIR: dir,
    QC_REFRAME_BASE_URL: `http://127.0.0.1:${mirror.address().port}`, QC_REFRAME_DIR: join(dir, "Q C Reframe"),
    ALCHEMY_PORT: String(await unusedPort()), ALCHEMY_APP_SUPPORT_DIR: join(dir, "app support"),
    CODEX_BIN: codex, CODEX_HOME: join(dir, "codex-home"), IMAGEGEN_SKILL_PATH: join(dir, "missing-imagegen.md") };
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
  const install = async () => {
    const child = spawn("bash", [], { env, cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.stdin.end(await readFile(join(root, "scripts/install.sh")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    const [code] = await once(child, "close");
    clearTimeout(timer);
    return { code, stdout, stderr };
  };
  const npmCalls = async () => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const health = async () => JSON.parse((await manage("status")).stdout);
  return { dir, env, installDir, install, manage, health, npmCalls, requests };
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
