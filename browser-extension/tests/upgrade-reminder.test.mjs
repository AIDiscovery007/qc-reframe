import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const reminderCode = await compile("../lib/upgrade-reminder.ts"), rulesCode = await compile("../lib/service-upgrade.ts");
const release = version => ({ version, title: `QC-Reframe v${version}`, url: `https://github.com/AIDiscovery007/qc-reframe/releases/tag/v${version}`, publishedAt: null, notes: [] });
const status = (overrides = {}) => ({
  current: "0.8.0", install: "package", autoCheck: true, latest: release("0.9.0"), checkedAt: null, checkError: null,
  available: true, canUpgrade: true, reason: null, upgrading: false, lastResult: null, skippedVersion: null, remind: true, ...overrides,
});
const offline = new Error("本机服务未运行，启动后将自动连接。");

// Values created inside the VM are cloned on the way out so they compare with this realm's objects.
// A background with fake storage, alarms and notifications, reaching the service through `reply`.
async function harness({ local = { preferences: { token: "test-only" } }, reply = () => status(), alarmExists = false, permission = "granted", createFails = false } = {}) {
  const calls = [], notices = [], cleared = [], alarms = [], badges = [], opened = [];
  let onAlarm, onClicked, onButton;
  const browser = {
    storage: { local: {
      get: async keys => Object.fromEntries([keys].flat().filter(key => key in local).map(key => [key, structuredClone(local[key])])),
      set: async values => Object.assign(local, structuredClone(values)),
      remove: async key => { delete local[key]; },
    } },
    alarms: { get: async name => alarmExists ? { name } : undefined, create: async (name, info) => { alarms.push({ name, ...info }); }, onAlarm: { addListener(fn) { onAlarm = fn; } } },
    notifications: {
      getPermissionLevel: async () => permission,
      create: async (id, value) => { if (createFails) throw new Error("not shown"); notices.push(structuredClone({ id, ...value })); },
      clear: async id => { cleared.push(id); },
      onClicked: { addListener(fn) { onClicked = fn; } }, onButtonClicked: { addListener(fn) { onButton = fn; } },
    },
    runtime: { getURL: path => `chrome-extension://test${path}` },
  };
  const rules = {};
  runInNewContext(rulesCode, { exports: rules });
  const exports = {};
  runInNewContext(reminderCode, { exports, console: { error() {} }, require: name => name === "wxt/browser" ? { browser } : name === "./service-upgrade" ? rules : undefined });
  const bridge = async (path, token, body) => { calls.push(structuredClone({ path, token, body })); const value = reply(path, body); if (value instanceof Error) throw value; return value; };
  const service = exports.startUpgradeReminder({ bridge, extensionVersion: () => "0.8.0",
    refreshBadge: async () => { badges.push(local.upgradeBadge ?? null); }, openSettings: async () => { opened.push("connection"); } });
  await service.ready;
  return { local, calls, notices, cleared, alarms, badges, opened, service,
    alarm: async name => { onAlarm({ name }); await service.idle(); },
    click: async id => { onClicked(id); await service.idle(); },
    button: async (id, index) => { onButton(id, index); await service.idle(); } };
}

// Scenario: user is reminded of a new release without opening the extension
//   Given automatic checks are on, the service runs and 0.9.0 was just released
//   When the background checks on its schedule
//   Then the icon says NEW and one notification offers 查看并升级 and 跳过此版本
// Scenario: user is reminded only once per release
//   Given 0.9.0 was already reminded
//   When later checks run, also after the worker restarts
//   Then no further notification is shown and NEW stays
test("user is reminded of a new release once, without opening the extension", async () => {
  const h = await harness();
  assert.deepEqual(h.alarms, [{ name: "reframe-upgrade-check", periodInMinutes: 30 }]);
  assert.deepEqual(h.calls, [{ path: "/upgrade?check=auto", token: "test-only", body: undefined }]);
  assert.equal(h.local.upgradeBadge, "0.9.0");
  assert.deepEqual(h.badges, ["0.9.0"]);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].id, "reframe-upgrade");
  assert.equal(h.notices[0].title, "QC-Reframe 0.9.0 可用");
  assert.deepEqual(h.notices[0].buttons, [{ title: "查看并升级" }, { title: "跳过此版本" }]);
  // When the schedule fires again, Then the service is asked again but nothing new is shown.
  await h.alarm("reframe-upgrade-check");
  await h.alarm("reframe-task-reminders");
  assert.equal(h.calls.length, 2);
  assert.equal(h.notices.length, 1);
  assert.deepEqual(h.badges, ["0.9.0"], "an unchanged reminder does not redraw the icon");
  // When the worker restarts, Then the existing schedule is kept rather than pushed back, and nothing is repeated.
  const restarted = await harness({ local: h.local, alarmExists: true });
  assert.deepEqual(restarted.alarms, []);
  assert.equal(restarted.notices.length, 0);
  assert.equal(restarted.local.upgradeBadge, "0.9.0");
});

