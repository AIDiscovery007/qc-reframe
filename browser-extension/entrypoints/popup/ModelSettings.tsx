import RecoveryAction from "./RecoveryAction";
import { pollWhileVisible } from "../../lib/visible-poll";
import { useEffect, useRef, useState } from "react";
import { query, request } from "../../lib/client";
import type { ModelCatalog } from "../../lib/types";
import SelectField from "./SelectField";

export default function ModelSettings({ serviceBusy, wide = false, reverse = false, onCheckCli, loginCommand, agent = "codex", onBusyChange }: { reverse?: boolean; agent?: "codex" | "pi"; onBusyChange?(busy: boolean): void; loginCommand?: string; serviceBusy: boolean; wide?: boolean; onCheckCli?(): void }) {
  const mounted = useRef(false);
  const pending = useRef(false);
  const modelPath = agent === "pi" ? "/models?agent=pi" : "/models";
  const agentLabel = agent === "pi" ? "Pi" : "Codex";
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [draft, setDraft] = useState({ model: "", reasoningEffort: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const verifying = catalog?.verification?.status === "running";
  const accept = (value: ModelCatalog) => {
    setCatalog(value);
    setDraft((previous) => {
      const model = value.models.find((m) => m.model === previous.model)
        || value.models.find((m) => m.model === value.selected) || value.models.find((m) => m.isDefault) || value.models[0];
      const effort = model?.model === previous.model ? previous.reasoningEffort
        : model?.model === value.selected ? value.reasoningEffort : undefined;
      return { model: model?.model || "", reasoningEffort: model?.supportedReasoningEfforts?.some((option) => option.reasoningEffort === effort)
        ? effort! : model?.defaultReasoningEffort || model?.supportedReasoningEfforts?.[0]?.reasoningEffort || "" };
    });
  };
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const load = serviceBusy ? query<ModelCatalog>(modelPath) : request<ModelCatalog>({ type: "alchemy:models-refresh", agent });
    void load.then((value) => { if (!cancelled) accept(value); }, (e) => {
      if (!cancelled) setError(e.message === "Not found" ? "请重启本机服务，以启用模型选择。" : e.message);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { mounted.current = false; cancelled = true; };
  }, [agent]);
  useEffect(() => { onBusyChange?.(loading || !!verifying); return () => onBusyChange?.(false); }, [loading, verifying, onBusyChange]);
  useEffect(() => {
    if (!verifying) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const value = await query<ModelCatalog>(modelPath);
        if (cancelled) return 1500;
        accept(value);
        setError("");

      } catch (e) { if (!cancelled) setError((e as Error).message); }
      return 1500;
    };
    const stop = pollWhileVisible(poll);
    return () => { cancelled = true; stop(); };
  }, [verifying, agent]);
  const act = async (type: "alchemy:models-refresh" | "alchemy:model-verify") => {
    if (pending.current || loading || verifying || serviceBusy) return;
    pending.current = true;
    setLoading(true);
    setError("");
    try {
      const value = await request<ModelCatalog>({ type, agent, model: draft.model, reasoningEffort: draft.reasoningEffort || undefined });
      if (mounted.current) accept(value);
    }
    catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { pending.current = false; if (mounted.current) setLoading(false); }
  };
  const failure = catalog?.verification?.model === draft.model && catalog.verification.reasoningEffort === (draft.reasoningEffort || undefined) && catalog.verification.status === "failed" ? catalog.verification.error : "";
  const selected = catalog?.models.find((m) => m.model === catalog.selected);
  const model = catalog?.models.find((m) => m.model === draft.model);
  const efforts = model?.supportedReasoningEfforts || [];
  const verificationNote = `验证文字请求会消耗少量额度；${reverse || agent === "pi" ? "图片分析能力在逆向时检查。" : "图片与生图能力在使用时检查。"}`;
  const current = catalog?.selected ? `${selected?.label || catalog.selected}${catalog.reasoningEffort ? ` · ${catalog.reasoningEffort}` : ""}` : "尚未选择模型";
  return <div className="model-settings" aria-busy={loading || verifying}>
    {wide ? <>
      {reverse ? <div className="model-heading"><h3>{agentLabel} 模型</h3><button className="text-button" disabled={loading || verifying || serviceBusy} onClick={() => void act("alchemy:models-refresh")}>{loading ? "正在刷新…" : "刷新列表"}</button></div> : <h3>{agentLabel} 模型</h3>}
      <div className="settings-model-feature">{!reverse && <span className="settings-symbol" aria-hidden="true">✳</span>}<div>{reverse && <small>当前使用</small>}<strong>{loading && !catalog ? "正在读取模型…" : current}</strong><small>{catalog?.selected ? `${reverse ? "" : "当前使用 · "}${selected?.status === "verified" ? "请求已验证" : "待验证"}` : reverse ? "选择后验证并使用" : "待选择"}{catalog?.accountLabel ? `${reverse ? " · " : " / "}${catalog.accountLabel}` : ""}</small></div></div>
    </> : <><div className="model-heading">
      <h2>插件模型</h2>
      <button className="text-button" disabled={loading || verifying || serviceBusy} onClick={() => void act("alchemy:models-refresh")}>{loading ? "正在刷新…" : "刷新列表"}</button>
    </div><p className="fine">{catalog?.accountLabel || `本机 ${agentLabel}`}</p></>}
    <div className="settings-model-fields">
    <SelectField label={wide ? "可用模型" : "模型"} value={draft.model} disabled={loading || verifying || serviceBusy || !catalog?.models.length} onChange={(e) => {
      const next = catalog?.models.find((m) => m.model === e.target.value);
      setDraft({ model: e.target.value, reasoningEffort: next?.defaultReasoningEffort || next?.supportedReasoningEfforts?.[0]?.reasoningEffort || "" });
      setError("");
    }}>
      {!catalog?.models.length && <option value="">{loading ? "正在读取模型…" : "暂无可选模型"}</option>}
      {catalog?.models.map((m) => <option key={m.model} value={m.model}>{m.label} · {m.status === "verified" ? "已验证" : m.status === "unavailable" ? "不可用" : "待验证"}</option>)}
    </SelectField>
    <SelectField label="推理强度" value={draft.reasoningEffort} disabled={loading || verifying || serviceBusy || !efforts.length} onChange={(e) => { setDraft({ ...draft, reasoningEffort: e.target.value }); setError(""); }}>
      {!efforts.length && <option value="">模型默认</option>}
      {efforts.map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}{option.reasoningEffort === model?.defaultReasoningEffort ? " · 推荐" : ""}</option>)}
    </SelectField>
    </div>
    {!loading && model && !efforts.length && <p className="fine">{agent === "pi" ? "此模型使用默认推理强度。" : "当前服务未提供可选档位，请重启本机服务或检查 Codex 版本。"}</p>}
    {wide && !reverse && <div className="settings-row"><span className="settings-label">模型列表</span><button disabled={loading || verifying || serviceBusy} onClick={() => void act("alchemy:models-refresh")}>{loading ? "正在刷新…" : "刷新列表"}</button></div>}
    <button className="primary" disabled={serviceBusy || !draft.model || !reverse && (loading || verifying)} aria-disabled={loading || verifying || serviceBusy || !draft.model} onClick={() => void act("alchemy:model-verify")}>
      {verifying ? "正在验证…" : "验证并使用"}
    </button>
    <p className="fine model-status" role="status">{serviceBusy && !verifying ? "请等待正在执行的任务完成，再切换模型或推理强度。" : wide && !verifying ? verificationNote : verifying ? "正在发送简短请求，验证模型与推理强度。" : catalog?.selected ? `当前使用：${current}` : verificationNote}</p>
    {(error || failure) && <div className="error" role="alert">{error || failure} <RecoveryAction error={error || failure} currentSection="models" /></div>}
    {/登录/.test(error || failure || "") && loginCommand && <div className="settings-detail"><p className="fine">在终端完成登录后，刷新模型列表：</p><code>{loginCommand}</code></div>}
    {wide && onCheckCli && <button className={reverse ? "text-button model-manage-link" : "secondary"} disabled={loading || verifying || serviceBusy} onClick={onCheckCli}>管理 {agentLabel} CLI →</button>}
  </div>;
}
