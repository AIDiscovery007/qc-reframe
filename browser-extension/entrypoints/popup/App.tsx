import ProjectVisibilityToast from "./ProjectVisibilityToast";
import { ReminderToast, useTaskReminders } from "./TaskReminders";
import { type TaskNotice } from "../../lib/task-reminders";
import type { PromptDraft, WorkspaceDraft, WorkspaceHandoff } from "../../lib/workspace-handoff";
import { resultDrawers, resultDrawerView } from "../../lib/result-drawer";
import useProjectLibrary from "./useProjectLibrary";
import { useMotion } from "../../lib/use-motion";
import { pollWhileVisible } from "../../lib/visible-poll";
import { createPortal } from "react-dom";
import { normalizeImage } from "../../lib/image";
import NewProject from "../workspace/NewProject";
import CanvasWorkspace from "../workspace/CanvasWorkspace";
import PromptEditor from "../workspace/PromptEditor";
import RecentProject from "../workspace/RecentProject";
import ResultGallery from "../workspace/ResultGallery";
import SettingsCenter from "./SettingsCenter";
import TaskCenter from "./TaskCenter";
import HiddenProjectsToggle from "./HiddenProjectsToggle";
import { useEffect, useReducer, useRef, useState } from "react";
import { query, readState, request, type UiState } from "../../lib/client";
import type { Job, Mode, Project, ProjectSummary, SubjectInput, Selection, MultiSubject } from "../../lib/types";
import ProjectHistory from "./ProjectHistory";
import QuickWorkspace from "./QuickWorkspace";
import MultiInputPreview from "./MultiInputPreview";
import { defaultInstructions } from "./TaskInstruction";
import GenerationPanel from "./GenerationPanel";
import Icon from "./Icon";
import SelectField from "./SelectField";
import { logo } from "../../lib/brand";

const defaults: UiState["preferences"] = { paired: false, mode: "style" };
const laneStatus = (job?: Job) => !job ? "待生成" : job.status === "running" ? "逆向中"
  : job.generations?.some((item) => item.status === "running") ? "生图中"
  : job.status !== "completed" ? "待重试"
  : job.generations?.some((item) => item.status === "completed") ? "提示词 + 图片" : "提示词已就绪";
const modeName = (mode: Mode) => ({ style: "提取风格", recreate: "完整复刻", reenact: "主体重演", "multi-reenact": "多图重演" })[mode];

