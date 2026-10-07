import { moveImage, orderedImageIds } from "../../lib/image-order";
import { createPortal } from "react-dom";
import RecoveryAction from "../popup/RecoveryAction";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Mode, MultiSubject } from "../../lib/types";
import { normalizeImage } from "../../lib/image";
import Icon from "../popup/Icon";
import SelectField from "../popup/SelectField";
import TaskInstruction from "../popup/TaskInstruction";
import LoadingPlaceholder from "../popup/LoadingPlaceholder";
import ImagePreview from "../popup/ImagePreview";
import PromptSheet from "./PromptSheet";
import useEditorExpansion from "./useEditorExpansion";

const modes: Record<Mode, string> = { style: "提取风格", recreate: "完整复刻", reenact: "主体重演", "multi-reenact": "多图重演", session: "会话创作" };
export default function CanvasWorkspace({ revealPrompt, onPromptRevealed, contextKey, mode, image, subjectImage, subjects, referenceIndex, onImageOrder, selected, onSelect, instruction, disabled, modeDisabled, reverseDisabled, running, cancelling, status, error, errorTaskId, stale, hasPrompt, promptEditing, reduced, versions, prompt, actionsTarget, onMode, onInstruction, onSubject, onAvailability, onSubjects, onReference, onReferenceRotate, onSwap, onReverse, onCancel, onRetryReference, sessionTitle, onSessions }: {
  revealPrompt?: number; onPromptRevealed?(): void; contextKey: string; mode: Mode; image?: string; subjectImage: string; subjects: MultiSubject[]; selected: string; onSelect(id: string): void;
  referenceIndex: number; onImageOrder(referenceIndex: number, subjects: MultiSubject[]): Promise<void>;
  instruction: string; disabled: boolean; modeDisabled: boolean; reverseDisabled: boolean; running: boolean; cancelling: boolean;
  status?: string; error?: string; errorTaskId?: string; stale: boolean; hasPrompt: boolean; promptEditing: boolean; reduced: boolean;
  sessionTitle?: string; onSessions?(): void;
  versions: ReactNode; prompt: ReactNode; actionsTarget?: HTMLElement | null;
  onMode(mode: Mode): void; onInstruction(value: string): void; onSubject(image: string): void | Promise<void>; onAvailability(available: boolean): void;
  onSubjects(subjects: MultiSubject[]): void | Promise<void>; onReference(image: string): Promise<void>; onReferenceRotate(image: string): Promise<void>; onSwap(id?: string): void;
  onReverse(): void; onCancel(): void; onRetryReference?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const composer = useRef<HTMLDivElement>(null);
  const composerSlot = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const editorExpansion = useEditorExpansion(composer, reduced, contextKey, composerSlot);
  useEffect(() => { if (open) editorExpansion.change(false, true); }, [open]);
  const [settings, setSettings] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const target = useRef("");
  const revision = useRef(0);
  const pendingInput = useRef(false);
  const scope = useRef(contextKey);
  scope.current = contextKey;
  const previous = useRef(contextKey);
  const trigger = useRef<HTMLButtonElement>(null);
  const generate = useRef<HTMLButtonElement>(null);
  const modeControl = useRef<HTMLDivElement>(null);
  const inputArea = useRef<HTMLDivElement>(null);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const settingsPanel = useRef<HTMLDivElement>(null);
  const current = mode === "multi-reenact" ? subjects.find(item => item.id === selected) : undefined;
  const isSubject = (mode !== "recreate" && mode !== "session") && (mode === "multi-reenact" ? !!current : selected === "subject");
  const currentImage = isSubject ? current?.subjectImage ?? subjectImage : image;
  const index = current ? subjects.indexOf(current) : -1;
  const label = isSubject ? current ? `主体 ${index + 1}` : "主体图" : mode === "style" || mode === "recreate" || mode === "session" ? "参考图" : "参考模板";
  const subjectIds = mode === "multi-reenact" ? subjects.map(item => item.id) : (mode === "style" || mode === "reenact") && subjectImage ? ["subject"] : [];
  const imageIds = orderedImageIds(subjectIds, referenceIndex);
  const selectedId = isSubject ? current?.id || "subject" : "reference";
  const imageIndex = imageIds.indexOf(selectedId);
  const locked = disabled || uploading || open;
  useEffect(() => {
    if (previous.current !== contextKey) { setOpen(false); setSettings(false); setUploadError(""); setUploading(false); pendingInput.current = false; revision.current++; }
    if (!hasPrompt) setOpen(false);
    previous.current = contextKey;
  }, [contextKey, hasPrompt]);
  useEffect(() => { if (revealPrompt && hasPrompt) { setOpen(true); onPromptRevealed?.(); } }, [revealPrompt, contextKey, hasPrompt, onPromptRevealed]);
  useEffect(() => () => { revision.current++; pendingInput.current = false; onAvailability(true); }, [contextKey]);
  useEffect(() => {
    if (!settings) return;
    settingsPanel.current?.querySelector('select')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !settingsPanel.current?.contains(event.target) && !settingsTrigger.current?.contains(event.target)) setSettings(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [settings]);
  const select = (id: string) => { onSelect(id); setSettings(false); };
  const choose = (id: string) => { target.current = id; upload.current?.click(); };
  const saveInput = async (save: (current: () => boolean) => void | Promise<void>, rethrow = false) => {
    if (disabled || pendingInput.current) return false;
    const attempt = ++revision.current, context = contextKey;
    const current = () => attempt === revision.current && context === scope.current;
    pendingInput.current = true;
    setUploading(true); setUploadError(""); onAvailability(false);
    let saved = false;
    try { await save(current); saved = true; return current(); }
    catch (reason) {
      if (current()) setUploadError((reason as Error).message);
      if (rethrow) throw reason;
      return false;
    } finally {
      if (current()) { pendingInput.current = false; setUploading(false); onAvailability(saved); }
    }
  };
  const readFiles = async (files: File[]) => {
    if (!files.length || locked) return;
    const id = target.current, multi = mode === "multi-reenact";
    if (id === "add" && subjects.length + files.length > 6) { setUploadError("最多添加 6 张主体图"); return; }
    let selectedId = id;
    const saved = await saveInput(async current => {
      const images = await Promise.all((id === "add" ? files : files.slice(0, 1)).map(file => {
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error("请选择 20 MB 以内的 PNG、JPEG 或 WebP");
        return normalizeImage(file, (id === "reference" ? 4 : 2) * 1024 * 1024);
      }));
      if (!current()) return;
      if (id === "reference") await onReference(images[0]!);
      else if (multi) {
        const added = id === "add" ? images.map(subjectImage => ({ id: crypto.randomUUID(), subjectImage, role: "自动", detail: "" })) : [];
        await onSubjects(id === "add" ? [...subjects, ...added] : subjects.map(item => item.id === id ? { ...item, subjectImage: images[0]! } : item));
        selectedId = added[0]?.id || id;
      } else { await onSubject(images[0]!); selectedId = "subject"; }
    });
    if (saved) onSelect(selectedId);
  };
  const remove = async () => {
    if (!await saveInput(() => current ? onSubjects(subjects.filter(item => item.id !== current.id)) : onSubject(""))) return;
    onSelect("reference"); setSettings(false);
    inputArea.current?.querySelector<HTMLButtonElement>('[aria-label="查看参考图"]')?.focus({ preventScroll: true });
  };
  const update = async (patch: Partial<MultiSubject>) => {
    await saveInput(() => onSubjects(subjects.map(item => item.id === current?.id ? { ...item, ...patch } : item)));
  };
  const reorder = async (delta: number) => {
    const next = moveImage(subjectIds, referenceIndex, selectedId, delta);
    if (!next) return;
    if (!await saveInput(() => onImageOrder(next.referenceIndex, mode === "multi-reenact"
      ? next.subjectIds.map(id => subjects.find(item => item.id === id)!) : subjects))) return;
    inputArea.current?.querySelector<HTMLButtonElement>(`[data-image-id="${selectedId}"]`)?.focus({ preventScroll: true });
  };
  const rotateInput = async (next: string) => {
    const saved = await saveInput(() => isSubject ? current
      ? onSubjects(subjects.map(item => item.id === current.id ? { ...item, subjectImage: next } : item))
      : onSubject(next) : onReferenceRotate(next), true);
    if (!saved) throw new Error("当前输入已切换，请重新调整图片");
  };
  const returnFocus = () => {
    const destination = hasPrompt ? trigger.current : generate.current;
    return destination?.disabled ? modeControl.current?.querySelector('select') || null : destination;
  };
  const sheetOpen = open && hasPrompt;
  const reverseButton = <button ref={generate} className="primary canvas-generate" data-ready={hasPrompt && !stale && !running} disabled={running ? cancelling : reverseDisabled || uploading} aria-busy={running} onClick={running ? onCancel : onReverse}><Icon name={running ? "close" : hasPrompt ? "retry" : "edit"} />{running ? cancelling ? "正在取消…" : "取消提示词" : hasPrompt ? "更新提示词" : "生成提示词"}</button>;
  return <section className="canvas-workspace" data-prompt-open={sheetOpen} aria-label={`${modes[mode]}工作区`}>
    <div className="canvas-input" ref={inputArea}>
      <div className="canvas-stage" inert={sheetOpen}>
        <div className="canvas-label"><strong>{label}</strong>{currentImage && <span>图 {imageIndex + 1}</span>}</div>
        <div className="canvas-large" aria-label="图片展示区" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); target.current = isSubject ? current?.id || "subject" : "reference"; void readFiles([...event.dataTransfer.files]); }}>
          {currentImage ? <ImagePreview src={currentImage} alt={label} disabled={locked} rotation={{ disabled: locked, maxBytes: (isSubject ? 2 : 4) * 1024 * 1024, onApply: rotateInput }} />
            : !isSubject ? <LoadingPlaceholder active={!error}>{error || "正在读取参考图…"}</LoadingPlaceholder>
            : <button className="canvas-upload" disabled={locked} onClick={() => choose(current?.id || "subject")}><Icon name="plus" />上传{label}</button>}
        </div>
        <div className="canvas-filmstrip" role="group" aria-label="图片图条" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); target.current = mode === "multi-reenact" ? "add" : (mode === "recreate" || mode === "session") ? "reference" : "subject"; void readFiles([...event.dataTransfer.files]); }}>
          {imageIds.map((id, i) => {
            const item = subjects.find(item => item.id === id), ref = id === "reference";
            const src = ref ? image : mode === "multi-reenact" ? item?.subjectImage : subjectImage;
            const name = ref ? "参考图" : mode === "multi-reenact" ? `主体 ${subjects.indexOf(item!) + 1}` : "主体图";
            return <button key={id} data-image-id={id} aria-label={`查看${name}`} aria-description={`图 ${i + 1}`} aria-pressed={selectedId === id} onClick={() => select(id)}>{src ? <img src={src} alt="" /> : <Icon name="image" />}图 {i + 1} · {name}</button>;
          })}
          {(mode === "style" || mode === "reenact") && !subjectImage && <button aria-label="查看主体图" aria-pressed={isSubject} onClick={() => select("subject")}><Icon name="plus" />主体图{mode === "style" ? " · 可选" : ""}</button>}
          {mode === "multi-reenact" && <button disabled={locked || subjects.length >= 6} aria-label="添加主体图" onClick={() => choose("add")}><Icon name="plus" /></button>}
          {mode === "session" && <button className="session-entry" aria-label="选择对话会话" aria-haspopup="dialog" disabled={locked} onClick={onSessions} title={sessionTitle || "选择对话会话"}><Icon name={sessionTitle ? "check" : "plus"} /><span>{sessionTitle || "选择对话会话"}</span></button>}
        </div>
      </div>
      <div className="canvas-controls">
      <div className="canvas-floating-tools" role="group" aria-label="画布工具栏" ref={modeControl}>
        <SelectField label="逆向模式" aria-label="逆向模式" value={mode} disabled={modeDisabled || uploading} onChange={event => { setOpen(false); setSettings(false); onMode(event.target.value as Mode); }}>
          {(Object.keys(modes) as Mode[]).map(key => <option key={key} value={key}>{modes[key]}</option>)}
        </SelectField>
        <span className="canvas-tool-divider" />
        <button className="quiet-button" disabled={locked} aria-label={currentImage ? "替换当前图片" : "上传当前图片"} title={currentImage ? "替换当前图片" : "上传当前图片"} onClick={() => choose(isSubject ? current?.id || "subject" : "reference")}><Icon name="image" /><span>{currentImage ? "替换" : "上传"}</span></button>
        {(mode !== "recreate" && mode !== "session") && <button className="quiet-button canvas-icon-tool" aria-label="互换主体与参考" title="互换主体与参考" disabled={locked || !image || (mode === "multi-reenact" ? !current?.subjectImage : !subjectImage)} onClick={() => onSwap(current?.id)}><Icon name="swap" /></button>}
        {(mode !== "recreate" && mode !== "session") && <button className="quiet-button canvas-icon-tool" aria-label="移除主体" title="移除主体" disabled={locked || !isSubject} onClick={() => void remove()}><Icon name="trash" /></button>}
        {imageIds.length > 1 && <><button className="quiet-button canvas-icon-tool" aria-label="图片前移" title="图片前移" disabled={locked || imageIndex <= 0} onClick={() => void reorder(-1)}>←</button><button className="quiet-button canvas-icon-tool" aria-label="图片后移" title="图片后移" disabled={locked || imageIndex < 0 || imageIndex === imageIds.length - 1} onClick={() => void reorder(1)}>→</button></>}
        {mode === "multi-reenact" && <button ref={settingsTrigger} className="quiet-button canvas-icon-tool" aria-label="主体设置" title="主体设置" aria-expanded={settings} disabled={locked || !current} onClick={() => setSettings(!settings)}><Icon name="settings" /></button>}
        {versions && <><span className="canvas-tool-divider" /><div className="canvas-versions">{versions}</div></>}
        {settings && current && <div ref={settingsPanel} className="canvas-subject-settings" role="group" aria-label="主体设置" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setSettings(false); settingsTrigger.current?.focus(); } }}>
          <div className="canvas-subject-head"><strong>{label}</strong><button className="quiet-button" aria-label="关闭主体设置" onClick={() => { setSettings(false); settingsTrigger.current?.focus(); }}><Icon name="close" /></button></div>
          <SelectField label="用途" aria-label="主体用途" disabled={locked} value={current.role} onChange={event => void update({ role: event.target.value })}>{["自动", "人物", "物品", "服饰", "场景", "细节"].map(role => <option key={role}>{role}</option>)}</SelectField>
          <input key={`${contextKey}:${current.id}:${current.detail}`} aria-label="主体保留特征" placeholder="保留特征" maxLength={2000} disabled={locked} defaultValue={current.detail} onBlur={event => { if (event.target.value !== current.detail) void update({ detail: event.target.value }); }} />
        </div>}
      </div>
      <div className="canvas-composer-slot" ref={composerSlot}>
      <div ref={composer} className="canvas-composer" inert={sheetOpen} onKeyDown={event => { if (event.key === "Escape" && editorExpansion.expanded) { event.preventDefault(); editorExpansion.change(false, true); expandButton.current?.focus({ preventScroll: true }); } }}>
        <button ref={expandButton} type="button" className="quiet-button canvas-editor-expand canvas-instruction-expand" aria-label={editorExpansion.expanded ? "收起指令" : "放大指令"} title={editorExpansion.expanded ? "收起指令" : "放大指令"} aria-expanded={editorExpansion.expanded} onClick={event => editorExpansion.toggle(event.detail === 0)}><Icon name={editorExpansion.expanded ? "minimize" : "maximize"} /></button>
        <TaskInstruction value={instruction} disabled={disabled || uploading || promptEditing} onChange={onInstruction} />
        <div className="canvas-composer-bar">
        {hasPrompt && <button ref={trigger} className="quiet-button canvas-prompt-link" aria-label={sheetOpen ? "收起提示词" : "展开提示词"} aria-expanded={sheetOpen} aria-controls="workspace-prompt-sheet" onClick={() => { setSettings(false); setOpen(true); }}><Icon name={sheetOpen ? "chevronDown" : "edit"} /><span>{sheetOpen ? "收起" : "提示词"}</span><i className={stale ? "canvas-stale-dot" : "canvas-ready-dot"} /></button>}
          <span data-reminder-task={!uploadError && error ? errorTaskId : undefined} className={uploadError || error ? "canvas-error" : ""} role={uploadError || error ? "alert" : "status"} title={uploadError || error || status}>{uploadError || error || (uploading ? "正在读取图片…" : status || (stale ? "提示词待更新" : ""))}<RecoveryAction error={uploadError || error} />{onRetryReference && <button className="text-button" onClick={onRetryReference}>重试</button>}</span>

        </div>
      </div>
      </div>
    <PromptSheet contextKey={contextKey} open={sheetOpen} onOpenChange={setOpen} returnFocus={returnFocus} reduced={reduced}>
      {stale && <div className="canvas-prompt-notice"><span role="status">{status || "提示词待更新"}</span><button className="text-button" onClick={() => setOpen(false)}>返回输入</button></div>}
      <div className="canvas-prompt-content">{prompt}</div>
    </PromptSheet>
      </div>
    </div>
    {actionsTarget && createPortal(reverseButton, actionsTarget)}
    <input hidden ref={upload} type="file" accept="image/png,image/jpeg,image/webp" multiple={mode === "multi-reenact"} aria-label="上传画布图片" onChange={event => { void readFiles([...event.target.files || []]); event.target.value = ""; }} />
  </section>;
}
