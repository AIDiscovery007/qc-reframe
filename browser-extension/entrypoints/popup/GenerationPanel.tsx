import { orderedImageIds } from "../../lib/image-order";
import RecoveryAction from "./RecoveryAction";
import { showMotionDialog } from "../../lib/motion-dialog";
import ImageFileActions from "./ImageFileActions";
import ImagePreview from "./ImagePreview";
import LoadingPlaceholder from "./LoadingPlaceholder";
import { createPortal } from "react-dom";
import { createContext, useContext, useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import { request } from "../../lib/client";
import { useGeneration } from "../../lib/use-generation";
import type { AspectRatio, Generation, Job, MultiSubject } from "../../lib/types";
import Icon from "./Icon";
import AsyncAction from "./AsyncAction";
import { logo } from "../../lib/brand";
import SelectField from "./SelectField";

const ratios = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"];

export const GenerationEffectContext = createContext<ComponentType<{ running: boolean; image: string; failed: boolean }> | null>(null);

export default function GenerationPanel({ gatewayDefaultSize = false, onAspectRatioChange, targetGeneration, onTargetSelected, job, lang, disabled, disabledReason = "", subjectImage, subjects, inputPreview, onUpdate, workspace = false, actionsTarget, hideActions = false, versionNumber = 1, drawerOpen = true, onRequestState, requestError = "", requestPending = false }: {
  gatewayDefaultSize?: boolean;
  onAspectRatioChange?(ratio?: AspectRatio): void;
  targetGeneration?: string; onTargetSelected?(): void; requestPending?: boolean; requestError?: string; drawerOpen?: boolean; onRequestState?(pending: boolean, error?: string): void;
  inputPreview?: ReactNode; workspace?: boolean; hideActions?: boolean; actionsTarget?: HTMLElement | null; versionNumber?: number;
  job: Job; lang: "zh" | "en"; disabled: boolean; disabledReason?: string; subjectImage?: string; subjects?: MultiSubject[]; onUpdate(job: Job, subjectImage?: string, subjects?: MultiSubject[]): void;
}) {
  const GenerationEffect = useContext(GenerationEffectContext);
  const [compare, setCompare] = useState(false);
  const [modal, setModal] = useState<Generation>();
  const infoDialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(targetGeneration || "");
  useEffect(() => { if (targetGeneration) { setSelected(targetGeneration); onTargetSelected?.(); } }, [targetGeneration, onTargetSelected]);
  const previousRatio = job.generations?.length ? job.generations.at(-1)?.aspectRatio : job.autoGeneration?.aspectRatio;
  const previousRatioValue = previousRatio ? `${previousRatio.width}:${previousRatio.height}` : "auto";
  const [ratio, setRatio] = useState(previousRatio ? ratios.includes(previousRatioValue) ? previousRatioValue : "custom" : "auto");
  const [ratioWidth, setRatioWidth] = useState(String(previousRatio?.width || 1));
  const [ratioHeight, setRatioHeight] = useState(String(previousRatio?.height || 1));
  const ratioHintId = useId();
  const [width = NaN, height = NaN] = ratio === "custom" ? [Number(ratioWidth), Number(ratioHeight)] : ratio.split(":").map(Number);
  useEffect(() => { onAspectRatioChange?.(gatewayDefaultSize || ratio === "auto" ? undefined : { width, height }); }, [gatewayDefaultSize, ratio, width, height]);
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState("");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyRevision = useRef(0);
  const generations = job.generations || [];
  const generation = generations.find((item) => item.id === selected) || generations.at(-1);
  const controls = useGeneration({ job, lang, disabled, subjectImage, subjects, generation, compare, requestPending,
    aspectRatio: gatewayDefaultSize || ratio === "auto" ? undefined : { width, height }, onUpdate, onRequestState });
  const { asset, original, comparisonError, imageError, running, multi, inputsReady, generic, incomplete, validRatio } = controls;
  const busy = controls.busy || requestPending;
  const submitting = controls.submitting || requestPending;
  const error = controls.error || requestError;
  const assetKey = `${job.id}:${generation?.id}`;
  const image = asset?.key === assetKey ? asset.image : "";
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
    if (busy || (cancel ? !running : !controls.canGenerate)) return;
    if (!cancel) { setCompare(false); setSelected(""); }
    if (await controls.act(cancel)) setSelected(cancel ? [...generations].reverse().find(item => item.status === "completed")?.id || "" : "");
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

  const ratioControls = gatewayDefaultSize ? <p className="hint">尺寸：Magpie 网关默认（暂不支持指定比例）</p> : <div className="generation-ratio">
    <div className="generation-ratio-fields">
      <SelectField label={workspace ? "目标尺寸" : "图片比例"} title="按宽高比例生成，实际像素以结果为准" value={ratio} disabled={disabled || busy || !!running} aria-describedby={validRatio ? undefined : ratioHintId} onChange={event => setRatio(event.target.value)}>
        <option value="auto">自动</option>
        {ratios.map(value => <option key={value} value={value}>{value}</option>)}
        <option value="custom">自定义</option>
      </SelectField>
      {ratio === "custom" && <div className="custom-ratio">
        <label>宽<input type="number" inputMode="numeric" min={1} max={10000} step={1} value={ratioWidth} disabled={disabled || busy || !!running} aria-label="比例宽" aria-invalid={!validRatio} aria-describedby={validRatio ? undefined : ratioHintId} onChange={event => setRatioWidth(event.target.value)} /></label>
        <span aria-hidden="true">:</span>
        <label>高<input type="number" inputMode="numeric" min={1} max={10000} step={1} value={ratioHeight} disabled={disabled || busy || !!running} aria-label="比例高" aria-invalid={!validRatio} aria-describedby={validRatio ? undefined : ratioHintId} onChange={event => setRatioHeight(event.target.value)} /></label>
      </div>}
    </div>
    {!validRatio && <p id={ratioHintId} className="ratio-hint ratio-error" role="status">宽高请填 1–10000 的整数，比例范围为 1:20–20:1。</p>}
  </div>;
  const generateButton = <button className="primary generate-button" disabled={busy || !controls.canGenerate} aria-busy={busy || !!running}
    title={`使用${job.mode === "recreate" ? "" : job.mode === "session" ? "参考风格与" : "当前主体图、参考模板与"}${lang === "zh" ? "中文" : "英文"}提示词生成，包含排除项。使用设置中选择的生图渠道。`} onClick={() => act()}>
    {!running && !busy && <Icon name="image" />}{running ? workspace ? "图片生成中…" : "生成中，完成后提醒" : busy ? "正在提交…" : generations.length ? workspace ? "再生成图片" : "再生成一张" : "生成图片"}{!workspace && <Icon name="arrow" />}
  </button>;
  const warning = disabledReason || ((generic || incomplete) ? "请先上传主体图，生成专属提示词。" : !inputsReady ? multi ? "请添加至少 2 张可用的主体图。" : "请先上传可用的主体图。" : "");
  const generationControls = <>{ratioControls}{generateButton}{workspace && warning && <p className="hint">{warning}</p>}{workspace && error && <p className="error" role="alert">{error} <RecoveryAction error={error} /></p>}</>;
  const action = hideActions ? null : actionsTarget ? createPortal(generationControls, actionsTarget) : workspace ? generationControls : <>{ratioControls}<AsyncAction status={running?.stage || (busy ? "正在提交…" : undefined)} onCancel={running ? () => act(true) : undefined} cancelling={busy}>{generateButton}</AsyncAction></>;
  const dimensions = image && asset?.width && asset?.height ? <p className="generation-dimensions">{asset.width} × {asset.height} px · {imageRatio(asset.width, asset.height)}</p> : null;
  const caption = <div className="result-caption"><strong>{generation ? `版本 ${versionNumber} · ${generation.status === "completed" ? "图片" : "记录"} ${generations.indexOf(generation) + 1}` : "图片待生成"}</strong>{dimensions}</div>;
  const comparisonInputs = original?.key === assetKey ? multi ? <div className="multi-comparison-inputs">
    {orderedImageIds((original.subjects || []).map(item => item.id), original.referenceIndex ?? original.subjects?.length ?? 0).map((id, index) => {
      const subject = original.subjects?.find(item => item.id === id);
      return <figure key={id}><ImagePreview src={subject?.subjectImage || original.image} alt={subject ? `本次主体 ${index + 1}` : "本次参考模板"} loading="lazy" /><figcaption>图 {index + 1} · {subject ? subject.role : "参考模板"}{subject?.detail && <small>{subject.detail}</small>}</figcaption></figure>;
    })}
  </div> : <figure><ImagePreview src={original.image} alt="本次生成的原始输入" /><figcaption>{job.mode === "recreate" ? "逆向参考图（未发送生图）" : job.mode === "session" ? "本次风格参考图" : "本次主体图"}</figcaption></figure>
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
      <h3>{generation?.status === "failed" ? "图片生成失败" : generation?.status === "cancelled" ? "图片生成已取消" : "图片暂不可用"}</h3>
      <p data-reminder-task={drawerOpen && generation?.status === "failed" && !imageError && !error ? generation.id : undefined} role={generation?.status === "failed" || imageError ? "alert" : "status"}>{imageError || error || (generation?.status === "failed" ? generation.error || "请重新生成图片。" : "可以重新生成，或查看其他生成记录。")}</p>
      <RecoveryAction error={imageError || error || generation?.error} />
      {workspace && <button className="outline-button" disabled={busy || !controls.canGenerate} onClick={() => act()}>重新生成</button>}
    </div> : !GenerationEffect && generation?.status === "completed" ? <p role="status">正在读取生成图片…</p> : null}{GenerationEffect && drawerOpen && generation && !compare && !submitting && <GenerationEffect key={assetKey} running={generation.status === "running"} image={image}
      failed={generation.status === "failed" || generation.status === "cancelled" || !!imageError} />}</div>
    <div className="result-footer">
    {!workspace && caption}
    <div className="result-history" aria-label="生成记录">{generations.map((item, index) => <GenerationThumbnail key={`${job.id}:${item.id}`} jobId={job.id} generation={item} index={index} active={generation?.id === item.id} image={generation?.id === item.id ? image : ""} onSelect={() => { setSelected(item.id); setCompare(false); }} />)}</div>
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
        {modal.provider === "magpie" && <p className="hint">Magpie · 网关默认尺寸{modal.outputSize ? ` · ${modal.outputSize.width} × ${modal.outputSize.height} px` : ""}{modal.gatewayReportedModel ? ` · 网关返回模型：${modal.gatewayReportedModel}` : ""}</p>}
        <p className="hint">模型：{modal.model || job.model || "未记录"} · 语言：{modal.language === "zh" ? "中文" : "英文"}</p>
        <p className="hint">输入：{job.mode === "recreate" ? "纯文字，不附参考图" : job.mode === "session" ? "风格参考图 + 会话专属提示词" : multi ? `${modal.subjects?.length || 0} 张主体图 + 参考模板` : "生成时的主体图 + 参考图"}</p>
        <div className="prompt-box"><div className="prompt-text">{modal.prompt || "此记录未保存提示词快照。"}</div><div className="negative"><p>排除项：{modal.negativePrompt || "无"}</p></div></div>
      </div>
    </dialog>}
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
      {image || thumbnail ? <img src={image || thumbnail} alt="" /> : generation.status === "running" ? <span className="static-effect thumbnail-loading" aria-hidden="true" /> : <small>{generation.status === "completed" && !failed ? "读取中" : status}</small>}<span>{index + 1}</span>
    </button>
  </div>;
}
