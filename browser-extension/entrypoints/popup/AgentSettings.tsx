import { useEffect, useRef, useState } from "react";
import { query, request } from "../../lib/client";
import ModelSettings from "./ModelSettings";
import AgentCliSettings from "./AgentCliSettings";

type AgentId = "codex" | "pi";
type AgentCatalog = { selected: AgentId; agents: { id: AgentId; label: string; model: string | null }[] };

export default function AgentSettings({ serviceBusy, recoveryAgent, loginCommand, onSelected }: {
  serviceBusy: boolean; recoveryAgent?: AgentId; loginCommand?: string; onSelected(): void;
}) {
  const [catalog, setCatalog] = useState<AgentCatalog>();
  const [legacy, setLegacy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modelBusy, setModelBusy] = useState(false);
  const [cliBusy, setCliBusy] = useState(false);
  const [modelEpoch, setModelEpoch] = useState(0);
  const management = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const pending = useRef(false);
  const agent = catalog?.selected || "codex";
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void query<AgentCatalog>("/agents").then(value => { if (!cancelled) setCatalog(value); }, e => {
      if (!cancelled) e.message === "Not found" ? setLegacy(true) : setError(e.message);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { mounted.current = false; cancelled = true; };
  }, []);
  useEffect(() => {
    if (recoveryAgent) { management.current?.focus({ preventScroll: true }); management.current?.scrollIntoView({ block: "start" }); }
  }, [recoveryAgent]);
  const select = async (agent: AgentId) => {
    if (pending.current || loading || modelBusy || cliBusy || serviceBusy || catalog?.selected === agent) return;
    pending.current = true;
    setLoading(true);
    setError("");
    try {
      const value = await request<AgentCatalog>({ type: "alchemy:agent-select", agent });
      if (mounted.current) { setCatalog(value); onSelected(); }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { pending.current = false; if (mounted.current) setLoading(false); }
  };
  return <div className="agent-settings" aria-busy={loading}>
    <header className="settings-section-heading"><h3>插件模型</h3><p className="fine">选择用于逆向提示词的 Agent 和模型。生图渠道独立配置。</p></header>
    {catalog && <fieldset className="settings-agent-cards" aria-label="逆向 Agent" disabled={serviceBusy}>
      {catalog.agents.map(agent => <label className="settings-agent-card" key={agent.id}>
        <input type="radio" name="reverse-agent" value={agent.id} checked={catalog.selected === agent.id} aria-disabled={loading || modelBusy || cliBusy || serviceBusy} onChange={() => void select(agent.id)} />
        <span><strong>{agent.label}</strong><small>{catalog.selected === agent.id ? "当前用于逆向" : "切换使用"}</small></span>
      </label>)}
    </fieldset>}
    {(loading || serviceBusy || modelBusy || cliBusy) && <p className="fine agent-selection-status" role="status">{loading ? catalog ? "正在保存 Agent…" : "正在读取 Agent…" : "当前操作完成后可切换 Agent。"}</p>}
    {error && <div className="error" role="alert">{error}</div>}
    {(catalog || legacy) && <ModelSettings key={`${agent}:${modelEpoch}`} agent={agent} serviceBusy={serviceBusy || loading || cliBusy} onBusyChange={setModelBusy} loginCommand={agent === "codex" ? loginCommand : undefined} />}
    <div className="agent-management-target" ref={management} tabIndex={-1} role="group" aria-label={`${agent === "pi" ? "Pi" : "Codex"} CLI 管理`}>
      {recoveryAgent && recoveryAgent !== agent && !loading && <p className="settings-info">要检查 {recoveryAgent === "pi" ? "Pi" : "Codex"} CLI，请先选择上方的 {recoveryAgent === "pi" ? "Pi" : "Codex"} 卡片。</p>}
      <AgentCliSettings key={agent} agent={agent} serviceBusy={serviceBusy || loading || modelBusy} onBusyChange={setCliBusy} onUpdated={() => setModelEpoch(value => value + 1)} />
    </div>
  </div>;
}
