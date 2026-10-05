import { Worker } from "node:worker_threads";

const fail = (message, status = 503) => Object.assign(new Error(message), { status });
const methods = ["get", "list", "put", "remove", "clear", "search"];

export function createSessionIndexClient({ directory }) {
  let worker, failure, termination, closing = false, closePromise, nextId = 0;
  const pending = new Map();
  const stop = error => {
    failure ||= error;
    for (const item of pending.values()) item.reject(failure);
    pending.clear();
    termination ||= worker?.terminate();
    void termination?.catch(() => {});
  };
  const start = () => {
    if (worker) return;
    worker = new Worker(new URL("./session-index-worker.mjs", import.meta.url), {
      workerData: { directory }, stdout: true, stderr: true,
    });
    // Index errors never forward worker stacks, private paths or content to logs.
    worker.stdout.resume(); worker.stderr.resume();
    worker.on("error", () => stop(fail("本机会话检索进程异常，请重试")));
    worker.on("exit", () => {
      if (!closing || pending.size) stop(fail("本机会话检索进程已退出，请重试"));
    });
    worker.on("message", message => {
      if (message.fatal) { stop(fail("本机会话检索索引初始化失败，请重建索引后重试")); return; }
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(fail(message.error.message, message.error.status));
      else item.resolve(message.result);
    });
  };
  const request = (method, args) => {
    if (failure) return Promise.reject(failure);
    if (closing && method !== "close") return Promise.reject(fail("会话索引已关闭"));
    if (pending.size >= 64 && method !== "close") return Promise.reject(fail("会话索引请求过多，请稍后重试", 429));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      try { start(); worker.postMessage({ id, method, args }); }
      catch { stop(fail("无法提交本机会话索引请求")); }
    });
  };
  return {
    ...Object.fromEntries(methods.map(method => [method, (...args) => request(method, args)])),
    get busy() { return pending.size > 0; },
    get failed() { return !!failure; },
    terminate() {
      closing = true;
      stop(fail("会话索引已停止"));
      return termination;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (worker && !failure ? request("close", []) : Promise.resolve()).finally(async () => {
        termination ||= worker?.terminate();
        await termination;
      });
      return closePromise;
    },
  };
}
