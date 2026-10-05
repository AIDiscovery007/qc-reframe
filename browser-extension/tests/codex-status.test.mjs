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
