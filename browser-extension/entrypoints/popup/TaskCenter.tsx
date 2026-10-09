import { noticeLabel, type TaskNotice } from "../../lib/task-reminders";
import { showMotionDialog } from "../../lib/motion-dialog";
import { pollWhileVisible } from "../../lib/visible-poll";
import { useEffect, useRef, useState } from "react";
import { query, request } from "../../lib/client";
import type { Batch, Generation, Job, Mode } from "../../lib/types";
import Icon from "./Icon";
import HiddenProjectsToggle from "./HiddenProjectsToggle";
import { logo } from "../../lib/brand";

const modes: Record<Mode, string> = { style: "提取风格", recreate: "完整复刻", reenact: "主体重演", "multi-reenact": "多图重演", session: "会话创作" };
const statuses = { running: "进行中", completed: "已完成", failed: "失败", cancelled: "已取消" };
const batchStatuses = { ...statuses, queued: "排队中", rejected: "未受理" };

export default function TaskCenter({ unread, onNoticeOpen, onClose, onOpen, onUpdate, showHidden, hiddenProjectIds, busy, onToggleHidden, visibilityError, workspace = false }: {
  workspace?: boolean;
  unread: TaskNotice[]; onNoticeOpen(notice: TaskNotice): void;
  visibilityError?: string; showHidden: boolean; hiddenProjectIds: string[]; busy: boolean; onToggleHidden(): void;
  onClose(): void;
  onOpen(projectId: string, mode: Mode, jobId: string, generationId?: string): Promise<void>;
  onUpdate?(job: Job): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(false);
  const revision = useRef(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchError, setBatchError] = useState("");
  const batchPending = useRef(new Set<string>());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  const [opening, setOpening] = useState("");
  const [images, setImages] = useState<Record<string, string>>({});
  const requestedImages = useRef(new Set<string>());

  useEffect(() => {
    alive.current = true;
    const element = dialog.current!;
    const closeDialog = showMotionDialog(element);
    element.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { alive.current = false; closeDialog(); };
  }, []);

  useEffect(() => {
    let stopped = false;
    let active = true;
    const refresh = async () => {
      const current = revision.current;
      if (workspace) {
        try {
          const values = await request<Batch[]>({ type: "alchemy:batches" });
          if (!stopped && current === revision.current) { setBatches(values); setBatchError(""); active = values.some(batch => batch.items.some(item => item.status === "queued" || item.status === "running")); }
        } catch (e) { if (!stopped && current === revision.current) setBatchError((e as Error).message === "Not found" ? "请重启本机服务以查看批量任务。" : (e as Error).message); }
      }
      try {
        const values = await query<Job[]>("/jobs");
        if (!stopped && current === revision.current) { setJobs(values); setError(""); active = (workspace && active) || values.some(job => (job.status === "running" || job.autoGeneration?.status === "pending") || job.generations?.some(item => item.status === "running")); }
      } catch (e) { if (!stopped) setError((e as Error).message); }
      finally { if (!stopped) setLoaded(true); }
      return active ? 2000 : 10_000;
    };
    const stopPolling = pollWhileVisible(refresh);
    return () => {
      stopped = true;
      stopPolling();
    };
  }, [showHidden, workspace]);

  const cancelBatch = async (batch: Batch, projectId?: string) => {
    const key = `${batch.id}:${projectId || "queued"}`;
    if (batchPending.current.has(key)) return;
    batchPending.current.add(key); setPending(items => [...items, key]);
    setActionError(""); revision.current++;
    try {
      const updated = await request<Batch>({ type: "alchemy:batch-cancel", id: batch.id, ...(projectId ? { projectId } : {}) });
      if (!alive.current) return;
      revision.current++;
      setBatches(items => items.map(item => item.id === updated.id ? { ...updated,
        items: item.items.map(previous => updated.items.find(value => value.projectId === previous.projectId) || previous) } : item));
    } catch (e) { if (alive.current) setActionError((e as Error).message); }
    finally { batchPending.current.delete(key); if (alive.current) setPending(items => items.filter(item => item !== key)); }
  };

  const cancel = async (job: Job, generation?: Generation) => {
    const id = generation?.id || job.id;
    setPending((items) => [...items, id]);
    setActionError("");
    revision.current++;
    try {
      const updated = await request<Job>({ type: generation ? "alchemy:generation-cancel" : "alchemy:cancel",
        id: job.id, ...(generation ? { generationId: generation.id } : {}) });
      if (!alive.current) return;
      revision.current++;
      setJobs((items) => items.map((item) => item.id === updated.id ? updated : item));
      onUpdate?.(updated);
    } catch (e) { if (alive.current) setActionError((e as Error).message); }
    finally { if (alive.current) setPending((items) => items.filter((item) => item !== id)); }
  };

  const open = async (job: Job, generation?: Generation) => {
    if (!job.projectId) return;
    setOpening(job.id);
    setActionError("");
    try { await onOpen(job.projectId, job.mode, job.id, generation?.id); if (alive.current) onClose(); }
    catch (e) { if (alive.current) setActionError((e as Error).message); }
    finally { if (alive.current) setOpening(""); }
  };

  const loadImage = (job: Job) => {
    const id = job.projectId || job.id;
    if (requestedImages.current.has(id)) return;
    requestedImages.current.add(id);
    void request<{ image: string }>({ type: job.projectId ? "alchemy:project-thumbnail" : "alchemy:reference", id, reference: true }).then(
      value => { if (alive.current) setImages(previous => ({ ...previous, [id]: value.image })); },
      () => {}, // A missing reference must not hide the task or its recovery actions.
    );
  };

  const visibleBatches = batches.map(batch => ({ ...batch, items: batch.items.filter(item => showHidden || !hiddenProjectIds.includes(item.projectId)) })).filter(batch => batch.items.length);
  const batchJobs = new Set(visibleBatches.flatMap(batch => batch.items.map(item => item.jobId)));
  const batchGenerations = new Set(visibleBatches.flatMap(batch => batch.items.map(item => item.generationId)));
  const tasks = jobs.filter(job => showHidden || !hiddenProjectIds.includes(job.projectId || "")).flatMap((job) => [
    { job, task: job.autoGeneration?.status === "pending" ? { ...job, status: "running" as const, stage: job.result ? "正在准备生图…" : job.stage } : job, generation: undefined as Generation | undefined },
    ...(job.generations || []).map((generation) => ({ job, task: generation, generation })),
  ]).filter(({ job, generation }) => generation ? !batchGenerations.has(generation.id) && !(batchJobs.has(job.id) && job.autoGeneration?.generationId === generation.id) : !batchJobs.has(job.id)).map((item) => {
    const timestamp = Date.parse(item.task.createdAt || item.job.createdAt);
    return { ...item, timestamp: Number.isFinite(timestamp) ? timestamp : null };
  }).sort((a, b) => Number(b.task.status === "running") - Number(a.task.status === "running") || (b.timestamp ?? 0) - (a.timestamp ?? 0));
  const running = tasks.filter(({ task }) => task.status === "running").length + visibleBatches.reduce((count, batch) => count + batch.items.filter(item => item.status === "running").length, 0);

  return <dialog ref={dialog} className="task-center" aria-labelledby="task-center-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <div className="modal-head"><img src={logo} alt="" /><h2 id="task-center-title">任务中心{running > 0 && ` · ${running} 项执行中`}</h2>
      <HiddenProjectsToggle shown={showHidden} disabled={busy} onToggle={onToggleHidden} />
      <button type="button" className="close-btn" aria-label="关闭窗口" onClick={onClose}>×</button></div>
    <div className="task-list">
      {unread.length > 0 && <section aria-label="未查看结果" className="reminder-unread-list">
        <div className="settings-row"><strong>{unread.length} 项结果未查看</strong><button className="text-button" onClick={() => void request({ type: "alchemy:reminder-read", ids: unread.map(item => item.id) }).catch(error => setActionError(error.message))}>全部标为已读</button></div>
        {unread.map(item => <button key={item.id} className="text-button" onClick={() => onNoticeOpen(item)}><span className="reminder-dot" data-failed={item.status === "failed"} />{modes[item.mode]} · {noticeLabel(item)} · {new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</button>)}
      </section>}
      {!loaded && <p className="hint task-scope" role="status">正在读取任务…</p>}
      {error && <div className="error" role="alert">{error}</div>}
      {batchError && <div className="error" role="alert">{batchError}</div>}
      {visibilityError && <div className="error" role="alert">{visibilityError}</div>}
      {actionError && <div className="error" role="alert">{actionError}</div>}
      {loaded && !tasks.length && !visibleBatches.length && !error && !batchError && <div className="empty-canvas"><h3>暂无任务</h3></div>}
      {visibleBatches.map(batch => <section key={batch.id} className="batch-tasks" aria-label="批量完整复刻任务">
        <div className="batch-task-heading"><div><strong>批量完整复刻 · {batch.items.length} 个项目</strong>
          <small>{new Date(batch.createdAt).toLocaleString("zh-CN")} · {batch.items.filter(item => item.status === "completed").length} 已完成 · {batch.items.filter(item => item.status === "queued").length} 排队中</small></div>
          {batch.items.some(item => item.status === "queued") && <button className="outline-button" title="仅取消排队中的项目，运行中项目继续" disabled={pending.includes(`${batch.id}:queued`)} onClick={() => void cancelBatch(batch)}>停止剩余</button>}
        </div>
        <ul>{batch.items.map(item => <li key={item.projectId} className="task-item" data-status={item.status}>
          <div className="task-meta" role="status"><strong>{item.title}</strong><small>{batchStatuses[item.status]}{item.status === "running" ? ` · ${item.stage}` : ""}</small>{item.error && <small className="task-error">{item.error}</small>}</div>
          {(item.status === "queued" || item.status === "running") && <button className="text-link task-cancel" disabled={pending.includes(`${batch.id}:${item.projectId}`)} onClick={() => void cancelBatch(batch, item.projectId)}>取消</button>}
          {item.jobId && <button className="outline-button" disabled={!!opening} onClick={async () => {
            setOpening(item.jobId!); setActionError("");
            try { await onOpen(item.projectId, "recreate", item.jobId!, item.generationId); if (alive.current) onClose(); }
            catch (e) { if (alive.current) setActionError((e as Error).message); }
            finally { if (alive.current) setOpening(""); }
          }}>查看项目</button>}
        </li>)}</ul>
      </section>)}
      <ul>{tasks.map(({ job, task, generation, timestamp }) => <li key={task.id} className="task-item" data-status={task.status}>
        <button type="button" className="task-image-open" aria-label={`打开项目：${job.result?.title || "参考图项目"} · ${modes[job.mode]}`} disabled={!job.projectId || !!opening} onClick={() => void open(job, generation)}>
          <TaskImage image={images[job.projectId || job.id]} onVisible={() => loadImage(job)} />
        </button>
        <div className="task-meta" role="status" aria-atomic="true"><strong>{job.result?.title || "参考图项目"} · {modes[job.mode]}</strong>
          <small title={timestamp === null ? "时间未知" : new Date(timestamp).toLocaleString("zh-CN")}>{generation ? "生成图片" : "逆向提示词"} / <i className={task.status === "running" ? "activity-dot" : "task-status-dot"} aria-hidden="true" /> {statuses[task.status]}</small>
          {task.status === "running" && <small className="task-stage" title={task.stage}>{task.stage}</small>}
          {(task.error || !generation && job.autoGeneration?.error) && <small className="task-error">{task.error || job.autoGeneration?.error}</small>}
        </div>
        <button type="button" className="text-link task-cancel" style={{ visibility: task.status === "running" ? "visible" : "hidden" }} disabled={pending.includes(task.id)} onClick={() => void cancel(job, generation)}>{pending.includes(task.id) ? "正在取消…" : "取消"}</button>
        {job.projectId && <button type="button" className="outline-button" title={`打开逆向版本 ${job.id}`} disabled={!!opening} onClick={() => void open(job, generation)}>{opening === job.id ? "正在打开…" : "查看项目"}</button>}
      </li>)}</ul>
    </div>
  </dialog>;
}

function TaskImage({ image, onVisible }: { image?: string; onVisible(): void }) {
  const element = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      onVisible();
    });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  return <span ref={element} className="task-image">{image ? <img src={image} alt="" decoding="async" /> : <Icon name="image" />}</span>;
}
