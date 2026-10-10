import { orderedImageIds } from "../../lib/image-order";
import RecoveryAction from "./RecoveryAction";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { normalizeImage } from "../../lib/image";
import { useGeneration } from "../../lib/use-generation";
import type { Job, Mode, Selection } from "../../lib/types";
import ImagePreview from "./ImagePreview";
import LoadingPlaceholder from "./LoadingPlaceholder";
import SelectField from "./SelectField";
import Icon from "./Icon";

const modes: Record<Mode, string> = { style: "提取风格", recreate: "完整复刻", reenact: "主体重演", "multi-reenact": "多图重演", session: "会话创作" };

export default function QuickWorkspace({ gatewayDefaultSize = false, revealPrompt, targetGeneration, contextKey, selection, title, mode, subject, referenceIndex, onImageOrder, instruction, job, disabled, modeDisabled, reverseDisabled, continuous, submitting, status, stale, cancelling, copied, lang, versions, onMode, onSubject, onAvailability, onInstruction, onReference, onRotateReference, onSwap, onReverse, onGenerate, chainDisabled, onCancel, onCopy, onLanguage, onWorkspace, onUpdate, onGenerationViewUpdate, generationDisabled, generationHint }: {
  gatewayDefaultSize?: boolean;
  revealPrompt?: number; targetGeneration?: string; contextKey: string; selection?: Selection; title?: string; mode: Mode; subject: string; instruction: string; job?: Job;
  referenceIndex: number; onImageOrder(referenceIndex: number, onSaved: () => void): Promise<void>;
  generationHint?: string; generationDisabled: boolean; disabled: boolean; modeDisabled: boolean; reverseDisabled: boolean; continuous: boolean; submitting: boolean; status?: string; stale: boolean; cancelling: boolean; copied: boolean; lang: "zh" | "en"; versions: ReactNode;
  onMode(mode: Mode): void; onSubject(image: string): void | Promise<void>; onAvailability(available: boolean): void;
  onInstruction(value: string): void; onReference(file?: File): void; onRotateReference(image: string): Promise<void>; onSwap(): void;
  onReverse(): void; onGenerate(): void; chainDisabled: boolean; onCancel(): void; onCopy(): void; onLanguage(lang: "zh" | "en"): void; onWorkspace(): void; onUpdate(job: Job): void; onGenerationViewUpdate(): void;
}) {
  const reverseRunning = job?.status === "running" || job?.autoGeneration?.status === "pending";
  // Stable action buttons preserve keyboard focus; aria-disabled requests remain guarded.
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
  const referenceTab = useRef<HTMLButtonElement>(null);
  const focusAfterOrder = useRef(false);
  const pendingJob = useRef("");
  useEffect(() => {
    if (job?.status === "running") pendingJob.current = job.id;
    else {
      if (job?.result && !job.autoGeneration && pendingJob.current === job.id) setPromptOpen(true);
      pendingJob.current = "";
    }
  }, [job?.id, job?.status]);
  useEffect(() => { select("reference"); }, [selection?.projectId || selection?.id, mode]);
  useEffect(() => { setUploading(false); setError(""); return () => { revision.current++; pendingInput.current = false; onAvailability(true); }; }, [contextKey]);
  useEffect(() => {
    if (!focusAfterOrder.current) return;
    focusAfterOrder.current = false;
    (selected === "subject" ? subjectTab : referenceTab).current?.focus({ preventScroll: true });
  }, [referenceIndex, contextKey]);
  useEffect(() => { if (revealPrompt !== undefined) setPromptOpen(true); else if (targetGeneration) setPromptOpen(false); }, [revealPrompt, targetGeneration]);
  const saveSubject = async (read: () => Promise<string>, rethrow = false) => {
    if (disabled || pendingInput.current) return false;
    const attempt = ++revision.current, context = contextKey;
    const current = () => attempt === revision.current && context === scope.current;
    pendingInput.current = true;
    setUploading(true); setError(""); onAvailability(false);
    let saved = false;
    try {
      const image = await read();
      if (!current()) return false;
      await onSubject(image);
      saved = true;
      return current();
    } catch (error) {
      if (current()) setError((error as Error).message);
      if (rethrow) throw error;
      return false;
    } finally { if (current()) { pendingInput.current = false; setUploading(false); onAvailability(saved); } }
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
  const multi = mode === "multi-reenact" || mode === "session";
  const paired = mode === "style" || mode === "reenact";
  const image = selected === "subject" && paired ? subject : selection?.image;
  const label = selected === "subject" && paired ? "主体图" : "参考图";
  const imageIds = orderedImageIds(paired && subject ? ["subject"] : [], referenceIndex);
  const imageIndex = imageIds.indexOf(selected);
  const reorder = async () => {
    if (disabled || pendingInput.current) return;
    const context = contextKey, attempt = ++revision.current;
    pendingInput.current = true; setUploading(true); setError("");
    try { await onImageOrder(referenceIndex === 0 ? 1 : 0, () => { focusAfterOrder.current = true; }); }
    catch (error) { if (context === scope.current && attempt === revision.current) setError((error as Error).message); }
    finally { if (context === scope.current && attempt === revision.current) { pendingInput.current = false; setUploading(false); } }
  };
  const locked = disabled || uploading;
  return <section className="quick-workspace" aria-label="快捷逆向">
    <div className="quick-heading"><h1>{title || "选择参考图"}</h1><SelectField label="" aria-label="逆向模式" value={mode} disabled={modeDisabled || uploading} onChange={e => onMode(e.target.value as Mode)}>{Object.entries(modes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</SelectField></div>
    <div className="quick-canvas">
      {image ? <ImagePreview src={image} alt={label} rotation={{ maxBytes: selected === "subject" ? 2 * 1024 * 1024 : 4 * 1024 * 1024, disabled: locked, onApply: selected === "subject" ? rotateSubject : onRotateReference }} />
        : selection && !selection.image && !selection.error ? <LoadingPlaceholder>正在读取参考图…</LoadingPlaceholder>
        : <button className="quick-upload" disabled={locked} onClick={() => selected === "subject" ? subjectFile.current?.click() : referenceFile.current?.click()}><Icon name="plus" />{uploading ? "正在读取…" : `上传${label}`}</button>}
    </div>
    {selection && <div className="quick-filmstrip" role="group" aria-label="图片图条">
      {imageIds.map((id, i) => <button key={id} ref={id === "subject" ? subjectTab : referenceTab} aria-label={id === "reference" ? "查看参考图" : "查看主体图"} aria-description={`图 ${i + 1}`} aria-pressed={selected === id} onClick={() => select(id as "reference" | "subject")}>{(id === "reference" ? selection.image : subject) && <img src={id === "reference" ? selection.image : subject} alt="" />}图 {i + 1} · {id === "reference" ? "参考图" : "主体图"}</button>)}
      {paired && !subject && <button ref={subjectTab} aria-label="查看主体图" aria-pressed={selected === "subject"} onClick={() => select("subject")}><Icon name="plus" />主体图{mode === "style" ? " · 可选" : ""}</button>}
    </div>}
    <div className="quick-tools">
      {versions}
      <button className="icon-button" aria-label={`替换${label}`} title={`替换${label}`} disabled={locked} onClick={() => selected === "subject" ? subjectFile.current?.click() : referenceFile.current?.click()}><Icon name="plus" /></button>
      {paired && <><button className="icon-button" aria-label="互换主体与参考" title="互换主体与参考" disabled={locked || !subject || !selection?.image} onClick={onSwap}><Icon name="swap" /></button><button className="icon-button" aria-label="移除主体" title="移除主体" disabled={locked || !subject} onClick={() => void removeSubject()}><Icon name="trash" /></button></>}
      {paired && subject && <><button className="icon-button" aria-label="图片前移" title="图片前移" disabled={locked || imageIndex <= 0} onClick={() => void reorder()}>←</button><button className="icon-button" aria-label="图片后移" title="图片后移" disabled={locked || imageIndex !== 0} onClick={() => void reorder()}>→</button></>}
      {job?.result && <button ref={promptToggle} className="text-button quick-prompt-toggle" aria-expanded={promptOpen} aria-controls="quick-prompt" onClick={() => setPromptOpen(!promptOpen)}><Icon name="edit" />提示词<Icon name="chevronDown" /></button>}
    </div>
    <input ref={referenceFile} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传参考图" onChange={e => { onReference(e.target.files?.[0]); e.target.value = ""; }} />
    <input ref={subjectFile} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传主体图" onChange={e => { void uploadSubject(e.target.files?.[0]); e.target.value = ""; }} />
    {(error || selection?.error || job?.error || job?.autoGeneration?.error) && <p data-reminder-task={!error && job?.error && job.status === "failed" ? job.id : undefined} className="error" role="alert">{error || job?.error || job?.autoGeneration?.error || selection?.error} <RecoveryAction error={error || job?.error || job?.autoGeneration?.error || selection?.error} /></p>}
    {multi ? <div className="quick-handoff"><span>{mode === "session" ? "会话创作在工作台继续" : "多图编排在工作台继续"}</span><button className="primary" disabled={uploading} onClick={onWorkspace}>打开工作台<Icon name="arrow" /></button></div> : selection ? <div className="quick-compose">
      <textarea aria-label="任务指令" rows={2} value={instruction} disabled={locked} onChange={e => onInstruction(e.target.value)} />
      <div className="quick-submit"><span role="status">{status || (mode === "style" && !subject ? "添加主体图后可逆向并生图" : stale ? "输入已修改" : job?.status === "cancelled" ? "已取消" : "")}</span><div className="quick-submit-actions">
        <button className="text-button" hidden={reverseRunning && continuous} disabled={!reverseRunning && !submitting && (reverseDisabled || uploading)} aria-disabled={reverseRunning ? cancelling : reverseDisabled || uploading} onClick={reverseRunning ? cancelling ? undefined : onCancel : reverseDisabled || uploading ? undefined : onReverse}>{reverseRunning ? cancelling ? "正在取消…" : "取消" : job?.result ? "更新提示词" : "仅逆向"}</button>
        <button className="primary" hidden={reverseRunning && !continuous} disabled={!reverseRunning && !submitting && (chainDisabled || uploading)} aria-disabled={reverseRunning ? cancelling : chainDisabled || uploading} onClick={reverseRunning ? cancelling ? undefined : onCancel : chainDisabled || uploading ? undefined : onGenerate}>{reverseRunning ? cancelling ? "正在取消…" : "取消" : <>逆向并生图<Icon name="arrow" /></>}</button>
      </div></div>
    </div> : <p className="quick-empty-hint">也可从网页图片打开快捷面板</p>}
    {multi && reverseRunning && <div className="quick-submit"><span role="status">{status}</span><button className="text-button" disabled={cancelling} onClick={onCancel}>{cancelling ? "正在取消…" : "取消"}</button></div>}
    {job?.result && <section id="quick-prompt" className="quick-prompt" hidden={!promptOpen} aria-label="当前提示词" onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setPromptOpen(false); promptToggle.current?.focus(); } }}>
      <div className="quick-prompt-head"><div className="language-tabs"><button aria-pressed={lang === "zh"} onClick={() => onLanguage("zh")}>中</button><button aria-pressed={lang === "en"} onClick={() => onLanguage("en")}>EN</button></div><button className="text-button" data-copied={copied} onClick={onCopy}>{copied ? "已复制" : "复制"}</button></div>
      <p className="quick-prompt-text" data-reminder-task={job.id}>{lang === "zh" ? job.result.promptZh : job.result.promptEn}</p>
      <button className="text-button" onClick={onWorkspace}>完整编辑<Icon name="arrow" /></button>
    </section>}
    {job && <QuickResult gatewayDefaultSize={gatewayDefaultSize} key={job.id} targetGeneration={targetGeneration} job={job} lang={lang} subject={subject} disabled={generationDisabled || uploading} hint={generationHint} onSubject={() => subjectFile.current?.click()} onReverse={onReverse} onUpdate={onUpdate} onGenerationViewUpdate={onGenerationViewUpdate} onWorkspace={onWorkspace} />}
  </section>;
}

