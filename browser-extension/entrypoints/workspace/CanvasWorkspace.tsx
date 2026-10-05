import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Mode, MultiSubject } from "../../lib/types";
import { normalizeImage } from "../../lib/image";
import Icon from "../popup/Icon";
import SelectField from "../popup/SelectField";
import TaskInstruction from "../popup/TaskInstruction";
import LoadingPlaceholder from "../popup/LoadingPlaceholder";
import ImagePreview from "../popup/ImagePreview";
import PromptSheet from "./PromptSheet";

const modes: Record<Mode, string> = { style: "提取风格", recreate: "完整复刻", reenact: "主体重演", "multi-reenact": "多图重演" };
export default function CanvasWorkspace({ revealPrompt, onPromptRevealed, contextKey, mode, image, subjectImage, subjects, selected, onSelect, instruction, disabled, modeDisabled, reverseDisabled, running, cancelling, status, error, errorTaskId, stale, hasPrompt, promptEditing, reduced, versions, prompt, generationActions, onMode, onInstruction, onSubject, onAvailability, onSubjects, onReference, onReferenceRotate, onSwap, onReverse, onExtract, onCancel, onRetryReference }: {
  revealPrompt?: number; onPromptRevealed?(): void; contextKey: string; mode: Mode; image?: string; subjectImage: string; subjects: MultiSubject[]; selected: string; onSelect(id: string): void;
  instruction: string; disabled: boolean; modeDisabled: boolean; reverseDisabled: boolean; running: boolean; cancelling: boolean;
  status?: string; error?: string; errorTaskId?: string; stale: boolean; hasPrompt: boolean; promptEditing: boolean; reduced: boolean;
  versions: ReactNode; prompt: ReactNode; generationActions(element: HTMLDivElement | null): void;
  onMode(mode: Mode): void; onInstruction(value: string): void; onSubject(image: string): void | Promise<void>; onAvailability(available: boolean): void;
  onSubjects(subjects: MultiSubject[]): void | Promise<void>; onReference(image: string): Promise<void>; onReferenceRotate(image: string): Promise<void>; onSwap(id?: string): void;
  onReverse(): void; onExtract(): void; onCancel(): void; onRetryReference?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const target = useRef("");
  const revision = useRef(0);
  const pendingInput = useRef(false);
  const scope = useRef(contextKey);
  scope.current = contextKey;
  const previous = useRef({ contextKey, running, hasPrompt });
  const trigger = useRef<HTMLButtonElement>(null);
  const generate = useRef<HTMLButtonElement>(null);
  const modeControl = useRef<HTMLDivElement>(null);
  const inputArea = useRef<HTMLDivElement>(null);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const settingsPanel = useRef<HTMLDivElement>(null);
  const current = mode === "multi-reenact" ? subjects.find(item => item.id === selected) : undefined;
  const isSubject = mode !== "recreate" && (mode === "multi-reenact" ? !!current : selected === "subject");
  const currentImage = isSubject ? current?.subjectImage ?? subjectImage : image;
  const index = current ? subjects.indexOf(current) : -1;
  const label = isSubject ? current ? `主体 ${index + 1}` : "主体图" : mode === "style" || mode === "recreate" ? "参考图" : "参考模板";
  const locked = disabled || uploading || open;
  useEffect(() => {
    const before = previous.current;
    if (before.contextKey !== contextKey) { setOpen(false); setSettings(false); setUploadError(""); setUploading(false); pendingInput.current = false; revision.current++; }
    if (hasPrompt && before.contextKey === contextKey && before.running && !running) setOpen(true);
    if (!hasPrompt) setOpen(false);
    previous.current = { contextKey, running, hasPrompt };
  }, [contextKey, running, hasPrompt]);
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
    try { await save(current); return current(); }
    catch (reason) {
      if (current()) setUploadError((reason as Error).message);
      if (rethrow) throw reason;
      return false;
    } finally {
      if (current()) { pendingInput.current = false; setUploading(false); onAvailability(true); }
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
    if (index < 0 || index + delta < 0 || index + delta >= subjects.length) return;
    const next = [...subjects]; [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    if (await saveInput(() => onSubjects(next))) settingsPanel.current?.querySelector('select')?.focus();
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
  return <section className="canvas-workspace" data-prompt-open={sheetOpen} aria-label={`${modes[mode]}工作区`}>
    <div className="canvas-input" ref={inputArea}>
      <div className="canvas-stage" inert={sheetOpen}>
        <div className="canvas-label"><strong>{label}</strong><span>{modes[mode]}</span></div>
        <div className="canvas-large" aria-label="图片展示区" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); target.current = isSubject ? current?.id || "subject" : "reference"; void readFiles([...event.dataTransfer.files]); }}>
          {currentImage ? <ImagePreview src={currentImage} alt={label} disabled={locked} rotation={{ disabled: locked, maxBytes: (isSubject ? 2 : 4) * 1024 * 1024, onApply: rotateInput }} />
            : !isSubject ? <LoadingPlaceholder active={!error}>{error || "正在读取参考图…"}</LoadingPlaceholder>
            : <button className="canvas-upload" disabled={locked} onClick={() => choose(current?.id || "subject")}><Icon name="plus" />上传{label}</button>}
        </div>
        <div className="canvas-filmstrip" role="group" aria-label="图片图条" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); target.current = mode === "multi-reenact" ? "add" : mode === "recreate" ? "reference" : "subject"; void readFiles([...event.dataTransfer.files]); }}>
          {mode !== "recreate" && (mode === "multi-reenact" ? subjects.map((item, i) => <button key={item.id} aria-label={`查看主体 ${i + 1}`} aria-pressed={current?.id === item.id} onClick={() => select(item.id)}>{item.subjectImage ? <img src={item.subjectImage} alt="" /> : <Icon name="plus" />}主体 {i + 1}</button>) : <button aria-label="查看主体图" aria-pressed={isSubject} onClick={() => select("subject")}>{subjectImage ? <img src={subjectImage} alt="" /> : <Icon name="plus" />}主体图{mode === "style" ? " · 可选" : ""}</button>)}
          {mode === "multi-reenact" && <button disabled={locked || subjects.length >= 6} aria-label="添加主体图" onClick={() => choose("add")}><Icon name="plus" /></button>}
          <button aria-label="查看参考图" aria-pressed={!isSubject} onClick={() => select("reference")}>{image ? <img src={image} alt="" /> : <Icon name="image" />}参考图</button>
        </div>
      </div>
      <div className="canvas-controls">
      <div className="canvas-floating-tools" role="group" aria-label="画布工具栏" ref={modeControl}>
        <SelectField label="逆向模式" aria-label="逆向模式" value={mode} disabled={modeDisabled || uploading} onChange={event => { setOpen(false); setSettings(false); onMode(event.target.value as Mode); }}>
          {(Object.keys(modes) as Mode[]).map(key => <option key={key} value={key}>{modes[key]}</option>)}
        </SelectField>
        <span className="canvas-tool-divider" />
        <button className="quiet-button" disabled={locked} aria-label={currentImage ? "替换当前图片" : "上传当前图片"} title={currentImage ? "替换当前图片" : "上传当前图片"} onClick={() => choose(isSubject ? current?.id || "subject" : "reference")}><Icon name="image" /><span>{currentImage ? "替换" : "上传"}</span></button>
        {mode !== "recreate" && <button className="quiet-button canvas-icon-tool" aria-label="互换主体与参考" title="互换主体与参考" disabled={locked || !image || (mode === "multi-reenact" ? !current?.subjectImage : !subjectImage)} onClick={() => onSwap(current?.id)}><Icon name="swap" /></button>}
        {mode !== "recreate" && <button className="quiet-button canvas-icon-tool" aria-label="移除主体" title="移除主体" disabled={locked || !isSubject} onClick={() => void remove()}><Icon name="trash" /></button>}
        {mode === "multi-reenact" && <button ref={settingsTrigger} className="quiet-button canvas-icon-tool" aria-label="主体设置" title="主体设置" aria-expanded={settings} disabled={locked || !current} onClick={() => setSettings(!settings)}><Icon name="settings" /></button>}
        {versions && <><span className="canvas-tool-divider" /><div className="canvas-versions">{versions}</div></>}
        {settings && current && <div ref={settingsPanel} className="canvas-subject-settings" role="group" aria-label="主体设置" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setSettings(false); settingsTrigger.current?.focus(); } }}>
          <div className="canvas-subject-head"><strong>{label}</strong><button className="quiet-button" aria-label="关闭主体设置" onClick={() => { setSettings(false); settingsTrigger.current?.focus(); }}><Icon name="close" /></button></div>
          <SelectField label="用途" aria-label="主体用途" disabled={locked} value={current.role} onChange={event => void update({ role: event.target.value })}>{["自动", "人物", "物品", "服饰", "场景", "细节"].map(role => <option key={role}>{role}</option>)}</SelectField>
          <input key={`${contextKey}:${current.id}:${current.detail}`} aria-label="主体保留特征" placeholder="保留特征" maxLength={2000} disabled={locked} defaultValue={current.detail} onBlur={event => { if (event.target.value !== current.detail) void update({ detail: event.target.value }); }} />
          <button className="quiet-button" aria-label="主体前移" disabled={locked || index === 0} onClick={() => void reorder(-1)}>←</button><button className="quiet-button" aria-label="主体后移" disabled={locked || index === subjects.length - 1} onClick={() => void reorder(1)}>→</button>
        </div>}
      </div>
      <div className="canvas-composer" inert={sheetOpen}>
        <TaskInstruction value={instruction} disabled={disabled || uploading || promptEditing} onChange={onInstruction} />
        <div className="canvas-composer-bar">
        {hasPrompt && <button ref={trigger} className="quiet-button canvas-prompt-link" aria-label={sheetOpen ? "收起提示词" : "展开提示词"} aria-expanded={sheetOpen} aria-controls="workspace-prompt-sheet" onClick={() => { setSettings(false); setOpen(true); }}><Icon name={sheetOpen ? "chevronDown" : "edit"} /><span>{sheetOpen ? "收起" : "提示词"}</span><i className={stale ? "canvas-stale-dot" : "canvas-ready-dot"} /></button>}
          <span data-reminder-task={!uploadError && error ? errorTaskId : undefined} className={uploadError || error ? "canvas-error" : ""} role={uploadError || error ? "alert" : "status"} title={uploadError || error || status}>{uploadError || error || (uploading ? "正在读取图片…" : status || (stale ? "提示词待更新" : ""))}{onRetryReference && <button className="text-button" onClick={onRetryReference}>重试</button>}</span>
          {mode === "style" && subjectImage && <button className="quiet-button canvas-generic" disabled={locked || promptEditing || !instruction.trim()} title="不使用主体图，仅提取通用风格" onClick={onExtract}>仅提取风格</button>}
          <button ref={generate} className="primary canvas-generate" disabled={running ? cancelling : reverseDisabled || uploading} aria-busy={running} onClick={running ? onCancel : onReverse}><Icon name={running ? "close" : hasPrompt ? "retry" : "edit"} />{running ? cancelling ? "正在取消…" : "取消" : hasPrompt ? stale ? "更新提示词" : "重新生成" : "生成提示词"}{!running && <Icon name="arrow" />}</button>
        </div>
      </div>
    <PromptSheet open={sheetOpen} onOpenChange={setOpen} returnFocus={returnFocus} reduced={reduced}>
      {stale && <div className="canvas-prompt-notice"><span role="status">{status || "提示词待更新"}</span><button className="text-button" onClick={() => setOpen(false)}>返回输入</button></div>}
      <div className="canvas-prompt-content">{prompt}</div>
      <div className="canvas-generation-actions" ref={generationActions} />
    </PromptSheet>
      </div>
    </div>
    <input hidden ref={upload} type="file" accept="image/png,image/jpeg,image/webp" multiple={mode === "multi-reenact"} aria-label="上传画布图片" onChange={event => { void readFiles([...event.target.files || []]); event.target.value = ""; }} />
  </section>;
}
