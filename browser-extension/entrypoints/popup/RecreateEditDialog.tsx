import { useEffect, useId, useRef } from "react";
import { showMotionDialog } from "../../lib/motion-dialog";
import { EDIT_LIMITS, editPrompt, editRequested, type EditProfile, type EditRequest, type EditSnapshot } from "../../lib/recreate-edit.mjs";
import RecoveryAction from "./RecoveryAction";

export type EditDraft = { values: Record<string, string>; note: string };

export const emptyEditDraft = (): EditDraft => ({ values: {}, note: "" });

/** Reopen a finished edit with the values it was generated from. */
export const editDraftFrom = (snapshot?: EditSnapshot): EditDraft | undefined => snapshot
  ? { values: Object.fromEntries(snapshot.changes.map(change => [change.id, change.value])), note: snapshot.note }
  : undefined;

export function editRequestFrom(profile: EditProfile, draft: EditDraft): EditRequest {
  return {
    changes: profile.elements.map(item => ({ id: item.id, value: draft.values[item.id] || "" })).filter(change => change.value.trim()),
    ...(draft.note.trim() ? { note: draft.note } : {}),
  };
}

// 原图编辑：用户按逆向扫描出的元素填写修改，提交后由本机服务拼装提示词并附原图生图。
export default function RecreateEditDialog({ profile, lang, draft, busy, error, onDraft, onCancel, onSubmit }: {
  profile: EditProfile; lang: "zh" | "en"; draft: EditDraft; busy: boolean; error: string;
  onDraft(draft: EditDraft): void; onCancel(): void; onSubmit(edit: EditRequest): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => showMotionDialog(dialog.current!), []);
  const edit = editRequestFrom(profile, draft);
  const ready = editRequested(edit);
  const snapshot: EditSnapshot = {
    changes: profile.elements.filter(item => draft.values[item.id]?.trim()).map(item => ({ ...item, value: draft.values[item.id]!.trim() })),
    note: draft.note.trim(),
  };
  const close = () => { if (!busy) onCancel(); };
  return <dialog ref={dialog} className="result-dialog modal dialog-small recreate-edit" aria-labelledby={titleId} aria-busy={busy}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); close(); } }}>
    <div className="modal-head"><h2 id={titleId}>编辑原图</h2><button className="close-btn" aria-label="关闭窗口" disabled={busy} onClick={close}>×</button></div>
    <form className="dialog-content" onSubmit={event => { event.preventDefault(); if (ready && !busy) onSubmit(edit); }}>
      <div className="edit-body">
        <p>只填写要修改的元素，留空的保持原样。提交后附原图生成，未提及的部分与原图保持一致。</p>
        <div className="edit-elements">
          {profile.elements.map(item => <label key={item.id} className="edit-element">
            <span className="edit-element-label"><strong>{item.label}</strong><small title={item.currentZh}>当前：{item.currentZh}</small></span>
            <input type="text" value={draft.values[item.id] || ""} maxLength={EDIT_LIMITS.value} placeholder="保持不变" disabled={busy}
              onChange={event => onDraft({ ...draft, values: { ...draft.values, [item.id]: event.target.value } })} />
          </label>)}
          <label className="edit-element">
            <span className="edit-element-label"><strong>其他修改</strong><small>上面未列出的内容</small></span>
            <textarea rows={2} value={draft.note} maxLength={EDIT_LIMITS.note} placeholder="可选" disabled={busy}
              onChange={event => onDraft({ ...draft, note: event.target.value })} />
          </label>
        </div>
        {ready && <details className="edit-prompt-preview"><summary>查看将发送的提示词</summary>
          <div className="prompt-text">{editPrompt(profile, snapshot, lang)}</div>
        </details>}
      </div>
      {error && <p className="error" role="alert">{error} <RecoveryAction error={error} /></p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={close}>取消</button>
        <button type="submit" className="primary" disabled={busy || !ready} aria-busy={busy}>{busy ? "正在提交…" : ready ? "提交生成" : "请至少填写一项修改"}</button>
      </div>
    </form>
  </dialog>;
}
