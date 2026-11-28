import test from "node:test";
import assert from "node:assert/strict";
import {
  newerVersion, upgradeHint, remindedVersion, waitForUpgrade, upgradeOutcomeMessage, markReopenAfterReload, reopenAfterReload, REOPEN_KEY,
} from "../lib/service-upgrade.ts";

const status = (overrides = {}) => ({
  current: "0.8.0", install: "package", autoCheck: true, latest: null, checkedAt: null, checkError: null,
  available: false, canUpgrade: false, reason: null, upgrading: false, lastResult: null, ...overrides,
});
const release = version => ({ version, title: `v${version}`, url: `https://github.com/AIDiscovery007/qc-reframe/releases/tag/v${version}`, publishedAt: null });
const ticket = { version: "0.9.0", startedAt: "2026-11-27T10:00:00.000Z" };
const result = (outcome, stage = null, overrides = {}) => ({ version: "0.9.0", from: "0.8.0", outcome, stage, at: "2026-11-27T10:03:00.000Z", ...overrides });
const scripted = replies => {
  let calls = 0;
  const read = async () => { const value = replies[Math.min(calls++, replies.length - 1)]; if (value instanceof Error) throw value; return value; };
  return { read, get calls() { return calls; } };
};
const offline = new Error("本机服务未运行，启动后将自动连接。");
const instant = async () => {};

// Scenario: user sees which action the workspace offers
//   Given the extension that is running and the service it reaches
//   When the service has a newer release, or already runs a newer version than the extension
//   Then the sidebar offers the upgrade, or a reload first so the extension matches the service
test("user is offered an upgrade only for a newer release, and a reload once the service is ahead of the extension", () => {
  assert.equal(upgradeHint("0.8.0", undefined), undefined);
  assert.equal(upgradeHint("0.8.0", status()), undefined);
  assert.equal(upgradeHint("0.8.0", status({ latest: release("0.8.0") })), undefined);
  assert.equal(upgradeHint("0.8.0", status({ latest: release("0.9.0"), available: true })), "available");
  assert.equal(upgradeHint("0.8.0", status({ current: "0.9.0" })), "reload");
  assert.equal(upgradeHint("0.8.0", status({ current: "0.9.0", latest: release("1.0.0"), available: true })), "reload");
  assert.equal(upgradeHint("0.9.0", status()), undefined, "an extension newer than its service is not an upgrade");
  // And a release the user skipped, or any release while automatic checks are off, is not pointed out; a service from
  // before reminders existed sends no `remind` and keeps offering what is available.
  assert.equal(upgradeHint("0.8.0", status({ latest: release("0.9.0"), available: true, remind: false, skippedVersion: "0.9.0" })), undefined);
  assert.equal(upgradeHint("0.8.0", status({ latest: release("0.9.0"), available: true, remind: true })), "available");
  assert.equal(newerVersion("0.10.0", "0.9.9"), true);
  assert.equal(newerVersion("1.0.0", "1.0.0"), false);
  for (const invalid of ["v1.0.0", "1.0", "01.0.0", "", undefined]) assert.equal(newerVersion(invalid, "0.0.1"), false);
});

// Scenario: user is reminded of a new release without opening the extension
//   Given the status the background reads from the service
//   When a newer release should be pointed out
//   Then the reminder names that release; otherwise there is none, also while the extension still needs a reload
test("user is reminded only of a release the service says to point out", () => {
  assert.equal(remindedVersion("0.8.0", undefined), null);
  assert.equal(remindedVersion("0.8.0", status({ latest: release("0.9.0"), available: true, remind: true })), "0.9.0");
  assert.equal(remindedVersion("0.8.0", status({ latest: release("0.9.0"), available: true, remind: false })), null);
  // An older service sends no `remind` and cannot report the user's opt-out, so it never earns a background reminder.
  assert.equal(remindedVersion("0.8.0", status({ latest: release("0.9.0"), available: true, autoCheck: false })), null);
  assert.equal(remindedVersion("0.8.0", status({ latest: release("0.9.0"), available: true })), null);
  assert.equal(remindedVersion("0.8.0", status({ latest: release("0.8.0") })), null);
  assert.equal(remindedVersion("0.8.0", status({ current: "0.9.0", latest: release("1.0.0"), available: true, remind: true })), null);
});

// Scenario: user waits while the upgrade runs
//   Given an accepted upgrade ticket for 0.9.0
//   When the service goes away during replacement and comes back as 0.9.0
//   Then the wait ends with success, and the outage is not mistaken for a failure
test("user waiting on an upgrade sees success once the new version answers, through the service outage", async () => {
  const done = status({ current: "0.9.0", lastResult: result("upgraded") });
  const replies = scripted([status({ upgrading: true }), offline, offline, status({ upgrading: true, current: "0.8.0" }), done]);
  const outcome = await waitForUpgrade(ticket, replies.read, new AbortController().signal, 1000, instant);
  assert.equal(outcome.outcome, "upgraded");
  assert.equal(outcome.status, done);
  assert.equal(replies.calls, 5);
  assert.match(upgradeOutcomeMessage(outcome.outcome, outcome.result, ticket.version), /已升级到 0\.9\.0/);
});

