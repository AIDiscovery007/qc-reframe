import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, rm, realpath, stat, lstat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiExecutable } from "./pi-cli.mjs";

const extension = fileURLToPath(new URL("./pi-extension.mjs", import.meta.url));
const isolation = ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve", "--offline"];
const MAX_OUTPUT = 128 * 1024 * 1024;

// Wait for process termination before removing its private files or releasing task occupancy.
async function invoke({ dir, args, signal, input, manifest, timeoutMs, onEvent, rpc, executable, node, dataDir, env = process.env }) {
  signal?.throwIfAborted();
  const located = executable ? { executable, node } : await resolvePiExecutable(env, dataDir);
  if (!located) throw new Error("找不到 Pi CLI，请先安装 Pi 或配置 PI_BIN。");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(located.node || located.executable, located.node ? [located.executable, ...args] : args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"],
      env: { ...env, PI_TELEMETRY: "0", REFRAME_PI_MANIFEST: manifest || "" } });
    let failure, buffer = "", stderr = "", bytes = 0, killTimer;
    const stop = error => {
      failure ||= error;
      child.kill("SIGTERM");
      killTimer ||= setTimeout(() => child.kill("SIGKILL"), 1500);
    };
    const abort = () => stop(new Error("Pi 任务已取消。"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(new Error("Pi 响应超时，请重试。")), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) return stop(new Error("Pi 输出超过限制。"));
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { onEvent(JSON.parse(line), child); }
        catch (error) { stop(error); break; }
      }
    });
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk).slice(-16_384);
      // Pi routes extension stdout through its output guard to stderr.
      const marker = '{"type":"reframe_tools_ready"}';
      if (stderr.includes(marker)) {
        stderr = stderr.replace(marker, "");
        try { onEvent({ type: "reframe_tools_ready" }, child); } catch (error) { stop(error); }
      }
    });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") stop(error); });
    child.on("error", error => {
      failure = error.code === "ENOENT" ? new Error("找不到 Pi CLI，请先安装 Pi 或配置 PI_BIN。") : error;
    });
    child.on("close", code => {
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (!failure && buffer.trim()) {
        try { onEvent(JSON.parse(buffer), child); } catch (error) { failure = error; }
      }
      if (failure) reject(failure);
      else if (code && !rpc?.done) reject(new Error(`Pi 执行失败${stderr.trim() ? `：${stderr.trim().slice(-1200)}` : `（${code}）`}`));
      else resolvePromise();
    });
    if (rpc) child.stdin.write(input); else child.stdin.end(input);
  });
}

async function taskResources(input, dir, probe) {
  const images = probe ? [] : input.filter(item => item.type === "localImage").map(item => resolve(item.path));
  const references = {};
  const skillText = [];
  let bytes = 0;
  if (!probe) for (const skill of input.filter(item => item.type === "skill")) {
    const path = await realpath(skill.path);
    const text = await readFile(path, "utf8");
    bytes += Buffer.byteLength(text);
    if (bytes > 2 * 1024 * 1024) throw new Error("Pi 技能资料超过大小限制。");
    skillText.push(text);
    const root = join(dirname(path), "references");
    const collect = async (directory, prefix) => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
        const key = `${prefix}/${entry.name}`, file = join(directory, entry.name);
        if (entry.isDirectory()) await collect(file, key);
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          const text = await readFile(file, "utf8");
          bytes += Buffer.byteLength(text);
          if (bytes > 2 * 1024 * 1024) throw new Error("Pi 技能资料超过大小限制。");
          references[key] = text;
        }
      }
    };
    const info = await lstat(root).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (info?.isDirectory()) await collect(root, "references");
  }
  const manifest = join(dir, "task.json");
  await writeFile(manifest, JSON.stringify({ images, references }), { mode: 0o600 });
  return { images, references, skillText, manifest };
}

