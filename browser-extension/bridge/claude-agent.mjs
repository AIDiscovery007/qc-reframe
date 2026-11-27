import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { resolveClaudeExecutable } from "./claude-cli.mjs";
import { taskResources, taskSystemPrompt } from "./skill-resources.mjs";
import { CLAUDE_IMAGE_LIMITS } from "./claude-mcp.mjs";

const server = fileURLToPath(new URL("./claude-mcp.mjs", import.meta.url));
const MAX_OUTPUT = 128 * 1024 * 1024;
const TOOLS = ["mcp__reframe__alchemy_inspect_image", "mcp__reframe__alchemy_read_reference"];
// Documented `claude -p` flags: no user/project settings, hooks, CLAUDE.md, plugins' MCP servers, skills or saved sessions.
const isolation = ["--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--permission-prompts", "none", "--tools", ""];
const stream = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
const childEnv = env => ({ ...env, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
const missing = () => new Error("找不到 Claude Code CLI，请先安装 Claude Code 或配置 CLAUDE_BIN。");
const changed = () => Object.assign(new Error("Claude Code 登录账号或本机程序已变化，请刷新模型列表并重新验证。"), { modelContextChanged: true, recovery: "models" });

// Wait for process termination before removing private files or releasing task occupancy.
function invoke({ executable, args, cwd, env, input, endInput = true, signal, timeoutMs, onEvent }) {
  signal?.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: childEnv(env) });
    let failure, buffer = "", stdout = "", stderr = "", bytes = 0, killTimer;
    const stop = error => {
      failure ||= error;
      child.kill("SIGTERM");
      killTimer ||= setTimeout(() => child.kill("SIGKILL"), 1500);
    };
    const abort = () => stop(new Error("Claude Code 任务已取消。"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(new Error("Claude Code 响应超时，请重试。")), timeoutMs);
    const line = text => {
      if (!text.trim()) return;
      let event;
      try { event = JSON.parse(text); } catch { throw new Error("Claude Code 输出格式无法识别，请更新 CLI 后重试。"); }
      onEvent(event, child);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) return stop(new Error("Claude Code 输出超过限制。"));
      if (!onEvent) { stdout += chunk; return; }
      buffer += chunk;
      let newline;
      while (!failure && (newline = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try { line(text); } catch (error) { stop(error); }
      }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16_384); });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") stop(error); });
    child.on("error", error => { failure ||= error.code === "ENOENT" ? missing() : new Error("Claude Code CLI 无法启动，请检查安装与执行权限。"); });
    child.on("close", code => {
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (!failure && onEvent && buffer.trim()) { try { line(buffer); } catch (error) { failure = error; } }
      if (failure) reject(failure);
      else resolvePromise({ code, stdout, stderr: stderr.trim() });
    });
    if (endInput) child.stdin.end(input); else child.stdin.write(input);
  });
}

/** Login identity from the documented `claude auth status`, plus the executable fingerprint; tokens are never read. */
async function claudeContext(env = process.env, signal) {
  const located = await resolveClaudeExecutable(env);
  if (!located) throw missing();
  const { stdout } = await invoke({ executable: located.executable, args: ["auth", "status", "--json"], cwd: tmpdir(), env, signal, timeoutMs: 15_000 });
  let status;
  try { status = JSON.parse(stdout); } catch { throw new Error("Claude Code CLI 无法读取登录状态，请更新 CLI 后重试。"); }
  if (!status || typeof status !== "object" || status.loggedIn !== true)
    throw Object.assign(new Error("Claude Code 未登录，请在终端运行 claude auth login 后刷新模型列表。"), { recovery: "models" });
  const info = await stat(located.resolved);
  const identity = Object.fromEntries(["authMethod", "apiProvider", "email", "orgId", "subscriptionType", "planTier", "configDirectory"].map(key => [key, status[key] ?? null]));
  const accountKey = createHash("sha256").update(JSON.stringify({ identity, baseUrl: env.ANTHROPIC_BASE_URL ?? null,
    executable: located.resolved, stamp: [info.ino, info.size, info.mtimeMs, info.ctimeMs] })).digest("hex");
  const plan = typeof status.subscriptionType === "string" && status.subscriptionType ? `Claude ${status.subscriptionType[0].toUpperCase()}${status.subscriptionType.slice(1)}` : null;
  const accountLabel = typeof status.apiProvider === "string" && status.apiProvider !== "firstParty" ? `Claude Code · ${status.apiProvider}` : plan || "Claude Code · API";
  return { executable: located.executable, accountKey, accountLabel };
}