// Scenario: user's upgrade fails and the installation is restored
//   Given an accepted upgrade ticket for 0.9.0
//   When the installer rolls back after setup fails and restarts 0.8.0
//   Then the wait reports the rollback and the stage, not a timeout; older or unrelated records are ignored
test("user sees a restored installation and the failed stage when the new version cannot start", async () => {
  const stale = status({ lastResult: result("failed", "download", { at: "2026-11-27T09:00:00.000Z" }), upgrading: true });
  const other = status({ lastResult: result("failed", "download", { version: "0.8.5" }), upgrading: true });
  const rolledBack = result("rolled_back", "setup");
  const replies = scripted([stale, other, offline, status({ lastResult: rolledBack })]);
  const outcome = await waitForUpgrade(ticket, replies.read, new AbortController().signal, 1000, instant);
  assert.equal(outcome.outcome, "rolled_back");
  assert.deepEqual(outcome.result, rolledBack);
  assert.match(upgradeOutcomeMessage(outcome.outcome, outcome.result, ticket.version), /初始化.*已恢复 0\.8\.0/);
});

// Scenario: user's upgrade is refused before anything changes
//   Given an accepted upgrade ticket
//   When the download or signature check fails, or the installer exits without a record
//   Then the user learns nothing was changed, or where the log is
test("user learns whether the installation was changed when the installer stops early or vanishes", async () => {
  for (const [stage, label] of [["download", "下载"], ["verify", "校验"], ["stop", "停止旧服务"]]) {
    const failed = result("failed", stage);
    const outcome = await waitForUpgrade(ticket, scripted([status({ lastResult: failed })]).read, new AbortController().signal, 1000, instant);
    assert.equal(outcome.outcome, "failed");
    const message = upgradeOutcomeMessage(outcome.outcome, outcome.result, ticket.version);
    assert.ok(message.includes(label) && message.includes("本机服务未改动"), message);
  }
  for (const stage of ["replace", "setup", "start", null])
    assert.match(upgradeOutcomeMessage("failed", result("failed", stage), ticket.version), /未能自动恢复.*重新运行安装命令/);
  const vanished = await waitForUpgrade(ticket, scripted([status({ upgrading: true }), status()]).read, new AbortController().signal, 1000, instant);
  assert.deepEqual([vanished.outcome, vanished.result], ["failed", null]);
  assert.match(upgradeOutcomeMessage(vanished.outcome, vanished.result, ticket.version), /\.local\/logs\/upgrade\.log/);
});

// Scenario: user's upgrade cannot be confirmed
//   Given an accepted upgrade ticket
//   When the service never answers again before the deadline, or the settings page closes
//   Then the user gets the status command and log location, and a closed page stops polling
test("user gets recovery guidance when the upgrade cannot be confirmed, and closing the page stops waiting", async () => {
  let now = 0;
  const clock = () => now++;
  await assert.rejects(waitForUpgrade(ticket, async () => { throw offline; }, new AbortController().signal, 3, instant, clock),
    /npm run status.*\.local\/logs\/upgrade\.log/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(waitForUpgrade(ticket, () => assert.fail("a closed page must not poll"), controller.signal), { name: "AbortError" });
});

// Scenario: user returns to the connection settings after the extension reloads
//   Given the extension reloads itself to finish an upgrade
//   When it starts again within two minutes
//   Then the workspace reopens once on the connection settings; an old or invalid mark is dropped without opening
test("user returns to the connection settings once after the extension reloads itself", async () => {
  const data = {};
  const storage = {
    get: async key => ({ [key]: data[key] }),
    set: async value => { Object.assign(data, value); },
    remove: async key => { delete data[key]; },
  };
  let opened = 0;
  const open = async () => { opened++; };
  await markReopenAfterReload(storage, 1_000);
  assert.equal(data[REOPEN_KEY], 1_000);
  assert.equal(await reopenAfterReload(storage, open, 61_000), true);
  assert.equal(await reopenAfterReload(storage, open, 62_000), false);
  assert.equal(opened, 1);
  for (const mark of [1_000, "1000", 999_999]) {
    data[REOPEN_KEY] = mark;
    assert.equal(await reopenAfterReload(storage, open, 200_000), false);
    assert.equal(REOPEN_KEY in data, false);
  }
  assert.equal(opened, 1);
});