export default function App({ embedded = false, workspace = false }: { embedded?: boolean; workspace?: boolean }) {
  const { reduced } = useMotion();
  const reminderRoot = useRef<HTMLDivElement>(null);
  const reminders = useTaskReminders(reminderRoot);
  const [targetPrompt, setTargetPrompt] = useState<{ jobId: string; request: number }>();
  const [targetGeneration, setTargetGeneration] = useState<{ jobId: string; id: string }>();
  const noticeNavigation = useRef<((params: URLSearchParams) => Promise<void>) | undefined>(undefined);
  const openNotice = (notice?: TaskNotice) => {
    if (!noticeNavigation.current) { setError("正在恢复界面，请稍后重试"); return; }
    void noticeNavigation.current(new URLSearchParams(notice
      ? { task: notice.jobId, ...(notice.generationId ? { generation: notice.generationId } : {}) }
      : { tasks: "unread" }));
  };
  const [projectSearchTarget, setProjectSearchTarget] = useState<HTMLDivElement | null>(null);
  const [resultPane, setResultPane] = useState<HTMLElement | null>(null);
  const [generationActions, setGenerationActions] = useState<HTMLDivElement | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [drawers, dispatchDrawer] = useReducer(resultDrawers, {});
  const resultReturn = useRef<HTMLButtonElement>(null);
  const wasDrawerOpen = useRef(false);
  const editor = useRef<HTMLDivElement>(null);
  const [sidebarExpanded, setSidebarExpanded] = useState<boolean>();
  const [smallSidebar, setSmallSidebar] = useState(() => matchMedia("(max-width: 860px)").matches);
  const sidebarCollapsed = smallSidebar || !(sidebarExpanded ?? true);
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 650px)").matches);
  const [draftReady, setDraftReady] = useState(false);
  const [draftError, setDraftError] = useState("");
  const handoffPending = useRef(false);
  const [instructions, setInstructions] = useState<Record<string, string>>({});
  const referenceInput = useRef<HTMLInputElement>(null);
  const [activeCount, setActiveCount] = useState(0);
  const [cliBusy, setCliBusy] = useState(false);
  const [basePreferences, setPreferences] = useState(defaults);
  const [projectModes, setProjectModes] = useState<Record<string, Mode>>({});
  const [inputRevisions, setInputRevisions] = useState<Record<string, number>>({});
  const [inputReload, setInputReload] = useState(0);
  const [viewsReady, setViewsReady] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [storedSelection, setSelection] = useState<Selection>();
  const [hiddenProjectIds, setHiddenProjectIds] = useState<string[]>([]);
  const preferences = { ...basePreferences, mode: storedSelection?.projectId
    ? projectModes[storedSelection.projectId] || "style" : basePreferences.mode };
  const setProjectMode = (projectId: string | undefined, mode: Mode) => {
    if (projectId) setProjectModes(items => ({ ...items, [projectId]: mode }));
    else setPreferences(value => ({ ...value, mode }));
  };
  const showHidden = !!preferences.showHiddenProjects;
  const visibilityRevision = useRef(0);
  const visibilityPending = useRef(false);
  const visibilityFeedback = useRef<HTMLDivElement>(null);
  const [visibilityNotice, setVisibilityNotice] = useState<{ ids: string[]; hidden: boolean; undone: boolean }>();
  const [visibilityError, setVisibilityError] = useState("");
  const selection = !showHidden && storedSelection?.projectId && hiddenProjectIds.includes(storedSelection.projectId) ? undefined : storedSelection;
  const [project, setProject] = useState<Project>();
  const projectSnapshot = useRef<Project | undefined>(undefined);
  projectSnapshot.current = project;
  const [dataRevision, setDataRevision] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [references, setReferences] = useState<Record<string, Selection>>({});
  const [multiSubjectDrafts, setMultiSubjectDrafts] = useState<Record<string, MultiSubject[]>>({});
  const [canvasSelections, setCanvasSelections] = useState<Record<string, string>>({});
  const [swappedSubjectId, setSwappedSubjectId] = useState("");
  const [subjectUnavailable, setSubjectUnavailable] = useState<Record<string, boolean>>({});
  const [subjectDrafts, setSubjectDrafts] = useState<Record<string, string>>({});
  const [promptDrafts, setPromptDrafts] = useState<Record<string, PromptDraft>>({});
  const [savingPrompt, setSavingPrompt] = useState("");
  const [referenceErrors, setReferenceErrors] = useState<Record<string, string>>({});
  const [savingMode, setSavingMode] = useState(false);
  const modeRevision = useRef(0);
  const projectRevision = useRef(0);
  const selectionRevision = useRef(0);
  const deletingProjects = useRef(false);
  const [settings, setSettings] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const library = useProjectLibrary(preferences.paired, historyOpen, workspace, dataRevision, showHidden);
  const visibleProject = (item: ProjectSummary) => showHidden || (!item.hidden && !hiddenProjectIds.includes(item.id));
  const recentProjects = library.recent.items.filter(visibleProject);
  const [connected, setConnected] = useState(false);
  const [connectionText, setConnectionText] = useState("尚未连接");
  const [serviceBusy, setServiceBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputSaving = useRef(false);
  const pendingCancellations = useRef(new Set<string>());
  const [cancellingJobs, setCancellingJobs] = useState<string[]>([]);
  const [lang, setLang] = useState<"zh" | "en">("zh");
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeProject = project?.id === selection?.projectId ? project : undefined;
  const modeJobs = (mode: Mode) => activeProject?.jobs.filter((item) => item.mode === mode) || [];
  const modeJob = (mode: Mode) => {
    const jobs = modeJobs(mode);
    if (versions[`${activeProject?.id}:${mode}`] === "new") return undefined;
    return jobs.find((item) => item.id === versions[`${activeProject?.id}:${mode}`]) || jobs[0];
  };
  const subjectKey = (mode: Mode) => `${selection?.projectId || selection?.id}:${mode}`;
  const subjectDraftKey = (mode: Mode) => `${subjectKey(mode)}:${modeJob(mode)?.id || "new"}`;
  const currentInput = (mode: Mode) => {
    const saved = modeJob(mode);
    return !saved || saved.id === selection?.inputVersions?.[mode] ? selection?.inputs?.[mode] : undefined;
  };
  const subjectImage = (mode: Mode) => {
    const savedJob = modeJob(mode);
    const saved = savedJob && references[savedJob.id];
    return subjectDrafts[subjectDraftKey(mode)] ?? (currentInput(mode) ? currentInput(mode)?.subjectImage || "" : undefined) ?? saved?.generationSubjectImage ?? saved?.reenact?.subjectImage ?? "";
  };
  const instructionKey = (mode: Mode) => `${subjectKey(mode)}:${modeJob(mode)?.id || "new"}`;
  const taskInstruction = (mode: Mode) => {
    const saved = modeJob(mode);
    return instructions[instructionKey(mode)] ?? currentInput(mode)?.instruction ?? saved?.instruction ?? saved?.reenact?.basePrompt ?? defaultInstructions[mode];
  };
  const changeInstruction = (mode: Mode, value: string) => {
    const key = subjectKey(mode), version = modeJob(mode)?.id || "new";
    setVersions(items => ({ ...items, [key]: version }));
    setInstructions(items => ({ ...items, [`${key}:${version}`]: value }));
  };
  const multiJob = modeJob("multi-reenact");
  const multiKey = `${subjectKey("multi-reenact")}:${multiJob?.id || "new"}`;
  const multiReference = multiJob && references[multiJob.id];
  const multiSubjects = multiSubjectDrafts[multiKey] ?? currentInput("multi-reenact")?.subjects ?? multiReference?.generationSubjects ?? multiReference?.reenact?.subjects ?? [];
  const multiPrompt = taskInstruction("multi-reenact");
  const savedMulti = multiReference?.reenact?.subjects || [];
  const multiStale = !!multiJob?.result && (multiSubjects.length !== savedMulti.length || multiSubjects.some((item, index) => {
    const saved = savedMulti[index];
    return !saved || item.id !== saved.id || item.subjectImage !== saved.subjectImage || item.role !== saved.role || item.detail !== saved.detail;
  }) || multiPrompt.trim() !== (multiJob.instruction ?? multiJob.reenact?.basePrompt)?.trim());
  const job = modeJob(preferences.mode);
  const activeJob = job;
  const displayImage = job ? references[job.id]?.image : selection?.image;
  const displaySelection = selection && { ...selection, image: displayImage };
  const drawerKey = `${selection?.projectId || selection?.id}:${preferences.mode}:${activeJob?.id || "new"}`;
  const referenceContext = useRef({ key: drawerKey });
  if (referenceContext.current.key !== drawerKey) referenceContext.current = { key: drawerKey };
  const running = job?.status === "running";
  const loadingProject = !!selection && !activeProject;
  const result = job?.result;
    const cancelling = !!job && cancellingJobs.includes(job.id);
  const promptDraft = job && promptDrafts[job.id];
  const reading = selection && !selection.image && !selection.error;
  const referenceError = job && referenceErrors[job.id];
  const restoring = !!job && !references[job.id] && !referenceError;
  const inputConflict = !!selection?.inputs && (activeProject?.inputRevision || 0) > (selection.inputRevision || 0);
  const blocked = inputConflict || !draftReady || !connected || !selectedModel || busy || savingMode || modelBusy || cliBusy || !!running || loadingProject || restoring;

  useEffect(() => {
    setCopied(false);
    return () => clearTimeout(copyTimer.current);
  }, [job?.id, lang, promptDraft]);

  useEffect(() => {
    let cancelled = false;
    let stopPolling = () => {};
    let previous: Selection | undefined;
    let initialized = false;
    let ownContext = false;
    let lastGlobalSelection: string | null | undefined;
    let quickRestored = workspace;
    let savedQuick: WorkspaceHandoff | undefined;
    const restoreDraft = (draft?: WorkspaceDraft, merge = false) => {
      if (!draft) return;
      setSubjectDrafts(merge ? value => ({ ...value, ...draft.subjectDrafts }) : draft.subjectDrafts || {});
      setMultiSubjectDrafts(merge ? value => ({ ...value, ...draft.multiSubjectDrafts }) : draft.multiSubjectDrafts || {});
      setPromptDrafts(merge ? value => ({ ...value, ...draft.promptDrafts }) : draft.promptDrafts || {});
      setInstructions(merge ? value => ({ ...value, ...draft.instructions }) : draft.instructions || {});
      setVersions(items => ({ ...items, ...draft.versions }));
      setLang(draft.lang || "zh");
    };
    const refresh = async () => {
      try {
        const revision = modeRevision.current;
        const visibility = visibilityRevision.current;
        const snapshotRevision = selectionRevision.current;
        const value = await readState(previous?.image ? previous.id : undefined, previous?.jobId);
        if (cancelled || snapshotRevision !== selectionRevision.current) return 1500;
        const firstRefresh = !initialized;
        const globalSelection = value.selection?.id || null;
        const selectionChanged = lastGlobalSelection !== undefined && globalSelection !== lastGlobalSelection;
        lastGlobalSelection = globalSelection;
        setPreferences((previous) => ({ ...value.preferences,
          mode: firstRefresh && !ownContext && revision === modeRevision.current && revision % 2 === 0
            ? savedQuick && savedQuick.selection?.projectId === value.selection?.projectId && savedQuick.selection?.id === value.selection?.id ? savedQuick.mode : value.preferences.mode
            : previous.mode,
          showHiddenProjects: visibility === visibilityRevision.current ? value.preferences.showHiddenProjects : previous.showHiddenProjects,
        }));
        if (firstRefresh && !ownContext) setSettings(!value.preferences.paired);
        initialized = true;
        setDraftReady(quickRestored);
        if (workspace && (ownContext || !firstRefresh)) return 1500;
        if (!workspace && ownContext) {
          if (!selectionChanged) return 1500;
          ownContext = false;
        }
        if (!deletingProjects.current && !value.selection && snapshotRevision === selectionRevision.current) {
          previous = undefined;
          setSelection(undefined);
          setProject(undefined);
        } else if (!deletingProjects.current && value.selection && snapshotRevision === selectionRevision.current) {
          const next = { ...value.selection,
            image: value.selection.image || (previous?.id === value.selection.id ? previous.image : undefined),
          };
          if (previous?.id !== next.id) { if (!firstRefresh) { setHistoryOpen(false); setGalleryOpen(false); } setError(""); }
          previous = next;
          setSelection(current => current?.projectId === next.projectId && current?.inputs && (next.inputRevision || 0) > (current.inputRevision || 0)
            ? current : current?.id === next.id ? { ...next, inputs: current.inputs } : next);
        }
      } catch (e) { if (!cancelled) setError((e as Error).message); }
      return 1500;
    };
    const navigateReminder = async (params: URLSearchParams) => {
      const revision = ++selectionRevision.current;
      setSettings(false); setNewProjectOpen(false);
      if (params.get("tasks") === "unread") { setTasksOpen(true); return; }
      const taskId = params.get("task");
      if (!taskId || !/^[\da-f-]{36}$/.test(taskId)) return;
      ownContext = true;
      try {
        const target = await query<Job>(`/jobs/${taskId}`);
        const reference = await request<Selection>({ type: "alchemy:project-reference", id: target.projectId });
        if (cancelled || revision !== selectionRevision.current) return;
        previous = reference; setSelection(reference);
        setInputRevisions(items => ({ ...items, [reference.projectId!]: reference.inputRevision || 0 }));
        setHistoryOpen(false); setGalleryOpen(false); setTasksOpen(false); setError("");
        setProjectMode(target.projectId, target.mode);
        setVersions(value => ({ ...value, [`${target.projectId}:${target.mode}`]: target.id }));
        const generationId = params.get("generation");
        const image = !!generationId && !!target.generations?.some(item => item.id === generationId);
        setTargetGeneration(image ? { jobId: target.id, id: generationId! } : undefined);
        setTargetPrompt(image ? undefined : { jobId: target.id, request: revision });
        dispatchDrawer({ type: "toggle", key: `${target.projectId}:${target.mode}:${target.id}`, open: image, seen: "" });
      } catch (error) { if (!cancelled && revision === selectionRevision.current) setError((error as Error).message); }
    };
    const navigateHandoff = async (params: URLSearchParams, merge = true) => {
      const id = params.get("handoff");
      const revision = ++selectionRevision.current;
      ownContext = true;
      try {
        const handoff = await request<WorkspaceHandoff | undefined>({ type: "alchemy:workspace-handoff", id });
        if (cancelled || revision !== selectionRevision.current) return;
        if (!handoff) throw new Error("接续草稿已失效，请从快捷面板重新打开工作台");

        setSettings(false); setNewProjectOpen(false); setHistoryOpen(false); setGalleryOpen(false); setTasksOpen(false); setError("");
        setProjectMode(handoff.selection?.projectId, handoff.mode);
        if (handoff.selection) {
          const source = handoff.selection;
          previous = source;
          setSelection(source);
          if (source.projectId) {
            try {
              const reference = await request<Selection>({ type: "alchemy:project-reference", id: source.projectId });
              if (cancelled || revision !== selectionRevision.current) return;
              const stale = (source.inputRevision || 0) !== (reference.inputRevision || 0);
              if (!stale) {
                restoreDraft(handoff.draft, merge);
                setInputRevisions(items => ({ ...items, [source.projectId!]: reference.inputRevision || 0 }));
              } else {
                setInputRevisions(items => ({ ...items, [source.projectId!]: -1 }));
                setError("项目输入已更新，已打开最新输入；旧窗口草稿未覆盖当前项目。");
              }
              previous = { ...reference, inputs: stale ? undefined : reference.inputs };
              setSelection(previous);
            } catch (error) {
              if (cancelled || revision !== selectionRevision.current) return;
              setSelection({ ...source, error: (error as Error).message });
            }
          } else setSelection({ ...source, error: "参考图尚未保存，请重新上传" });
        } else { previous = undefined; setSelection(undefined); setProject(undefined); }
        if (params.get("view") === "settings") setSettings(true);
        if (params.get("view") === "tasks") setTasksOpen(true);
      } catch (e) { if (!cancelled && revision === selectionRevision.current) setError((e as Error).message); }
    };
    const onReminderNavigation = () => {
      if (!workspace || !/^#(?:reminder|workspace)=/.test(location.hash)) return;
      const params = new URLSearchParams(location.hash.slice(location.hash.indexOf("=") + 1));
      history.replaceState(null, "", location.pathname + location.search);
      void (params.has("handoff") ? navigateHandoff(params) : navigateReminder(params));
    };
    const initialize = async () => {
      let views: Record<string, { mode: Mode; versions: Record<string, string>; inputRevision?: number }> = {};
      try {
        views = await request<typeof views>({ type: "alchemy:project-views" }) || {};
        if (cancelled) return;
        setProjectModes(Object.fromEntries(Object.entries(views || {}).map(([id, view]) => [id, view.mode])));
        setInputRevisions(Object.fromEntries(Object.entries(views || {}).map(([id, view]) => [id, view.inputRevision || 0])));
        setVersions(Object.fromEntries(Object.entries(views || {}).flatMap(([id, view]) =>
          Object.entries(view.versions).map(([mode, version]) => [`${id}:${mode}`, version]))));
        setViewsReady(true);
      } catch (error) { if (!cancelled) setError(`项目选择恢复失败：${(error as Error).message}`); }
      const params = new URLSearchParams(location.search);
      if (workspace && (params.has("task") || params.get("tasks") === "unread")) {
        await navigateReminder(params);
        for (const key of ["task", "tasks", "generation"]) params.delete(key);
        history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash);
      }
      if (workspace && params.has("handoff")) {
        await navigateHandoff(params, false);
        for (const key of ["handoff", "view"]) params.delete(key);
        history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash);
      }
      if (!workspace) {
        try {
          savedQuick = await request<WorkspaceHandoff | undefined>({ type: "alchemy:quick-draft" });
          if (cancelled) return;
          const projectId = savedQuick?.selection?.projectId;
          const current = projectId ? await request<Selection>({ type: "alchemy:project-reference", id: projectId }) : undefined;
          if (cancelled) return;
          const stale = !!projectId && (savedQuick?.selection?.inputRevision || 0) !== (current?.inputRevision || 0);
          if (projectId && !stale) setInputRevisions(items => ({ ...items, [projectId]: current?.inputRevision || 0 }));
          const keepInput = ([key]: [string, unknown]) => !stale || !key.startsWith(`${projectId}:`);
          restoreDraft(savedQuick?.draft && { ...savedQuick.draft,
            instructions: Object.fromEntries(Object.entries(savedQuick.draft.instructions || {}).filter(keepInput)),
            subjectDrafts: Object.fromEntries(Object.entries(savedQuick.draft.subjectDrafts || {}).filter(keepInput)),
            multiSubjectDrafts: Object.fromEntries(Object.entries(savedQuick.draft.multiSubjectDrafts || {}).filter(keepInput)),
            versions: Object.fromEntries(Object.entries(savedQuick.draft.versions || {}).filter(([key]) =>
              keepInput([key, undefined]) && !views[key.slice(0, key.indexOf(":"))])),
          });
          if (savedQuick && !views[savedQuick.selection?.projectId || ""]) setProjectMode(savedQuick.selection?.projectId, savedQuick.mode);
          quickRestored = true;
        } catch (error) {
          if (!cancelled) setDraftError(`草稿恢复失败：${(error as Error).message}`);
          quickRestored = true;
        }
      }
      if (!cancelled) {
        noticeNavigation.current = navigateReminder;
        stopPolling = pollWhileVisible(refresh);
        if (workspace) { window.addEventListener("hashchange", onReminderNavigation); onReminderNavigation(); }
      }
    };
    void initialize();
    return () => { cancelled = true; noticeNavigation.current = undefined; stopPolling(); window.removeEventListener("hashchange", onReminderNavigation); };
  }, []);

  // Older extension selections join the same durable template project on first open.
  useEffect(() => {
    if (!preferences.paired || !selection?.image || selection.projectId) return;
    let cancelled = false;
    void request<Selection>({ type: "alchemy:ensure-project", id: selection.id }).then(
      (next) => { if (!cancelled) { selectionRevision.current++; setSelection(next); } },
      (e) => { if (!cancelled) setError(e.message); },
    );
    return () => { cancelled = true; };
  }, [preferences.paired, selection?.id, !!selection?.image, selection?.projectId]);

  useEffect(() => {
    if (!preferences.paired) return;
    let cancelled = false;
    let fetchedRevision: string | undefined;
    const stop = pollWhileVisible(async () => {
      const revision = projectRevision.current;
      let delay = 10_000;
      try {
        const health = await query<{ ready: boolean; skill: string; active: number; visibleActive?: number; hiddenProjectIds?: string[]; projectsRevision?: string; modelBusy?: boolean; cliBusy?: boolean; model?: string }>("/health");
        if (cancelled) return delay;
        setConnected(health.ready);
        setServiceBusy(health.active > 0);
        if (revision === projectRevision.current) {
          setActiveCount(health.visibleActive ?? health.active);
          setHiddenProjectIds(health.hiddenProjectIds || []);
        }
        setCliBusy(!!health.cliBusy);
        setModelBusy(!!health.modelBusy);
        setSelectedModel(health.model || null);
        setConnectionText(health.ready ? `已连接 · ${health.skill}` : "未找到图片逆向技能");
        delay = health.active || health.modelBusy || health.cliBusy ? 2000 : 10_000;
        // An older bridge must report an upgrade need instead of silently showing an empty library.
        const nextRevision = health.projectsRevision || "legacy";
        if (!deletingProjects.current) setDataRevision(nextRevision);
        if (selection?.projectId && !deletingProjects.current && (nextRevision !== fetchedRevision || nextRevision === "legacy")) {
          const saved = projectSnapshot.current;
          const value = await request<Project | { unchanged: true; revision: string }>({ type: "alchemy:project", id: selection.projectId,
            revision: saved?.id === selection.projectId ? saved.revision : undefined });
          if (!cancelled && revision === projectRevision.current) {
            if (!("unchanged" in value)) setProject(value);
            fetchedRevision = nextRevision;
          }
        }
      } catch (e) {
        if (!cancelled && revision === projectRevision.current) { setConnected(false); setConnectionText((e as Error).message); }
      }
      return delay;
    });
    return () => { cancelled = true; stop(); };
  }, [preferences.paired, selection?.projectId, refreshNonce, showHidden]);

  useEffect(() => {
    if (!job || references[job.id] || referenceErrors[job.id]) return;
    let cancelled = false;
    void request<Selection>({ type: "alchemy:reference", id: job.id }).then(
      (value) => { if (!cancelled) setReferences((items) => ({ ...items, [job.id]: value })); },
      (e) => { if (!cancelled) setReferenceErrors((items) => ({ ...items, [job.id]: e.message })); },
    );
    return () => { cancelled = true; };
  }, [job?.id, referenceError]);

  useEffect(() => {
    if (!activeProject || !viewsReady) return;
    const id = activeProject.id, revision = activeProject.inputRevision || 0;
    if (revision <= (inputRevisions[id] ?? 0) && selection?.inputs !== undefined) return;
    if (inputConflict) { setError("项目输入已在其他窗口更新，请重新打开项目后继续。"); return; }
    let cancelled = false;
    const snapshot = selectionRevision.current;
    void request<Selection>({ type: "alchemy:project-reference", id }).then(next => {
      if (cancelled || snapshot !== selectionRevision.current) return;
      if ((next.inputRevision || 0) > (inputRevisions[id] ?? 0)) {
        setVersions(items => ({ ...items, ...Object.fromEntries(Object.entries(next.inputVersions || {}).map(([mode, version]) => [`${id}:${mode}`, version])) }));
        // A newer durable input supersedes only working drafts, never historical snapshots.
        setSubjectDrafts(items => Object.fromEntries(Object.entries(items).filter(([key]) => !key.startsWith(`${id}:`))));
        setMultiSubjectDrafts(items => Object.fromEntries(Object.entries(items).filter(([key]) => !key.startsWith(`${id}:`))));
        setInstructions(items => Object.fromEntries(Object.entries(items).filter(([key]) => !key.startsWith(`${id}:`))));
      }
      setInputRevisions(items => ({ ...items, [id]: next.inputRevision || 0 }));
      setSelection({ ...next, inputs: next.inputs || {} });
    }).catch(error => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [activeProject?.id, activeProject?.inputRevision, viewsReady, selection?.id, inputReload]);

  const projectView = JSON.stringify({ mode: preferences.mode, inputRevision: inputRevisions[selection?.projectId || ""] || 0, versions: Object.fromEntries(
    Object.entries(versions).filter(([key]) => key.startsWith(`${selection?.projectId}:`))
      .map(([key, value]) => [key.slice(key.indexOf(":") + 1), value]),
  ) });
  useEffect(() => {
    if (!viewsReady || !draftReady || !selection?.projectId || !activeProject) return;
    void request({ type: "alchemy:save-project-view", projectId: selection.projectId, view: JSON.parse(projectView) })
      .catch(error => setError(`项目选择暂未保存：${error.message}`));
  }, [viewsReady, draftReady, selection?.projectId, activeProject?.id, projectView]);

  const draftSnapshot = (): WorkspaceDraft => ({
    multiSubjectDrafts, subjectDrafts, instructions, promptDrafts, lang,
    versions: activeProject ? { ...versions, [subjectKey(preferences.mode)]: job?.id || "new" } : versions,
  });
  const workspaceContext = () => ({ mode: preferences.mode, selection: selection ? {
    id: selection.id, projectId: selection.projectId, sourceUrl: selection.sourceUrl, capture: selection.capture, inputRevision: selection.inputRevision,
  } : null });
  useEffect(() => {
    if (workspace || !draftReady) return;
    let cancelled = false;
    void request({ type: "alchemy:quick-draft", context: workspaceContext(), draft: draftSnapshot() }).then(
      () => { if (!cancelled) setDraftError(""); },
      error => { if (!cancelled) setDraftError(`草稿暂未保存：${error.message}`); },
    );
    return () => { cancelled = true; };
  }, [workspace, draftReady, multiSubjectDrafts, subjectDrafts, instructions, promptDrafts, lang, versions, job?.id, activeProject?.id, selection?.id, selection?.projectId, preferences.mode]);

  const openWorkspace = async (view?: "tasks" | "settings") => {
    if (handoffPending.current) return;
    if (busy || savingMode || subjectUnavailable[subjectKey(preferences.mode)] || reading || (connected && loadingProject)) {
      setError("正在处理当前输入，请完成后再打开工作台"); return;
    }
    handoffPending.current = true;
    setBusy(true); setError("");
    try {
      const prefix = `${selection?.projectId || selection?.id}:`;
      const forProject = <T,>(items: Record<string, T>) => Object.fromEntries(Object.entries(items).filter(([key]) => key.startsWith(prefix)));
      const draft = draftSnapshot();
      await request({ type: "alchemy:open-workspace", view, context: workspaceContext(), draft: {
        multiSubjectDrafts: forProject(multiSubjectDrafts), subjectDrafts: forProject(subjectDrafts), instructions: forProject(instructions), versions: forProject(draft.versions || {}), lang,
        promptDrafts: Object.fromEntries(Object.entries(promptDrafts).filter(([id]) => activeProject?.jobs.some(job => job.id === id))),
      } });
    } catch (e) { setError((e as Error).message); }
    finally { handoffPending.current = false; setBusy(false); }
  };
  const uploadReference = async (file?: File, create = true) => {
    if (!file || busy) return;
    const context = referenceContext.current, revision = selectionRevision.current;
    setBusy(true); setError("");
    try {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 20 * 1024 * 1024)
        throw new Error("请上传不超过 20 MB 的 PNG、JPEG 或 WebP 图片");
      const image = await normalizeImage(file, 4 * 1024 * 1024);
      if (context !== referenceContext.current || revision !== selectionRevision.current) return;
      if (!create && selection?.projectId) {
        // Normalization finishes before the input transaction acquires its busy state.
        setBusy(false);
        await applyReferenceUpload(image, preferences.mode, taskInstruction(preferences.mode));
        return;
      }
      const next = await request<Selection>({ type: "alchemy:upload-reference", image });
      if (context !== referenceContext.current || revision !== selectionRevision.current) throw new Error("当前输入已切换，请重新选择图片");
      if (!workspace && next.projectId && selection) {
        const key = `${next.projectId}:${preferences.mode}`;
        setVersions(items => ({ ...items, [key]: "new" }));
        setInstructions(items => ({ ...items, [`${key}:new`]: taskInstruction(preferences.mode) }));
        if (preferences.mode !== "recreate") setSubjectDrafts(items => ({ ...items, [`${key}:new`]: subjectImage(preferences.mode) }));
      }
      selectionRevision.current++;
      setProjectMode(next.projectId, preferences.mode);
      setSelection(next); setHistoryOpen(false); setGalleryOpen(false); setNewProjectOpen(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const saveInput = async (mode: Mode, image: string | undefined, instruction: string,
    subject: string = subjectImage(mode), subjects: MultiSubject[] = multiSubjects) => {
    if (blocked || inputSaving.current || !selection?.projectId) throw new Error("当前无法修改图片，请稍后重试");
    const revision = selectionRevision.current, context = referenceContext.current, id = selection.projectId;
    inputSaving.current = true; setBusy(true);
    try {
      const next = await request<Selection>({ type: "alchemy:update-project-input", projectId: id,
        expectedRevision: selection.inputRevision || 0, referenceJobId: modeJob(mode)?.id, image, mode, instruction,
        ...(mode === "multi-reenact" ? { subjects } : mode !== "recreate" ? { subjectImage: subject } : {}),
      });
      if (revision !== selectionRevision.current || context !== referenceContext.current) return;
      selectionRevision.current++;
      setInputRevisions(items => ({ ...items, [id]: next.inputRevision || 0 }));
      setVersions(items => ({ ...items, ...Object.fromEntries(Object.entries(next.inputVersions || {}).map(([lane, version]) => [`${id}:${lane}`, version])) }));
      const key = `${id}:${mode}:${next.inputVersions?.[mode] || "new"}`;
      // Persisted images are restored from the project, not duplicated in session storage.
      setMultiSubjectDrafts(items => Object.fromEntries(Object.entries(items).filter(([name]) => name !== key)));
      setSubjectDrafts(items => Object.fromEntries(Object.entries(items).filter(([name]) => name !== key)));
      setInstructions(items => Object.fromEntries(Object.entries(items).filter(([name]) => name !== key)));
      setSelection(next); setError(""); setRefreshNonce(value => value + 1);
      setHistoryOpen(false); setGalleryOpen(false);
    } catch (error) {
      if (revision === selectionRevision.current) setError((error as Error).message);
      throw error;
    } finally { inputSaving.current = false; setBusy(false); }
  };
  const applyReferenceUpload = (image: string, mode: Mode, instruction = taskInstruction(mode)) => saveInput(mode, image, instruction);
  const applyReferenceRotation = async (image: string, mode: Mode, instruction?: string) => {
    if (!displayImage) throw new Error("当前无法修改图片，请稍后重试");
    await applyReferenceUpload(image, mode, instruction);
  };
  const changeSubject = (image: string) => saveInput(preferences.mode, displayImage, taskInstruction(preferences.mode), image);
  const changeSubjects = (subjects: MultiSubject[]) => saveInput("multi-reenact", displayImage, multiPrompt, "", subjects);
  const swapImages = async (mode: "style" | "reenact" | "multi-reenact", instruction: string, subjectId?: string) => {
    const image = mode === "multi-reenact" ? multiSubjects.find(item => item.id === subjectId)?.subjectImage : subjectImage(mode);
    if (blocked || !displayImage || !image) return;
    const revision = selectionRevision.current, context = referenceContext.current;
    try {
      const blob = await (await fetch(displayImage)).blob();
      const subject = blob.size <= 2 * 1024 * 1024 ? displayImage : await normalizeImage(blob, 2 * 1024 * 1024);
      if (revision !== selectionRevision.current || context !== referenceContext.current) return;
      await saveInput(mode, image, instruction, subject, multiSubjects.map(item => item.id === subjectId
        ? { ...item, subjectImage: subject, role: "自动", detail: "" } : item));
      if (mode === "multi-reenact") setSwappedSubjectId(subjectId!);
    } catch (e) { if (revision === selectionRevision.current) setError((e as Error).message || "无法互换图片，请重试"); }
  };
  const updateJob = (updated: Job) => {
    projectRevision.current++;
    setRefreshNonce(value => value + 1);
    setProject((current) => current && current.id === updated.projectId
      ? { ...current, jobs: [updated, ...current.jobs.filter((item) => item.id !== updated.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
      : current);
  };
  const saveMode = async (mode: Mode) => {
    if (savingMode || busy || !draftReady) return;
    setCopied(false); setError("");
    setProjectMode(selection?.projectId, mode);
  };
  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      const health = await request<{ ready: boolean; skill: string }>({ type: "alchemy:connect", token: tokenDraft.trim() });
      setPreferences({ ...preferences, paired: true });
      setTokenDraft("");
      setConnected(true);
      setConnectionText(`已连接 · ${health.skill}`);
      setSettings(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = async (mode: Mode = preferences.mode, reenact?: SubjectInput) => {
    if (!selection || !displayImage || !activeProject || blocked) return;
    const revision = selectionRevision.current;
    setBusy(true);
    setError("");
    try {
      const value = await request<{ selection: Selection; currentSelection: Selection; job: Job }>({
        type: "alchemy:start", id: selection.id, projectId: activeProject.id, mode, reenact, instruction: taskInstruction(mode),
        inputRevision: selection.inputRevision || 0, referenceJobId: modeJob(mode)?.id,
      });
      setReferences(items => ({ ...items, [value.job.id]: value.selection }));
      updateJob(value.job);
      if (revision !== selectionRevision.current) return;
      selectionRevision.current++;
      setSelection((current) => current?.id === selection.id ? value.currentSelection : current);
      setInputRevisions(items => ({ ...items, [activeProject.id]: value.currentSelection.inputRevision || 0 }));
      setVersions((items) => ({ ...items, [`${activeProject.id}:${mode}`]: value.job.id }));
      setCopied(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const showHistory = () => {
    setGalleryOpen(false);
    setHistoryOpen(value => !value);
    setError("");
  };
  const openProject = async (item: ProjectSummary) => {
    const revision = ++selectionRevision.current;
    setBusy(true);
    setError("");
    try {
      const next = await request<Selection>({ type: "alchemy:open-project", id: item.id });
      if (revision !== selectionRevision.current) return;
      // Reopening is the explicit recovery path for a stale window.
      setSelection({ ...next, inputs: undefined });
      setInputReload(value => value + 1);
      setHistoryOpen(false); setGalleryOpen(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const deleteProjects = async (ids: string[]) => {
    setBusy(true);
    setError("");
    selectionRevision.current++;
    projectRevision.current++;
    deletingProjects.current = true;
    try {
      const { deletedIds } = await request<{ deletedIds: string[] }>({ type: "alchemy:delete-projects", ids });
      const removedJobs = activeProject && deletedIds.includes(activeProject.id) ? activeProject.jobs.map((job) => job.id) : [];
      library.refresh();
      setRefreshNonce(value => value + 1);
      if (selection?.projectId && deletedIds.includes(selection.projectId)) { setSelection(undefined); setProject(undefined); }
      setProjectModes(items => Object.fromEntries(Object.entries(items).filter(([id]) => !deletedIds.includes(id))));
      setVersions((items) => Object.fromEntries(Object.entries(items).filter(([key]) => !deletedIds.some((id) => key.startsWith(`${id}:`)))));
      setPromptDrafts((items) => Object.fromEntries(Object.entries(items).filter(([id]) => !removedJobs.includes(id))));
      setMultiSubjectDrafts((items) => Object.fromEntries(Object.entries(items).filter(([key]) => !deletedIds.some((id) => key.startsWith(`${id}:`)))));
      setSubjectDrafts((items) => Object.fromEntries(Object.entries(items).filter(([key]) => !deletedIds.some((id) => key.startsWith(`${id}:`)))));
      setReferences((items) => Object.fromEntries(Object.entries(items).filter(([id, value]) => !removedJobs.includes(id) && !deletedIds.includes(value.projectId || ""))));
      setReferenceErrors((items) => Object.fromEntries(Object.entries(items).filter(([id]) => !removedJobs.includes(id))));
    } finally { deletingProjects.current = false; selectionRevision.current++; projectRevision.current++; setBusy(false); }
  };
  const setProjectsHidden = async (ids: string[], hidden: boolean, undo = false) => {
    if (visibilityPending.current) return [];
    const changed = [...new Set(ids)].filter(id => hiddenProjectIds.includes(id) !== hidden);
    if (!changed.length) {
      if (undo) { setVisibilityNotice(undefined); setVisibilityError("项目状态已恢复，无需撤销。"); }
      return [];
    }
    visibilityPending.current = true;
    const focus = document.activeElement;
    const keyboardFocus = focus?.matches(":focus-visible");
    setBusy(true); setVisibilityError("");
    const revision = ++selectionRevision.current;
    projectRevision.current++;
    deletingProjects.current = true;
    try {
      const response = await request<{ updatedIds: string[] }>({ type: "alchemy:set-project-hidden", ids: changed, hidden });
      const updatedIds = [...new Set(response.updatedIds)].filter(id => changed.includes(id));
      setHiddenProjectIds(previous => hidden ? [...new Set([...previous, ...updatedIds])] : previous.filter(id => !updatedIds.includes(id)));
      setProject(current => current && updatedIds.includes(current.id) ? { ...current, hidden } : current);
      if (hidden && !showHidden && selection?.projectId && updatedIds.includes(selection.projectId) && revision === selectionRevision.current) {
        setSelection(undefined); setProject(undefined); setHistoryOpen(true);
      }
      if (updatedIds.length) {
        const remaining = changed.filter(id => !updatedIds.includes(id));
        setVisibilityNotice(undo && remaining.length ? { ids: remaining, hidden: !hidden, undone: false } : { ids: updatedIds, hidden, undone: undo });
        if (undo && remaining.length) setVisibilityError(`还有 ${remaining.length} 个项目未撤销，请重试。`);
        requestAnimationFrame(() => { if (keyboardFocus && focus && (!focus.isConnected || focus.matches(":disabled"))) visibilityFeedback.current?.focus(); });
      }
      library.refresh();
      setRefreshNonce(value => value + 1);
      if (!updatedIds.length) {
        setVisibilityNotice(undefined);
        throw new Error("项目状态未变化，请刷新后重试。");
      }
      return updatedIds;
    } finally {
      visibilityPending.current = false; deletingProjects.current = false;
      selectionRevision.current++; projectRevision.current++; setBusy(false);
    }
  };
  const toggleHiddenProjects = async () => {
    if (visibilityPending.current) return;
    visibilityPending.current = true;
    setBusy(true); setVisibilityError("");
    visibilityRevision.current++;
    projectRevision.current++;
    const revision = selectionRevision.current;
    try {
      const shown = await request<boolean>({ type: "alchemy:show-hidden-projects", show: !showHidden });
      visibilityRevision.current++;
      setPreferences(previous => ({ ...previous, showHiddenProjects: shown }));
      if (!shown && revision === selectionRevision.current && (project?.hidden || (selection?.projectId && hiddenProjectIds.includes(selection.projectId)))) {
        selectionRevision.current++; setSelection(undefined); setProject(undefined); setHistoryOpen(true);
      }
    } catch (e) { setVisibilityError((e as Error).message); }
    finally { visibilityPending.current = false; setBusy(false); }
  };
  const cancel = async () => {
    if (!job || !running || pendingCancellations.current.has(job.id)) return;
    pendingCancellations.current.add(job.id);
    setCancellingJobs([...pendingCancellations.current]);
    setError("");
    try { updateJob(await request<Job>({ type: "alchemy:cancel", id: job.id })); }
    catch (e) { setError((e as Error).message); }
    finally {
      pendingCancellations.current.delete(job.id);
      setCancellingJobs([...pendingCancellations.current]);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        lang === "zh" ? (promptDraft || result)!.promptZh : (promptDraft || result)!.promptEn,
      );
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("复制失败，请选中提示词手动复制");
    }
  };
  const discardPrompt = (id: string) => setPromptDrafts((items) => {
    const next = { ...items };
    delete next[id];
    return next;
  });
  const savePrompt = async () => {
    if (!job || !promptDraft || savingPrompt) return;
    setSavingPrompt(job.id);
    setError("");
    try {
      updateJob(await request<Job>({ type: "alchemy:save-prompt", id: job.id, ...promptDraft }));
      discardPrompt(job.id);
    } catch (e) { setError((e as Error).message); }
    finally { setSavingPrompt(""); }
  };
  const exportResult = () => {
    if (!job?.result) return;
    const r = job.result;
    const inputs = job.mode === "multi-reenact" ? `\n使用方法：依次附图 1–${job.reenact?.subjects?.length || 0}（主体图），最后附参考模板，再使用下方提示词。此 Markdown 不包含图片文件。\n` : job.reenact ? "\n使用方法：生成图片时，先附图 1（用户主体图），再附图 2（原始参考图），然后使用下方提示词。此 Markdown 不包含图片文件。\n" : "";
    const markdown = `# ${r.title}\n\n来源：${job.sourceUrl || "网页图片"}\n模式：${modeName(job.mode)}\n${inputs}\n## 视觉观察\n${r.observations.map((x) => `- ${x}`).join("\n")}\n\n## 中文提示词\n${r.promptZh}\n\n## English prompt\n${r.promptEn}\n\n## 排除项\n${r.negativePrompt || "无"}\n\n## 不确定性\n${r.uncertainties.join("\n") || "无额外说明"}\n`;
    const url = URL.createObjectURL(
      new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `qc-reframe-${job.id.slice(0, 8)}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const reverseStatus = reading ? selection?.stage || "正在读取图片…" : running ? `${job?.stage || "正在逆向提示词…"} · 完成后会提醒你`
    : restoring ? "正在恢复原图…" : loadingProject ? "正在读取模板项目…" : cliBusy ? "Codex 正在升级…"
    : modelBusy ? "正在验证模型…" : busy ? "正在提交…" : undefined;

  const instructionStale = !!result && taskInstruction(preferences.mode).trim() !== (job?.instruction ?? job?.reenact?.basePrompt ?? defaultInstructions[preferences.mode]).trim();
  const genericPrompt = !!result && preferences.mode === "style" && !job?.reenact;
  const needsPrompt = !result || instructionStale || (preferences.mode === "multi-reenact" && multiStale) || genericPrompt;
  const genericHint = genericPrompt && !subjectImage("style") ? "添加主体图后可生成专属提示词" : "";
  const reverseHint = !selection ? "先选择一张参考图。" : referenceError ? "历史参考图不可用，请重新上传参考图。" : !displayImage ? "等待参考图读取完成。"
    : subjectUnavailable[subjectKey(preferences.mode)] ? "主体图尚未就绪，请完成上传。"
    : preferences.mode === "reenact" && !subjectImage("reenact") ? "先上传主体图。"
    : preferences.mode === "multi-reenact" && (multiSubjects.length < 2 || multiSubjects.some(item => !item.subjectImage)) ? "请添加至少 2 张可用的主体图。"
    : !taskInstruction(preferences.mode).trim() ? "填写任务指令后可生成提示词。"
    : "";
  const reverseDisabled = blocked || !!reverseHint || !!promptDraft;
  const reverse = () => {
    if (reverseDisabled) return;
    const mode = preferences.mode;
    void start(mode, mode === "multi-reenact" ? { subjects: multiSubjects, basePrompt: multiPrompt }
      : mode !== "recreate" && subjectImage(mode) ? { subjectImage: subjectImage(mode), basePrompt: taskInstruction(mode) } : undefined);
  };
  const extractStyle = () => {
    if (blocked || !selection?.image || promptDraft || !taskInstruction("style").trim()) return;
    const image = subjectImage("style");
    if (image) setSubjectDrafts(items => ({ ...items, [subjectDraftKey("style")]: image }));
    void start("style");
  };


  const versionSelector = modeJobs(preferences.mode).length > 0 && <SelectField className="version-select" label="" aria-label="提示词版本" value={job?.id || "new"} disabled={busy}
              onChange={(e) => { setCopied(false); setVersions((items) => ({ ...items, [`${activeProject!.id}:${preferences.mode}`]: e.target.value })); }}>
              <option value="new">当前输入</option>
              {modeJobs(preferences.mode).map((item, i, items) => <option key={item.id} value={item.id}>{`版本 ${items.length - i}${i === 0 ? " · 最新" : ""}`}</option>)}
            </SelectField>;
  const multiPreview = preferences.mode === "multi-reenact" ? <MultiInputPreview image={displayImage} subjects={multiSubjects} /> : undefined;
  const drawer = resultDrawerView(drawers, drawerKey, activeJob?.generations);
  const drawerOpen = workspace && !historyOpen && !galleryOpen && drawer.open;
  const closeResults = () => {
    dispatchDrawer({ type: "toggle", key: drawerKey, open: false, seen: drawer.completed });
    requestAnimationFrame(() => resultReturn.current?.focus({ preventScroll: true }));
  };
  useEffect(() => {
    const media = matchMedia("(max-width: 650px)");
    const sidebarMedia = matchMedia("(max-width: 860px)");
    const update = () => { setNarrow(media.matches); setSmallSidebar(sidebarMedia.matches); };
    media.addEventListener("change", update);
    sidebarMedia.addEventListener("change", update);
    return () => { media.removeEventListener("change", update); sidebarMedia.removeEventListener("change", update); };
  }, []);
  useEffect(() => {
    const closed = wasDrawerOpen.current && !drawerOpen;
    wasDrawerOpen.current = drawerOpen;
    if (!workspace || !closed || !(resultPane?.contains(document.activeElement) || document.activeElement === document.body)) return;
    (resultReturn.current || editor.current?.querySelector<HTMLButtonElement>(".generate-button"))?.focus({ preventScroll: true });
  }, [workspace, drawerOpen, resultPane]);
  useEffect(() => {
    if (!workspace || !narrow || !drawerOpen) return;
    if (editor.current?.contains(document.activeElement) || document.activeElement === document.body) resultReturn.current?.focus({ preventScroll: true });
  }, [workspace, narrow, drawerOpen, resultPane]);
  const generationPanel = activeJob?.result ? <GenerationPanel key={activeJob.id} onTargetSelected={() => setTargetGeneration(undefined)} targetGeneration={targetGeneration?.jobId === activeJob.id ? targetGeneration.id : undefined} job={activeJob} lang={lang} workspace={workspace}
                  drawerOpen={drawerOpen} requestError={drawer.error} requestPending={drawer.pending}
                  onRequestState={(pending, error) => dispatchDrawer({ type: pending ? "request" : "settled", key: drawerKey, error })} versionNumber={modeJobs(preferences.mode).length - modeJobs(preferences.mode).findIndex(item => item.id === activeJob.id)} actionsTarget={generationActions} disabled={blocked || !!subjectUnavailable[subjectKey(preferences.mode)] || !!promptDraft || (workspace && needsPrompt) || (activeJob.mode === "multi-reenact" && multiStale)}
                  subjectImage={activeJob.mode === "recreate" ? undefined : subjectImage(activeJob.mode)}
                  inputPreview={multiPreview}
                  subjects={activeJob.mode === "multi-reenact" ? multiSubjects : undefined}
                  onUpdate={(updated, image, subjects) => {
                    if (subjects) setReferences(items => items[updated.id] ? { ...items, [updated.id]: { ...items[updated.id]!, generationSubjects: subjects } } : items);
                    updateJob(updated);
                    if (image) setReferences((items) => {
                      const saved = items[updated.id];
                      return saved ? { ...items, [updated.id]: { ...saved, generationSubjectImage: image } } : items;
                    });
                  }} /> : null;

  return (
    <div ref={reminderRoot} className={`${workspace ? "app workspace-app" : "app"}${preferences.mode === "multi-reenact" ? " multi-mode" : ""}`} data-motion={reduced ? "reduce" : "full"} data-motion-input="keyboard" data-sidebar-collapsed={sidebarCollapsed}
      onPointerDownCapture={event => { event.currentTarget.dataset.motionInput = "pointer"; }}
      onKeyDownCapture={event => { event.currentTarget.dataset.motionInput = "keyboard"; }}
      onClickCapture={event => { if (!event.detail) event.currentTarget.dataset.motionInput = "keyboard"; }}
      onKeyDown={event => {
        if (event.key === "Escape" && drawerOpen && !event.defaultPrevented && !(event.target as Element).closest('dialog, .canvas-workspace[data-prompt-open="true"]')) { event.stopPropagation(); closeResults(); }
      }}>
      {reminders.toast.length > 0 && <ReminderToast container={reminderRoot.current?.querySelector("dialog[open]") || reminderRoot.current} notices={reminders.toast} onClose={reminders.dismiss} onOpen={openNotice} />}
      {!workspace && reminders.unread.length > 0 && <button className="text-button" onClick={() => openNotice(reminders.unread.length === 1 ? reminders.unread[0] : undefined)}><span className="reminder-dot" data-failed={reminders.unread.some(item => item.status === "failed")} />{reminders.unread.length} 项结果未查看</button>}
      {workspace && <aside id="workspace-sidebar" className="sidebar" aria-label="工作台导航">
        <div className="logo-row"><img src={logo} alt="QC-Reframe" /><div><strong>QC-Reframe</strong></div><button className="quiet-button sidebar-toggle" aria-label={sidebarCollapsed ? "展开项目栏" : "收起项目栏"} title={sidebarCollapsed ? "展开项目栏" : "收起项目栏"} aria-expanded={!sidebarCollapsed} aria-controls="workspace-sidebar" onClick={() => setSidebarExpanded(sidebarCollapsed)}><Icon name="sidebar" /></button></div>
        <button className="new-project" aria-label="新建项目" disabled={busy || !connected} onClick={() => { setError(""); setNewProjectOpen(true); }}><Icon name="plus" /><span>新建项目</span></button>
        <input ref={referenceInput} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传参考图新建项目" onChange={(e) => { void uploadReference(e.target.files?.[0]); e.target.value = ""; }} />
        <button className={`nav-action ${galleryOpen ? "active" : ""}`} aria-label="作品画廊" onClick={() => { setGalleryOpen(true); setHistoryOpen(false); setError(""); }}><Icon name="image" /><span>作品画廊</span></button>
        <button className={`nav-action ${historyOpen ? "active" : ""}`} aria-label="全部项目" disabled={busy || !connected} onClick={showHistory}><Icon name="grid" /><span>全部项目</span><span className="count">{library.recent.total}</span></button>
        <button className="nav-action" aria-label="任务中心" disabled={!connected} onClick={() => setTasksOpen(true)}><Icon name="clock" /><span>任务中心</span>{reminders.unread.length > 0 && <span className="reminder-dot" data-failed={reminders.unread.some(item => item.status === "failed")} role="img" aria-label={`${reminders.unread.length} 项结果未查看`} />}{activeCount > 0 && <span className="count">{activeCount}</span>}</button>
        <div className="sidebar-label">最近项目</div>
        <div className="project-nav">{recentProjects.map(item => <RecentProject key={item.id} project={item} currentMode={preferences.mode} active={!historyOpen && !galleryOpen && activeProject?.id === item.id} disabled={busy} onOpen={() => void openProject(item)} />)}</div>
        <div className="sidebar-bottom"><button className="nav-action" aria-label="设置中心" onClick={() => setSettings(true)}><Icon name="settings" /><span>设置中心</span></button><div className="connection-state"><i className={`online-dot ${connected ? "" : "offline"}`} />{connected ? "Codex 已连接" : "本机未连接"}</div></div>
      </aside>}
      <div className={workspace ? "workspace-main" : "compact-main"}>
      {workspace && !galleryOpen && <header className="workspace-head"><div><h1>{historyOpen ? "全部项目" : activeProject?.title || "新项目"}</h1></div><div className="head-actions">
        {historyOpen && <div ref={setProjectSearchTarget} />}
        {!historyOpen && drawer.content && <button ref={narrow ? undefined : resultReturn} className="outline-button result-return" aria-controls="workspace-results" aria-expanded={drawerOpen} aria-label={drawerOpen ? "收起生成结果" : drawer.label} onClick={drawerOpen ? closeResults : () => dispatchDrawer({ type: "toggle", key: drawerKey, open: true, seen: drawer.completed })}><Icon name="image" />{drawerOpen ? "收起结果" : drawer.label}</button>}
        {historyOpen ? <HiddenProjectsToggle shown={showHidden} disabled={busy || !connected} onToggle={() => void toggleHiddenProjects()} /> : activeProject && <button type="button" className="text-button project-visibility-action" disabled={busy || !connected}
          onClick={() => void setProjectsHidden([activeProject.id], !activeProject.hidden).catch(error => setVisibilityError(error.message))}>{activeProject.hidden ? "恢复项目" : "隐藏项目"}</button>}
      </div></header>}
      {workspace && !historyOpen && !galleryOpen && drawer.content && <div className="workspace-canvas-tabs" role="group" aria-label="画布视图">
        <button ref={narrow && !drawerOpen ? resultReturn : undefined} aria-pressed={!drawerOpen} onClick={closeResults}>输入画布</button>
        <button ref={narrow && drawerOpen ? resultReturn : undefined} aria-pressed={drawerOpen} onClick={() => dispatchDrawer({ type: "toggle", key: drawerKey, open: true, seen: drawer.completed })}>生成结果</button>
      </div>}
      {!workspace && !embedded && <header>
        <div className="brand">
          <img className="brand-mark" src={logo} alt="" />
          <strong>QC-Reframe</strong>
        </div>
      </header>}
      {!workspace && <div className="connection">
        <span className={`dot ${connected ? "online" : ""}`} />
        <span title={connectionText}>
          {connected ? "Codex 已连接" : "Codex 未连接"}
        </span>
        {activeCount > 0 && <button className="text-button" onClick={() => openNotice()}>{activeCount} 个任务</button>}
        <button className="text-button workspace-entry" disabled={busy || savingMode || !!subjectUnavailable[subjectKey(preferences.mode)]} onClick={() => void openWorkspace()} title="在工作台继续"><Icon name="expand" />工作台</button>
        <button
          className="icon-button"
          title="连接设置"
          aria-label="连接设置"
          aria-expanded={settings}
          onClick={() => {
            setSettings(!settings);
            setError("");
          }}
        >
          <Icon name="settings" />
        </button>
      </div>}

      {!workspace && settings && (
        <section className="settings card">
          <h2>连接 Codex</h2>
          <details className="inline-help" open={!connected}><summary>如何获取配对码？</summary><p>在插件目录打开终端，启动服务并获取配对码。</p><code className="command">npm start<br />npm run pair</code></details>
          <label htmlFor="pair-token">本机配对码</label>
          <input
            id="pair-token"
            type="password"
            autoComplete="off"
            value={tokenDraft}
            placeholder="粘贴终端中的配对码"
            onChange={(e) => setTokenDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void connect();
            }}
          />
          <button
            className="primary"
            disabled={busy || !tokenDraft.trim()}
            onClick={connect}
          >
            {busy ? "正在连接…" : "连接 Codex"}
          </button>
          {connected && <button className="text-button" onClick={() => void openWorkspace("settings")}>在工作台管理模型与设置<Icon name="arrow" /></button>}
        </section>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!connected && preferences.paired && !settings && (
        <div className="error">{connectionText}</div>
      )}
      {connected && !selectedModel && !settings && <div className="model-notice">
        <span>先为 QC-Reframe 选择可用模型</span>
        <button className="text-button" onClick={() => workspace ? setSettings(true) : void openWorkspace("settings")}>选择模型</button>
      </div>}

      {(visibilityNotice || (!tasksOpen && visibilityError)) && <ProjectVisibilityToast notice={visibilityNotice} error={tasksOpen ? "" : visibilityError} busy={busy} containerRef={visibilityFeedback}
        onDismiss={() => { setVisibilityNotice(undefined); setVisibilityError(""); }}
        onUndo={() => { if (visibilityNotice) void setProjectsHidden(visibilityNotice.ids, !visibilityNotice.hidden, true).catch(error => setVisibilityError(error.message)); }} />}
      {workspace && newProjectOpen && <NewProject busy={busy} error={error} onClose={() => setNewProjectOpen(false)} onUpload={() => referenceInput.current?.click()} />}
      {workspace && settings && <SettingsCenter connected={connected} serviceBusy={serviceBusy} onClose={() => setSettings(false)} onConnected={() => setPreferences(value => ({ ...value, paired: true }))} />}
      {tasksOpen && <TaskCenter visibilityError={visibilityError} unread={reminders.unread} onNoticeOpen={openNotice} showHidden={showHidden} hiddenProjectIds={hiddenProjectIds} busy={busy} onToggleHidden={() => void toggleHiddenProjects()} onClose={() => setTasksOpen(false)} onUpdate={updateJob} onOpen={async (_projectId, _mode, jobId, generationId) => {
        await noticeNavigation.current?.(new URLSearchParams({ task: jobId, ...(generationId ? { generation: generationId } : {}) }));
      }} />}
      {workspace && galleryOpen ? <ResultGallery connected={connected} revision={dataRevision} showHidden={showHidden} hiddenProjectIds={hiddenProjectIds}
        visibilityToggle={<HiddenProjectsToggle shown={showHidden} disabled={busy || !connected} onToggle={() => void toggleHiddenProjects()} />}
        onOpen={async work => {
          const revision = ++selectionRevision.current;
          setBusy(true); modeRevision.current++;
          try {
            const next = await request<Selection>({ type: "alchemy:open-project", id: work.projectId });
            if (revision !== selectionRevision.current) return;
            setInputRevisions(items => ({ ...items, [work.projectId]: next.inputRevision || 0 }));
            setSelection(next); setHistoryOpen(false);
            setProjectMode(work.projectId, work.mode);
            setVersions(items => ({ ...items, [`${work.projectId}:${work.mode}`]: work.jobId }));
            setTargetGeneration({ jobId: work.jobId, id: work.generationId });
            dispatchDrawer({ type: "toggle", key: `${work.projectId}:${work.mode}:${work.jobId}`, open: true, seen: "" });
            setGalleryOpen(false);
          } finally { modeRevision.current++; setBusy(false); }
        }} /> : <div className={workspace ? "workspace-body" : undefined} data-results-open={drawerOpen} data-history={historyOpen}>
      <div ref={editor} className={workspace ? "workspace-editor" : undefined} inert={workspace && narrow && drawerOpen}>
      {!workspace && draftError && <p className="error" role="alert">{draftError}</p>}
      <main className={workspace && !historyOpen && !galleryOpen && selection ? "canvas-main" : undefined}>
        {historyOpen ? (
          <ProjectHistory searchTarget={projectSearchTarget} workspace={workspace} projects={library.data.items.filter(visibleProject)} page={library.page} total={library.data.total} pageSize={library.data.pageSize} search={library.search} status={library.status} onStatus={library.setStatus} loading={library.loading} loadError={library.error} onPage={library.setPage} onSearch={library.setSearch} onRetry={library.refresh} busy={busy} onOpen={openProject} onDelete={deleteProjects} showHidden={showHidden} onSetHidden={setProjectsHidden} onToggleHidden={() => void toggleHiddenProjects()} />
        ) : workspace && selection ? <CanvasWorkspace onPromptRevealed={() => setTargetPrompt(undefined)} revealPrompt={targetPrompt?.jobId === activeJob?.id ? targetPrompt?.request : undefined} contextKey={drawerKey} mode={preferences.mode}
          image={displayImage} subjectImage={subjectImage(preferences.mode)} subjects={multiSubjects}
          selected={canvasSelections[subjectKey(preferences.mode)] || "reference"} onSelect={id => setCanvasSelections(items => ({ ...items, [subjectKey(preferences.mode)]: id }))}
          instruction={taskInstruction(preferences.mode)} onInstruction={value => changeInstruction(preferences.mode, value)}
          disabled={blocked || !!promptDraft} modeDisabled={savingMode || busy} reverseDisabled={reverseDisabled} running={!!running} cancelling={cancelling}
          status={reverseStatus || (promptDraft ? "编辑未保存" : reverseHint || genericHint || (job?.status === "cancelled" ? "已取消" : ""))}
          error={referenceError || currentInput(preferences.mode)?.subjectError || selection.error || job?.error} errorTaskId={!referenceError && !selection.error && job?.status === "failed" ? job.id : undefined} stale={instructionStale || (preferences.mode === "multi-reenact" && multiStale) || genericPrompt}
          hasPrompt={!!result} promptEditing={!!promptDraft} reduced={reduced} versions={versionSelector} generationActions={setGenerationActions}
          onMode={mode => void saveMode(mode)} onSubject={changeSubject}
          onAvailability={available => setSubjectUnavailable(items => ({ ...items, [subjectKey(preferences.mode)]: !available }))}
          onSubjects={changeSubjects}
          onReference={image => applyReferenceUpload(image, preferences.mode, taskInstruction(preferences.mode))}
          onReferenceRotate={image => applyReferenceRotation(image, preferences.mode, taskInstruction(preferences.mode))}
          onSwap={id => { if (preferences.mode !== "recreate") void swapImages(preferences.mode, taskInstruction(preferences.mode), id); }}
          onReverse={reverse} onExtract={extractStyle} onCancel={cancel}
          onRetryReference={referenceError ? () => setReferenceErrors(items => { const next = { ...items }; delete next[job!.id]; return next; }) : undefined}
          prompt={result && activeJob && <PromptEditor taskId={activeJob.id} sheet result={result} draft={promptDraft} lang={lang} copied={copied} saving={!!savingPrompt} disabled={!connected} versionSelector={null} onExport={exportResult}
            onLanguage={setLang} onCopy={copy} onEdit={() => setPromptDrafts(items => ({ ...items, [activeJob.id]: { promptZh: result.promptZh, promptEn: result.promptEn, negativePrompt: result.negativePrompt } }))}
            onDraft={draft => setPromptDrafts(items => ({ ...items, [activeJob.id]: draft }))} onSave={savePrompt} onCancel={() => discardPrompt(activeJob.id)} />}
        /> : !workspace ? <QuickWorkspace contextKey={drawerKey} revealPrompt={targetPrompt?.jobId === job?.id ? targetPrompt?.request : undefined} targetGeneration={targetGeneration?.jobId === job?.id ? targetGeneration?.id : undefined} selection={displaySelection} title={activeProject?.title} mode={preferences.mode}
          subject={subjectImage(preferences.mode)} instruction={taskInstruction(preferences.mode)} job={job}
          disabled={blocked || !!promptDraft} modeDisabled={savingMode || busy} reverseDisabled={reverseDisabled}
          status={reverseStatus || reverseHint} stale={instructionStale || (preferences.mode === "multi-reenact" && multiStale)} cancelling={cancelling} copied={copied} lang={lang} versions={versionSelector}
          onMode={mode => void saveMode(mode)} onSubject={changeSubject}
          onAvailability={available => setSubjectUnavailable(items => ({ ...items, [subjectKey(preferences.mode)]: !available }))}
          onInstruction={value => changeInstruction(preferences.mode, value)} onReference={file => void uploadReference(file, false)}
          onRotateReference={image => applyReferenceRotation(image, preferences.mode, taskInstruction(preferences.mode))}
          onSwap={() => { if (preferences.mode !== "recreate") void swapImages(preferences.mode, taskInstruction(preferences.mode)); }}
          onReverse={reverse} onCancel={cancel} onCopy={copy} onLanguage={setLang} onWorkspace={() => void openWorkspace()} onUpdate={value => { setTargetGeneration(undefined); updateJob(value); }}
          generationHint={promptDraft ? "未保存的提示词请在工作台继续编辑" : instructionStale ? "输入已修改，请重新生成提示词" : reverseStatus || (!connected ? "请先连接服务" : !selectedModel ? "请在工作台选择模型" : "")}
          generationDisabled={!connected || !selectedModel || blocked || !!promptDraft || needsPrompt || !!subjectUnavailable[subjectKey(preferences.mode)]}
        /> : <section className="empty"><span className="empty-mark"><Icon name="image" /></span><h1>选择一张参考图</h1></section>}

      </main>
      {workspace && !historyOpen && !galleryOpen && resultPane && generationPanel && createPortal(generationPanel, resultPane)}
      </div>
      {workspace && !historyOpen && !galleryOpen && <div className="result-drawer-slot"><aside id="workspace-results" className="workspace-results" ref={setResultPane} aria-label="生成结果抽屉" aria-hidden={!drawerOpen} inert={!drawerOpen} /></div>}
      </div>}
      </div>
    </div>
  );
}
