import { useEffect, useRef, useState } from "react";
import { request } from "../../lib/client";
import SelectField from "./SelectField";
import type { ImageSettings, ImageProvider, MagpieModels } from "../../lib/types";

const labels = { magpie: "Magpie", codex: "Codex 内置生图", openai: "OpenAI 兼容 API", gemini: "Gemini 原生 API" };

export default function ImageGenerationSettings({ onSave, settingsRevision }: { settingsRevision: number; onSave(settings: Record<string, unknown>): Promise<ImageSettings> }) {
  const [saved, setSaved] = useState<ImageSettings>();
  const [provider, setProvider] = useState<ImageProvider>("codex");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [catalog, setCatalog] = useState<MagpieModels>();
  const [catalogError, setCatalogError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [checking, setChecking] = useState(false);
  const revision = useRef(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(false);
  const saving = useRef(false);
  const draftEdited = useRef(false);
  const validAddress = /^https?:\/\//.test(baseUrl) && URL.canParse(baseUrl);
  const selectedModelAvailable = !!catalog?.models.some(item => item.id === model);
  const choose = (value: ImageProvider, settings = saved, preserveNotice = false) => {
    revision.current++; setChecking(false); setCatalog(undefined); setCatalogError("");
    setProvider(value); setApiKey(""); if (!preserveNotice) setNotice(""); setError("");
    setBaseUrl(value === "codex" ? "" : settings?.configs[value]?.baseUrl || (value === "magpie" ? "http://127.0.0.1:3425" : ""));
    setModel(value === "codex" ? "" : settings?.configs[value]?.model || "");
  };
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const value = await request<ImageSettings>({ type: "alchemy:image-settings" });
        if (!cancelled) { setSaved(value); if (!draftEdited.current) choose(value.provider, value, true); }
      } catch (e) {
        if (!cancelled) setError((e as Error).message === "Not found" ? "请更新并重启本机服务，以启用 API 生图设置。" : (e as Error).message);
      }
    })();
    return () => { cancelled = true; alive.current = false; revision.current++; };
  }, [settingsRevision]);
  const save = async (clearApiKey = false) => {
    if (!saved || saving.current || (provider === "magpie" && (checking || !selectedModelAvailable))) return;
    saving.current = true; setPending(true); setError(""); setNotice("");
    try {
      const value = await onSave({
        provider, ...(provider === "codex" ? {} : provider === "magpie" ? { baseUrl, model } : { baseUrl, model, apiKey: clearApiKey ? "" : apiKey, ...(clearApiKey ? { clearApiKey: true } : {}) }),
      });
      if (alive.current) { draftEdited.current = false; setSaved(value); choose(value.provider, value); setNotice(clearApiKey ? "API Key 已清除。再次生图前请重新填写。" : "已保存，用于之后提交的生图任务。保存不会调用模型。" ); }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { saving.current = false; if (alive.current) setPending(false); }
  };
  useEffect(() => {
    if (provider !== "magpie" || !saved || !validAddress) return;
    const current = ++revision.current;
    setChecking(true); setCatalog(undefined); setCatalogError("");
    const timer = setTimeout(async () => {
      try {
        const value = await request<MagpieModels>({ type: "alchemy:image-models", baseUrl });
        if (alive.current && current === revision.current) setCatalog(value);
      } catch (e) { if (alive.current && current === revision.current) setCatalogError((e as Error).message === "Not found" ? "请更新并重启本机服务，以启用 Magpie。" : (e as Error).message); }
      finally { if (alive.current && current === revision.current) setChecking(false); }
    }, 200);
    return () => { clearTimeout(timer); revision.current++; };
  }, [provider, baseUrl, saved, refresh]);
  const catalogHint = !validAddress ? "请填写有效的 Magpie 本机地址。" : checking ? "正在读取生图模型…" : catalogError
    ? `${catalogError} 请检查地址和 Magpie 服务后刷新重试。` : !catalog ? "准备读取生图模型…"
    : !catalog.models.length ? "已连接，但没有可用的生图模型。请在 Magpie 配置生图来源后刷新。"
    : model && !selectedModelAvailable ? "已选模型不在当前目录中，原选择已保留。请重新选择模型，或检查 Magpie 配置后刷新。"
    : `已连接 Magpie ${catalog.version}，找到 ${catalog.models.length} 个生图模型。${model ? "" : "请选择模型后保存。"}目录可见不代表已通过实际生图验证。`;
  const hasKey = provider !== "codex" && provider !== "magpie" && !!saved?.configs[provider].hasApiKey;
  return <section aria-labelledby="image-generation-title" className="image-generation-settings">
    <h3 id="image-generation-title">生图渠道</h3>
    <p className="fine">独立选择图片生成服务，逆向 Agent 的选择保持不变。</p>
    {saved && <p className="fine">当前使用：{labels[saved.provider]}</p>}
    <form onChange={() => { draftEdited.current = true; }} onSubmit={event => { event.preventDefault(); void save(); }}>
      <SelectField label="生图渠道" aria-label="生图渠道" value={provider} disabled={!saved || pending} onChange={event => choose(event.target.value as ImageProvider)}>
        {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </SelectField>
      {provider === "magpie" && <>
        <p id="magpie-help" className="fine">填写本机网关地址后会自动读取模型，请选择后保存。生图来源在 Magpie 中配置，这里无需填写供应商 API Key。</p>
        <label className="settings-pair-label">Magpie 地址<input type="url" required maxLength={2048} autoComplete="off" spellCheck={false} value={baseUrl} disabled={pending} aria-describedby="magpie-help" onChange={event => { revision.current++; setChecking(false); setCatalog(undefined); setCatalogError(""); setBaseUrl(event.target.value); setModel(""); setNotice(""); setError(""); }} /></label>
        <button type="button" className="text-button" disabled={pending || checking || !validAddress} onClick={() => { setRefresh(value => value + 1); setNotice(""); }}>{checking ? "正在读取…" : "刷新模型"}</button>
        <SelectField label="生图模型" aria-label="生图模型" aria-describedby="magpie-model-status" aria-invalid={!!catalog && !!model && !selectedModelAvailable} required value={model} disabled={pending || checking || !catalog?.models.length} onChange={event => { setModel(event.target.value); setNotice(""); }}>
          <option value="">{checking ? "正在读取模型…" : catalog?.models.length ? "请选择生图模型" : "暂无可选模型"}</option>
          {model && !selectedModelAvailable && <option value={model} disabled>{model}（{catalog ? "当前目录不可用" : "待核对"}）</option>}
          {catalog?.models.map(item => <option key={item.id} value={item.id}>{item.name === item.id ? item.id : `${item.name} · ${item.id}`}</option>)}
        </SelectField>
        <p id="magpie-model-status" className="fine" role={catalogError ? "alert" : "status"}>{catalogHint}</p>
        <p className="fine">支持手动、连续与批量生图，可使用网关默认尺寸或指定像素尺寸。附图及具体尺寸是否可用取决于所选模型；目录可见不代表已通过实际生图验证。连接与保存不会生图；生成时提示词和所需图片交给 Magpie，由所选来源计费。</p>
      </>}
      {provider !== "codex" && provider !== "magpie" && <>
        <p id="image-api-help" className="fine">{provider === "openai" ? "需要支持 Images generations / edits 的接口。带参考图时使用 edits；仅提供聊天接口的服务不适用。" : "需要支持 generateContent 图片输出的 Gemini 模型。"} 地址须包含版本路径，例如 {provider === "openai" ? "https://api.openai.com/v1" : "https://generativelanguage.googleapis.com/v1beta"}。</p>
        <label className="settings-pair-label">API 地址<input type="url" required maxLength={2000} autoComplete="off" spellCheck={false} value={baseUrl} disabled={pending} aria-describedby="image-api-help" onChange={event => { setBaseUrl(event.target.value); setNotice(""); }} /></label>
        <label className="settings-pair-label">模型 ID<input required maxLength={200} autoComplete="off" spellCheck={false} value={model} disabled={pending} placeholder="填写服务商提供的生图模型 ID" onChange={event => { setModel(event.target.value); setNotice(""); }} /></label>
        <p id="image-api-key-help" className="fine">{hasKey ? "已保存密钥；留空保留，修改 API 地址时须重新填写。" : "尚未保存密钥。"} 密钥仅保存在本机服务的私有配置中。生图时，提示词和所需图片会发送给所选服务，费用由服务商收取。</p>
        <label className="settings-pair-label">API Key<input type="password" maxLength={4096} autoComplete="off" spellCheck={false} value={apiKey} disabled={pending} aria-describedby="image-api-key-help" placeholder={hasKey ? "已保存，留空不修改" : "输入 API Key"} onChange={event => { setApiKey(event.target.value); setNotice(""); }} /></label>
        <p className="fine">尺寸按接口支持的横竖方向或相近比例请求，精确比例同时写入提示词。不同模型的图片输入和尺寸能力可能不同；失败时不会自动切换渠道或重试付费请求。</p>
      </>}
      <button className="primary" disabled={!saved || pending || checking || (provider === "magpie" && !selectedModelAvailable)}>{pending ? "正在保存…" : "保存生图设置"}</button>
      {hasKey && <button type="button" className="text-button" disabled={pending} onClick={() => void save(true)}>清除 API Key</button>}
    </form>
    <p className="fine" role="status">{notice}</p>
    {error && <div className="settings-info settings-error" role="alert">{error}</div>}
  </section>;
}
