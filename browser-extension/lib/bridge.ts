import { bridgeTimeout } from "./operation-policy";

export const BRIDGE_URL = "http://127.0.0.1:43187";

export class BridgeError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function bridge<T>(
  path: string,
  token: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (!token && path !== "/connection") throw new Error("本机服务尚未连接，正在自动重试。");
  let response: Response;
  const timeout = AbortSignal.timeout(bridgeTimeout(path));
  try {
    response = await fetch(`${BRIDGE_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    signal?.throwIfAborted();
    if (timeout.aborted) throw new Error("本机服务请求超时，读取已停止；请重新打开项目或任务中心确认状态后重试。");
    throw new Error("本机服务未运行，启动后将自动连接。");
  }
  const value = await response.json();
  if (!response.ok)
    throw new BridgeError(value.error || `本机服务返回 ${response.status}`, response.status);
  return value as T;
}
