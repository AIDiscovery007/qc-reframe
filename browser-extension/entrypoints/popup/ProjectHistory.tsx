import { showMotionDialog } from "../../lib/motion-dialog";
import { createPortal } from "react-dom";
import { logo } from "../../lib/brand";
import { useEffect, useRef, useState } from "react";
import type { Batch, ProjectSummary } from "../../lib/types";
import BatchRecreate from "./BatchRecreate";
import ProjectItem from "./ProjectItem";
import Icon from "./Icon";
import HiddenProjectsToggle from "./HiddenProjectsToggle";

export default function ProjectHistory({ projects, busy, onOpen, onDelete, workspace = false, searchTarget, page, total, pageSize, search, status, loading, loadError, onPage, onSearch, onStatus, onRetry, showHidden, hiddenProjectIds, onSetHidden, onToggleHidden, batchDisabled = false, onTasks }: {
  batchDisabled?: boolean; onTasks?(): void;
  page: number; total: number; pageSize: number; search: string; loading: boolean; loadError: string;
  status?: "unstarted"; onStatus(value: "unstarted" | undefined): void;
  onPage(page: number): void; onSearch(value: string): void; onRetry(): void;
  projects: ProjectSummary[]; busy: boolean; onOpen(project: ProjectSummary): void;
  onDelete(ids: string[]): Promise<void>;
  showHidden: boolean; hiddenProjectIds: string[]; onSetHidden(ids: string[], hidden: boolean): Promise<string[]>; onToggleHidden(): void;
  workspace?: boolean; searchTarget?: HTMLElement | null;
}) {
  const [managing, setManaging] = useState(false);
  const [view, setView] = useState<"grid" | "list">(() => {
    try { return workspace && localStorage.getItem("reframe:project-view") === "list" ? "list" : "grid"; }
    catch { return "grid"; }
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [batchProjects, setBatchProjects] = useState<ProjectSummary[]>();
  const [batchStarted, setBatchStarted] = useState(false);
  const [pending, setPending] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [visibilityAction, setVisibilityAction] = useState<boolean>();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const taskButton = useRef<HTMLButtonElement>(null);
  const restoreBatchFocus = useRef(false);
  const visible = projects;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const unavailable = busy || loading || !!loadError;
  const listView = workspace && view === "list";
  const selectable = managing;
  const changeView = (value: "grid" | "list") => {
    setView(value);
    if (selected.length) setManaging(true);
    try { localStorage.setItem("reframe:project-view", value); }
    catch { /* Keep switching available when browser storage is unavailable. */ }
  };
  useEffect(() => { setSelected([]); setNotice(""); setBatchProjects(undefined); setBatchStarted(false); }, [page, search, status, showHidden]);
  useEffect(() => {
    if (batchProjects || !restoreBatchFocus.current) return;
    restoreBatchFocus.current = false;
    (taskButton.current || heading.current)?.focus({ preventScroll: true });
  }, [batchProjects, batchStarted]);
  const eligible = visible;
  const checked = eligible.filter((project) => selected.includes(project.id));
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = checked.length > 0 && checked.length < eligible.length;
  }, [checked.length, eligible.length]);
  useEffect(() => {
    if (!pending.length) return;
    const closeDialog = showMotionDialog(dialog.current!);
    cancel.current?.focus({ preventScroll: true });
    return closeDialog;
  }, [pending]);
  const confirm = (items: ProjectSummary[]) => { setError(""); setNotice(""); setPending(items); };
  const started = (batch: Batch) => {
    restoreBatchFocus.current = true;
    const accepted = batch.items.filter(item => item.status !== "rejected").map(item => item.projectId);
    setSelected(ids => ids.filter(id => !accepted.includes(id)));
    setNotice(`已受理 ${accepted.length} 个项目`);
    setError(batch.items.filter(item => item.status === "rejected" && (showHidden || !hiddenProjectIds.includes(item.projectId))).map(item => `${item.title}：${item.error || "未受理"}`).join("；"));
    setBatchStarted(accepted.length > 0);
    setBatchProjects(undefined);
    onRetry();
  };
  const remove = async () => {
    try {
      await onDelete(pending.map((project) => project.id));
      setSelected((ids) => ids.filter((id) => !pending.some((project) => project.id === id)));
      setNotice(`已删除 ${pending.length} 个项目`);
      dialog.current?.close();
      setPending([]);
      heading.current?.focus();
    } catch (error) { setError((error as Error).message); }
  };
  const setHidden = async (hidden: boolean, items = checked) => {
    setError(""); setNotice("");
    setVisibilityAction(hidden);
    const ids = items.filter(project => !!project.hidden !== hidden).map(project => project.id);
    try {
      const updated = await onSetHidden(ids, hidden);
      setSelected(previous => previous.filter(id => !updated.includes(id)));
      const remaining = ids.filter(id => !updated.includes(id)).length;
      if (remaining) setError(`还有 ${remaining} 个项目未更新，请重试。`);
    } catch (error) { setError((error as Error).message); }
    finally { setVisibilityAction(undefined); }
  };
  const items = visible.map((project) => <ProjectItem key={project.id} project={project} workspace={workspace} selectable={selectable} disabled={unavailable} selected={checked.some((item) => item.id === project.id)}
    onSelect={() => setSelected((ids) => ids.includes(project.id) ? ids.filter((id) => id !== project.id) : [...ids, project.id])}
    onOpen={() => onOpen(project)} onSetHidden={() => void setHidden(!project.hidden, [project])} onDelete={() => confirm([project])} />);
  const searchInput = <input className="workspace-project-search" aria-label="搜索项目" type="search" value={search} maxLength={200} placeholder={status ? "搜索待逆向项目" : "搜索全部项目"} disabled={busy}
        onChange={(event) => { onSearch(event.target.value); setSelected([]); }} />;
  const statusFilter = <div className="project-status-filter" role="group" aria-label="项目状态筛选">
      <button type="button" aria-pressed={!status} disabled={busy} onClick={() => onStatus(undefined)}>全部</button>
      <button type="button" aria-pressed={status === "unstarted"} disabled={busy} onClick={() => onStatus("unstarted")}>待逆向</button>
    </div>;
  return <section className={`history${workspace ? " workspace-project-library" : ""}`}>
    {workspace ? <h2 ref={heading} className="workspace-library-heading" tabIndex={-1}>项目记录</h2> : <h1 ref={heading} tabIndex={-1}>项目记录</h1>}
    <div className={workspace ? "workspace-library-controls" : undefined}>
    {workspace && <div className="workspace-library-toolbar">
      {statusFilter}
      <div className="workspace-library-actions">{searchTarget ? createPortal(searchInput, searchTarget) : searchInput}
      <div className="workspace-project-view" role="group" aria-label="项目显示方式">
        <button type="button" aria-label="卡片视图" aria-pressed={view === "grid"} onClick={() => changeView("grid")}><Icon name="grid" />卡片</button>
        <button type="button" aria-label="列表视图" aria-pressed={view === "list"} onClick={() => changeView("list")}><Icon name="list" />列表</button>
      </div>
      {!!projects.length && <button className="text-button" disabled={busy} aria-pressed={managing} onClick={() => { setManaging(!managing); setSelected([]); }}>{managing ? "完成管理" : "批量管理"}</button>}</div>
    </div>}
    {!workspace && <div className="history-search">{searchInput}<div className="history-view-controls">
      <HiddenProjectsToggle shown={showHidden} disabled={busy} onToggle={onToggleHidden} />
      {!!projects.length && <button className="text-button" disabled={busy} aria-pressed={managing} onClick={() => { setManaging(!managing); setSelected([]); }}>{managing ? "完成管理" : "批量管理"}</button>}
    </div></div>}
    {!workspace && statusFilter}
    {!!projects.length && selectable && <div className="history-toolbar">
      <label><input ref={selectAll} className="project-checkbox" type="checkbox" checked={!!eligible.length && checked.length === eligible.length}
        disabled={unavailable || !eligible.length} onChange={(event) => setSelected(event.target.checked ? eligible.map((project) => project.id) : [])} />选择本页</label>
      <div className="history-management-actions">
      {workspace && <button className="primary" disabled={unavailable || batchDisabled || !checked.length} onClick={() => setBatchProjects([...checked])}>批量完整复刻</button>}
      <button className="text-button" aria-busy={visibilityAction === true || undefined} disabled={unavailable || !checked.some(project => !project.hidden)} onClick={() => void setHidden(true)}>隐藏所选</button>
      {showHidden && <button className="text-button" aria-busy={visibilityAction === false || undefined} disabled={unavailable || !checked.some(project => project.hidden)} onClick={() => void setHidden(false)}>恢复所选</button>}
      <button className="text-button danger" disabled={unavailable || !checked.length || checked.some(project => project.busy)} onClick={() => confirm(checked)}>
        <Icon name="trash" />删除所选<span className="history-selection-count">({checked.length})</span>
      </button>
      </div>
    </div>}
    </div>
    <div className={workspace ? "workspace-library-content" : undefined} tabIndex={workspace ? 0 : undefined} role={workspace ? "region" : undefined} aria-label={workspace ? "项目内容" : undefined}>
    <p className="history-notice" role="status">{notice}</p>
    {batchStarted && onTasks && <button ref={taskButton} className="text-button" onClick={onTasks}>查看任务</button>}
    {error && !pending.length && <p className="error" role="alert">{error}</p>}
    {!loading && !loadError && !projects.length && !search.trim() && <p className="muted">{status ? "暂无待逆向项目。" : "暂无可见项目。"}</p>}
    {!loading && !loadError && !visible.length && !!search.trim() && <p className="muted">{status ? "没有找到匹配的待逆向项目。" : "没有找到匹配的项目。"}</p>}
    <div className="project-page-status" role="status" aria-live="polite">{loading ? `正在读取第 ${page} 页…` : loadError ? "项目读取失败" : total ? `共 ${total} 个${status ? "待逆向" : ""}项目` : ""}</div>
    {loadError && <div className="error" role="alert">{loadError}<button className="text-button" onClick={onRetry}>重试</button></div>}
    {(pages > 1 || page > 1) && <nav className="project-pagination" aria-label="项目分页">
      <button className="secondary" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
      <span aria-live="polite">{page} / {pages}</span>
      <button className="secondary" disabled={busy || page >= pages} onClick={() => onPage(page + 1)}>下一页</button>
    </nav>}
    <div className={workspace ? listView ? "workspace-project-list" : "workspace-project-grid" : "project-page-items"} role={workspace ? "list" : undefined} aria-label={workspace ? "项目" : undefined} aria-busy={loading} data-loading={loading}>{items}</div>
    </div>
    {batchProjects && <BatchRecreate projects={batchProjects} showHidden={showHidden} hiddenProjectIds={hiddenProjectIds} onClose={() => setBatchProjects(undefined)} onStarted={started} />}
    <dialog ref={dialog} className={workspace ? "result-dialog modal dialog-small" : "delete-dialog"} aria-labelledby="delete-title" aria-describedby="delete-description"
      onCancel={(event) => { event.stopPropagation(); event.preventDefault(); if (!busy) setPending([]); }}
      onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}>
      <div className={workspace ? "modal-head" : undefined}>{workspace && <img src={logo} alt="" />}
      <h2 id="delete-title">{pending.length === 1 ? "删除这个项目？" : `删除 ${pending.length} 个项目？`}</h2>
      {workspace && <button className="close-btn" disabled={busy} aria-label="关闭窗口" onClick={() => setPending([])}>×</button>}</div>
      <div className={workspace ? "dialog-content" : undefined}>
      {pending.length === 1 && <strong className="delete-project-name">{pending[0]?.title}</strong>}
      <p id="delete-description">将删除项目内的提示词、生成记录及插件保存的图片，无法撤销。</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button ref={cancel} className="secondary" disabled={busy} onClick={() => setPending([])}>取消</button>
        <button className="primary danger-fill" disabled={busy} onClick={remove}>{busy ? "正在删除…" : "确认删除"}</button>
      </div>
      </div>
    </dialog>
  </section>;
}
