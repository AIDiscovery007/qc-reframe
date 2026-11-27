import { extensionChannel } from "./extension-channel";
import { browser } from "wxt/browser";
import { bridge as fetchBridge, BridgeError, BridgeTransportError } from "./bridge";
import type { Preferences } from "./types";

// The background's only route to the local service: pairing, one renewal after a 401,
// and an on-demand native launcher that only an opening UI may trigger.
export function createServiceConnection() {
  // Only credentials live in storage; concurrent callers share an in-flight handshake.
  let connecting: Promise<string> | undefined;
  let preferencesWrite = Promise.resolve();
  const savePreferences = (patch: Partial<Preferences>) => {
    const previous = preferencesWrite;
    const save = (async () => {
      await previous;
      const { preferences } = await browser.storage.local.get("preferences") as { preferences?: Preferences };
      await browser.storage.local.set({ preferences: { mode: "style", ...preferences, ...patch } });
    })();
    preferencesWrite = save.catch(() => {});
    return save;
  };
  const connectionToken = async (rejectedToken?: string): Promise<string> => {
    if (connecting) return connecting;
    const { preferences } = await browser.storage.local.get("preferences") as { preferences?: Preferences };
    if (preferences?.token && preferences.token !== rejectedToken) return preferences.token;
    if (connecting) return connecting;
    connecting = (async () => {
      const { token } = await fetchBridge<{ token: string }>("/connection", "", {});
      if (typeof token !== "string" || !token || token.length > 1024) throw new Error("本机服务未提供有效连接凭据，请更新本机服务。");
      await savePreferences({ token });
      return token;
    })();
    try { return await connecting; }
    finally { connecting = undefined; }
  };
  const bridge = async <T,>(path: string, token: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    const credential = token || await connectionToken();
    signal?.throwIfAborted();
    try { return await fetchBridge<T>(path, credential, body, signal); }
    catch (error) {
      if (!(error instanceof BridgeError) || error.status !== 401) throw error;
      signal?.throwIfAborted();
      // Authentication failures must never become permission to start a process.
      try {
        const renewed = await connectionToken(credential);
        signal?.throwIfAborted();
        // A 401 proves rejection before execution; network failures never replay writes.
        return await fetchBridge<T>(path, renewed, body, signal);
      } catch (cause) {
        if (cause instanceof BridgeTransportError) throw new Error(cause.message, { cause });
        throw cause;
      }
    }
  };
  const launcherHelp = `请在 ${extensionChannel.shortName} 安装目录运行 ${extensionChannel.commands.start} 启动本机服务。`;
  const ensureStarted = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    let port: ReturnType<typeof browser.runtime.connectNative> | undefined;
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (port) {
        port.onMessage.removeListener(message);
        port.onDisconnect.removeListener(disconnected);
        try { port.disconnect(); } catch { /* The browser may already have destroyed the port. */ }
      }
      if (error) reject(error); else resolve();
    };
    const fail = (cause: string) => finish(new Error(`本机自动启动失败：${cause} ${launcherHelp}`));
    const abort = () => finish(signal.reason);
    const message = (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return fail("启动器返回无效响应。");
      const response = value as Record<string, unknown>;
      if (response.ok === true && Object.keys(response).length === 1) return finish();
      if (response.ok === false && Object.keys(response).length === 2 && typeof response.error === "string" && response.error.length <= 2000)
        return fail(response.error);
      fail("启动器返回无效响应。");
    };
    const disconnected = () => fail(browser.runtime.lastError?.message || "启动器连接已断开。");
    const timer = setTimeout(() => fail("启动器未按时响应，已超时。"), 10_000);
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      if (typeof browser.runtime.connectNative !== "function") return fail("此浏览器不支持本机启动器。");
      port = browser.runtime.connectNative(extensionChannel.hostName);
      port.onMessage.addListener(message);
      port.onDisconnect.addListener(disconnected);
      port.postMessage({ action: "ensure-start" });
    } catch (error) { fail(error instanceof Error ? error.message : "无法连接启动器。"); }
  });
  // Only opening a UI may wake the service. Share the entire bounded operation,
  // including HTTP recovery, so concurrent windows cannot launch a second host.
  let opening: Promise<unknown> | undefined;
  const open = (healthPath: () => Promise<string>) => {
    if (opening) return opening;
    const controller = new AbortController();
    const { signal } = controller;
    const timer = setTimeout(() => controller.abort(new Error(`本机自动连接超时。${launcherHelp}`)), 28_000);
    let onAbort: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const read = async () => {
      const { preferences } = await browser.storage.local.get("preferences") as { preferences?: Preferences };
      const path = await healthPath();
      signal.throwIfAborted();
      try { return await bridge(path, preferences?.token || "", undefined, signal); }
      catch (error) {
        if (!(error instanceof BridgeTransportError)) throw error;
        signal.throwIfAborted();
        await ensureStarted(signal);
        return bridge(path, preferences?.token || "", undefined, signal);
      }
    };
    opening = Promise.race([read(), cancelled]).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      opening = undefined;
    });
    return opening;
  };
  return { request: bridge, open, savePreferences };
}
