import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const exports = {};
runInNewContext(ts.transpileModule(await readFile(new URL("../lib/codex-status.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
const { cliLabel, compatibilityMessage, recoverySection } = exports;
const installed = { installed: true, version: "0.100.0", latestVersion: "0.100.0", checkedAt: "2026-10-05", source: "npm" };
test("CLI labels distinguish offline, unknown, reference and completed checks", () => {
  assert.equal(cliLabel({ ...installed, checkError: "offline" }), "暂时无法检查更新");
  assert.equal(cliLabel({ ...installed, version: null }), "需要检查安装");
  assert.equal(cliLabel({ ...installed, installed: false }), "需要安装 CLI");
  assert.equal(cliLabel({ ...installed, checkedAt: null }), "已安装");
  assert.equal(cliLabel({ ...installed, comparisonReference: "npm-stable", updateAvailable: true }), "有新版可供参考");
  assert.equal(cliLabel(installed), "当前渠道无更新");
});
test("recovery keeps service failures separate from CLI and account/model failures", () => {
  for (const [message, expected] of [["当前 Codex CLI 不支持接口", "cli"], ["模型列表读取失败，请登录", "models"], ["配对码不正确", "connection"], ["找不到 Alchemy 技能，请设置 ALCHEMY_SKILL_PATH", "connection"], ["请先在本机 Codex CLI 登录，然后刷新模型列表。", "models"], ["Codex 账号、登录或提供方已变化（或 CLI 已更换），请刷新模型列表并重新验证。", "models"], ["图片过大", undefined]])
    assert.equal(recoverySection(message), expected);
});
test("capability summaries do not promise model/image access or block unknown checks", () => {
  assert.match(compatibilityMessage({ features: { reverse: { status: "unknown" } } }), /仍可尝试/);
  assert.match(compatibilityMessage({ features: { reverse: { status: "supported" } } }), /账户权限/);
  assert.match(compatibilityMessage({ features: { sessions: { status: "unsupported" }, reverse: { status: "supported" } } }), /会话创作.*其他功能可继续使用/);
});

test("Given a historical Pi CLI failure, recovery opens Pi management without changing reverse selection", () => {
  assert.equal(recoverySection("Pi CLI 未安装，请安装后重试"), "pi-cli");
  assert.equal(recoverySection("Pi 无法启动，请检查路径"), "pi-cli");
  assert.equal(recoverySection("Pi 模型当前不可用"), "models");
});

test("Given a Claude Code failure, recovery opens Claude Code CLI management only for installation problems", () => {
  for (const message of ["找不到 Claude Code CLI，请先安装 Claude Code 或配置 CLAUDE_BIN。", "Claude Code 无法启动，请检查路径", "CLAUDE_BIN 指定的 Claude Code 不存在，请修正配置后重试。"])
    assert.equal(recoverySection(message), "claude-cli");
  for (const message of ["Claude Code 未登录，请在终端运行 claude auth login 后刷新模型列表。", "Claude Code 无法使用所选模型，请刷新模型列表后重新选择。", "Claude Code 登录账号或本机程序已变化，请刷新模型列表并重新验证。"])
    assert.equal(recoverySection(message), "models");
});

test("Given built-in generation errors, recovery targets Codex CLI before text-model keywords", () => {
  for (const message of ["Codex 内置生图：请先登录", "Codex 内置生图：执行模型缺失，请检查配置", "Codex 内置生图：账号已变化，请重新验证", "Codex 内置生图：IMAGEGEN_SKILL_PATH 不可用"])
    assert.equal(recoverySection(message), "cli");
  assert.equal(recoverySection("生图 API Key 尚未配置"), "generation");
});
