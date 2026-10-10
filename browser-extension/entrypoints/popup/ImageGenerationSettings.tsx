import { useEffect, useRef, useState } from "react";
import { request } from "../../lib/client";
import SelectField from "./SelectField";
import ModelSettings from "./ModelSettings";
import type { ImageSettings, ImageProvider } from "../../lib/types";

const labels = { codex: "Codex 内置生图", openai: "OpenAI 兼容 API", gemini: "Gemini 原生 API" };

export default function ImageGenerationSettings({ serviceBusy, onCheckCli, loginCommand }: {
  serviceBusy: boolean; onCheckCli(): void; loginCommand?: string;
}) {
  const [saved, setSaved] = useState<ImageSettings>();
  const [provider, setProvider] = useState<ImageProvider>("codex");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(false);
  const saving = useRef(false);
  const choose = (value: ImageProvider, settings = saved) => {
    setProvider(value); setApiKey(""); setNotice(""); setError("");
    setBaseUrl(value === "codex" ? "" : settings?.configs[value].baseUrl || "");
    setModel(value === "codex" ? "" : settings?.configs[value].model || "");
  };
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const value = await request<ImageSettings>({ type: "alchemy:image-settings" });
        if (!cancelled) { setSaved(value); choose(value.provider, value); }
      } catch (e) {
        if (!cancelled) setError((e as Error).message === "Not found" ? "请更新并重启本机服务，以启用 API 生图设置。" : (e as Error).message);
      }
    })();
    return () => { cancelled = true; alive.current = false; };
  }, []);
  const save = async (clearApiKey = false) => {
    if (!saved || saving.current) return;
    saving.current = true; setPending(true); setError(""); setNotice("");
    try {
      const value = await request<ImageSettings>({ type: "alchemy:image-settings-save", settings: {
        provider, ...(provider === "codex" ? {} : { baseUrl, model, apiKey: clearApiKey ? "" : apiKey, ...(clearApiKey ? { clearApiKey: true } : {}) }),
      } });
      if (alive.current) { setSaved(value); choose(value.provider, value); setNotice(clearApiKey ? "API Key 已清除。再次生图前请重新填写。" : "已保存，用于之后提交的生图任务。保存不会调用模型。" ); }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { saving.current = false; if (alive.current) setPending(false); }
  };
  const hasKey = provider !== "codex" && !!saved?.configs[provider].hasApiKey;
  return <section aria-labelledby="image-generation-title" className="image-generation-settings">
    <h3 id="image-generation-title">生图渠道</h3>
    <p className="fine">独立选择图片生成服务，逆向 Agent 的选择保持不变。</p>
    {saved && <p className="fine">当前使用：{labels[saved.provider]}</p>}
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <SelectField label="生图渠道" aria-label="生图渠道" value={provider} disabled={!saved || pending} onChange={event => choose(event.target.value as ImageProvider)}>
        {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </SelectField>
      {provider !== "codex" && <>
        <p id="image-api-help" className="fine">{provider === "openai" ? "需要支持 Images generations / edits 的接口。带参考图时使用 edits；仅提供聊天接口的服务不适用。" : "需要支持 generateContent 图片输出的 Gemini 模型。"} 地址须包含版本路径，例如 {provider === "openai" ? "https://api.openai.com/v1" : "https://generativelanguage.googleapis.com/v1beta"}。</p>
        <label className="settings-pair-label">API 地址<input type="url" required maxLength={2000} autoComplete="off" spellCheck={false} value={baseUrl} disabled={pending} aria-describedby="image-api-help" onChange={event => { setBaseUrl(event.target.value); setNotice(""); }} /></label>
        <label className="settings-pair-label">模型 ID<input required maxLength={200} autoComplete="off" spellCheck={false} value={model} disabled={pending} placeholder="填写服务商提供的生图模型 ID" onChange={event => { setModel(event.target.value); setNotice(""); }} /></label>
        <p id="image-api-key-help" className="fine">{hasKey ? "已保存密钥；留空保留，修改 API 地址时须重新填写。" : "尚未保存密钥。"} 密钥仅保存在本机服务的私有配置中。生图时，提示词和所需图片会发送给所选服务，费用由服务商收取。</p>
        <label className="settings-pair-label">API Key<input type="password" maxLength={4096} autoComplete="off" spellCheck={false} value={apiKey} disabled={pending} aria-describedby="image-api-key-help" placeholder={hasKey ? "已保存，留空不修改" : "输入 API Key"} onChange={event => { setApiKey(event.target.value); setNotice(""); }} /></label>
        <p className="fine">尺寸按接口支持的横竖方向或相近比例请求，精确比例同时写入提示词。不同模型的图片输入和尺寸能力可能不同；失败时不会自动切换渠道或重试付费请求。</p>
      </>}
      <button className="primary" disabled={!saved || pending}>{pending ? "正在保存…" : "保存生图设置"}</button>
      {hasKey && <button type="button" className="text-button" disabled={pending} onClick={() => void save(true)}>清除 API Key</button>}
    </form>
    <p className="fine" role="status">{notice}</p>
    {error && <div className="settings-info settings-error" role="alert">{error}</div>}
    {provider === "codex" && saved && <ModelSettings wide agent="codex" serviceBusy={serviceBusy || pending} onCheckCli={onCheckCli} loginCommand={loginCommand} />}
  </section>;
}
