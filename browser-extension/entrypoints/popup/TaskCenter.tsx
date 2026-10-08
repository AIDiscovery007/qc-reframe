import { noticeLabel, type TaskNotice } from "../../lib/task-reminders";
import { showMotionDialog } from "../../lib/motion-dialog";
import { pollWhileVisible } from "../../lib/visible-poll";
import { useEffect, useRef, useState } from "react";
import { query, request } from "../../lib/client";
import type { Generation, Job, Mode } from "../../lib/types";
import Icon from "./Icon";
import HiddenProjectsToggle from "./HiddenProjectsToggle";
import { logo } from "../../lib/brand";

const modes: Record<Mode, string> = { style: "提取风格", recreate: "完整复刻", reenact: "主体重演", "multi-reenact": "多图重演", session: "会话创作" };
const statuses = { running: "进行中", completed: "已完成", failed: "失败", cancelled: "已取消" };

export default function TaskCenter({ unread, onNoticeOpen, onClose, onOpen, onUpdate, showHidden, hiddenProjectIds, busy, onToggleHidden, visibilityError }: {
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
      try {
        const values = await query<Job[]>("/jobs");
        if (!stopped && current === revision.current) { setJobs(values); setError(""); active = values.some(job => (job.status === "running" || job.autoGeneration?.status === "pending") || job.generations?.some(item => item.status === "running")); }
      } catch (e) { if (!stopped) setError((e as Error).message); }
      finally { if (!stopped) setLoaded(true); }
      return active ? 2000 : 10_000;
    };
    const stopPolling = pollWhileVisible(refresh);
    return () => {
      stopped = true;
      stopPolling();
    };
  }, [showHidden]);

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

  const tasks = jobs.filter(job => showHidden || !hiddenProjectIds.includes(job.projectId || "")).flatMap((job) => [
    { job, task: job.autoGeneration?.status === "pending" ? { ...job, status: "running" as const, stage: job.result ? "正在准备生图…" : job.stage } : job, generation: undefined as Generation | undefined },
    ...(job.generations || []).map((generation) => ({ job, task: generation, generation })),
  ]).map((item) => {
    const timestamp = Date.parse(item.task.createdAt || item.job.createdAt);
    return { ...item, timestamp: Number.isFinite(timestamp) ? timestamp : null };
  }).sort((a, b) => Number(b.task.status === "running") - Number(a.task.status === "running") || (b.timestamp ?? 0) - (a.timestamp ?? 0));
  const running = tasks.filter(({ task }) => task.status === "running").length;

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
      {visibilityError && <div className="error" role="alert">{visibilityError}</div>}
      {actionError && <div className="error" role="alert">{actionError}</div>}
      {loaded && !tasks.length && !error && <div className="empty-canvas"><h3>暂无任务</h3></div>}
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
