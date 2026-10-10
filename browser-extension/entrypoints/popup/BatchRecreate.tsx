import { useEffect, useRef, useState } from "react";
import { request } from "../../lib/client";
import { showMotionDialog } from "../../lib/motion-dialog";
import type { AspectRatio, Batch, BatchPreview, BatchProject, ProjectSummary } from "../../lib/types";
import SelectField from "./SelectField";
import GenerationSizeFields from "./GenerationSizeFields";
import { inheritedGenerationSize } from "../../lib/generation-size";
import { requestedImageSize, validImageSizeRequest } from "../../lib/image-size.mjs";
import { validGenerationRatio } from "../../lib/generation-session";

type Submission = { generationModel?: string; requestId: string; projects: BatchProject[]; language: "zh" | "en"; aspectRatio?: AspectRatio; imageSize?: AspectRatio; pixelSize?: boolean };

export default function BatchRecreate({ generationModel, pixelSize = false, projects, showHidden, hiddenProjectIds, onClose, onStarted }: {
  generationModel?: string; pixelSize?: boolean; projects: ProjectSummary[]; showHidden: boolean; hiddenProjectIds: string[]; onClose(): void; onStarted(batch: Batch): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(false);
  const pending = useRef(false);
  const started = useRef(onStarted);
  started.current = onStarted;
  const storageKey = `reframe:batch-pending:${projects.map(item => item.id).sort().join(",")}`;
  const [submission, setSubmission] = useState<Submission | undefined>(() => {
    try { return JSON.parse(sessionStorage.getItem(storageKey) || "null") || undefined; }
    catch { return undefined; }
  });
  const [language, setLanguage] = useState<"zh" | "en">(submission?.language || "zh");
  const usePixels = submission ? !!submission.pixelSize : pixelSize;
  const [sizeDraft, setSizeDraft] = useState(() => ({ pixelSize: usePixels, size: inheritedGenerationSize(usePixels, submission) }));
  const size = sizeDraft.pixelSize === usePixels ? sizeDraft.size : undefined;
  const setSize = (size?: AspectRatio) => setSizeDraft({ pixelSize: usePixels, size });
  const validSize = usePixels ? validImageSizeRequest(size) : validGenerationRatio(size);
  const [preview, setPreview] = useState<BatchPreview>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    alive.current = true;
    const close = showMotionDialog(dialog.current!);
    return () => { alive.current = false; close(); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setPreview(undefined); setError("");
    void (async () => {
      try {
        const value = await request<BatchPreview>({ type: "alchemy:batch-preview", projects: projects.map(item => ({ projectId: item.id, inputRevision: item.inputRevision || 0 })) });
        if (!cancelled) setPreview(value);
      } catch (reason) { if (!cancelled) setError((reason as Error).message); }
    })();
    return () => { cancelled = true; };
  }, [projects, retry]);
  const visible = (id: string) => showHidden || !hiddenProjectIds.includes(id);
  const previewItems = preview?.items.filter(item => visible(item.projectId)) || [];
  const eligible = previewItems.filter(item => item.eligible);
  const start = async () => {
    if (pending.current || (!submission && (!eligible.length || !validSize))) return;
    const requestedSize = pixelSize ? requestedImageSize(size) : size;
    const body = submission || { requestId: crypto.randomUUID(), projects: eligible.map(({ projectId, inputRevision }) => ({ projectId, inputRevision })), language,
      generationModel, pixelSize, ...(requestedSize ? pixelSize ? { imageSize: { ...requestedSize } } : { aspectRatio: { ...requestedSize } } : {}) };
    pending.current = true; setBusy(true); setError(""); setSubmission(body);
    // Retain the exact request after an uncertain response, including across a page reload.
    try { sessionStorage.setItem(storageKey, JSON.stringify(body)); } catch { /* The open dialog still retains the request. */ }
    try {
      const { pixelSize: _pixelSize, generationModel: _generationModel, ...snapshot } = body;
      const batch = await request<Batch>({ type: "alchemy:batch-start", ...snapshot });
      try { sessionStorage.removeItem(storageKey); } catch { /* A repeated request is still idempotent. */ }
      if (alive.current) started.current(batch);
    } catch (reason) { if (alive.current) setError((reason as Error).message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <dialog ref={dialog} className="result-dialog modal dialog-small batch-recreate" aria-labelledby="batch-recreate-title"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!pending.current) onClose(); }}
    onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
    <div className="modal-head"><h2 id="batch-recreate-title">批量完整复刻</h2><button className="close-btn" aria-label="关闭窗口" disabled={busy} onClick={onClose}>×</button></div>
    <div className="dialog-content">
      <p>每个项目使用已保存的参考图和完整复刻指令，生成新提示词后自动生图。</p>
      {preview && <p className="hint">模型：{preview.model} · 最多同时执行 2 个批量项目</p>}
      <div className="batch-options">
        <SelectField label="提示词语言" aria-label="提示词语言" value={language} disabled={busy || !!submission} onChange={event => setLanguage(event.target.value as "zh" | "en")}>
          <option value="zh">中文</option><option value="en">英文</option>
        </SelectField>
        <GenerationSizeFields generationModel={submission ? submission.generationModel : generationModel} key={String(usePixels)} pixelSize={usePixels} value={size} onChange={setSize} disabled={busy || !!submission} />
      </div>
      {submission && !busy && <p role="status">上次提交结果尚未确认。重试会核对同一请求，不会重复启动；也可关闭后在任务中心查看。</p>}
      {!preview && !error && <p role="status">正在检查 {projects.filter(item => visible(item.id)).length} 个项目…</p>}
      {preview && <><p role="status">可启动 {eligible.length} 个，共 {previewItems.length} 个项目</p>
        <ul className="batch-checks">{previewItems.map(item => <li key={item.projectId}><strong>{item.title}</strong><span>{item.eligible ? "可以启动" : item.error || "暂不能启动"}</span></li>)}</ul></>}
      {error && <p className="error" role="alert">{error}{!submission && <button className="text-button" onClick={() => setRetry(value => value + 1)}>重新检查</button>}</p>}
      <div className="dialog-actions"><button className="secondary" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary" disabled={busy || (!submission && (!eligible.length || !validSize))} aria-busy={busy} onClick={() => void start()}>{busy ? "正在提交…" : submission ? "重试提交" : `启动 ${eligible.length} 个项目`}</button>
      </div>
    </div>
  </dialog>;
}
