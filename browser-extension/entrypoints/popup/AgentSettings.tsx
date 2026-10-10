import { useEffect, useRef, useState } from "react";
import { query, request } from "../../lib/client";
import ModelSettings from "./ModelSettings";
import AgentCliSettings from "./AgentCliSettings";
import SelectField from "./SelectField";

type AgentId = "codex" | "pi";
type AgentCatalog = { selected: AgentId; agents: { id: AgentId; label: string; model: string | null }[] };

export default function AgentSettings({ serviceBusy, manageAgent, loginCommand, onManualTarget }: {
  serviceBusy: boolean; manageAgent?: AgentId; loginCommand?: string; onManualTarget(): void;
}) {
  const [catalog, setCatalog] = useState<AgentCatalog>();
  const [legacy, setLegacy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modelBusy, setModelBusy] = useState(false);
  const [cliBusy, setCliBusy] = useState(false);
  const [target, setTarget] = useState<AgentId>("codex");
  const [modelEpoch, setModelEpoch] = useState(0);
  const management = useRef<HTMLHeadingElement>(null);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const pending = useRef(false);
  const reverseAgent = useRef<AgentId>("codex");
  reverseAgent.current = catalog?.selected || "codex";
  const requestedTarget = useRef(manageAgent);
  requestedTarget.current = manageAgent;
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void query<AgentCatalog>("/agents").then(value => { if (!cancelled) { setCatalog(value); setTarget(requestedTarget.current || value.selected); } }, e => {
      if (!cancelled) e.message === "Not found" ? setLegacy(true) : setError(e.message);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { mounted.current = false; cancelled = true; };
  }, []);
  useEffect(() => {
    if (manageAgent) { setTarget(manageAgent); management.current?.focus({ preventScroll: true }); management.current?.scrollIntoView({ block: "start" }); }
  }, [manageAgent]);
  const inspect = (agent: AgentId) => { if (cliBusy) return; onManualTarget(); setTarget(agent); management.current?.focus({ preventScroll: true }); management.current?.scrollIntoView({ block: "start" }); };
  const select = async (agent: AgentId) => {
    if (pending.current || loading || modelBusy || cliBusy || serviceBusy || catalog?.selected === agent) return;
    pending.current = true;
    setLoading(true);
    setError("");
    try {
      const value = await request<AgentCatalog>({ type: "alchemy:agent-select", agent });
      if (mounted.current) { setCatalog(value); setTarget(value.selected); onManualTarget(); }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { pending.current = false; if (mounted.current) setLoading(false); }
  };
  return <div className="agent-settings" aria-busy={loading}>
    <header className="settings-section-heading"><h3>插件模型</h3><p className="fine">选择用于逆向提示词的 Agent 和模型。生图渠道独立配置。</p></header>
    {catalog && <fieldset className="settings-agent-cards" disabled={serviceBusy}>
      <legend className="settings-agent-legend">逆向 Agent · 切换自动保存</legend>
      {catalog.agents.map(agent => <label className="settings-agent-card" key={agent.id}>
        <input type="radio" name="reverse-agent" value={agent.id} checked={catalog.selected === agent.id} aria-disabled={loading || modelBusy || cliBusy || serviceBusy} onChange={() => void select(agent.id)} />
        <span><strong>{agent.label}</strong><small>{catalog.selected === agent.id ? "当前用于逆向" : "切换使用"}</small></span>
      </label>)}
    </fieldset>}
    <p className="fine agent-selection-status" role="status">{loading ? catalog ? "正在保存 Agent…" : "正在读取 Agent…" : serviceBusy || modelBusy || cliBusy ? "当前操作完成后可切换 Agent。" : "仅影响新任务；各 Agent 的模型单独保存。"}</p>
    {error && <div className="error" role="alert">{error}</div>}
    {(catalog || legacy) && <ModelSettings key={`${catalog?.selected || "codex"}:${modelEpoch}`} agent={catalog?.selected || "codex"} wide reverse serviceBusy={serviceBusy || loading || cliBusy} onBusyChange={setModelBusy}
      onCheckCli={() => inspect(catalog?.selected || "codex")} loginCommand={catalog?.selected !== "pi" ? loginCommand : undefined} />}
    <div className="agent-management-target">
      <header className="settings-section-heading"><h3 ref={management} tabIndex={-1}>本机 Agent 管理</h3><p className="fine">维护本机安装，不改变上方的逆向选择。会话读取仍使用 Codex。</p></header>
      <SelectField label="管理目标" value={target} disabled={cliBusy || modelBusy || loading || serviceBusy} onChange={event => { onManualTarget(); setTarget(event.target.value as AgentId); }}>
        <option value="codex">Codex</option>{!legacy && <option value="pi">Pi</option>}
      </SelectField>
      <AgentCliSettings key={target} agent={target} serviceBusy={serviceBusy || loading || modelBusy} onBusyChange={setCliBusy} onUpdated={() => { if (target === reverseAgent.current) setModelEpoch(value => value + 1); }} />
    </div>
  </div>;
}
