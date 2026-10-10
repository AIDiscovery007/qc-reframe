import { useEffect, useId, useRef, useState } from "react";
import { request } from "../../lib/client";
import type { ImageSettings, MagpieModels } from "../../lib/types";
import SelectField from "./SelectField";

export default function GenerationModelField({ model, settingsRevision, disabled, onSave }: {
  model?: string; settingsRevision: number; disabled: boolean;
  onSave(settings: Record<string, unknown>): Promise<ImageSettings>;
}) {
  const [catalog, setCatalog] = useState<MagpieModels>();
  const [baseUrl, setBaseUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const saving = useRef(false), revision = useRef(0), alive = useRef(false);
  const errorId = useId();
  useEffect(() => {
    alive.current = true;
    const current = ++revision.current;
    setLoading(true); setError("");
    void (async () => {
      try {
        const settings = await request<ImageSettings>({ type: "alchemy:image-settings" });
        if (!alive.current || current !== revision.current) return;
        if (settings.provider !== "magpie" || !settings.configs.magpie?.baseUrl) throw new Error("生图渠道已变化，请刷新后重试。");
        const address = settings.configs.magpie.baseUrl;
        const models = await request<MagpieModels>({ type: "alchemy:image-models", baseUrl: address });
        if (alive.current && current === revision.current) { setBaseUrl(address); setCatalog(models); }
      } catch (e) { if (alive.current && current === revision.current) setError((e as Error).message); }
      finally { if (alive.current && current === revision.current) setLoading(false); }
    })();
    return () => { alive.current = false; revision.current++; };
  }, [settingsRevision, model, refresh]);
  const choose = async (next: string) => {
    if (disabled || loading || saving.current || error || next === model || !catalog?.models.some(item => item.id === next)) return;
    const current = revision.current;
    saving.current = true; setPending(true); setError("");
    try { await onSave({ provider: "magpie", baseUrl, model: next }); }
    catch (e) { if (alive.current && current === revision.current) setError((e as Error).message); }
    finally { saving.current = false; if (alive.current) setPending(false); }
  };
  const available = catalog?.models.some(item => item.id === model);
  const message = error || (!loading && catalog && (!catalog.models.length ? "暂无可用的生图模型，原选择已保留。" : model && !available ? "原模型不在当前目录中，请选择其他模型或重试。" : ""));
  return <div className="generation-model-field">
    <SelectField label="生图模型" aria-label="生图模型" value={model || ""} disabled={disabled || loading || pending || !!error || !catalog?.models.length}
      aria-describedby={message ? errorId : undefined} onChange={event => void choose(event.target.value)}>
      {!model && <option value="">{loading ? "正在读取…" : "选择生图模型"}</option>}
      {model && !available && <option value={model} disabled>{model}</option>}
      {catalog?.models.map(item => <option key={item.id} value={item.id}>{item.name === item.id ? item.id : `${item.name} · ${item.id}`}</option>)}
    </SelectField>
    {message && <p id={errorId} className="error" role="alert">{message} <button type="button" className="text-button" disabled={disabled || pending || loading} onClick={() => setRefresh(value => value + 1)}>重试模型</button></p>}
  </div>;
}
