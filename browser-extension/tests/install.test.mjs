import test from "node:test";
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge } from "../bridge/server.mjs";

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
    CODEX_BIN: codex, CODEX_HOME: join(dir, "codex-home"), IMAGEGEN_SKILL_PATH: join(dir, "missing-imagegen.md") };
  delete env.ALCHEMY_SKILL_PATH;
  const run = command => exec(process.execPath, [join(installRoot, "scripts/manage.mjs"), command], { env, timeout: 15000 });
  t.after(async () => { await run("stop").catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  return { dir, env, run, installRoot };
}

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
  assert.match((await run("doctor")).stdout, /可逆向提示词/);
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
