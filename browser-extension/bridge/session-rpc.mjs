import { codexRpcError } from "./errors.mjs";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const methods = new Set(["thread/list", "thread/read", "thread/turns/list"]);
const failure = (message, code) => Object.assign(new Error(message), { code });

// Dedicated read-only connection: never shares inference tools or approvals.
export function createSessionReader({ cwd, spawnProcess = spawn, requestTimeoutMs = 30_000,
  idleTimeoutMs = 60_000, maxConcurrent = 4, maxQueued = 64, maxResponseBytes = 24 * 1024 * 1024 } = {}) {
  let connection, closed = false, nextId = 0;
  const queue = [];
  const settle = (item, error, value) => {
    item.signal?.removeEventListener("abort", item.abort);
    if (item.settled) return;
    item.settled = true;
    if (error) item.reject(error); else item.resolve(value);
  };
  const stop = (current, error) => {
    if (current.stopped) return;
    current.stopped = true;
    if (connection === current) connection = undefined;
    clearTimeout(current.initTimer); clearTimeout(current.idleTimer);
    for (const item of [...current.pending.values(), ...queue.splice(0)]) {
      clearTimeout(item.timer); settle(item, error);
    }
    current.pending.clear(); current.buffer = Buffer.alloc(0);
    current.proc.kill();
    const forceKill = setTimeout(() => current.proc.kill("SIGKILL"), 250);
    forceKill.unref();
    current.proc.once("exit", () => clearTimeout(forceKill));
  };
  const send = (current, message) => {
    try { current.proc.stdin.write(JSON.stringify(message) + "\n"); }
    catch { stop(current, failure("Codex 会话连接写入失败", "CONNECTION_CLOSED")); }
  };
  const pump = () => {
    const current = connection;
    if (!current || current.stopped || !current.ready) return;
    clearTimeout(current.idleTimer);
    while (queue.length && current.pending.size < maxConcurrent && !current.stopped) {
      const item = queue.shift();
      item.connection = current;
      current.pending.set(item.id, item);
      send(current, { id: item.id, method: item.method, params: item.params });
    }
    if (!current.pending.size && !queue.length)
      current.idleTimer = setTimeout(() => stop(current, failure("会话连接已空闲回收", "CONNECTION_CLOSED")), idleTimeoutMs);
  };
  const connect = () => {
    if (connection || closed) return;
    let proc;
    try { proc = spawnProcess(process.env.CODEX_BIN || "codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"] }); }
    catch {
      for (const item of queue.splice(0)) { clearTimeout(item.timer); settle(item, failure("无法启动本机 Codex", "CONNECTION_CLOSED")); }
      return;
    }
    const current = connection = { proc, pending: new Map(), buffer: Buffer.alloc(0), ready: false, stopped: false };
    const fail = error => stop(current, error);
    current.initTimer = setTimeout(() => fail(failure("Codex 会话初始化超时", "TIMEOUT")), requestTimeoutMs);
    proc.on("error", () => fail(failure("无法启动本机 Codex", "CONNECTION_CLOSED")));
    proc.stdin.on("error", () => fail(failure("Codex 会话连接已关闭", "CONNECTION_CLOSED")));
    proc.on("exit", () => fail(failure("Codex 会话进程已退出，请重试", "CONNECTION_CLOSED")));
    proc.stdout.on("error", () => fail(failure("Codex 会话响应读取失败", "CONNECTION_CLOSED")));
    proc.stderr.resume();
    proc.stdout.on("data", chunk => {
      if (current.stopped) return;
      // Bound incomplete lines too, before parsing or buffering further output.
      let start = 0;
      for (let end = 0; end <= chunk.length; end++) {
        if (end !== chunk.length && chunk[end] !== 10) continue;
        const piece = chunk.subarray(start, end);
        if (current.buffer.length + piece.length > maxResponseBytes) { fail(failure("Codex 会话响应超过 24 MB", "RESPONSE_TOO_LARGE")); return; }
        current.buffer = Buffer.concat([current.buffer, piece]);
        start = end + 1;
        if (end === chunk.length) break;
        const line = current.buffer; current.buffer = Buffer.alloc(0);
        if (!line.length) continue;
        let message;
        try { message = JSON.parse(line.toString("utf8")); }
        catch { fail(failure("Codex 会话响应格式无效", "INVALID_RESPONSE")); return; }
        if (!message || typeof message !== "object") { fail(failure("Codex 会话响应格式无效", "INVALID_RESPONSE")); return; }
        if (message.method) {
          if (message.id !== undefined) {
            send(current, { id: message.id, error: { code: -32601, message: "Read-only session connection does not accept interactive requests." } });
            fail(failure("会话读取不支持工具或授权请求", "INTERACTIVE_REQUEST")); return;
          }
          continue;
        }
        const error = message.error ? codexRpcError(message.error, message.id === 0 ? "initialize" : current.pending.get(message.id)?.method) : undefined;
        if (message.id === 0 && !current.ready) {
          if (error) { fail(error); return; }
          clearTimeout(current.initTimer); current.ready = true;
          send(current, { method: "initialized", params: {} }); pump();
        } else {
          const item = current.pending.get(message.id);
          if (!item) continue;
          clearTimeout(item.timer); current.pending.delete(message.id);
          settle(item, error, message.result); pump();
        }
        if (current.stopped) return;
      }
    });
    send(current, { id: 0, method: "initialize", params: { clientInfo: { name: "qc_reframe_sessions", title: "QC-Reframe Sessions", version }, capabilities: { experimentalApi: true } } });
  };
  return {
    request(method, params, signal) {
      if (!methods.has(method)) return Promise.reject(failure("不支持的会话只读接口", "METHOD_NOT_ALLOWED"));
      if (closed) return Promise.reject(failure("会话读取器已关闭", "CONNECTION_CLOSED"));
      if (signal?.aborted) return Promise.reject(failure("会话请求已取消", "ABORT_ERR"));
      if (queue.length >= maxQueued) return Promise.reject(failure("会话读取请求过多，请稍后重试", "QUEUE_FULL"));
      return new Promise((resolve, reject) => {
        const item = { id: ++nextId, method, params, signal, resolve, reject };
        item.abort = () => {
          settle(item, failure("会话请求已取消", "ABORT_ERR"));
          if (!item.connection) { clearTimeout(item.timer); queue.splice(queue.indexOf(item), 1); pump(); }
          // In-flight cancelled reads keep their slot/deadline until their late reply.
        };
        item.timer = setTimeout(() => {
          if (item.connection) stop(item.connection, failure("Codex 会话读取超时，请重试", "TIMEOUT"));
          else { queue.splice(queue.indexOf(item), 1); settle(item, failure("Codex 会话读取等待超时", "TIMEOUT")); }
        }, requestTimeoutMs);
        signal?.addEventListener("abort", item.abort, { once: true });
        queue.push(item); connect(); pump();
      });
    },
    get busy() { return Boolean(queue.length || (connection && (!connection.ready || connection.pending.size))); },
    reset() {
      if (connection) stop(connection, failure("会话连接已重置，请重试", "CONNECTION_CLOSED"));
    },
    close() {
      closed = true;
      if (connection) stop(connection, failure("会话读取器已关闭", "CONNECTION_CLOSED"));
    },
  };
}
