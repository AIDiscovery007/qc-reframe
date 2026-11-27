import { homedir } from "node:os";
import { join } from "node:path";
import { createCliManager, resolveExecutable, runCliCommand, quote } from "./cli.mjs";

const parseVersion = text => String(text).trim().match(/^(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\s+\(Claude Code\))?$/)?.[1] || null;
const unmanaged = "此安装来源无法安全自动升级，请通过原安装方式更新。";

/** `CLAUDE_BIN`, then `claude` on PATH, then the official native installer's launcher. */
export async function resolveClaudeExecutable(env = process.env) {
  if (env.CLAUDE_BIN) return resolveExecutable(env.CLAUDE_BIN, env);
  return await resolveExecutable("claude", env) || await resolveExecutable(join(env.HOME || homedir(), ".local/bin/claude"), env);
}

/**
 * Only the native installer's launcher is upgraded in place, with the fixed `claude update`.
 * npm, Homebrew, desktop-app and custom installs show their own update path instead.
 */
export async function inspectClaude({ env = process.env, run = runCliCommand } = {}) {
  const located = await resolveClaudeExecutable(env);
  if (!located) return { installed: false, version: null, executable: null, source: "missing",
    reason: env.CLAUDE_BIN ? "CLAUDE_BIN 指定的 Claude Code 不存在，请修正配置后重试。" : "未找到本机 Claude Code CLI，请按官方说明安装后重新检测。" };
  const { executable, resolved } = located;
  const info = { installed: true, version: null, executable, source: "custom", reason: unmanaged };
  try { info.version = parseVersion(await run(executable, ["--version"], { env: { ...env, DISABLE_AUTOUPDATER: "1" } })); } catch {}
  if (!info.version) info.reason = "Claude Code CLI 无法运行或版本无法识别，请通过原安装方式检查。";
  if (/\.app[\\/]Contents[\\/]/i.test(resolved)) return { ...info, source: "app", reason: "当前使用桌面 App 内置 Claude Code，请通过该 App 更新。" };
  if (/[\\/]lib[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]/.test(resolved))
    return { ...info, source: "npm", reason: info.version ? "当前通过 npm 全局安装，请在终端运行 claude update 后重新检测。" : info.reason };
  if (/[\\/]Caskroom[\\/]claude-code[\\/]/.test(resolved))
    return { ...info, source: "homebrew", reason: info.version ? "当前通过 Homebrew 安装，请在终端运行 brew upgrade --cask claude-code 后重新检测。" : info.reason };
  const native = resolved.match(/[\\/]claude[\\/]versions[\\/]([^\\/]+)$/);
  if (!native || process.platform === "win32" || !info.version || native[1] !== info.version) return info;
  const detected = { ...info, source: "standalone", reason: "当前使用独立安装版，请在终端运行 claude update 更新。" };
  if (executable === resolved) return { ...detected, reason: "当前固定到某个版本文件，请将 CLAUDE_BIN 改为安装器创建的 claude 入口后更新。" };
  try {
    if (/Usage:\s+claude update\b/.test(await run(executable, ["update", "--help"], { env })))
      return { ...detected, reason: undefined, manager: executable, managerEnv: env };
  } catch {}
  return detected;
}

/** Compares with the npm `stable` dist-tag, so a release channel install is never told to downgrade. */
export async function latestClaudeRelease(_source, fetcher = fetch) {
  const response = await fetcher("https://registry.npmjs.org/-/package/@anthropic-ai%2fclaude-code/dist-tags", { signal: AbortSignal.timeout(12_000), redirect: "error" });
  if (!response.ok) throw new Error("版本服务暂时不可用，请稍后重试。");
  const version = parseVersion((await response.json())?.stable);
  if (!version) throw new Error("版本服务返回了无法识别的版本号。");
  return version;
}

export const claudeProduct = {
  name: "Claude Code",
  url: "https://code.claude.com/docs/en/setup",
  command: installation => installation?.manager ? `${quote(installation.executable)} update` : null,
  loginCommand: executable => `${quote(executable)} auth login`,
  comparisonReference: source => ["app", "custom", "npm", "homebrew"].includes(source) ? "npm-stable" : undefined,
  message: installation => installation?.reason || "使用当前安装来源升级后，重新检查并验证模型。",
  upgrade: (run, target, options) => run(target.executable, ["update"], options),
};

export function createClaudeCliManager(options = {}) {
  return createCliManager({ inspect: inspectClaude, latest: latestClaudeRelease, product: claudeProduct, ...options });
}