function QuickResult({ gatewayDefaultSize, targetGeneration, job, lang, subject, disabled, hint, onSubject, onReverse, onUpdate, onGenerationViewUpdate, onWorkspace }: { gatewayDefaultSize: boolean; targetGeneration?: string; hint?: string; onSubject(): void; onReverse(): void; job: Job; lang: "zh" | "en"; subject: string; disabled: boolean; onUpdate(job: Job): void; onGenerationViewUpdate(): void; onWorkspace(): void }) {
  const running = job.generations?.find(item => item.status === "running");
  const generation = job.generations?.find(item => item.id === targetGeneration) || running || job.generations?.at(-1);
  const controls = useGeneration({ job, lang, disabled, subjectImage: subject, generation, allowMulti: false,
    aspectRatio: gatewayDefaultSize ? undefined : generation ? generation.aspectRatio : job.autoGeneration?.aspectRatio, onUpdate, onViewUpdate: onGenerationViewUpdate });
  const { generic, incomplete, inputsReady, asset, busy: cancelling } = controls;
  const error = controls.error || controls.imageError;
  const key = `${job.id}:${generation?.id}`;
  if (!job.result) return null;
  return <section className="quick-result" aria-label="当前生图结果"><div className="quick-result-head"><strong>生成结果</strong><button className="text-button" onClick={onWorkspace}>工作台查看<Icon name="arrow" /></button></div>
    {asset?.key === key && generation?.status === "completed" ? <ImagePreview data-reminder-task={generation.id} src={asset.image} alt="当前生成结果" /> : generation ? <p data-reminder-task={generation.status === "failed" ? generation.id : undefined} role="status">{generation?.status === "running" ? generation?.stage || "正在生成图片…" : generation?.status === "failed" ? "图片生成失败" : generation?.status === "cancelled" ? "图片生成已取消" : "正在读取结果…"}</p> : null}
    {(error || generation?.error) && <p className="error" role="alert">{error || generation?.error} <RecoveryAction error={error || generation?.error} /></p>}
    {!running && job.mode !== "multi-reenact" && (generic || incomplete || !inputsReady || hint) && <p className="quick-generation-hint" role="status">{!inputsReady ? <>先添加主体图 <button className="text-button" onClick={onSubject}>上传主体</button></> : generic || incomplete ? <>需要专属提示词 <button className="text-button" onClick={onReverse}>重新逆向</button></> : hint}</p>}
    {generation?.status === "running" ? <button className="text-button" disabled={cancelling} onClick={() => void controls.act(true)}>{cancelling ? "正在取消…" : "取消生图"}</button> : job.mode !== "multi-reenact" && <button className="primary" disabled={cancelling || !controls.canGenerate} onClick={() => void controls.act(false)}>{cancelling ? "正在提交…" : job.generations?.length ? "再生成图片" : "生成图片"}<Icon name="arrow" /></button>}
  </section>;
}
