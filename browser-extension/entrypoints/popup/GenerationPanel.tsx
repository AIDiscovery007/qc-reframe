import { orderedImageIds } from "../../lib/image-order";
import RecoveryAction from "./RecoveryAction";
import { showMotionDialog } from "../../lib/motion-dialog";
import ImageFileActions from "./ImageFileActions";
import ImagePreview from "./ImagePreview";
import LoadingPlaceholder from "./LoadingPlaceholder";
import { createPortal } from "react-dom";
import { createContext, useContext, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { request } from "../../lib/client";
import { useGeneration } from "../../lib/use-generation";
import type { AspectRatio, Generation, Job, MultiSubject } from "../../lib/types";
import Icon from "./Icon";
import AsyncAction from "./AsyncAction";
import { logo } from "../../lib/brand";
import GenerationSizeFields from "./GenerationSizeFields";
import { generationSizeDescription, inheritedGenerationSize } from "../../lib/generation-size";
import type { EditRequest } from "../../lib/recreate-edit.mjs";
import SelectField from "./SelectField";
import RecreateEditDialog, { editDraftFrom, emptyEditDraft, type EditDraft } from "./RecreateEditDialog";

export const GenerationEffectContext = createContext<ComponentType<{ running: boolean; image: string; failed: boolean }> | null>(null);

export default function GenerationPanel({ modelControl, generationModel, pixelSize = false, onAspectRatioChange, onImageSizeChange, targetGeneration, onTargetSelected, job, lang, disabled, disabledReason = "", subjectImage, subjects, inputPreview, onUpdate, workspace = false, actionsTarget, hideActions = false, versionNumber = 1, drawerOpen = true, onRequestState, requestError = "", requestPending = false }: {
  modelControl?: ReactNode; generationModel?: string; pixelSize?: boolean;
  onAspectRatioChange?(ratio?: AspectRatio): void;
  onImageSizeChange?(size?: AspectRatio): void;
  targetGeneration?: string; onTargetSelected?(): void; requestPending?: boolean; requestError?: string; drawerOpen?: boolean; onRequestState?(pending: boolean, error?: string): void;
  inputPreview?: ReactNode; workspace?: boolean; hideActions?: boolean; actionsTarget?: HTMLElement | null; versionNumber?: number;
  job: Job; lang: "zh" | "en"; disabled: boolean; disabledReason?: string; subjectImage?: string; subjects?: MultiSubject[]; onUpdate(job: Job, subjectImage?: string, subjects?: MultiSubject[]): void;
}) {
  const GenerationEffect = useContext(GenerationEffectContext);
  const [compare, setCompare] = useState(false);
  const [modal, setModal] = useState<Generation>();
  const infoDialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(targetGeneration || "");
  useEffect(() => { if (targetGeneration) { const target = job.generations?.find(item => item.id === targetGeneration); setSelected(targetGeneration); setSize(inheritedGenerationSize(pixelSize, target)); setEditMode(editChoice && !!target?.edit); onTargetSelected?.(); } }, [targetGeneration, onTargetSelected]);
  const previous = job.generations?.find(item => item.id === targetGeneration) || job.generations?.at(-1) || job.autoGeneration;
  const [size, setSize] = useState(() => inheritedGenerationSize(pixelSize, previous));
  // 完整复刻在工作台可选「文生图」或「原图编辑」；查看某条记录时沿用它的方式，与尺寸一致。
  const editChoice = workspace && job.mode === "recreate";
  const [editMode, setEditMode] = useState(() => editChoice && !!previous && "edit" in previous && !!previous.edit);
  const [editDraft, setEditDraft] = useState<EditDraft>();
  const [editOpen, setEditOpen] = useState(false);
  const [editAttempted, setEditAttempted] = useState(false);
  useEffect(() => {
    if (pixelSize) onImageSizeChange?.(size);
    else onAspectRatioChange?.(size);
  }, [pixelSize, size]);
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState("");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyRevision = useRef(0);
  const generations = job.generations || [];
  const generation = generations.find((item) => item.id === selected) || generations.at(-1);
  const controls = useGeneration({ job, lang, disabled, subjectImage, subjects, generation, compare, requestPending,
    pixelSize, ...(pixelSize ? { imageSize: size } : { aspectRatio: size }), onUpdate, onRequestState });
  const { asset, original, comparisonError, imageError, running, recovery, multi, inputsReady, generic, incomplete, editable } = controls;
  const editing = editChoice && editMode;
  const editProfile = editable ? job.result?.editProfile : undefined;
  const busy = controls.busy || requestPending;
  const submitting = controls.submitting || requestPending;
  const error = controls.error || requestError;
  const assetKey = `${job.id}:${generation?.id}`;
  const image = generation?.status === "completed" && asset?.key === assetKey ? asset.image : "";
  const imagePath = asset?.key === assetKey ? asset.path : undefined;
  useEffect(() => {
    setCopied(""); setCopyError("");
    return () => { copyRevision.current++; clearTimeout(copyTimer.current); };
  }, [assetKey, generation?.status]);
  useEffect(() => {
    if (!modal) return;
    const element = infoDialog.current!;
    return showMotionDialog(element);
  }, [modal]);
  const act = async (cancel = false) => {
    if (busy) return;
    if (!cancel && recovery) { setSelected(recovery.id); await controls.save(recovery); return; }
    if (cancel ? !running : !controls.canGenerate) return;
    if (!cancel) { setCompare(false); setSelected(""); }
    if (await controls.act(cancel)) setSelected(cancel ? [...generations].reverse().find(item => item.status === "completed")?.id || "" : "");
  };
  const generate = () => {
    if (recovery || !editing) { void act(); return; }
    if (busy || !controls.canGenerate || !editProfile) return;
    setEditDraft(draft => draft || editDraftFrom(generation?.edit) || emptyEditDraft());
    setEditAttempted(false); setEditOpen(true);
  };
  const submitEdit = async (edit: EditRequest) => {
    if (busy || !controls.canGenerate || !editProfile) return;
    setEditAttempted(true); setCompare(false); setSelected("");
    if (await controls.act(false, edit)) { setSelected(""); setEditOpen(false); setEditDraft(undefined); }
  };

  const copyPath = async () => {
    setCopyError("");
    if (!imagePath) { setCopyError("请重启本机服务后复制图片路径。"); return; }
    const revision = copyRevision.current;
    try {
      await navigator.clipboard.writeText(imagePath);
      if (revision !== copyRevision.current) return;
      setCopied(assetKey);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(""), 1800);
    } catch {
      if (revision === copyRevision.current) setCopyError("复制失败，可手动复制下方路径。");
    }
  };

  const modeControl = editChoice ? <SelectField label="生图方式" aria-label="生图方式" title="文生图只发送提示词；原图编辑附原图，只修改你填写的元素" value={editMode ? "edit" : "text"}
    disabled={disabled || busy || !!running || !!recovery} onChange={event => setEditMode(event.target.value === "edit")}>
    <option value="text">文生图</option><option value="edit">原图编辑</option>
  </SelectField> : undefined;
  const ratioControls = <GenerationSizeFields modeControl={modeControl} modelControl={modelControl} generationModel={generationModel} key={`${pixelSize}:${selected}`} pixelSize={pixelSize} value={size} onChange={setSize} workspace={workspace} disabled={disabled || busy || !!running || !!recovery} />;
  const generateDisabled = busy || (recovery ? !!running : !controls.canGenerate || (editing && !editProfile));
  const generateButton = <button className="primary generate-button" disabled={generateDisabled} aria-busy={busy || !!running}
    title={editing ? "附原图，只按你填写的修改项编辑生成。使用设置中选择的生图渠道。" : `使用${job.mode === "recreate" ? "" : job.mode === "session" ? "参考风格与" : "当前主体图、参考模板与"}${lang === "zh" ? "中文" : "英文"}提示词生成，包含排除项。使用设置中选择的生图渠道。`} onClick={generate}>
    {!running && !busy && <Icon name="image" />}{recovery ? busy ? "正在保存…" : "重试保存" : running ? workspace ? "图片生成中…" : "生成中，完成后提醒" : busy ? "正在提交…" : editing ? "填写修改并生成" : generations.length ? workspace ? "再生成图片" : "再生成一张" : "生成图片"}{!workspace && <Icon name="arrow" />}
  </button>;
  const warning = recovery ? "图片已生成，保存尚未完成。重试保存不会再次生图；服务重启后未落盘的结果可能无法恢复。" : disabledReason || (editing && !editProfile ? "此版本没有可编辑元素，请重新逆向后再使用原图编辑。" : "") || ((generic || incomplete) ? "请先上传主体图，生成专属提示词。" : !inputsReady ? multi ? "请添加至少 2 张可用的主体图。" : "请先上传可用的主体图。" : "");
  const generationControls = <>{ratioControls}{generateButton}{workspace && warning && <p className="hint">{warning}</p>}{workspace && error && <p className="error" role="alert">{error} <RecoveryAction error={error} /></p>}</>;
  const action = hideActions ? null : actionsTarget ? createPortal(generationControls, actionsTarget) : workspace ? generationControls : <>{ratioControls}<AsyncAction status={running?.stage || (busy ? "正在提交…" : undefined)} onCancel={running ? () => act(true) : undefined} cancelling={busy}>{generateButton}</AsyncAction></>;
  const dimensions = image && asset?.width && asset?.height ? <p className="generation-dimensions">实际图片：{asset.width} × {asset.height} px · {imageRatio(asset.width, asset.height)}</p> : null;
  const caption = <div className="result-caption"><strong>{generation ? `版本 ${versionNumber} · ${generation.status === "completed" ? "图片" : "记录"} ${generations.indexOf(generation) + 1}` : "图片待生成"}</strong>{dimensions}</div>;
  const comparisonInputs = original?.key === assetKey ? multi ? <div className="multi-comparison-inputs">
    {orderedImageIds((original.subjects || []).map(item => item.id), original.referenceIndex ?? original.subjects?.length ?? 0).map((id, index) => {
      const subject = original.subjects?.find(item => item.id === id);
      return <figure key={id}><ImagePreview src={subject?.subjectImage || original.image} alt={subject ? `本次主体 ${index + 1}` : "本次参考模板"} loading="lazy" /><figcaption>图 {index + 1} · {subject ? subject.role : "参考模板"}{subject?.detail && <small>{subject.detail}</small>}</figcaption></figure>;
    })}
  </div> : <figure><ImagePreview src={original.image} alt="本次生成的原始输入" /><figcaption>{job.mode === "recreate" ? generation?.edit ? "原图（已发送生图）" : "逆向参考图（未发送生图）" : job.mode === "session" ? "本次风格参考图" : "本次主体图"}</figcaption></figure>
    : <p role="status">{comparisonError || "正在读取原图…"}</p>;
  const copyNotice = copyError && <div className="error" role="alert">{copyError}{imagePath && <p className="file-path">{imagePath}</p>}</div>;

  return <section className={`generated-pane${workspace ? "" : " compact-results"}`} aria-label="图片生成" data-pending={submitting || generation?.status === "running"}>
    <div className="result-toolbar">{workspace ? <><strong>生成结果</strong><span>{generation ? `版本 ${versionNumber} · ${generation.status === "completed" ? "图片" : "记录"} ${generations.indexOf(generation) + 1}` : "图片待生成"}</span></> : <>
      <h2>{!generation && inputPreview ? "输入预览" : "生成结果"} <small>{!generation && inputPreview ? `${(subjects?.length || 0) + 1} 张` : `${generations.filter(item => item.status === "completed").length} 张`}</small></h2>
      <button className="quiet-button" disabled={!image} aria-pressed={compare} onClick={() => setCompare(!compare)}><ResultIcon name="compare" />{compare ? "退出对照" : "对照原图"}</button>
    </>}</div>
    {action}
    {!workspace && warning && <p className="result-notice">{warning}</p>}
    {!workspace && error && <div className="error result-notice" role="alert">{error} <RecoveryAction error={error} /></div>}
    <div className="preview-canvas">{workspace && error && (image || running) && <p className="error result-request-error" role="alert">{error} <RecoveryAction error={error} /></p>}{!workspace && !generation && inputPreview}{submitting ? workspace && drawerOpen ? <LoadingPlaceholder className="generation-submitting">正在提交生成请求…</LoadingPlaceholder> : null : image ? compare ? <div className="compare-images">
      {comparisonInputs}
      <figure><ImagePreview data-reminder-task={drawerOpen ? generation?.id : undefined} src={image} alt="生成结果" /><figcaption>生成结果</figcaption></figure>
    </div> : <ImagePreview data-reminder-task={drawerOpen ? generation?.id : undefined} className="generation-result-preview" imageClassName="generation-result-image" src={image} alt={`${job.result!.title} · 生成结果`} /> : (generation?.status === "failed" || generation?.status === "cancelled" || imageError || error) ? <div className="empty-canvas">
      <Icon name="image" />
      <h3>{generation?.resultSavePending ? "图片等待保存" : generation?.status === "failed" ? "图片生成失败" : generation?.status === "cancelled" ? "图片生成已取消" : "图片暂不可用"}</h3>
      <p data-reminder-task={drawerOpen && generation?.status === "failed" && !imageError && !error ? generation.id : undefined} role={generation?.status === "failed" || imageError ? "alert" : "status"}>{imageError || error || (generation?.status === "failed" ? generation.error || (generation.resultSavePending ? "请重试保存现有图片。" : "请重新生成图片。") : "可以重新生成，或查看其他生成记录。")}</p>
      <RecoveryAction error={imageError || error || generation?.error} />
      {workspace && <button className="outline-button" disabled={generateDisabled} onClick={generate}>{recovery ? "重试保存" : "重新生成"}</button>}
    </div> : !GenerationEffect && generation?.status === "completed" ? <p role="status">正在读取生成图片…</p> : null}{GenerationEffect && drawerOpen && generation && !compare && !submitting && <GenerationEffect key={assetKey} running={generation.status === "running"} image={image}
      failed={generation.status === "failed" || generation.status === "cancelled" || !!imageError} />}</div>
    <div className="result-footer">
    {!workspace && caption}
    <div className="result-history" aria-label="生成记录">{generations.map((item, index) => <GenerationThumbnail key={`${job.id}:${item.id}`} jobId={job.id} generation={item} index={index} active={generation?.id === item.id} image={generation?.id === item.id ? image : ""} onSelect={() => { setSelected(item.id); setSize(inheritedGenerationSize(pixelSize, item)); setEditMode(editChoice && !!item.edit); setCompare(false); }} />)}</div>
    <div className="result-controls">
    {workspace && caption}
    {copyNotice}
    {(workspace || generation) && <div className="result-bottom" role="group" aria-label="图片操作">
      {workspace && <button className="quiet-button result-icon-action" disabled={!image || submitting} aria-label={compare ? "退出对照" : "对照原图"} title={compare ? "退出对照" : "对照原图"} aria-pressed={compare} onClick={() => setCompare(!compare)}><ResultIcon name="compare" /></button>}
      {workspace && running && <button className="quiet-button result-icon-action" disabled={busy} onClick={() => act(true)} aria-label="取消生图" title="取消生图"><Icon name="close" /></button>}
      <ImageFileActions key={assetKey} jobId={job.id} generationId={generation?.id} disabled={!image} compact iconOnly={workspace} /><button className="outline-button copy-path-button result-icon-action" data-copied={copied === assetKey} disabled={!image} onClick={copyPath} title={copied === assetKey ? "已复制路径" : "复制图片路径"} aria-label={copied === assetKey ? "已复制路径" : "复制图片路径"}><Icon key={String(copied === assetKey)} name={copied === assetKey ? "check" : "copy"} /></button>
      <button className="outline-button result-icon-action" disabled={!generation} title="生成信息" aria-label="生成信息" onClick={() => generation && setModal(generation)}><ResultIcon name="info" /></button><span className="result-action-status" role="status">{copied === assetKey ? "已复制路径" : ""}</span></div>}
    </div>
    </div>
    {modal && <dialog className="result-dialog modal" ref={infoDialog} aria-label="本次生成信息"
      onCancel={event => { event.preventDefault(); setModal(undefined); }} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); setModal(undefined); } }}>
      <div className="modal-head"><img src={logo} alt="" /><h2>本次生成信息</h2><button className="close-btn" aria-label="关闭窗口" onClick={() => setModal(undefined)}>×</button></div>
      <div className="generation-details">
        <p className="hint">{generationSizeDescription(modal)}{modal.gatewayReportedModel ? ` · 网关返回模型：${modal.gatewayReportedModel}` : ""}</p>
        <p className="hint">模型：{modal.model || job.model || "未记录"} · 语言：{modal.language === "zh" ? "中文" : "英文"}</p>
        <p className="hint">输入：{job.mode === "recreate" ? modal.edit ? `原图 + ${modal.edit.changes.length + (modal.edit.note ? 1 : 0)} 项修改` : "纯文字，不附参考图" : job.mode === "session" ? "风格参考图 + 会话专属提示词" : multi ? `${modal.subjects?.length || 0} 张主体图 + 参考模板` : "生成时的主体图 + 参考图"}</p>
        <div className="prompt-box"><div className="prompt-text">{modal.prompt || "此记录未保存提示词快照。"}</div><div className="negative"><p>排除项：{modal.negativePrompt || "无"}</p></div></div>
      </div>
    </dialog>}
    {editOpen && editProfile && <RecreateEditDialog profile={editProfile} lang={lang} draft={editDraft || emptyEditDraft()} busy={busy} error={editAttempted ? error : ""}
      onDraft={setEditDraft} onCancel={() => setEditOpen(false)} onSubmit={edit => void submitEdit(edit)} />}
  </section>;

}

