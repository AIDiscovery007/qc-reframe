import { useEffect, useRef, useState, type ReactNode } from "react";
import { normalizeImage } from "../../lib/image";
import { request } from "../../lib/client";
import type { Job, Mode, Selection } from "../../lib/types";
import ImagePreview from "./ImagePreview";
import LoadingPlaceholder from "./LoadingPlaceholder";
import SelectField from "./SelectField";
import Icon from "./Icon";

const modes: Record<Mode, string> = { style: "提取风格", recreate: "完整复刻", reenact: "主体重演", "multi-reenact": "多图重演" };

export default function QuickWorkspace({ revealPrompt, targetGeneration, contextKey, selection, title, mode, subject, instruction, job, disabled, modeDisabled, reverseDisabled, status, stale, cancelling, copied, lang, versions, onMode, onSubject, onAvailability, onInstruction, onReference, onRotateReference, onSwap, onReverse, onCancel, onCopy, onLanguage, onWorkspace, onUpdate, generationDisabled, generationHint }: {
  revealPrompt?: number; targetGeneration?: string; contextKey: string; selection?: Selection; title?: string; mode: Mode; subject: string; instruction: string; job?: Job;
  generationHint?: string; generationDisabled: boolean; disabled: boolean; modeDisabled: boolean; reverseDisabled: boolean; status?: string; stale: boolean; cancelling: boolean; copied: boolean; lang: "zh" | "en"; versions: ReactNode;
  onMode(mode: Mode): void; onSubject(image: string): void | Promise<void>; onAvailability(available: boolean): void;
  onInstruction(value: string): void; onReference(file?: File): void; onRotateReference(image: string): Promise<void>; onSwap(): void;
  onReverse(): void; onCancel(): void; onCopy(): void; onLanguage(lang: "zh" | "en"): void; onWorkspace(): void; onUpdate(job: Job): void;
}) {
  const [selected, select] = useState<"reference" | "subject">("reference");
  const [promptOpen, setPromptOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const pendingInput = useRef(false);
  const scope = useRef(contextKey);
  scope.current = contextKey;
  const subjectFile = useRef<HTMLInputElement>(null);
  const referenceFile = useRef<HTMLInputElement>(null);
  const promptToggle = useRef<HTMLButtonElement>(null);
  const subjectTab = useRef<HTMLButtonElement>(null);
  const pendingJob = useRef("");
  useEffect(() => {
    if (job?.status === "running") pendingJob.current = job.id;
    else {
      if (job?.result && pendingJob.current === job.id) setPromptOpen(true);
      pendingJob.current = "";
    }
  }, [job?.id, job?.status]);
  useEffect(() => { select("reference"); setUploading(false); setError(""); return () => { revision.current++; pendingInput.current = false; onAvailability(true); }; }, [contextKey]);
  useEffect(() => { if (revealPrompt !== undefined) setPromptOpen(true); else if (targetGeneration) setPromptOpen(false); }, [revealPrompt, targetGeneration]);
  const saveSubject = async (read: () => Promise<string>, rethrow = false) => {
    if (disabled || pendingInput.current) return false;
    const attempt = ++revision.current, context = contextKey;
    const current = () => attempt === revision.current && context === scope.current;
    pendingInput.current = true;
    setUploading(true); setError(""); onAvailability(false);
    try {
      const image = await read();
      if (!current()) return false;
      await onSubject(image);
      return current();
    } catch (error) {
      if (current()) setError((error as Error).message);
      if (rethrow) throw error;
      return false;
    } finally { if (current()) { pendingInput.current = false; setUploading(false); onAvailability(true); } }
  };
  const uploadSubject = async (file?: File) => {
    if (!file) return;
    const saved = await saveSubject(async () => {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 20 * 1024 * 1024) throw new Error("请上传不超过20 MB的PNG、JPEG或WebP图片");
      return normalizeImage(file, 2 * 1024 * 1024);
    });
    if (saved) { select("subject"); subjectTab.current?.focus({ preventScroll: true }); }
  };
  const removeSubject = async () => { if (await saveSubject(async () => "")) select("reference"); };
  const rotateSubject = async (image: string) => {
    if (!await saveSubject(async () => image, true)) throw new Error("当前输入已切换，请重新调整图片");
  };
  const multi = mode === "multi-reenact";
  const paired = mode === "style" || mode === "reenact";
  const image = selected === "subject" && paired ? subject : selection?.image;
  const label = selected === "subject" && paired ? "主体图" : "参考图";
  const locked = disabled || uploading;
  return <section className="quick-workspace" aria-label="快捷逆向">
    <div className="quick-heading"><h1>{title || "选择参考图"}</h1><SelectField label="" aria-label="逆向模式" value={mode} disabled={modeDisabled || uploading} onChange={e => onMode(e.target.value as Mode)}>{Object.entries(modes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</SelectField></div>
    <div className="quick-canvas">
      {image ? <ImagePreview src={image} alt={label} rotation={{ maxBytes: selected === "subject" ? 2 * 1024 * 1024 : 4 * 1024 * 1024, disabled: locked, onApply: selected === "subject" ? rotateSubject : onRotateReference }} />
        : selection && !selection.image && !selection.error ? <LoadingPlaceholder>正在读取参考图…</LoadingPlaceholder>
        : <button className="quick-upload" disabled={locked} onClick={() => selected === "subject" ? subjectFile.current?.click() : referenceFile.current?.click()}><Icon name="plus" />{uploading ? "正在读取…" : `上传${label}`}</button>}
    </div>
    {selection && <div className="quick-filmstrip" role="group" aria-label="图片图条">
      <button aria-label="查看参考图" aria-pressed={selected === "reference"} onClick={() => select("reference")}>{selection.image && <img src={selection.image} alt="" />}参考图</button>
      {paired && <button ref={subjectTab} aria-label="查看主体图" aria-pressed={selected === "subject"} onClick={() => select("subject")}>{subject ? <img src={subject} alt="" /> : <Icon name="plus" />}主体图{mode === "style" && !subject ? " · 可选" : ""}</button>}
    </div>}
    <div className="quick-tools">
      {versions}
      <button className="icon-button" aria-label={`替换${label}`} title={`替换${label}`} disabled={locked} onClick={() => selected === "subject" ? subjectFile.current?.click() : referenceFile.current?.click()}><Icon name="plus" /></button>
      {paired && <><button className="icon-button" aria-label="互换主体与参考" title="互换主体与参考" disabled={locked || !subject || !selection?.image} onClick={onSwap}><Icon name="swap" /></button><button className="icon-button" aria-label="移除主体" title="移除主体" disabled={locked || !subject} onClick={() => void removeSubject()}><Icon name="trash" /></button></>}
      {job?.result && <button ref={promptToggle} className="text-button quick-prompt-toggle" aria-expanded={promptOpen} aria-controls="quick-prompt" onClick={() => setPromptOpen(!promptOpen)}><Icon name="edit" />提示词<Icon name="chevronDown" /></button>}
    </div>
    <input ref={referenceFile} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传参考图" onChange={e => { onReference(e.target.files?.[0]); e.target.value = ""; }} />
    <input ref={subjectFile} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传主体图" onChange={e => { void uploadSubject(e.target.files?.[0]); e.target.value = ""; }} />
    {(error || selection?.error || job?.error) && <p data-reminder-task={!error && job?.error && job.status === "failed" ? job.id : undefined} className="error" role="alert">{error || job?.error || selection?.error}</p>}
    {multi ? <div className="quick-handoff"><span>多图编排在工作台继续</span><button className="primary" disabled={uploading} onClick={onWorkspace}>打开工作台<Icon name="arrow" /></button></div> : selection ? <div className="quick-compose">
      <textarea aria-label="任务指令" rows={2} value={instruction} disabled={locked} onChange={e => onInstruction(e.target.value)} />
      <div className="quick-submit"><span role="status">{status || (stale ? "输入已修改" : job?.status === "cancelled" ? "已取消" : "")}</span>{job?.status === "running" ? <button className="text-button" disabled={cancelling} onClick={onCancel}>{cancelling ? "正在取消…" : "取消"}</button> : <button className="primary" disabled={reverseDisabled || uploading} onClick={onReverse}>{job?.result ? "重新生成" : "生成提示词"}<Icon name="arrow" /></button>}</div>
    </div> : <p className="quick-empty-hint">也可从网页图片打开快捷面板</p>}
    {multi && job?.status === "running" && <div className="quick-submit"><span role="status">{status}</span><button className="text-button" disabled={cancelling} onClick={onCancel}>{cancelling ? "正在取消…" : "取消"}</button></div>}
    {job?.result && <section id="quick-prompt" className="quick-prompt" hidden={!promptOpen} aria-label="当前提示词" onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setPromptOpen(false); promptToggle.current?.focus(); } }}>
      <div className="quick-prompt-head"><div className="language-tabs"><button aria-pressed={lang === "zh"} onClick={() => onLanguage("zh")}>中</button><button aria-pressed={lang === "en"} onClick={() => onLanguage("en")}>EN</button></div><button className="text-button" data-copied={copied} onClick={onCopy}>{copied ? "已复制" : "复制"}</button></div>
      <p className="quick-prompt-text" data-reminder-task={job.id}>{lang === "zh" ? job.result.promptZh : job.result.promptEn}</p>
      <button className="text-button" onClick={onWorkspace}>完整编辑<Icon name="arrow" /></button>
    </section>}
    {job && <QuickResult key={job.id} targetGeneration={targetGeneration} job={job} lang={lang} subject={subject} disabled={generationDisabled || uploading} hint={generationHint} onSubject={() => subjectFile.current?.click()} onReverse={onReverse} onUpdate={onUpdate} onWorkspace={onWorkspace} />}
  </section>;
}

