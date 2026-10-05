export const BRIDGE_URL = "http://127.0.0.1:43187";

export async function bridge<T>(
  path: string,
  token: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (!token) throw new Error("请先在设置中粘贴本机服务的配对码");
  let response: Response;
  const timeout = AbortSignal.timeout((path.startsWith("/sessions") || path.endsWith("/input") || path === "/jobs") ? 120_000 : (path.startsWith("/models") || path.startsWith("/cli")) ? 30_000 : 15_000);
  try {
    response = await fetch(`${BRIDGE_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    signal?.throwIfAborted();
    if (timeout.aborted) throw new Error("本机服务请求超时，读取已停止；请重新打开项目或任务中心确认状态后重试。");
    throw new Error("连接不到本机服务，请在 browser-extension 目录运行 npm start");
  }
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error || `本机服务返回 ${response.status}`);
  return value as T;
}