async function contextKey(dataDir) {
  const configDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const located = await resolvePiExecutable(process.env, dataDir);
  const executable = located?.resolved || process.env.PI_BIN || "pi";
  const fingerprint = await Promise.all([executable, ...["auth.json", "models.json", "settings.json"].map(name => join(configDir, name))].map(async path => {
    try { const info = await stat(path); return [path, info.ino, info.size, info.mtimeMs, info.ctimeMs]; }
    catch (error) { if (error.code === "ENOENT") return [path, null]; throw error; }
  }));
  return createHash("sha256").update(JSON.stringify([configDir, fingerprint])).digest("hex");
}

export async function runPi({ input, schema, cwd, signal, onProgress = () => {}, instructions = "", modelSettings, probe = false, dynamicTools = [], dataDir }) {
  signal?.throwIfAborted();
  if (!modelSettings?.model) throw new Error("请先在连接设置中选择并验证 Pi 模型。");
  if (modelSettings.accountKey && modelSettings.accountKey !== await contextKey(dataDir))
    throw Object.assign(new Error("Pi 登录、模型配置或 CLI 已变化，请刷新模型列表并重新验证。"), { modelContextChanged: true, recovery: "models" });
  if (dynamicTools.some(tool => tool.spec?.name !== "alchemy_inspect_image")) throw new Error("Pi 不支持本次请求的工具。");
  const dir = await mkdtemp(join(tmpdir(), "reframe-pi-"));
  try {
    const { images, references, skillText, manifest } = await taskResources(input, dir, probe);
    signal?.throwIfAborted();
    const system = [instructions, ...skillText,
      "仅使用本次提供的图片和技能资料。需要参考文档时调用 alchemy_read_reference，path 使用以下名称：", Object.keys(references).join("\n"),
      schema ? `只返回符合以下 JSON Schema 的 JSON，不使用 Markdown 代码围栏：${JSON.stringify(schema)}` : ""].join("\n\n");
    const systemPath = join(dir, "system.txt");
    await writeFile(systemPath, system, { mode: 0o600 });
    const args = ["--print", "--mode", "json", ...isolation, "--system-prompt", systemPath, "--append-system-prompt", "",
      ...(probe ? ["--no-tools"] : ["-e", extension, "--tools", "alchemy_inspect_image,alchemy_read_reference"])];
    if (modelSettings?.model) {
      args.push("--model", modelSettings.model);
      if (!modelSettings.model.includes("/") && modelSettings.provider) args.push("--provider", modelSettings.provider);
    }
    if (modelSettings?.reasoningEffort) args.push("--thinking", modelSettings.reasoningEffort);
    args.push(...images.map(path => `@${path}`));
    let final, toolsReady = probe;
    onProgress({ stage: "Pi 正在读取图片分析规则…", model: modelSettings?.model });
    await invoke({ dir, args, signal, manifest, dataDir, timeoutMs: probe ? 90_000 : 600_000,
      input: input.filter(item => item.type === "text").map(item => item.text).join("\n\n"),
      onEvent(event) {
        if (event.type === "reframe_tools_ready") toolsReady = true;
        if (event.type === "message_end" && event.message?.role === "assistant") final = event.message;
        if (event.type === "tool_execution_start") onProgress({ stage: event.toolName === "alchemy_inspect_image"
          ? `Pi 正在检查图 ${event.args?.image || ""}${event.args?.bbox ? " 的局部细节" : ""}…` : "Pi 正在读取技能参考资料…" });
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") onProgress({ stage: "Pi 正在整理提示词…" });
      } });
    signal?.throwIfAborted();
    if (!final || final.stopReason !== "stop") throw new Error(final?.stopReason === "length" ? "Pi 输出被截断，请重试。" : `Pi 未完成任务${final?.errorMessage ? `：${String(final.errorMessage).slice(0, 1200)}` : "。"}`);
    if (!toolsReady) throw new Error("Pi 未加载 Reframe 图像工具，请更新 Pi 后重试。");
    const expected = modelSettings.model.includes("/") ? modelSettings.model : `${modelSettings.provider}/${modelSettings.model}`;
    if (`${final.provider}/${final.model}` !== expected)
      throw Object.assign(new Error("Pi 实际使用的模型与已选择模型不一致，请刷新模型列表并重新验证。"), { modelContextChanged: true, recovery: "models" });
    const text = (final.content || []).filter(item => item.type === "text").map(item => item.text).join("\n").trim();
    if (!text || Buffer.byteLength(text) > 1024 * 1024) throw new Error("Pi 未返回有效文本，或结果超过大小限制。");
    if (schema) { try { JSON.parse(text); } catch { throw new Error("Pi 返回的结果不是有效 JSON，请重试。"); } }
    if (probe && modelSettings.accountKey && modelSettings.accountKey !== await contextKey(dataDir))
      throw Object.assign(new Error("Pi 认证或配置已更新，请刷新模型列表并重新验证。"), { modelContextChanged: true, recovery: "models" });
    signal?.throwIfAborted();
    return { text, images: [] };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function readPiCatalog(cwd, dataDir) {
  const dir = await mkdtemp(join(tmpdir(), "reframe-pi-catalog-"));
  try {
    const responses = new Map(), rpc = { done: false };
    await invoke({ dir, dataDir, args: ["--mode", "rpc", ...isolation, "--no-tools", "--system-prompt", "Reframe model catalog", "--append-system-prompt", ""],
      timeoutMs: 45_000, rpc, input: '{"id":"models","type":"get_available_models"}\n{"id":"state","type":"get_state"}\n',
      onEvent(event, child) {
        if (event.type !== "response" || !["models", "state"].includes(event.id)) return;
        if (!event.success) throw new Error("无法读取 Pi 模型目录，请检查本机 Pi 配置。");
        responses.set(event.id, event.data);
        if (responses.size === 2) { rpc.done = true; child.stdin.end(); child.kill("SIGTERM"); }
      } });
    if (!rpc.done) throw new Error("Pi 模型目录响应不完整。");
    const current = responses.get("state")?.model;
    const models = (responses.get("models")?.models || []).filter(model => model.input?.includes("image")).map(model => ({
      model: `${model.provider}/${model.id}`, provider: model.provider, label: `${model.name || model.id} · ${model.provider}`,
      reasoningEffort: model.reasoning ? "medium" : "off",
      supportedReasoningEfforts: (model.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"]).map(reasoningEffort => ({ reasoningEffort })),
      isDefault: model.id === current?.id && model.provider === current?.provider,
    }));
    const accountKey = await contextKey(dataDir);
    return { accountKey, accountLabel: "Pi 本机配置", provider: "pi", models };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// Candidate verification loads only our extension and requests metadata; it never sends a prompt.
export async function verifyPiInstallation({ executable, node, env, dir, signal }) {
  const manifest = join(dir, 'verification.json'), system = join(dir, 'verification-system.txt');
  await writeFile(manifest, JSON.stringify({ images: [], references: {} }), { mode: 0o600 });
  await writeFile(system, 'Reframe CLI compatibility check', { mode: 0o600 });
  const replies = new Set(), rpc = { done: false }; let ready = false;
  await invoke({ executable, node, env, dir, signal, manifest, timeoutMs: 30_000, rpc,
    args: ['--mode', 'rpc', ...isolation, '--system-prompt', system, '--append-system-prompt', '', '-e', extension, '--tools', 'alchemy_inspect_image,alchemy_read_reference'],
    input: '{"id":"state","type":"get_state"}\n{"id":"models","type":"get_available_models"}\n',
    onEvent(event, child) {
      if (event.type === 'reframe_tools_ready') ready = true;
      if (event.type === 'response' && ['state', 'models'].includes(event.id)) {
        if (!event.success) throw Error('Pi RPC 兼容检查失败。');
        replies.add(event.id);
      }
      if (ready && replies.size === 2) { rpc.done = true; child.stdin.end(); child.kill('SIGTERM'); }
    } });
  if (!rpc.done) throw Error('Pi 未通过 Reframe 工具与 RPC 兼容检查。');
}