// Inline images keep the task's order; inspection returns exact pixels for details.
async function imageBlock(path, signal) {
  let source;
  try { source = await readFile(path, { signal }); }
  catch { signal?.throwIfAborted(); throw new Error("无法读取本次输入图片。"); }
  const { maxEdge, maxBytes } = CLAUDE_IMAGE_LIMITS;
  for (const [edge, encode] of [[maxEdge, image => image.png()], [maxEdge, image => image.webp({ quality: 90 })], [1600, image => image.webp({ quality: 85 })], [1200, image => image.webp({ quality: 80 })]]) {
    let data;
    try {
      data = await encode(sharp(source, { limitInputPixels: 64_000_000 }).autoOrient().withIccProfile("srgb")
        .resize(edge, edge, { fit: "inside", withoutEnlargement: true })).toBuffer({ resolveWithObject: true });
    } catch { signal?.throwIfAborted(); throw new Error("无法读取本次输入图片，或图片超过 6400 万像素；请使用受支持的栅格图片。"); }
    signal?.throwIfAborted();
    if (data.data.length <= maxBytes) return { type: "image", source: { type: "base64", media_type: `image/${data.info.format}`, data: data.data.toString("base64") } };
  }
  throw new Error("输入图片压缩后仍超过 Claude 的大小限制，请换用较小的图片。");
}

async function messageContent(input, signal) {
  const content = [];
  let index = 0;
  for (const item of input) {
    if (item.type === "text") content.push({ type: "text", text: item.text });
    else if (item.type === "localImage") content.push({ type: "text", text: `图 ${++index}` }, await imageBlock(item.path, signal));
  }
  return content;
}

// The API may answer with a dated snapshot of the requested id; any other model is a different model.
const sameModel = (actual, expected) => actual === expected || (actual.startsWith(`${expected}-`) && /^\d{8}$/.test(actual.slice(expected.length + 1)));

