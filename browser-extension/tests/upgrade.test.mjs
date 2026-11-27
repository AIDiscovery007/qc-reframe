import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge } from "../bridge/server.mjs";
import { RELEASE_URL } from "../bridge/upgrade.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version: current } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const release = (tag, extra = {}) => ({ tag_name: tag, name: `QC-Reframe ${tag}`, draft: false, prerelease: false,
  html_url: `https://github.com/AIDiscovery007/qc-reframe/releases/tag/${tag}`, published_at: "2026-12-01T08:00:00Z", body: "<script>never rendered</script>", ...extra });

// A stand-in for the GitHub API: answers each request with the next queued reply and counts what it receives.
async function github(t) {
  const replies = [];
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    const reply = replies.length > 1 ? replies.shift() : replies[0];
    if (!reply) return response.writeHead(404).end("{}");
    if (reply.hang) return;
    if (reply.redirect) return response.writeHead(302, { Location: reply.redirect }).end();
    response.writeHead(reply.status || 200, { "Content-Type": "application/json" }).end(reply.raw ?? JSON.stringify(reply.body));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}/repos/AIDiscovery007/qc-reframe/releases/latest`, replies, requests };
}

// A service with a controllable clock, install kind, platform and installer; nothing is ever really spawned.
async function service(t, { gh, packaged = true, platform = "darwin", allowShutdown = true, dataDir } = {}) {
  dataDir ||= await mkdtemp(join(tmpdir(), "reframe-upgrade-"));
  const clock = { now: Date.parse("2026-12-01T09:00:00Z") };
  const spawned = [];
  const models = { busy: false, close() {}, selection: () => ({ model: "kept" }), list: async () => ({}), start: async () => ({}), refresh: async () => ({}) };
  const app = await createBridge({ dataDir, skillPath: join(dataDir, "missing-skill"), extensionId: "", allowShutdown, models,
    compatibility: { snapshot: () => ({}), getCompatibility: async () => ({}) },
    upgradeOptions: { releaseUrl: gh.url, timeoutMs: 300, packaged, platform, now: () => clock.now,
      spawnInstaller: async request => { spawned.push(request); return { exited: new Promise(() => {}) }; } } });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => { app.server.closeAllConnections(); await new Promise(done => app.server.close(done)); });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const call = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${app.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { call, clock, spawned, models, dataDir, port: app.server.address().port };
}

test("user sees a newer release in settings, checked at most once a day", async t => {
  // Given GitHub's latest release is newer than this installation.
  const gh = await github(t);
  gh.replies.push({ body: release("v9.9.9") });
  const s = await service(t, { gh });
  // When settings only read the status, Then nothing is sent to GitHub.
  const idle = (await s.call("/upgrade")).body;
  assert.equal(idle.current, current);
  assert.equal(idle.latest, null);
  assert.equal(idle.autoCheck, true);
  assert.equal(gh.requests.length, 0);
  // When the workspace asks for its automatic check, Then the release is offered with its page link and no body text.
  const seen = (await s.call("/upgrade?check=auto")).body;
  assert.deepEqual(seen.latest, { version: "9.9.9", title: "QC-Reframe v9.9.9",
    url: "https://github.com/AIDiscovery007/qc-reframe/releases/tag/v9.9.9", publishedAt: "2026-12-01T08:00:00.000Z" });
  assert.equal(seen.available, true);
  assert.equal(seen.canUpgrade, true);
  assert.equal(seen.checkError, null);
  // And the request carries no user data: a fixed path, a product User-Agent, no cookies or tokens.
  assert.equal(gh.requests[0].url, "/repos/AIDiscovery007/qc-reframe/releases/latest");
  assert.match(gh.requests[0].headers["user-agent"], /^QC-Reframe\/\d+\.\d+\.\d+$/);
  assert.equal(gh.requests[0].headers.authorization, undefined);
  assert.equal(gh.requests[0].headers.cookie, undefined);
  // And further automatic checks that day send nothing, even after a restart of the service on the same data.
  s.clock.now += 23 * 3600_000;
  assert.equal((await s.call("/upgrade?check=auto")).body.latest.version, "9.9.9");
  const restarted = await service(t, { gh, dataDir: s.dataDir });
  restarted.clock.now = s.clock.now;
  assert.equal((await restarted.call("/upgrade?check=auto")).body.latest.version, "9.9.9");
  assert.equal(gh.requests.length, 1);
  // And the next day's automatic check asks again.
  s.clock.now += 3600_000;
  await s.call("/upgrade?check=auto");
  assert.equal(gh.requests.length, 2);
  // And only the fixed GitHub address is the default source.
  assert.equal(RELEASE_URL, "https://api.github.com/repos/AIDiscovery007/qc-reframe/releases/latest");
});

test("user checks manually at most once a minute and sees when already up to date", async t => {
  // Given GitHub's latest release is this very version.
  const gh = await github(t);
  gh.replies.push({ body: release(`v${current}`) });
  const s = await service(t, { gh });
  // When the user clicks 检查更新 twice within a minute, Then one request is sent and no upgrade is offered.
  const first = (await s.call("/upgrade?check=manual")).body;
  await s.call("/upgrade?check=manual");
  assert.equal(gh.requests.length, 1);
  assert.equal(first.latest.version, current);
  assert.equal(first.available, false);
  assert.equal(first.canUpgrade, false);
  // And a minute later the button asks again.
  s.clock.now += 61_000;
  await s.call("/upgrade?check=manual");
  assert.equal(gh.requests.length, 2);
  // And an unknown check mode is refused without contacting GitHub.
  assert.equal((await s.call("/upgrade?check=always")).status, 400);
  assert.equal(gh.requests.length, 2);
});

test("user is offered nothing from an answer that is not a stable published release", async t => {
  // Given replies that are pre-releases, drafts, malformed tags, foreign pages, oversized, redirected, failing or silent.
  const bad = [
    { body: release("v9.9.9", { prerelease: true }) },
    { body: release("v9.9.9", { draft: true }) },
    ...["9.9.9", "v9.9", "v9.9.9-beta.1", "v09.9.9", "v9.9.9 "].map(tag => ({ body: release(tag, { html_url: "https://github.com/AIDiscovery007/qc-reframe/releases/tag/x" }) })),
    { body: release("v9.9.9", { html_url: "https://example.com/AIDiscovery007/qc-reframe/releases/tag/v9.9.9" }) },
    { body: release("v9.9.9", { html_url: "https://github.com/someone-else/qc-reframe/releases/tag/v9.9.9" }) },
    { raw: JSON.stringify(release("v9.9.9", { body: "x".repeat(1024 * 1024) })) },
    { redirect: "https://example.com/latest" },
    { status: 500, body: {} },
    { raw: "not json" },
    { hang: true },
  ];
  for (const reply of bad) {
    const gh = await github(t);
    gh.replies.push(reply);
    const s = await service(t, { gh });
    // When the user checks, Then the check reports it could not confirm a release and offers no upgrade.
    const { status, body } = await s.call("/upgrade?check=manual");
    assert.equal(status, 200, JSON.stringify(reply).slice(0, 80));
    assert.equal(body.latest, null, JSON.stringify(reply).slice(0, 80));
    assert.match(body.checkError, /无法检查更新/, JSON.stringify(reply).slice(0, 80));
    assert.equal(body.canUpgrade, false);
    // And an upgrade request cannot get around the check.
    assert.equal((await s.call("/upgrade", { version: "9.9.9" })).status >= 400, true);
    assert.deepEqual(s.spawned, []);
  }
});

test("user turns off automatic checks and only the button contacts GitHub", async t => {
  // Given a newer release and automatic checks turned off.
  const gh = await github(t);
  gh.replies.push({ body: release("v9.9.9") });
  const s = await service(t, { gh });
  assert.equal((await s.call("/upgrade/settings", { autoCheck: false })).body.autoCheck, false);
  // When the workspace opens, also after a restart, Then nothing is sent.
  await s.call("/upgrade?check=auto");
  const restarted = await service(t, { gh, dataDir: s.dataDir });
  assert.equal((await restarted.call("/upgrade?check=auto")).body.autoCheck, false);
  assert.equal(gh.requests.length, 0);
  // When the user clicks 检查更新, Then the release is found.
  assert.equal((await restarted.call("/upgrade?check=manual")).body.latest.version, "9.9.9");
  assert.equal(gh.requests.length, 1);
  // And the switch accepts only a boolean.
  for (const body of [{ autoCheck: "no" }, {}, { autoCheck: false, extra: 1 }]) assert.equal((await s.call("/upgrade/settings", body)).status, 400);
});

test("user upgrades with one click and the local installer runs for exactly that release", async t => {
  // Given a release install whose service was started by npm start, and a newer release.
  const gh = await github(t);
  gh.replies.push({ body: release("v9.9.9") });
  const s = await service(t, { gh });
  await s.call("/upgrade?check=auto");
  s.clock.now += 5 * 60_000;
  const previous = process.env.QC_REFRAME_BASE_URL;
  process.env.QC_REFRAME_BASE_URL = "http://attacker.invalid";
  t.after(() => { if (previous === undefined) delete process.env.QC_REFRAME_BASE_URL; else process.env.QC_REFRAME_BASE_URL = previous; });
  // When the user confirms the upgrade.
  const accepted = await s.call("/upgrade", { version: "9.9.9" });
  // Then the release is confirmed again with GitHub and the installer of this installation is started once.
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  assert.equal(accepted.body.version, "9.9.9");
  assert.ok(Date.parse(accepted.body.startedAt) >= s.clock.now);
  assert.equal(gh.requests.length, 2);
  assert.equal(s.spawned.length, 1);
  const [run] = s.spawned;
  assert.equal(run.command, "/bin/bash");
  assert.deepEqual(run.args, [join(root, "scripts/install.sh")]);
  assert.equal(run.log, join(s.dataDir, "logs/upgrade.log"));
  assert.equal(run.env.QC_REFRAME_DIR, root);
  assert.equal(run.env.QC_REFRAME_VERSION, "9.9.9");
  assert.equal(run.env.QC_REFRAME_REQUIRE_SIGNATURE, "1");
  assert.equal(run.env.ALCHEMY_DATA_DIR, s.dataDir);
  assert.equal(run.env.ALCHEMY_PORT, String(s.port));
  // And no inherited installer option can redirect the download or the target folder.
  assert.equal(run.env.QC_REFRAME_BASE_URL, undefined);
  for (const key of ["ALCHEMY_MANAGED", "ALCHEMY_RESTART_ID", "ALCHEMY_CHANNEL"]) assert.equal(run.env[key], undefined, key);
  // And a second click while it runs is refused.
  const status = (await s.call("/upgrade")).body;
  assert.equal(status.upgrading, true);
  assert.equal(status.canUpgrade, false);
  assert.equal((await s.call("/upgrade", { version: "9.9.9" })).status, 409);
  assert.equal(s.spawned.length, 1);
  // And no other change starts while the installer runs, but the installer may still stop the service.
  const refused = await s.call("/upgrade/settings", { autoCheck: false });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /正在升级/);
  assert.equal((await s.call("/shutdown", {})).status, 200);
});

test("user can only upgrade to the confirmed latest release", async t => {
  // Given GitHub's latest release is 9.9.9.
  const gh = await github(t);
  gh.replies.push({ body: release("v9.9.9") });
  const s = await service(t, { gh });
  await s.call("/upgrade?check=manual");
  // When any other version, a downgrade or a malformed value is requested, Then nothing is started.
  for (const version of ["9.9.8", "10.0.0", current, "0.0.1", "v9.9.9", "9.9.9; rm -rf /", 999, null]) {
    const { status } = await s.call("/upgrade", { version });
    assert.ok(status === 400 || status === 409, `${version}: ${status}`);
  }
  assert.equal((await s.call("/upgrade", { version: "9.9.9", extra: true })).status, 400);
  assert.deepEqual(s.spawned, []);
  // And when GitHub has moved on since the last check, the stale version is refused.
  gh.replies.splice(0, gh.replies.length, { body: release("v9.9.10") });
  s.clock.now += 61_000;
  assert.equal((await s.call("/upgrade", { version: "9.9.9" })).status, 409);
  assert.deepEqual(s.spawned, []);
});

test("user cannot upgrade while a task runs, from a source checkout, a foreground service or an unsupported system", async t => {
  const blocked = async (options, reason, prepare = () => {}) => {
    const gh = await github(t);
    gh.replies.push({ body: release("v9.9.9") });
    const s = await service(t, { gh, ...options });
    prepare(s);
    // When settings show the newer release, Then the upgrade is not offered and the reason says what to do.
    const status = (await s.call("/upgrade?check=manual")).body;
    assert.equal(status.available, true);
    assert.equal(status.canUpgrade, false);
    assert.match(status.reason, reason);
    // And a request sent anyway is refused before anything starts.
    const refused = await s.call("/upgrade", { version: "9.9.9" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, reason);
    assert.deepEqual(s.spawned, []);
  };
  await blocked({}, /等待.*完成/, s => { s.models.busy = true; });
  await blocked({ packaged: false }, /git pull/);
  await blocked({ allowShutdown: false }, /终端/);
  await blocked({ platform: "win32" }, /macOS 和 Linux/);
});

test("user sees the outcome of the last upgrade reported by the installer", async t => {
  // Given the installer recorded a rollback of 9.9.9.
  const gh = await github(t);
  const s = await service(t, { gh });
  await mkdir(join(s.dataDir, "runtime"), { recursive: true });
  const result = { version: "9.9.9", from: current, outcome: "rolled_back", stage: "setup", at: "2026-12-01T09:01:00.000Z" };
  await writeFile(join(s.dataDir, "runtime/upgrade-result.json"), JSON.stringify(result));
  // When settings read the status, Then the outcome is shown as recorded.
  assert.deepEqual((await s.call("/upgrade")).body.lastResult, result);
  // And an unreadable or unexpected record is ignored rather than shown.
  for (const raw of ["{", JSON.stringify({ ...result, outcome: "pwned" }), JSON.stringify({ ...result, version: "<b>" })]) {
    await writeFile(join(s.dataDir, "runtime/upgrade-result.json"), raw);
    assert.equal((await s.call("/upgrade")).body.lastResult, null);
  }
});