function QuickResult({ targetGeneration, job, lang, subject, disabled, hint, onSubject, onReverse, onUpdate, onWorkspace }: { targetGeneration?: string; hint?: string; onSubject(): void; onReverse(): void; job: Job; lang: "zh" | "en"; subject: string; disabled: boolean; onUpdate(job: Job): void; onWorkspace(): void }) {
  const running = job.generations?.find(item => item.status === "running");
  const generation = job.generations?.find(item => item.id === targetGeneration) || running || job.generations?.at(-1);
  const generic = job.mode === "style" && !job.reenact;
  const incomplete = /\[SUBJECT\]/i.test(lang === "zh" ? job.result?.promptZh || "" : job.result?.promptEn || "");
  const inputsReady = job.mode === "recreate" || !!subject;
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [asset, setAsset] = useState<{ key: string; image: string }>();
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const key = `${job.id}:${generation?.id}`;
  useEffect(() => {
    let cancelled = false; setError("");
    if (generation?.status === "completed") void request<{ image: string }>({ type: "alchemy:generation-image", id: job.id, generationId: generation.id }).then(value => { if (!cancelled) setAsset({ key, image: value.image }); }, error => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [key, generation?.status]);
  if (!job.result) return null;
  const act = async (cancel: boolean) => {
    if (pending.current || (!cancel && (disabled || running || generic || incomplete || !inputsReady || job.mode === "multi-reenact")) || (cancel && !running)) return;
    pending.current = true;
    setCancelling(true); setError("");
    try { const updated = await request<Job>({ type: cancel ? "alchemy:generation-cancel" : "alchemy:generate", id: job.id, generationId: cancel ? running?.id : undefined,
      ...(!cancel ? { language: lang, aspectRatio: generation?.aspectRatio, ...(job.mode !== "recreate" ? { subjectImage: subject } : {}) } : {}) }); if (mounted.current) onUpdate(updated); }
    catch (error) { if (mounted.current) setError((error as Error).message); }
    finally { pending.current = false; if (mounted.current) setCancelling(false); }
  };
  return <section className="quick-result" aria-label="当前生图结果"><div className="quick-result-head"><strong>生成结果</strong><button className="text-button" onClick={onWorkspace}>工作台查看<Icon name="arrow" /></button></div>
    {asset?.key === key && generation?.status === "completed" ? <ImagePreview data-reminder-task={generation.id} src={asset.image} alt="当前生成结果" /> : generation ? <p data-reminder-task={generation.status === "failed" ? generation.id : undefined} role="status">{generation?.status === "running" ? generation?.stage || "正在生成图片…" : generation?.status === "failed" ? "图片生成失败" : generation?.status === "cancelled" ? "图片生成已取消" : "正在读取结果…"}</p> : null}
    {(error || generation?.error) && <p className="error" role="alert">{error || generation?.error}</p>}
    {!running && job.mode !== "multi-reenact" && (generic || incomplete || !inputsReady || hint) && <p className="quick-generation-hint" role="status">{!inputsReady ? <>先添加主体图 <button className="text-button" onClick={onSubject}>上传主体</button></> : generic || incomplete ? <>需要专属提示词 <button className="text-button" onClick={onReverse}>重新逆向</button></> : hint}</p>}
    {generation?.status === "running" ? <button className="text-button" disabled={cancelling} onClick={() => void act(true)}>{cancelling ? "正在取消…" : "取消生图"}</button> : job.mode !== "multi-reenact" && <button className="primary" disabled={disabled || cancelling || generic || incomplete || !inputsReady} onClick={() => void act(false)}>{cancelling ? "正在提交…" : "生成图片"}<Icon name="arrow" /></button>}
  </section>;
}