export async function runClaude({ input = [], schema, signal, onProgress = () => {}, instructions = "", modelSettings, probe = false, dynamicTools = [], env = process.env }) {
  signal?.throwIfAborted();
  if (!modelSettings?.model) throw new Error("请先在连接设置中选择并验证 Claude Code 模型。");
  if (dynamicTools.some(tool => tool.spec?.name !== "alchemy_inspect_image")) throw new Error("Claude Code 不支持本次请求的工具。");
  const context = await claudeContext(env, signal);
  if (modelSettings.accountKey && modelSettings.accountKey !== context.accountKey) throw changed();
  const dir = await mkdtemp(join(tmpdir(), "reframe-claude-"));
  try {
    const { references, skillText, manifest } = await taskResources(input, dir, { probe, label: "Claude Code" });
    const content = await messageContent(probe ? input.filter(item => item.type === "text") : input, signal);
    const system = probe ? instructions : [taskSystemPrompt({ instructions, skillText, references, readTool: TOOLS[1] }),
      `本次工具通过 MCP 提供：alchemy_inspect_image 即 ${TOOLS[0]}，alchemy_read_reference 即 ${TOOLS[1]}。`,
      schema ? `最终结果须符合以下 JSON Schema：${JSON.stringify(schema)}` : ""].join("\n\n");
    const systemPath = join(dir, "system.txt"), mcpPath = join(dir, "mcp.json");
    await writeFile(systemPath, system, { mode: 0o600 });
    await writeFile(mcpPath, JSON.stringify({ mcpServers: { reframe: { type: "stdio", command: process.execPath, args: [server, manifest] } } }), { mode: 0o600 });
    const args = [...stream, ...isolation, "--system-prompt-file", systemPath, "--model", modelSettings.model,
      ...(modelSettings.reasoningEffort ? ["--effort", modelSettings.reasoningEffort] : []),
      ...(probe ? [] : ["--mcp-config", mcpPath, "--allowedTools", TOOLS.join(",")]),
      ...(schema ? ["--json-schema", JSON.stringify(schema)] : [])];
    const allowed = new Set([...(probe ? [] : TOOLS), ...(schema ? ["StructuredOutput"] : [])]);
    let init, result, apiError;
    onProgress({ stage: "Claude Code 正在读取图片分析规则…", model: modelSettings.model });
    const { stderr } = await invoke({ executable: context.executable, args, cwd: dir, env, signal, timeoutMs: probe ? 90_000 : 600_000,
      input: JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n",
      onEvent(event) {
        if (event.type === "system" && event.subtype === "init") {
          init = event;
          const tools = Array.isArray(event.tools) ? event.tools : [];
          if (tools.some(name => !allowed.has(name))) throw new Error("Claude Code 加载了预期之外的工具，已停止任务；请更新插件或 CLI 后重试。");
          const reframe = (event.mcp_servers || []).find(item => item?.name === "reframe");
          if (!probe && (reframe?.status !== "connected" || TOOLS.some(name => !tools.includes(name))))
            throw new Error("Claude Code 未加载 Reframe 图像工具，请更新 CLI 后重试。");
        }
        if (event.type === "assistant") {
          if (event.error) apiError ||= event.error;
          const message = event.message || {};
          if (typeof message.model === "string" && message.model !== "<synthetic>" && !sameModel(message.model, modelSettings.model))
            throw Object.assign(new Error("Claude Code 实际使用的模型与已选择模型不一致，请刷新模型列表并重新验证。"), { modelContextChanged: true, recovery: "models" });
          if (message.model !== "<synthetic>") for (const block of message.content || []) {
            if (block.type === "tool_use" && block.name === TOOLS[0]) onProgress({ stage: `Claude Code 正在检查图 ${block.input?.image || ""}${block.input?.bbox ? " 的局部细节" : ""}…` });
            else if (block.type === "tool_use" && block.name === TOOLS[1]) onProgress({ stage: "Claude Code 正在读取技能参考资料…" });
            else if (block.type === "text" || block.type === "tool_use") onProgress({ stage: "Claude Code 正在整理提示词…" });
          }
        }
        if (event.type === "result") result = event;
      } });
    signal?.throwIfAborted();
    if (!init) throw new Error("Claude Code 未报告会话初始化信息，请更新 CLI 后重试。");
    if (!result) throw new Error(`Claude Code 未完成任务${stderr ? `：${stderr.slice(-1200)}` : "。"}`);
    if (result.is_error || result.subtype !== "success") {
      if (apiError === "model_not_found" || result.api_error_status === 404)
        throw Object.assign(new Error("Claude Code 无法使用所选模型，请刷新模型列表并重新验证。"), { modelUnavailable: true, recovery: "models" });
      if (apiError === "authentication_failed" || [401, 403].includes(result.api_error_status))
        throw Object.assign(new Error("Claude Code 登录已失效，请在终端运行 claude auth login 后重新验证。"), { recovery: "models" });
      const detail = typeof result.result === "string" && result.result ? result.result : Array.isArray(result.errors) ? result.errors.join("；") : result.subtype;
      throw new Error(`Claude Code 未完成任务：${String(detail || "未知错误").slice(0, 1200)}`);
    }
    let text;
    if (schema) {
      if (!result.structured_output || typeof result.structured_output !== "object") throw new Error("Claude Code 未返回符合格式的结果，请重试。");
      text = JSON.stringify(result.structured_output);
    } else text = typeof result.result === "string" ? result.result.trim() : "";
    if (!text || Buffer.byteLength(text) > 1024 * 1024) throw new Error("Claude Code 未返回有效文本，或结果超过大小限制。");
    if (probe && modelSettings.accountKey && modelSettings.accountKey !== (await claudeContext(env, signal)).accountKey) throw changed();
    signal?.throwIfAborted();
    return { text, images: [] };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/**
 * Model catalog without a model call. `claude -p` documents no model listing, so this reads the stream-json
 * initialize handshake that the official Agent SDK uses for `supportedModels()`; an unsupported CLI fails explicitly.
 */
export async function readClaudeCatalog(_cwd, { env = process.env, signal } = {}) {
  const context = await claudeContext(env, signal);
  const dir = await mkdtemp(join(tmpdir(), "reframe-claude-catalog-"));
  try {
    let models;
    await invoke({ executable: context.executable, args: [...stream, ...isolation], cwd: dir, env, signal, timeoutMs: 45_000, endInput: false,
      input: JSON.stringify({ type: "control_request", request_id: "reframe-models", request: { subtype: "initialize" } }) + "\n",
      onEvent(event, child) {
        if (event.type !== "control_response" || event.response?.request_id !== "reframe-models") return;
        if (event.response.subtype !== "success" || !Array.isArray(event.response.response?.models)) throw new Error("无法读取 Claude Code 模型目录，请更新 CLI 后重试。");
        models = event.response.response.models;
        child.stdin.end();
      } });
    if (!models) throw new Error("Claude Code 模型目录响应不完整，请更新 CLI 后重试。");
    const defaultModel = models.find(item => item?.value === "default")?.resolvedModel;
    const byModel = new Map();
    for (const item of models) {
      const model = typeof item?.resolvedModel === "string" ? item.resolvedModel : typeof item?.value === "string" && item.value.startsWith("claude-") ? item.value : null;
      if (!model || !/^[\w.[\]-]{1,200}$/.test(model)) continue;
      const existing = byModel.get(model);
      // Aliases resolve to the same model; prefer a concrete name over "Default (recommended)" while keeping list order.
      if (!existing || (existing.value === "default" && item.value !== "default")) byModel.set(model, item);
    }
    return { accountKey: context.accountKey, accountLabel: context.accountLabel, provider: "claude",
      models: [...byModel].map(([model, item]) => {
        const levels = item.supportsEffort && Array.isArray(item.supportedEffortLevels) ? item.supportedEffortLevels.filter(level => typeof level === "string" && /^[a-z]{1,20}$/.test(level)) : [];
        return { model, label: typeof item.displayName === "string" && item.displayName.trim() ? item.displayName.trim() : model,
          reasoningEffort: levels.includes("high") ? "high" : levels[0], supportedReasoningEfforts: levels.map(reasoningEffort => ({ reasoningEffort })),
          isDefault: model === defaultModel };
      }) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function verifyClaudeModel({ selection, signal, env }) {
  const result = await runClaude({ signal, env, modelSettings: selection, probe: true,
    instructions: "这是模型连接检查。仅按用户要求回复文字，不调用任何工具，不读取文件，不执行其他任务。", input: [{ type: "text", text: "仅回复 OK。" }] });
  if (!result.text.trim()) throw new Error("Claude Code 未返回有效响应，请重新验证。");
}
