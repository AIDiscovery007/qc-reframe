import { useEffect, useRef, useState } from "react";
import { request } from "../../lib/client";
import { showMotionDialog } from "../../lib/motion-dialog";
import { logo } from "../../lib/brand";
import type { SessionPage, SessionSummary } from "../../lib/types";
import Icon from "../popup/Icon";

export default function SessionPicker({ value, onConfirm, onClose }: {
  value: SessionSummary[]; onConfirm(ids: string[]): Promise<void>; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const revision = useRef(0);
  const reader = useRef<AbortController | undefined>(undefined);
  const [draft, setDraft] = useState(value);
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState<SessionPage>({ data: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [error, setError] = useState("");
  const load = async (cursor?: string, attempt = ++revision.current) => {
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    setLoading(true); setError("");
    try {
      const next = await request<SessionPage>({ type: "alchemy:sessions-list", searchTerm: search.trim() || undefined, archived, cursor }, controller.signal);
      if (attempt !== revision.current) return;
      setPage(previous => ({ data: cursor ? [...new Map([...previous.data, ...next.data].map(item => [item.id, item])).values()] : next.data, nextCursor: next.nextCursor === cursor ? null : next.nextCursor }));
    } catch (reason) { if (attempt === revision.current) setError((reason as Error).message); }
    finally { if (attempt === revision.current) setLoading(false); }
  };
  useEffect(() => showMotionDialog(dialog.current!), []);
  useEffect(() => {
    const attempt = ++revision.current;
    setPage({ data: [], nextCursor: null }); setLoading(true); setError("");
    const timer = setTimeout(() => void load(undefined, attempt), search ? 250 : 0);
    return () => { clearTimeout(timer); revision.current++; reader.current?.abort(); };
  }, [search, archived]);
  const confirm = async () => {
    if (saving) return;
    setSaving(true); setSaveError("");
    try { await onConfirm(draft.map(item => item.id)); onClose(); }
    catch (reason) { setSaveError((reason as Error).message); }
    finally { setSaving(false); }
  };
  // Keep previously selected, unavailable sources removable without importing their content.
  const visible = !search && !archived ? [...draft.filter(item => !page.data.some(row => row.id === item.id)), ...page.data] : page.data;
  return <dialog ref={dialog} className="result-dialog modal session-picker" aria-labelledby="session-title" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="modal-head"><img src={logo} alt="" /><h2 id="session-title">选择对话会话</h2><button className="close-btn" aria-label="关闭窗口" disabled={saving} onClick={onClose}>×</button></div>
    <div className="session-picker-body"><input autoFocus type="search" aria-label="搜索会话" placeholder="搜索会话标题" maxLength={200} value={search} disabled={saving} onChange={event => setSearch(event.target.value)} />
      <p className="hint session-picker-hint"><span>勾选会话，将使用整个会话的上下文。</span><label><input type="checkbox" checked={archived} disabled={saving} onChange={event => setArchived(event.target.checked)} />已归档</label></p>
      <div className="session-list" aria-busy={loading}>{visible.map(item => <label key={item.id} className="session-row"><input type="checkbox" checked={draft.some(row => row.id === item.id)} disabled={saving || (draft.length >= 5 && !draft.some(row => row.id === item.id))} onChange={event => setDraft(event.target.checked ? [...draft, item] : draft.filter(row => row.id !== item.id))} /><span><strong>{item.title}</strong><small>完整会话</small></span><time>{new Date(item.updatedAt * 1000).toLocaleDateString("zh-CN")}</time></label>)}</div>
      {loading && <p className="session-empty" role="status">正在读取本机会话…</p>}
      {!loading && !error && !visible.length && <p className="session-empty" role="status">没有找到会话</p>}
      {error && <p className="error" role="alert">{error} <button className="text-button" disabled={loading || saving} onClick={() => void load()}>重新读取</button></p>}
      {saveError && <p className="error" role="alert">{saveError}</p>}
      {!loading && page.nextCursor && <button className="text-button" disabled={saving} onClick={() => void load(page.nextCursor!)}>加载更多</button>}
    </div>
    <div className="session-picker-footer"><span>本机 Codex · 已选 {draft.length} 个 / 最多 5 个</span><button className="quiet-button" disabled={saving} onClick={onClose}>取消</button><button className="primary" disabled={saving} onClick={() => void confirm()}>{saving ? "正在保存…" : "确认选择"}<Icon name="arrow" /></button></div>
  </dialog>;
}
