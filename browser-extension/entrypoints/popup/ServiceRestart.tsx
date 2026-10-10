import { useEffect, useRef, useState } from "react";
import { query, request } from "../../lib/client";
import { pollWhileVisible } from "../../lib/visible-poll";
import { waitForServiceRestart, type RestartTicket, type ServiceHealth } from "../../lib/service-restart";

export default function ServiceRestart({ connected, busy, onConnected }: { connected: boolean; busy: boolean; onConnected(): void }) {
  const [health, setHealth] = useState<ServiceHealth>();
  const [unreachable, setUnreachable] = useState(false);
  const [phase, setPhase] = useState<"idle" | "requesting" | "waiting" | "done" | "failed">("idle");
  const [error, setError] = useState("");
  const pending = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!connected) { if (!pending.current) setHealth(undefined); return; }
    let cancelled = false;
    const stop = pollWhileVisible(async () => {
      if (!pending.current) {
        try { const next = await query<ServiceHealth>("/health"); if (!cancelled && !pending.current) { setHealth(next); setUnreachable(false); } }
        catch { if (!cancelled && !pending.current) { setHealth(undefined); setUnreachable(true); } }
      }
      return 3000;
    });
    return () => { cancelled = true; stop(); };
  }, [connected]);
  const running = phase === "requesting" || phase === "waiting";
  const serviceBusy = busy || !!health?.active || health?.cliBusy || health?.modelBusy;
  const restart = async () => {
    if (pending.current || !connected || serviceBusy || !health?.canRestart) return;
    pending.current = true;
    const signal = lifetime.current!.signal;
    setPhase("requesting"); setError("");
    try {
      const ticket = await request<RestartTicket>({ type: "alchemy:service-restart" });
      signal.throwIfAborted();
      setPhase("waiting");
      const next = await waitForServiceRestart(ticket, () => query<ServiceHealth>("/health"), signal);
      setHealth(next); setUnreachable(false); setPhase("done"); onConnected();
    } catch (e) { if (!signal.aborted) { setError((e as Error).message); setPhase("failed"); } }
    finally { pending.current = false; }
  };
  const message = phase === "requesting" ? "正在准备重启…" : phase === "waiting" ? "正在等待本机服务重新连接…"
    : !connected || unreachable ? "本机服务未运行，启动后将自动连接。"
    : !health ? "正在检测本机服务…"
    : phase === "done" ? `本机服务已重启并重新连接（${health.version}）。`
    : !health.managed ? "此服务由终端直接启动。请在原终端按 Ctrl+C 停止，再在插件目录运行 npm start。"
    : !health.canRestart ? "当前服务尚不支持插件内重启。首次启用需在插件目录运行 npm stop，再运行 npm start。"
    : serviceBusy ? "请等待逆向、生图、模型验证或 Agent CLI 操作完成后重启。"
    : "重新加载本机服务代码，保留项目、图片和配对。";
  return <section className="settings-update-card" aria-label="重启本机服务" aria-busy={running}>
    <div className="settings-update-top"><strong>本机服务{health?.version ? ` · ${health.version}` : ""}</strong></div>
    <p className="settings-operation-status" role="status">{message}</p>
    {error && <div className="settings-info settings-error" role="alert">{error}</div>}
    <button className="primary" disabled={running || !connected || !health?.canRestart || serviceBusy} onClick={() => void restart()}>
      {phase === "requesting" ? "正在重启…" : phase === "waiting" ? "等待重新连接…" : "重启本机服务"}
    </button>
  </section>;
}
