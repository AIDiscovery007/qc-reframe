import { useEffect, useRef, useState } from "react";
import { request } from "../../lib/client";
import { showMotionDialog } from "../../lib/motion-dialog";
import { logo } from "../../lib/brand";
import type { SessionIndexStatus, SessionPage, SessionSummary } from "../../lib/types";
import Icon from "../popup/Icon";
import SelectField from "../popup/SelectField";
import TaskOrchestration from "./TaskOrchestration";

const issueDescriptions = {
  content_limit: "正文超过单会话上限（100 万字符 / 10 万段），未截断收录。",
  response_limit: "单条对话数据仍超过 24 MB 读取上限，未截断收录。",
  page_limit: "完整读取超过 200 页上限，未截断收录。",
  index_capacity: "本地索引达到容量上限（5000 会话 / 2000 万字符）。",
  changed: "读取期间会话发生变化，待编辑结束后更新索引。",
  timeout: "读取超时，可稍后更新索引重试。",
  read_failed: "暂时无法完整读取，可更新索引重试；仍失败时检查本机服务。",
};

export default function SessionPicker({ value, onConfirm, onClose }: {
  value: SessionSummary[]; onConfirm(ids: string[]): Promise<void>; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const revision = useRef(0);
  const reader = useRef<AbortController | undefined>(undefined);
  const indexReader = useRef<AbortController | undefined>(undefined);
  const focusSession = useRef<string | undefined>(undefined);
  const livePage = useRef<SessionPage>({ data: [], nextCursor: null });
  const lastResultRefresh = useRef(0);
  const indexFocus = useRef(false);
  const indexDisclosure = useRef<HTMLDetailsElement>(null);
  const [instant, setInstant] = useState(false);
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
  livePage.current = page;
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
    if (!indexBusy && indexFocus.current) {
      indexFocus.current = false;
      dialog.current?.querySelector<HTMLButtonElement>(".task-orchestration-actions button:not(:disabled)")?.focus();
    }
  }, [indexBusy, index?.state]);
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
        if (next.state === "building") {
          // New matches become visible before a large index finishes; leave nonempty lists stable.
          if (next.indexed > 0 && !livePage.current.data.length && Date.now() - lastResultRefresh.current >= 3000) {
            lastResultRefresh.current = Date.now(); setRefresh(previous => previous + 1);
          }
          timer = setTimeout(poll, 1000);
        }
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
    const focused = document.activeElement;
    try {
      const next = await request<SessionIndexStatus>({ type: "alchemy:sessions-index", action }, controller.signal);
      if (!controller.signal.aborted) {
        revision.current++; reader.current?.abort(); setLoading(false);
        setIndex(next); setRefresh(previous => previous + 1);
        indexFocus.current = focused === document.activeElement && !!dialog.current?.contains(focused);
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
  const building = index?.state === "building" || index?.state === "stale";
  const indexFailure = indexError || index?.error || (!index ? error : "");
  const processed = index?.processed ?? Math.min(index?.total || 0, (index?.indexed || 0) + (index?.failed || 0));
  const indexTitle = indexFailure ? "正文索引需要处理" : !index ? "正在检查正文索引" : index.state === "empty" ? "开启正文搜索" : building ? "正在建立正文索引" : index.state === "partial" ? "部分会话暂未收录" : "正文索引已就绪";
  const indexDetail = !index ? indexFailure ? "无法读取本地正文索引，可清除后重新建立。" : "正在连接本机服务…" : index.state === "empty" ? "建立本地索引后可搜索正文，标题搜索始终可用。" : building ? index.total ? `已处理 ${processed} / ${index.total} · ${index.indexed} 个可搜索` : "正在整理会话列表，已有索引仍可搜索。" : `${index.indexed} / ${index.total} 个会话可搜索${index.failed ? ` · ${index.failed} 个暂未收录` : ""}`;
  useEffect(() => {
    const disclosure = indexDisclosure.current;
    if (!disclosure) return;
    const completed = !indexFailure && (index?.state === "ready" || index?.state === "partial");
    // Only a lifecycle change resets disclosure; polling and searching preserve manual toggles.
    if (completed && disclosure.contains(document.activeElement)) disclosure.querySelector("summary")?.focus();
    disclosure.open = !completed;
  }, [scope, index?.state, indexFailure]);
  return <dialog ref={dialog} className="result-dialog modal session-picker" aria-labelledby="session-title" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="modal-head"><img src={logo} alt="" /><h2 id="session-title">选择对话会话</h2><button className="close-btn" aria-label="关闭窗口" disabled={saving} onClick={onClose}>×</button></div>
      <section className="session-selected" aria-labelledby="selected-sessions-title">
        <h3 id="selected-sessions-title">已选会话 <span>{draft.length} / 5</span></h3>
        {draft.length ? <div className="session-selected-list">{draft.map(item => <label key={item.id} className="session-row session-selected-row"><input type="checkbox" data-session-id={item.id} checked disabled={saving} onChange={() => choose(item, false)} /><strong title={item.title}>{item.title}</strong></label>)}</div>
          : <p className="session-selected-empty">尚未选择会话</p>}
      </section>
    <div className="session-picker-body">
      <div className="session-search"><input autoFocus type="search" aria-label="搜索会话" placeholder={scope === "title" ? "搜索会话标题" : "搜索标题和正文"} maxLength={200} value={search} disabled={saving} onChange={event => setSearch(event.target.value)} />
        <SelectField label="搜索范围" aria-label="搜索范围" value={scope} disabled={saving} onChange={event => setScope(event.target.value as "title" | "content")}><option value="title">标题</option><option value="content">标题和正文</option></SelectField>
      </div>
      {scope === "content" && <details ref={indexDisclosure} className="session-index" onPointerDownCapture={() => setInstant(false)} onKeyDownCapture={() => setInstant(true)}>
        <summary className="session-index-summary"><span><strong>{indexTitle}</strong><small>{indexDetail}</small></span><span className="session-index-toggle"><span>展开</span><span>收起</span></span></summary>
        <TaskOrchestration phase={indexFailure ? "error" : building ? "running" : index?.state === "ready" ? "success" : index?.state === "partial" ? "partial" : "idle"} title={indexTitle} detail={indexDetail}
          progress={index?.total ? processed / index.total * 100 : undefined} progressLabel="正文索引进度" instant={instant} actions={<>
            <button className={building ? "task-action-secondary" : "task-action-primary"} disabled={saving || indexBusy || !index} onClick={() => void updateIndex(building ? "clear" : "refresh")}>{indexBusy ? "正在处理…" : building ? "停止并清除" : index?.state === "empty" ? "建立索引" : "更新索引"}</button>
            {!building && (index && index.state !== "empty" || error || indexError) && <button className="task-action-secondary" disabled={saving || indexBusy} onClick={() => void updateIndex("clear")}>清除索引</button>}
            {indexError && <button className="task-action-secondary" disabled={saving || indexBusy} onClick={() => { setIndexError(""); setRefresh(previous => previous + 1); }}>重试读取状态</button>}
          </>}>
          {!!index?.failed && <details className="session-index-issues"><summary>{index.failed} 个会话暂未收录 <span>查看原因</span></summary><div>
            {index.issues?.length ? <ul>{index.issues.map(issue => <li key={issue.code}><span>{issue.count} 个</span>{issueDescriptions[issue.code] || issueDescriptions.read_failed}</li>)}</ul> : <p>部分会话无法完整读取；更新本机服务后重试，可获得具体原因。</p>}
          </div></details>}
          {indexFailure && <p className="session-index-error" role="alert">{indexFailure}</p>}
        </TaskOrchestration>
      </details>}
      <p className="hint session-picker-hint"><span>勾选会话，将使用整个会话的上下文。</span><label><input type="checkbox" checked={archived} disabled={saving} onChange={event => setArchived(event.target.checked)} />已归档</label></p>
      <h3 className="session-candidates-title" id="candidate-sessions-title">{search ? "搜索结果" : archived ? "归档会话" : "可选会话"}</h3>
      <section className="session-candidates" aria-labelledby="candidate-sessions-title" aria-busy={loading}>
      <div className="session-list">{visible.map(item => <label key={item.id} className="session-row"><input type="checkbox" data-session-id={item.id} checked={false} disabled={saving || draft.length >= 5} onChange={() => choose(item, true)} /><span><strong>{item.title}</strong><small>{item.match === "content" ? "正文匹配 · 完整会话" : "完整会话"}</small>{item.snippet && <small className="session-snippet">{item.snippet}</small>}</span><time>{new Date(item.updatedAt * 1000).toLocaleDateString("zh-CN")}</time></label>)}</div>
      {loading && <p className="session-empty" role="status">正在读取本机会话…</p>}
      {!loading && !error && !visible.length && <p className="session-empty" role="status">{page.data.length ? "当前列表中的会话已全部选中" : scope === "content" && building ? "已收录会话中暂未找到结果，索引仍在更新。" : scope === "content" && index?.state === "empty" ? "建立索引后，正文匹配会出现在这里。" : "没有找到会话"}</p>}
      {error && !(scope === "content" && !index) && <p className="error" role="alert">{error} <button className="text-button" disabled={loading || saving} onClick={() => void load()}>重新读取</button></p>}
      {!loading && page.nextCursor && <button className="text-button" disabled={saving} onClick={() => void load(page.nextCursor!)}>加载更多</button>}
      </section>
      {saveError && <p className="error" role="alert">{saveError}</p>}
    </div>
    <div className="session-picker-footer"><span>本机 Codex · 已选 {draft.length} 个 / 最多 5 个</span><button className="quiet-button" disabled={saving} onClick={onClose}>取消</button><button className="primary" disabled={saving} onClick={() => void confirm()}>{saving ? "正在保存…" : "确认选择"}<Icon name="arrow" /></button></div>
  </dialog>;
}
