import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_INSTRUCTIONS_PATH, PLUGIN_INSTRUCTIONS_LIMIT, createPluginInstructionsStore } from "../bridge/plugin-instructions.mjs";
import { reverseInstructions, runAgent } from "../bridge/agent.mjs";

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), "reframe-instructions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("user starts with the built-in designer instruction and can replace it with their own", async t => {
  // Given a fresh installation without a custom instruction file.
  const dir = await folder(t);
  const builtin = (await readFile(BUILTIN_INSTRUCTIONS_PATH, "utf8")).trim();
  const store = await createPluginInstructionsStore({ dataDir: dir });
  const initial = store.view();
  // Then reverse tasks use the shipped instruction, written from the reverse-prompt and senior-designer perspective.
  assert.equal(initial.custom, false);
  assert.equal(initial.text, builtin);
  assert.equal(initial.builtin, builtin);
  assert.equal(initial.maxLength, PLUGIN_INSTRUCTIONS_LIMIT);
  assert.match(builtin, /逆向/);
  assert.match(builtin, /资深.*设计师/);
  assert.equal(store.snapshot(), builtin);

  // When the user saves their own instruction with Windows line endings.
  const saved = await store.save({ text: "  只用摄影术语描述光线。\r\n保留可读文字。  ", revision: initial.revision });
  // Then the normalized text becomes the private override and survives a restart.
  assert.equal(saved.custom, true);
  assert.equal(saved.text, "只用摄影术语描述光线。\n保留可读文字。");
  assert.notEqual(saved.revision, initial.revision);
  const file = join(dir, "plugin-instructions.md");
  assert.equal(await readFile(file, "utf8"), saved.text);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const restarted = await createPluginInstructionsStore({ dataDir: dir });
  assert.deepEqual(restarted.view(), saved);
  assert.equal(restarted.snapshot(), saved.text);
});

test("user restoring the built-in text follows later built-in updates instead of freezing a copy", async t => {
  // Given a custom instruction.
  const dir = await folder(t);
  const builtinPath = join(dir, "builtin.md");
  await writeFile(builtinPath, "内置 v1");
  const store = await createPluginInstructionsStore({ dataDir: dir, builtinPath });
  const custom = await store.save({ text: "自定义", revision: store.view().revision });
  // When the user saves text identical to the built-in instruction.
  const restored = await store.save({ text: "内置 v1\n", revision: custom.revision });
  // Then the override is removed, and a later built-in update applies.
  assert.equal(restored.custom, false);
  await assert.rejects(stat(join(dir, "plugin-instructions.md")), { code: "ENOENT" });
  await writeFile(builtinPath, "内置 v2");
  const upgraded = await createPluginInstructionsStore({ dataDir: dir, builtinPath });
  assert.equal(upgraded.view().text, "内置 v2");
  assert.equal(upgraded.view().custom, false);
});

test("user can clear the instruction so reverse tasks add none", async t => {
  // Given the built-in instruction.
  const dir = await folder(t);
  const store = await createPluginInstructionsStore({ dataDir: dir });
  // When the user saves an empty instruction.
  const cleared = await store.save({ text: " \n ", revision: store.view().revision });
  // Then the empty override is kept and nothing is appended to the reverse rules.
  assert.equal(cleared.custom, true);
  assert.equal(cleared.text, "");
  assert.equal(store.snapshot(), "");
  assert.equal(reverseInstructions(store.snapshot()), reverseInstructions(undefined));
  assert.equal((await createPluginInstructionsStore({ dataDir: dir })).view().text, "");
});

test("user's stale or invalid instruction save is rejected and the saved text is kept", async t => {
  // Given a saved custom instruction.
  const dir = await folder(t);
  const store = await createPluginInstructionsStore({ dataDir: dir });
  const saved = await store.save({ text: "保存的指令", revision: store.view().revision });
  const file = join(dir, "plugin-instructions.md");
  // When another window saves with an old revision, or the request is malformed.
  await assert.rejects(store.save({ text: "旧窗口", revision: "stale" }), { status: 409, message: /其他窗口/ });
  for (const body of [
    { text: "x".repeat(PLUGIN_INSTRUCTIONS_LIMIT + 1), revision: saved.revision },
    { text: "控制\u0000字符", revision: saved.revision },
    { text: 42, revision: saved.revision },
    { text: "缺少版本" },
    { text: "多余字段", revision: saved.revision, reset: true },
  ]) await assert.rejects(store.save(body), { status: 400 });
  // Then neither the file nor the effective instruction changes.
  assert.equal(await readFile(file, "utf8"), "保存的指令");
  assert.deepEqual(store.view(), saved);
});

test("user's unreadable instruction file fails explicitly and is preserved", async t => {
  // Given an instruction file edited outside Reframe beyond the limit.
  const dir = await folder(t);
  const file = join(dir, "plugin-instructions.md");
  const oversized = "x".repeat(PLUGIN_INSTRUCTIONS_LIMIT + 1);
  await writeFile(file, oversized);
  // When the service loads it, Then it reports the file instead of silently using the built-in text.
  await assert.rejects(createPluginInstructionsStore({ dataDir: dir }), { status: 500, message: /plugin-instructions\.md/ });
  assert.equal(await readFile(file, "utf8"), oversized);
});

test("user's plugin instruction joins the reverse rules for every Agent without overriding them", async t => {
  // Given a reverse run with a plugin instruction.
  const dir = await folder(t);
  const skillPath = join(dir, "SKILL.md");
  await writeFile(skillPath, "---\nname: alchemy\n---\nskill");
  const image = join(dir, "a.png");
  await writeFile(image, Buffer.from("png"));
  let sent;
  const run = async options => { sent = options; return { text: JSON.stringify({ title: "t", promptZh: "中", promptEn: "en", negativePrompt: "", observations: [], uncertainties: [] }) }; };
  // When runAgent hands the task to the Agent adapter.
  await runAgent({ run, imagePath: image, mode: "style", skillPath, cwd: dir, dataDir: dir, pluginInstructions: "用伦勃朗光等专业布光术语。" });
  // Then the Reframe rules come first, the plugin instruction follows inside its own boundary,
  // and it is marked as unable to change permissions, image scope or the output protocol.
  const base = reverseInstructions(undefined);
  assert.ok(sent.instructions.startsWith(base));
  assert.match(sent.instructions, /<plugin-instructions>\n用伦勃朗光等专业布光术语。\n<\/plugin-instructions>/);
  assert.match(sent.instructions, /AGENTS\.md/);
  assert.match(sent.instructions, /任务指令优先/);
  assert.match(sent.instructions, /不能.*权限.*输出协议/);
  // And the user's text is never placed in the user turn, so it cannot pose as the task instruction.
  assert.ok(sent.input.every(item => item.type !== "text" || !item.text.includes("伦勃朗光")));

  // When an old task has no instruction snapshot, Then only the Reframe rules are sent.
  await runAgent({ run, imagePath: image, mode: "style", skillPath, cwd: dir, dataDir: dir });
  assert.equal(sent.instructions, base);
});
