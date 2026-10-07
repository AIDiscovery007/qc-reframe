import { browser } from "wxt/browser";
import type { Mode, Selection } from "./types";
import { operationFor, UI_RESPONSE_TIMEOUT } from "./operation-policy";

export type UiState = {
  preferences: { paired: boolean; mode: Mode; showHiddenProjects?: boolean };
  selection?: Selection;
};

// The bridge owns the deadline for slow reads and writes. A UI-side race could
// discard a successful write while the background request is still running.
function connectedRequest(message: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  signal?.throwIfAborted();
  const port = browser.runtime.connect({ name: "alchemy:request" });
  return new Promise((resolve, reject) => {
    const finish = (response?: unknown, error?: unknown) => {
      port.onMessage.removeListener(receive);
      port.onDisconnect.removeListener(disconnect);
      signal?.removeEventListener("abort", abort);
      port.disconnect();
      if (error) reject(error); else resolve(response);
    };
    const receive = (response: any) => { if (!response?.pending) finish(response); };
    const disconnect = () => finish(undefined, new Error(browser.runtime.lastError?.message || "扩展连接中断，结果尚未确认，请重新打开项目或任务中心检查。"));
    const abort = () => finish(undefined, signal?.reason || new DOMException("已取消", "AbortError"));
    port.onMessage.addListener(receive);
    port.onDisconnect.addListener(disconnect);
    signal?.addEventListener("abort", abort, { once: true });
    try { port.postMessage(message); } catch (error) { finish(undefined, error); }
  });
}

export async function request<T>(message: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    const response = operationFor(message.type)?.transport === "port"
      ? await connectedRequest(message, signal) : await Promise.race([
      browser.runtime.sendMessage(message),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("扩展响应超时，请重新加载扩展并刷新网页。")), UI_RESPONSE_TIMEOUT);
      }),
    ]);
    if (!response) throw new Error("扩展未响应，请重新加载扩展并刷新网页。");
    if (response.error) throw new Error(response.error);
    return response.value as T;
  } catch (error) {
    if (/context invalidated|receiving end does not exist/i.test(String(error)))
      throw new Error("扩展已更新或连接已失效，请刷新当前网页后重试。");
    throw error;
  } finally {
    clearTimeout(timer!);
  }
}

export const readState = (selectionId?: string, selectionJobId?: string) =>
  request<UiState>({ type: "alchemy:state", selectionId, selectionJobId });

export const query = <T>(path: string) =>
  request<T>({ type: "alchemy:query", path });