function imageRatio(width: number, height: number) {
  let a = width, b = height;
  while (b) [a, b] = [b, a % b];
  if (Math.max(width / a, height / a) <= 20) return `${width / a}:${height / a}`;
  return width >= height ? `≈${Number((width / height).toFixed(2))}:1` : `≈1:${Number((height / width).toFixed(2))}`;
}

function ResultIcon({ name }: { name: "compare" | "info" }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={name === "compare" ? "M12 3v18M4 5h4v14H4zM16 5h4v14h-4z" : "M12 11v6M12 7v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"} /></svg>;
}

function GenerationThumbnail({ jobId, generation, index, active, image, onSelect }: {
  jobId: string; generation: Generation; index: number; active: boolean; image: string; onSelect(): void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [thumbnail, setThumbnail] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (image) { setThumbnail(image); setFailed(false); return; }
    if (generation.status !== "completed" || thumbnail || active) return;
    let cancelled = false;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void request<{ image: string }>({ type: "alchemy:generation-thumbnail", id: jobId, generationId: generation.id }).then(
        value => { if (!cancelled) setThumbnail(value.image); },
        () => { if (!cancelled) setFailed(true); },
      );
    });
    if (element.current) observer.observe(element.current);
    return () => { cancelled = true; observer.disconnect(); };
  }, [jobId, generation.id, generation.status, thumbnail, active, image]);
  const status = { running: "生成中", completed: !image && !thumbnail && failed ? "图片不可用" : "已完成", failed: "失败", cancelled: "已取消" }[generation.status];
  const className = `result-thumb${active ? " active" : ""}`;
  return <div ref={element} className="result-thumb-wrap">
    <button className={className} onClick={onSelect} aria-pressed={active} aria-label={`查看第 ${index + 1} 条生成记录，${status}`} title={generation.error || generation.stage}>
      {generation.status === "completed" && (image || thumbnail) ? <img src={image || thumbnail} alt="" /> : generation.status === "running" ? <span className="static-effect thumbnail-loading" aria-hidden="true" /> : <small>{generation.status === "completed" && !failed ? "读取中" : status}</small>}<span>{index + 1}</span>
    </button>
  </div>;
}
