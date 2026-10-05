import { parentPort, workerData } from "node:worker_threads";
import { createSessionSearchIndex } from "./session-search-index.mjs";

const methods = new Set(["get", "list", "put", "remove", "clear", "search", "close"]);
let index;
try { index = createSessionSearchIndex({ directory: workerData.directory }); }
catch {
  parentPort.postMessage({ fatal: true, error: { status: 503, message: "本机会话检索索引初始化失败，请重建索引后重试" } });
  parentPort.close();
}
if (index) parentPort.on("message", message => {
  const { id, method, args } = message || {};
  if (!Number.isSafeInteger(id) || !methods.has(method) || !Array.isArray(args)) {
    parentPort.postMessage({ id, error: { status: 400, message: "无效的索引操作" } });
    return;
  }
  try { parentPort.postMessage({ id, result: index[method](...args) }); }
  catch (error) {
    parentPort.postMessage({ id, error: { status: error.status || 503, code: error.code,
      message: error.status ? error.message : "本机会话检索索引不可用，请重建索引后重试" } });
  }
  // Synchronous handlers process queued operations in FIFO order before closing.
  if (method === "close") parentPort.close();
});
