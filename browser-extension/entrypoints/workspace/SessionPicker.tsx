import { useEffect, useRef, useState } from "react";
import { request } from "../../lib/client";
import { showMotionDialog } from "../../lib/motion-dialog";
import { logo } from "../../lib/brand";
import type { SessionIndexStatus, SessionPage, SessionSummary } from "../../lib/types";
import Icon from "../popup/Icon";

export default function SessionPicker({ value, onConfirm, onClose }: {
  value: SessionSummary[]; onConfirm(ids: string[]): Promise<void>; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const revision = useRef(0);
  const reader = useRef<AbortController | undefined>(undefined);
  const indexReader = useRef<AbortController | undefined>(undefined);
  const focusSession = useRef<string | undefined>(undefined);
  const [draft, setDraft] = useState(value.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })));
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"title" | "content">("title");
  const [archived, setArchived] = useState(false);
  const [index, setIndex] = useState<SessionIndexStatus>();
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexError, setIndexError] = useState("");
  const [refresh, setRefresh] = useState(0);
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
      const next = await request<SessionPage>({ type: "alchemy:sessions-list", searchTerm: search.trim() || undefined, scope, archived, cursor }, controller.signal);
      if (attempt !== revision.current) return;
      setPage(previous => ({ data: cursor ? [...new Map([...previous.data, ...next.data].map(item => [item.id, item])).values()] : next.data, nextCursor: next.nextCursor === cursor ? null : next.nextCursor }));
      if (next.index) setIndex(next.index);
    } catch (reason) { if (attempt === revision.current) setError((reason as Error).message); }
    finally { if (attempt === revision.current) setLoading(false); }
  };
  useEffect(() => showMotionDialog(dialog.current!), []);
  useEffect(() => () => indexReader.current?.abort(), []);
  useEffect(() => {
    if (!focusSession.current) return;
    const inputs = dialog.current?.querySelectorAll<HTMLInputElement>("input[data-session-id]");
    const target = inputs && [...inputs].find(input => input.dataset.sessionId === focusSession.current);
    (target || dialog.current?.querySelector<HTMLInputElement>(".session-selected input, input[type=search]"))?.focus();
    focusSession.current = undefined;
  }, [draft]);
  useEffect(() => {
    const attempt = ++revision.current;
    setPage({ data: [], nextCursor: null }); setLoading(true); setError("");
    const timer = setTimeout(() => void load(undefined, attempt), search ? 250 : 0);
    return () => { clearTimeout(timer); revision.current++; reader.current?.abort(); };
  }, [search, scope, archived, refresh]);
  useEffect(() => {
    if (scope !== "content" || index?.state !== "building" || indexBusy || saving || indexError) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await request<SessionIndexStatus>({ type: "alchemy:sessions-index", action: "status" }, controller.signal);
        if (controller.signal.aborted) return;
        setIndex(next);
        if (next.state === "building") timer = setTimeout(poll, 1000);
        else setRefresh(previous => previous + 1);
      } catch (reason) { if (!controller.signal.aborted) setIndexError((reason as Error).message); }
    };
    timer = setTimeout(poll, 1000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [scope, index?.state, indexBusy, saving, indexError]);
  const updateIndex = async (action: "refresh" | "clear") => {
    if (saving || indexBusy || (action === "refresh" && index?.state === "building")) return;
    revision.current++; reader.current?.abort(); setLoading(false);
    const controller = new AbortController();
    indexReader.current?.abort(); indexReader.current = controller;
    setIndexBusy(true); setIndexError("");
    try {
      const next = await request<SessionIndexStatus>({ type: "alchemy:sessions-index", action }, controller.signal);
      if (!controller.signal.aborted) {
        revision.current++; reader.current?.abort(); setLoading(false);
        setIndex(next); setRefresh(previous => previous + 1);
      }
    } catch (reason) { if (!controller.signal.aborted) setIndexError((reason as Error).message); }
    finally { if (!controller.signal.aborted) setIndexBusy(false); }
  };
  const confirm = async () => {
    if (saving) return;
    setSaving(true); setSaveError("");
    try { await onConfirm(draft.map(item => item.id)); onClose(); }
    catch (reason) { setSaveError((reason as Error).message); }
    finally { setSaving(false); }
  };
  const choose = (item: SessionSummary, checked: boolean) => {
    focusSession.current = item.id;
    const { id, title, updatedAt } = item;
    setDraft(previous => checked ? previous.length < 5 && !previous.some(row => row.id === id) ? [...previous, { id, title, updatedAt }] : previous : previous.filter(row => row.id !== id));
  };
  const visible = page.data.filter(item => !draft.some(row => row.id === item.id));
  return <dialog ref={dialog} className="result-dialog modal session-picker" aria-labelledby="session-title" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="modal-head"><img src={logo} alt="" /><h2 id="session-title">选择对话会话</h2><button className="close-btn" aria-label="关闭窗口" disabled={saving} onClick={onClose}>×</button></div>
    <div className="session-picker-body">
      <section className="session-selected" aria-labelledby="selected-sessions-title">
        <h3 id="selected-sessions-title">已选会话 <span>{draft.length} / 5</span></h3>
        {draft.length ? <div className="session-selected-list">{draft.map(item => <label key={item.id} className="session-row session-selected-row"><input type="checkbox" data-session-id={item.id} checked disabled={saving} onChange={() => choose(item, false)} /><strong title={item.title}>{item.title}</strong></label>)}</div>
          : <p className="session-selected-empty">尚未选择会话</p>}
      </section>
      <div className="session-search"><input autoFocus type="search" aria-label="搜索会话" placeholder={scope === "title" ? "搜索会话标题" : "搜索标题和正文"} maxLength={200} value={search} disabled={saving} onChange={event => setSearch(event.target.value)} />
        <select aria-label="搜索范围" value={scope} disabled={saving} onChange={event => setScope(event.target.value as "title" | "content")}><option value="title">标题</option><option value="content">标题和正文</option></select>
      </div>
      {scope === "content" && <div className="session-index">
        <p role="status">{!index ? error || indexError ? "无法读取本地正文索引，可清除后重新建立。" : "正在检查本地正文索引…" : index.state === "empty" ? "建立本地索引后可搜索正文，标题搜索始终可用。" : index.state === "building" ? `正在建立索引 ${index.indexed} / ${index.total} · 当前结果仅覆盖已索引会话` : index.state === "partial" ? `已索引 ${index.indexed} / ${index.total} 个会话，${index.failed} 个未能读取；正文结果未覆盖全部会话。` : index.state === "stale" ? `已索引 ${index.indexed} / ${index.total} 个会话，正在更新；正文结果可能尚未包含最新内容。` : `本地正文索引 · ${index.indexed} 个会话`}</p>
        <div className="session-index-actions"><button className="text-button" disabled={saving || indexBusy || !index || index.state === "building"} onClick={() => void updateIndex("refresh")}>{index?.state === "empty" ? "建立索引" : "更新索引"}</button>
          {(index && index.state !== "empty" || error || indexError) && <button className="text-button" disabled={saving || indexBusy} onClick={() => void updateIndex("clear")}>{index?.state === "building" ? "停止并清除" : "清除索引"}</button>}
          <span>仅存于本机</span>
        </div>
        {(indexError || index?.error) && <p className="error" role="alert">{indexError || index?.error}{indexError && <button className="text-button" disabled={saving || indexBusy} onClick={() => { setIndexError(""); setRefresh(previous => previous + 1); }}>重试读取状态</button>}</p>}
      </div>}
      <p className="hint session-picker-hint"><span>勾选会话，将使用整个会话的上下文。</span><label><input type="checkbox" checked={archived} disabled={saving} onChange={event => setArchived(event.target.checked)} />已归档</label></p>
      <h3 className="session-candidates-title" id="candidate-sessions-title">{search ? "搜索结果" : archived ? "归档会话" : "可选会话"}</h3>
      <section className="session-candidates" aria-labelledby="candidate-sessions-title" aria-busy={loading}>
      <div className="session-list">{visible.map(item => <label key={item.id} className="session-row"><input type="checkbox" data-session-id={item.id} checked={false} disabled={saving || draft.length >= 5} onChange={() => choose(item, true)} /><span><strong>{item.title}</strong><small>{item.match === "content" ? "正文匹配 · 完整会话" : "完整会话"}</small>{item.snippet && <small className="session-snippet">{item.snippet}</small>}</span><time>{new Date(item.updatedAt * 1000).toLocaleDateString("zh-CN")}</time></label>)}</div>
      {loading && <p className="session-empty" role="status">正在读取本机会话…</p>}
      {!loading && !error && !visible.length && <p className="session-empty" role="status">{page.data.length ? "当前列表中的会话已全部选中" : "没有找到会话"}</p>}
      {error && <p className="error" role="alert">{error} <button className="text-button" disabled={loading || saving} onClick={() => void load()}>重新读取</button></p>}
      {!loading && page.nextCursor && <button className="text-button" disabled={saving} onClick={() => void load(page.nextCursor!)}>加载更多</button>}
      </section>
      {saveError && <p className="error" role="alert">{saveError}</p>}
    </div>
    <div className="session-picker-footer"><span>本机 Codex · 已选 {draft.length} 个 / 最多 5 个</span><button className="quiet-button" disabled={saving} onClick={onClose}>取消</button><button className="primary" disabled={saving} onClick={() => void confirm()}>{saving ? "正在保存…" : "确认选择"}<Icon name="arrow" /></button></div>
  </dialog>;
}
