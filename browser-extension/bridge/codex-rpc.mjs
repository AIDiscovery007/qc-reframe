import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// One child per operation, using the same local login and provider as inference.
export async function withCodex({ cwd, signal, onNotification = () => {}, timeoutMs = 600_000, dynamicTools = [], maxResponseBytes = Infinity }, action) {
  if (signal?.aborted) throw new Error("任务已取消");
  const proc = spawn(process.env.CODEX_BIN || "codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const handlers = new Map(dynamicTools.map(tool => [tool.spec.name, tool.call]));
  const registered = new Map();
  const toolController = new AbortController();
  let nextId = 0;
  let failure;
  let rejectFailure;
  const failed = new Promise((_, reject) => { rejectFailure = reject; });
  failed.catch(() => {});
  const send = (message) => proc.stdin.write(JSON.stringify(message) + "\n");
  const stop = (error) => {
    failure ||= error;
    toolController.abort(failure);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
    rejectFailure(error);
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex 接口超时：${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer, method, params });
    send({ id, method, params });
  });
  const abort = () => stop(new Error("任务已取消"));
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => stop(new Error("Codex 请求超时，请重试")), timeoutMs);
  proc.on("error", (error) => stop(new Error(`无法启动 Codex：${error.message}。请安装并登录 Codex CLI。`)));
  proc.stdin.on("error", stop);
  // Do not forward stderr: third-party providers may include credentials in logs.
  proc.stderr.resume();
  proc.on("exit", (code) => stop(new Error(`Codex 进程结束（${code}），请检查 CLI 登录与配置。`)));
  createInterface({ input: proc.stdout }).on("line", (line) => {
    if (failure) return;
    if (Buffer.byteLength(line) > maxResponseBytes) { stop(new Error("Codex 会话响应过大，无法完整读取")); return; }
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiting = pending.get(message.id);
    if (waiting && !message.method) {
      clearTimeout(waiting.timer);
      pending.delete(message.id);
      if (message.error) waiting.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else {
        if (waiting.method === "thread/start" && message.result?.thread?.id)
          registered.set(message.result.thread.id, new Set((waiting.params.dynamicTools || []).map(tool => tool.name)));
        waiting.resolve(message.result);
      }
    } else if (message.id !== undefined && message.method) {
      const p = message.params;
      const handler = message.method === "item/tool/call" && p?.namespace == null && registered.get(p?.threadId)?.has(p.tool) && handlers.get(p.tool);
      if (handler) {
        Promise.resolve().then(() => {
          toolController.signal.throwIfAborted();
          return handler(p.arguments, { signal: toolController.signal });
        }).catch(error => ({
          success: false, contentItems: [{ type: "inputText", text: error.message || "图片检查失败。" }],
        })).then(result => { if (!failure) send({ id: message.id, result }); }).catch(stop);
        return;
      }
      send({ id: message.id, error: { code: -32601, message: "Interactive approvals are unavailable in QC-Reframe." } });
      stop(new Error("Codex 请求交互式操作，请在 Codex 中检查后重试。"));
    } else {
      try { onNotification(message); } catch (error) { stop(error); }
    }
  });
  try {
    return await Promise.race([failed, (async () => {
      await request("initialize", { clientInfo: { name: "qc_reframe", title: "QC-Reframe", version }, ...(handlers.size ? { capabilities: { experimentalApi: true } } : {}) });
      send({ method: "initialized", params: {} });
      return action(request);
    })()]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    stop(new Error("任务已结束"));
    proc.kill();
  }
}
