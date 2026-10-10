import { createHash } from "node:crypto";
import { readFile, stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

async function readContext(request, cwd) {
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
  return { config, context: { accountKey, provider, accountLabel: account?.type === "chatgpt"
    ? `ChatGPT · ${account.planType}` : account?.type || provider } };
}

export async function readModelContext(request, cwd) {
  return (await readContext(request, cwd)).context;
}

export function generationContextError(error) {
  const reason = error.modelContextChanged ? "账号、登录、提供方或 CLI 已变化，请检查 Codex 配置后重新提交。"
    : error.modelUnavailable ? "CLI 配置的执行模型不可用，请检查 Codex 配置后重试。"
    : error.message.replace("然后刷新模型列表。", "然后重试。");
  return Object.assign(new Error(reason.startsWith("Codex 内置生图") ? reason : `Codex 内置生图：${reason}`), { status: error.status || 409, code: error.code, recovery: "cli" });
}

export async function readGenerationContext(request, cwd) {
  try {
    const { config, context } = await readContext(request, cwd);
    let model = config.model, reasoningEffort = config.model_reasoning_effort ?? undefined;
    if (model == null) {
      const defaults = new Map(), cursors = new Set();
      let cursor;
      do {
        const page = await request("model/list", { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
        for (const item of page.data || []) if (item.isDefault) defaults.set(item.model, item);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error("CLI 模型目录分页异常，请检查 Codex CLI 后重试。");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (defaults.size !== 1) throw new Error("无法确定唯一的 CLI 默认执行模型，请在 Codex CLI 配置中明确指定模型后重试。");
      const item = [...defaults.values()][0];
      model = item.model; reasoningEffort ??= item.defaultReasoningEffort;
    }
    if (typeof model !== "string" || !model.trim()) throw new Error("CLI 配置的执行模型无效，请检查 Codex 配置后重试。");
    return { model, reasoningEffort, provider: context.provider, accountKey: context.accountKey, codexGeneration: true };
  } catch (error) { throw generationContextError(error); }
}

export async function assertModelContext(request, cwd, selection) {
  if (!selection?.model) throw Object.assign(new Error("请在连接设置中选择模型，并点击「验证并使用」。"), { recovery: "models" });
  const { context: current, config } = await readContext(request, cwd);
  // An absent effort inherits CLI defaults; never let a queued image task inherit a later explicit override.
  if (selection.codexGeneration && selection.reasoningEffort == null && config.model_reasoning_effort != null)
    throw Object.assign(new Error("Codex 内置生图：CLI 推理配置已变化，请重新提交。"), { modelContextChanged: true });
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
