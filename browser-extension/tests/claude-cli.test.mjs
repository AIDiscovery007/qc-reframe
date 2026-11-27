import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClaudeCliManager, inspectClaude, latestClaudeRelease, resolveClaudeExecutable } from "../bridge/claude-cli.mjs";

async function directory(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "reframe-claude-cli-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function executable(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return path;
}
async function linked(target, link) {
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link);
  return link;
}
const run = (version = "2.1.0", help = "Usage: claude update [options]") => async (_file, args) => args[0] === "--version" ? `${version} (Claude Code)` : help;
async function settled(manager) {
  for (let i = 0; i < 100 && manager.busy; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(manager.busy, false);
  return manager.status();
}

test("user's standalone Claude Code is found without CLAUDE_BIN and upgraded only through its own launcher", { skip: process.platform === "win32" }, async t => {
  // Given the official installer's launcher links to a versioned binary that offers `claude update`.
  const home = await directory(t);
  const binary = await executable(join(home, ".local/share/claude/versions/2.1.0"));
  const launcher = await linked(binary, join(home, ".local/bin/claude"));
  // When the bridge looks for Claude Code with an empty PATH.
  const env = { HOME: home, PATH: "" };
  assert.equal((await resolveClaudeExecutable(env)).executable, launcher);
  const info = await inspectClaude({ env, run: run() });
  // Then only the launcher is a manager, and a launcher without `update` stays manual.
  assert.equal(info.source, "standalone");
  assert.equal(info.version, "2.1.0");
  assert.equal(info.manager, launcher);
  assert.equal((await inspectClaude({ env, run: run("2.1.0", "Usage: claude [options]") })).manager, undefined);
  const pinned = await inspectClaude({ env: { ...env, CLAUDE_BIN: binary }, run: run() });
  assert.equal(pinned.manager, undefined);
  assert.match(pinned.reason, /固定到某个版本文件/);
  assert.equal((await inspectClaude({ env, run: run("2.0.9") })).source, "custom");
});

test("user sees the matching manual update path for npm, Homebrew, desktop-app and missing Claude Code", { skip: process.platform === "win32" }, async t => {
  // Given Claude Code from each source the bridge must not update itself.
  const dir = await directory(t);
  const npm = await linked(await executable(join(dir, "npm/lib/node_modules/@anthropic-ai/claude-code/cli.js")), join(dir, "npm/bin/claude"));
  const brew = await executable(join(dir, "Caskroom/claude-code/2.1.0/claude"));
  const app = await executable(join(dir, "Claude.app/Contents/Resources/claude"));
  const custom = await executable(join(dir, "custom/claude"));
  // When each installation is inspected, Then none receives an automatic updater and each names its own path.
  const cases = [[npm, "npm", /npm 全局安装.*claude update/], [brew, "homebrew", /brew upgrade --cask claude-code/], [app, "app", /桌面 App/], [custom, "custom", /原安装方式/]];
  for (const [path, source, reason] of cases) {
    const info = await inspectClaude({ env: { CLAUDE_BIN: path }, run: run() });
    assert.equal(info.source, source);
    assert.equal(info.manager, undefined);
    assert.match(info.reason, reason);
  }
  const broken = await inspectClaude({ env: { CLAUDE_BIN: npm }, run: async () => { throw new Error("spawn failed"); } });
  assert.match(broken.reason, /无法运行或版本无法识别/);
  assert.match((await inspectClaude({ env: { CLAUDE_BIN: join(dir, "missing") }, run: run() })).reason, /CLAUDE_BIN/);
  assert.match((await inspectClaude({ env: { HOME: dir, PATH: "" }, run: run() })).reason, /未找到本机 Claude Code CLI/);
});

test("user upgrades a standalone Claude Code with the fixed update command and must re-verify models", async () => {
  // Given a standalone Claude Code with a newer stable release.
  let version = "2.1.0", refreshed = 0;
  const commands = [];
  const manager = createClaudeCliManager({
    inspect: async () => ({ installed: true, version, executable: "/home/.local/bin/claude", source: "standalone", manager: "/home/.local/bin/claude", managerEnv: {} }),
    latest: async () => "2.2.0",
    run: async (file, args) => { commands.push([file, args]); version = "2.2.0"; },
    onUpdated: async () => { refreshed++; },
  });
  // When the user checks and upgrades.
  const checked = await manager.check();
  assert.equal(checked.command, "'/home/.local/bin/claude' update");
  assert.equal(checked.instructions.loginCommand, "'/home/.local/bin/claude' auth login");
  await manager.update();
  // Then only `claude update` ran, the new version is confirmed and the model selection is reset.
  assert.equal((await settled(manager)).operation.status, "completed");
  assert.deepEqual(commands, [["/home/.local/bin/claude", ["update"]]]);
  assert.equal(refreshed, 1);
});

test("user's unmanaged or ineffective Claude Code upgrade fails explicitly", async () => {
  // Given an npm install, Then the newer stable release is only a reference and upgrading is refused with its reason.
  const npm = createClaudeCliManager({
    inspect: async () => ({ installed: true, version: "2.1.0", executable: "/npm/bin/claude", source: "npm", reason: "当前通过 npm 全局安装，请在终端运行 claude update 后重新检测。" }),
    latest: async () => "2.2.0", run: async () => assert.fail("unmanaged installs must not run commands"),
  });
  const state = await npm.check();
  assert.equal(state.comparisonReference, "npm-stable");
  assert.equal(state.canUpdate, false);
  assert.match(state.instructions.message, /npm 全局安装/);
  await assert.rejects(npm.update(), /npm 全局安装/);
  // Given `claude update` leaves the version unchanged, Then the upgrade is reported as failed for Claude Code.
  const stuck = createClaudeCliManager({
    inspect: async () => ({ installed: true, version: "2.1.0", executable: "/home/.local/bin/claude", source: "standalone", manager: "/home/.local/bin/claude", managerEnv: {} }),
    latest: async () => "2.2.0", run: async () => {},
  });
  await stuck.update();
  const failed = (await settled(stuck)).operation;
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /升级后的 Claude Code 路径或版本不符合预期/);
});

test("user's update check reads the npm stable channel and rejects unusable versions", async () => {
  // Given the registry dist-tags, When the latest version is read, Then only a valid `stable` version is accepted.
  let request;
  const fetcher = body => async (url, options) => { request = { url, options }; return { ok: true, json: async () => body }; };
  assert.equal(await latestClaudeRelease("npm", fetcher({ latest: "2.3.0", stable: "2.2.0" })), "2.2.0");
  assert.equal(request.url, "https://registry.npmjs.org/-/package/@anthropic-ai%2fclaude-code/dist-tags");
  assert.equal(request.options.redirect, "error");
  await assert.rejects(latestClaudeRelease("npm", fetcher({ stable: "next" })), /无法识别/);
  await assert.rejects(latestClaudeRelease("npm", async () => ({ ok: false })), /暂时不可用/);
});