// Scenario: user opens the upgrade from the reminder
//   When the user clicks the notification or 查看并升级
//   Then 设置中心 › 本机连接 opens
// Scenario: user skips a release from the reminder
//   When the user clicks 跳过此版本
//   Then the service records the skip and NEW disappears; if the service cannot be reached NEW stays
test("user opens or skips the release from the reminder", async () => {
  let skipFails = true;
  const h = await harness({ reply: (path, body) => path === "/upgrade/settings" ? skipFails ? offline : status({ skippedVersion: body.skippedVersion, remind: false }) : status() });
  await h.click("reframe-tasks");
  await h.button("reframe-tasks", 1);
  assert.deepEqual(h.opened, []);
  assert.equal(h.calls.length, 1, "other notifications are not ours");
  await h.click("reframe-upgrade");
  await h.button("reframe-upgrade", 0);
  assert.deepEqual(h.opened, ["connection", "connection"]);
  // When skipping fails, Then the reminder stays so the user can skip in settings.
  await h.button("reframe-upgrade", 1);
  assert.deepEqual(h.calls.at(-1), { path: "/upgrade/settings", token: "test-only", body: { skippedVersion: "0.9.0" } });
  assert.equal(h.local.upgradeBadge, "0.9.0");
  // When skipping succeeds, Then NEW and the notification are gone.
  skipFails = false;
  await h.button("reframe-upgrade", 1);
  assert.equal(h.local.upgradeBadge, undefined);
  assert.equal(h.badges.at(-1), null);
  assert.ok(h.cleared.includes("reframe-upgrade"));
});

// Scenario: user whose service is stopped is not disturbed
// Scenario: user who turned off automatic checks gets no reminder
// Scenario: user who denied notifications still sees the badge
// Scenario: user stops being reminded after upgrading
test("user is not disturbed when unpaired, offline, opted out, denied notifications or already upgraded", async () => {
  // Given no pairing, Then the service is not contacted.
  const unpaired = await harness({ local: {} });
  assert.deepEqual(unpaired.calls, []);
  assert.deepEqual(unpaired.notices, []);
  // Given the service is stopped, Then nothing is shown and an earlier reminder stays.
  const stopped = await harness({ local: { preferences: { token: "test-only" }, upgradeBadge: "0.9.0", upgradeNotified: "0.9.0" }, reply: () => offline });
  assert.equal(stopped.local.upgradeBadge, "0.9.0");
  assert.deepEqual(stopped.notices, []);
  // Given automatic checks were turned off, Then the earlier reminder is cleared.
  const optedOut = await harness({ local: { preferences: { token: "test-only" }, upgradeBadge: "0.9.0", upgradeNotified: "0.9.0" }, reply: () => status({ autoCheck: false, remind: false }) });
  assert.equal(optedOut.local.upgradeBadge, undefined);
  assert.deepEqual(optedOut.badges, [null]);
  assert.ok(optedOut.cleared.includes("reframe-upgrade"));
  // Given notifications are denied or cannot be shown, Then the icon still says NEW.
  for (const options of [{ permission: "denied" }, { createFails: true }]) {
    const quiet = await harness(options);
    assert.equal(quiet.local.upgradeBadge, "0.9.0");
    assert.deepEqual(quiet.notices, []);
  }
  // Given the service already runs 0.9.0, Then nothing is reminded.
  const upgraded = await harness({ local: { preferences: { token: "test-only" }, upgradeBadge: "0.9.0", upgradeNotified: "0.9.0" }, reply: () => status({ current: "0.9.0", available: false, remind: false }) });
  assert.equal(upgraded.local.upgradeBadge, undefined);
  assert.deepEqual(upgraded.notices, []);
});

// Scenario: user skips a release from settings
//   Given the user sees 0.9.0 in the extension
//   Then the icon follows what the user saw and no system notification repeats it
test("user who already saw the release in the extension gets no system notification for it", async () => {
  const h = await harness({ local: { preferences: { token: "test-only" } }, reply: () => offline });
  await h.service.seen(status());
  assert.equal(h.local.upgradeBadge, "0.9.0");
  assert.equal(h.local.upgradeNotified, "0.9.0");
  assert.deepEqual(h.notices, []);
  // And a reply that is not an upgrade status changes nothing.
  await h.service.seen({ error: "x" });
  await h.service.seen(undefined);
  assert.equal(h.local.upgradeBadge, "0.9.0");
  await h.service.seen(status({ skippedVersion: "0.9.0", remind: false }));
  assert.equal(h.local.upgradeBadge, undefined);
});
