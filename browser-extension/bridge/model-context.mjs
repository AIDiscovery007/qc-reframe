import { createHash } from "node:crypto";
import { readFile, stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export async function readModelContext(request, cwd) {
  const { account, requiresOpenaiAuth } = await request("account/read", { refreshToken: false });
  if (!account && requiresOpenaiAuth) throw Object.assign(new Error("请先在本机 Codex CLI 登录，然后刷新模型列表。"), { recovery: "models" });
  const { config } = await request("config/read", { cwd, includeLayers: false });
  const provider = config.model_provider || "openai";
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  // File metadata also invalidates a selection when the same email switches workspace.
  const authStamp = await stat(join(home, "auth.json")).then((s) => s.mtimeMs, () => null);
  const binary = process.env.CODEX_BIN || "codex";
  let executable = binary;
  for (const candidate of binary.includes("/") || binary.includes("\\") ? [binary] : (process.env.PATH || "").split(delimiter).map((dir) => join(dir, binary))) {
    try { executable = await realpath(candidate); break; } catch {}
  }
  const executableStamp = await stat(executable).then(s => [s.ino, s.size, s.mtimeMs, s.ctimeMs], () => null);
  const packageRoot = executable.match(/^(.*[\\/]node_modules[\\/]@openai[\\/]codex)[\\/]/)?.[1];
  const packageVersion = packageRoot ? await readFile(join(packageRoot, "package.json"), "utf8").then(text => JSON.parse(text).version).catch(() => null) : null;
  const accountKey = createHash("sha256").update(JSON.stringify({ account, provider,
    providerConfig: config.model_providers?.[provider], authStamp, home, executable, executableStamp, packageVersion })).digest("hex");
  return { accountKey, provider, accountLabel: account?.type === "chatgpt"
    ? `ChatGPT · ${account.planType}` : account?.type || provider };
}

export async function assertModelContext(request, cwd, selection) {
  if (!selection?.model) throw Object.assign(new Error("请在连接设置中选择模型，并点击「验证并使用」。"), { recovery: "models" });
  const current = await readModelContext(request, cwd);
  if (current.accountKey !== selection.accountKey)
    throw Object.assign(new Error("Codex 账号、登录或提供方已变化（或 CLI 已更换），请在连接设置中刷新模型列表并重新验证。"), { modelContextChanged: true, recovery: "models" });
}

export function modelError(error, model) {
  const message = error.message || String(error);
  if (/\breasoning[._\s-]+effort\b/i.test(message) && /\b(?:unsupported|not support(?:ed)?|invalid)\b/i.test(message)) return error;
  if (/not supported.*ChatGPT account|model.*(?:not found|not available|not supported|does not exist)|do not have access.*model|unsupported.*model/i.test(message))
    return Object.assign(new Error(`模型 ${model || "所选模型"} 当前无法通过本机 Codex 账号调用，请在连接设置中选择其他模型并验证。`), { modelUnavailable: true, recovery: "models", code: error.code, status: error.status });
  return error;
}
