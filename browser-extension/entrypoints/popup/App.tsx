import { createReverseCancellation, deriveReverseAction, reverseRunning, reverseSubmission } from "../../lib/reverse-action";
import { requestedImageSize, validImageSizeRequest } from "../../lib/image-size.mjs";
import { chainTargetSize } from "../../lib/generation-size";
import GenerationSizeFields from "./GenerationSizeFields";
import GenerationModelField from "./GenerationModelField";
import { validGenerationRatio } from "../../lib/generation-session";
import { creationContext, emptyCreationState, createInputWriter, resolveCreation, viewScope } from "../../lib/creation-context";
import RecoveryAction, { RecoveryContext } from "./RecoveryAction";
import type { RecoverySection } from "../../lib/codex-status";
import ProjectVisibilityToast from "./ProjectVisibilityToast";
import { ReminderToast, useTaskReminders } from "./TaskReminders";
import type { TaskNotice } from "../../lib/task-reminders";
import { createWorkspaceOpener, draftSnapshot, projectDraft, workspaceContext, type PromptDraft } from "../../lib/workspace-handoff";
import { resultDrawers, resultDrawerView } from "../../lib/result-drawer";
import { createGenerationSettings, initialGenerationChannel } from "../../lib/generation-settings";
import { initialServiceStatus, pollServiceHealth } from "../../lib/service-health";
import StartCommand from "./StartCommand";
import { createSurfaceSync, type SurfaceSync } from "../../lib/surface-sync";
import { hydrateProjectInput, hydrationDependencies, inputConflict, openProject as openProjectInputs, restoreJobReference } from "../../lib/project-inputs";
import { projectVisibilityActions, type VisibilityNotice } from "../../lib/project-visibility";
import { downloadPromptMarkdown } from "../../lib/prompt-export";
import useProjectLibrary from "./useProjectLibrary";
import { useMotion } from "../../lib/use-motion";
import { pollWhileVisible } from "../../lib/visible-poll";
import { createPortal } from "react-dom";
import { normalizeImage } from "../../lib/image";
import NewProject from "../workspace/NewProject";
import SessionPicker from "../workspace/SessionPicker";
import CanvasWorkspace from "../workspace/CanvasWorkspace";
import PromptEditor from "../workspace/PromptEditor";
import RecentProject from "../workspace/RecentProject";
import ResultGallery from "../workspace/ResultGallery";
import SettingsCenter, { type SettingsSection } from "./SettingsCenter";
import TaskCenter from "./TaskCenter";
import HiddenProjectsToggle from "./HiddenProjectsToggle";
import { useEffect, useReducer, useRef, useState } from "react";
import { query, readState, request, type UiState } from "../../lib/client";
import type { Job, Mode, Project, ProjectSummary, SubjectInput, Selection, MultiSubject, AspectRatio } from "../../lib/types";
import ProjectHistory from "./ProjectHistory";
import QuickWorkspace from "./QuickWorkspace";
import MultiInputPreview from "./MultiInputPreview";
import { adaptDefaultInstruction, defaultInstructions } from "../../lib/task-instruction";
import GenerationPanel from "./GenerationPanel";
import Icon from "./Icon";
import SelectField from "./SelectField";
import { logo } from "../../lib/brand";

const defaults: UiState["preferences"] = { paired: false, mode: "style" };

/**
 * The composition root shared by the quick panel and the workspace. Background sync, service health,
 * project inputs/visibility, cancellation and handoff live in lib modules; App owns layout and wiring.
 */
export default function App({ embedded = false, workspace = false }: { embedded?: boolean; workspace?: boolean }) {
  const { reduced } = useMotion();
  const reminderRoot = useRef<HTMLDivElement>(null);
  const reminders = useTaskReminders(reminderRoot);
  const [sessionPicker, setSessionPicker] = useState<string>();
  const [targetPrompt, setTargetPrompt] = useState<{ jobId: string; request: number }>();
  const [targetGeneration, setTargetGeneration] = useState<{ jobId: string; id: string }>();
  const sync = useRef<SurfaceSync | undefined>(undefined);
  const openNotice = (notice?: TaskNotice) => {
    if (sync.current) void sync.current.openNotice(notice);
    else setError("正在恢复界面，请稍后重试");
  };
  const [projectSearchTarget, setProjectSearchTarget] = useState<HTMLDivElement | null>(null);
  const [resultPane, setResultPane] = useState<HTMLElement | null>(null);
  const [generationActions, setGenerationActions] = useState<HTMLDivElement | null>(null);
  const [reverseActions, setReverseActions] = useState<HTMLDivElement | null>(null);
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
  const [creation, dispatchCreation] = useReducer(creationContext, emptyCreationState);
  const { instructions, inputRevisions, versions, multiSubjectDrafts, subjectDrafts } = creation;
  const referenceInput = useRef<HTMLInputElement>(null);
  const [activeCount, setActiveCount] = useState(0);
  const [basePreferences, setPreferences] = useState(defaults);
  const [projectModes, setProjectModes] = useState<Record<string, Mode>>({});
  const [inputReload, setInputReload] = useState(0);
  const [viewsReady, setViewsReady] = useState(false);
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
  const [visibilityNotice, setVisibilityNotice] = useState<VisibilityNotice>();
  const [visibilityError, setVisibilityError] = useState("");
  const selection = !showHidden && storedSelection?.projectId && hiddenProjectIds.includes(storedSelection.projectId) ? undefined : storedSelection;
  const [project, setProject] = useState<Project>();
  const projectSnapshot = useRef<Project | undefined>(undefined);
  projectSnapshot.current = project;
  const [dataRevision, setDataRevision] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [references, setReferences] = useState<Record<string, Selection>>({});
  const [canvasSelections, setCanvasSelections] = useState<Record<string, string>>({});
  const [subjectUnavailable, setSubjectUnavailable] = useState<Record<string, boolean>>({});
  const [promptDrafts, setPromptDrafts] = useState<Record<string, PromptDraft>>({});
  const [savingPrompt, setSavingPrompt] = useState("");
  const [referenceErrors, setReferenceErrors] = useState<Record<string, string>>({});
  const modeRevision = useRef(0);
  const projectRevision = useRef(0);
  const selectionRevision = useRef(0);
  const deletingProjects = useRef(false);
  const [settings, setSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const library = useProjectLibrary(preferences.paired, historyOpen, workspace, dataRevision, showHidden);
  const refreshLibrary = () => { library.refresh(); setRefreshNonce(value => value + 1); };
  const visibleProject = (item: ProjectSummary) => showHidden || (!item.hidden && !hiddenProjectIds.includes(item.id));
  const recentProjects = library.recent.items.filter(visibleProject);
  const [service, setService] = useState(initialServiceStatus);
  const { connected, connectionText, cliBusy, cliStatus, modelBusy, reverseAgent, selectedModel } = service;
  const [serviceBusy, setServiceBusy] = useState(false);
  const [channel, setChannel] = useState(initialGenerationChannel);
  const generationSettings = useRef<ReturnType<typeof createGenerationSettings> | undefined>(undefined);
  generationSettings.current ??= createGenerationSettings({ request, query, publish: setChannel });
  const { magpie, model: generationModel, ready: generationReady, pending: generationSettingsPending,
    error: generationSettingsError, revision: imageSettingsRevision } = channel;
  const saveImageSettings = (value: Record<string, unknown>) => generationSettings.current!.save(value);
  const magpieHint = magpie ? "Magpie 按所选模型适配尺寸；附图支持取决于所选模型。" : "";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancellingJobs, setCancellingJobs] = useState<string[]>([]);
  const [lang, setLang] = useState<"zh" | "en">("zh");
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Long-lived modules (surface sync, cancellation) only read the stable setters and refs in here.
  const env = {
    workspace, request, query, readState, pollWhileVisible, location, history, window, document,
    requestAnimationFrame: (callback: FrameRequestCallback) => requestAnimationFrame(callback),
    modeRevision, visibilityRevision, selectionRevision, projectRevision, deletingProjects, visibilityPending, visibilityFeedback,
    dispatchCreation, dispatchDrawer, setPreferences, setProjectModes, setProjectMode, setViewsReady, setSelection, setProject,
    setPromptDrafts, setLang, setDraftReady, setDraftError, setError, setBusy, setSettings, setSettingsSection, setNewProjectOpen,
    setHistoryOpen, setGalleryOpen, setTasksOpen, setTargetGeneration, setTargetPrompt, setInputReload, setReferences,
    setReferenceErrors, setVisibilityError, setVisibilityNotice, setHiddenProjectIds, refresh: refreshLibrary,
  };
  const activeProject = project?.id === selection?.projectId ? project : undefined;
  const contextFor = (mode: Mode) => resolveCreation(creation, selection, activeProject, references, mode, defaultInstructions[mode]);
  const modeJobs = (mode: Mode) => contextFor(mode).jobs;
  const modeJob = (mode: Mode) => contextFor(mode).job;
  const subjectKey = (mode: Mode) => contextFor(mode).key;
  const subjectImage = (mode: Mode) => contextFor(mode).subjectImage;
  const selectedSessions = () => contextFor("session").sessions;
  const taskInstruction = (mode: Mode) => contextFor(mode).instruction;
  const changeInstruction = (mode: Mode, value: string) => dispatchCreation({ type: "edit",
    key: subjectKey(mode), version: modeJob(mode)?.id || "new", instruction: value });
  const multiContext = contextFor("multi-reenact");
  const multiSubjects = multiContext.subjects;
  const multiPrompt = multiContext.instruction;
  const multiStale = multiContext.multiStale;
  const job = modeJob(preferences.mode);
  const displayImage = contextFor(preferences.mode).image;
  const displaySelection = selection && { ...selection, image: displayImage };
  const drawerKey = `${selection?.projectId || selection?.id}:${preferences.mode}:${job?.id || "new"}`;
  const referenceContext = useRef({ key: drawerKey });
  if (referenceContext.current.key !== drawerKey) referenceContext.current = { key: drawerKey };
  const generationView = viewScope(referenceContext, selectionRevision);
  const revealGeneratedImage = () => { if (generationView()) setTargetGeneration(undefined); };
  const inputWriter = useRef<ReturnType<typeof createInputWriter> | undefined>(undefined);
  inputWriter.current ??= createInputWriter(message => request<Selection>(message),
    () => ({ context: referenceContext.current, revision: selectionRevision.current }));
  const running = reverseRunning(job);
  const loadingProject = !!selection && !activeProject;
  const result = job?.result;
  const cancelling = !!job && cancellingJobs.includes(job.id);
  const promptDraft = job && promptDrafts[job.id];
  const reading = selection && !selection.image && !selection.error;
  const referenceError = job && referenceErrors[job.id];
  const restoring = !!job && !references[job.id] && !referenceError;
  const inputBlocked = inputConflict(selection, activeProject) || !draftReady || !connected || busy || modelBusy || cliBusy || running || loadingProject || restoring;
  const blocked = inputBlocked || !selectedModel;
  const generationBlocked = inputBlocked || generationSettingsPending || !generationReady;

  useEffect(() => {
    setCopied(false);
    return () => clearTimeout(copyTimer.current);
  }, [job?.id, lang, promptDraft]);

  useEffect(() => {
    const surface = createSurfaceSync(env);
    sync.current = surface;
    surface.start();
    return () => { surface.dispose(); sync.current = undefined; };
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

  useEffect(() => pollServiceHealth({ ...env, generation: generationSettings.current!, project: projectSnapshot,
    setStatus: patch => setService(value => ({ ...value, ...patch })),
    setPaired: () => setPreferences(value => value.paired ? value : { ...value, paired: true }),
    setActivity: activity => { setServiceBusy(activity.busy); setActiveCount(activity.active); setHiddenProjectIds(activity.hiddenProjectIds); },
    setDataRevision,
  }, selection?.projectId), [preferences.paired, selection?.projectId, refreshNonce, showHidden]);

  useEffect(() => restoreJobReference(env, job, !!job && (!!references[job.id] || !!referenceError)), [job?.id, referenceError]);

  const inputView = { project: activeProject, selection, viewsReady, inputRevisions, reload: inputReload };
  useEffect(() => hydrateProjectInput(env, inputView), hydrationDependencies(inputView));

  const projectView = JSON.stringify({ mode: preferences.mode, inputRevision: inputRevisions[selection?.projectId || ""] || 0, versions: Object.fromEntries(
    Object.entries(versions).filter(([key]) => key.startsWith(`${selection?.projectId}:`))
      .map(([key, value]) => [key.slice(key.indexOf(":") + 1), value]),
  ) });
  useEffect(() => {
    if (!viewsReady || !draftReady || !selection?.projectId || !activeProject) return;
    void request({ type: "alchemy:save-project-view", projectId: selection.projectId, view: JSON.parse(projectView) })
      .catch(error => setError(`项目选择暂未保存：${error.message}`));
  }, [viewsReady, draftReady, selection?.projectId, activeProject?.id, projectView]);

  const shownDraft = () => draftSnapshot(creation, { promptDrafts, lang,
    shown: activeProject ? { key: subjectKey(preferences.mode), version: job?.id || "new" } : undefined });
  useEffect(() => {
    if (workspace || !draftReady) return;
    let cancelled = false;
    void request({ type: "alchemy:quick-draft", context: workspaceContext(preferences.mode, selection), draft: shownDraft() }).then(
      () => { if (!cancelled) setDraftError(""); },
      error => { if (!cancelled) setDraftError(`草稿暂未保存：${error.message}`); },
    );
    return () => { cancelled = true; };
  }, [workspace, draftReady, multiSubjectDrafts, subjectDrafts, instructions, promptDrafts, lang, versions, job?.id, activeProject?.id, selection?.id, selection?.projectId, preferences.mode]);

  const workspaceOpener = useRef<ReturnType<typeof createWorkspaceOpener> | undefined>(undefined);
  workspaceOpener.current ??= createWorkspaceOpener({ request, setBusy, setError });
  const openWorkspace = (view?: "tasks" | "settings", section?: RecoverySection) => workspaceOpener.current!({
    blocked: busy || !!subjectUnavailable[subjectKey(preferences.mode)] || !!reading || (connected && loadingProject),
    view, section, context: workspaceContext(preferences.mode, selection),
    draft: projectDraft(shownDraft(), selection?.projectId || selection?.id, activeProject?.jobs.map(item => item.id) || []),
  });
  const openRecovery = (section: RecoverySection) => {
    if (!workspace) { void openWorkspace("settings", section); return; }
    setSettingsSection(section); setSettings(true);
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
        dispatchCreation({ type: "edit", key, version: "new", instruction: taskInstruction(preferences.mode),
          subjectImage: preferences.mode !== "recreate" && preferences.mode !== "session" ? subjectImage(preferences.mode) : undefined });
      }
      selectionRevision.current++;
      setProjectMode(next.projectId, preferences.mode);
      setSelection(next); setHistoryOpen(false); setGalleryOpen(false); setNewProjectOpen(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const saveInput = async (mode: Mode, image: string | undefined, instruction: string,
    subject: string = subjectImage(mode), subjects: MultiSubject[] = multiSubjects, sessionIds = mode === "session" ? selectedSessions().map(item => item.id) : undefined,
    referenceIndex = contextFor(mode).referenceIndex, onSaved?: () => void) => {
    if (blocked || inputWriter.current!.pending || !selection?.projectId) throw new Error("当前无法修改图片，请稍后重试");
    const revision = selectionRevision.current, context = referenceContext.current;
    const subjectCount = mode === "multi-reenact" ? subjects.length : (mode === "style" || mode === "reenact") && subject ? 1 : 0;
    referenceIndex = Math.min(referenceIndex, subjectCount);
    instruction = adaptDefaultInstruction(instruction, mode, subjectCount, referenceIndex);
    setBusy(true);
    try {
      await inputWriter.current!.save({ selection, mode, referenceJobId: modeJob(mode)?.id,
        image, instruction, subjectImage: subject, subjects, sessionIds,
        referenceIndex }, next => {
        selectionRevision.current++;
        dispatchCreation({ type: "adopt", selection: next, savedMode: mode });
        setSelection(next); setError(""); setRefreshNonce(value => value + 1);
        setHistoryOpen(false); setGalleryOpen(false);
        onSaved?.();
      });
    } catch (error) {
      if (revision === selectionRevision.current && context === referenceContext.current) setError((error as Error).message);
      throw error;
    } finally { setBusy(false); }
  };
  const applyReferenceUpload = (image: string, mode: Mode, instruction = taskInstruction(mode)) => saveInput(mode, image, instruction);
  const applyReferenceRotation = async (image: string, mode: Mode, instruction?: string) => {
    if (!displayImage) throw new Error("当前无法修改图片，请稍后重试");
    await applyReferenceUpload(image, mode, instruction);
  };
  const changeSubject = (image: string) => saveInput(preferences.mode, displayImage, taskInstruction(preferences.mode), image);
  const changeSubjects = (subjects: MultiSubject[]) => saveInput("multi-reenact", displayImage, multiPrompt, "", subjects, undefined,
    multiSubjects.slice(0, multiContext.referenceIndex).filter(item => subjects.some(next => next.id === item.id)).length);
  const changeImageOrder = (referenceIndex: number, subjects = multiSubjects, onSaved?: () => void) => saveInput(preferences.mode,
    displayImage, taskInstruction(preferences.mode), subjectImage(preferences.mode), subjects, undefined, referenceIndex, onSaved);
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
    } catch (e) { if (revision === selectionRevision.current) setError((e as Error).message || "无法互换图片，请重试"); }
  };
  // Only refs and state setters are touched, so the canceller below may keep the first render's closure.
  const updateJob = (updated: Job) => {
    projectRevision.current++;
    if (updated.status === "running" || updated.autoGeneration?.status === "pending" || updated.generations?.some(item => item.status === "running")) setServiceBusy(true);
    setRefreshNonce(value => value + 1);
    setProject((current) => current && current.id === updated.projectId
      ? { ...current, jobs: [updated, ...current.jobs.filter((item) => item.id !== updated.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
      : current);
  };
  const saveMode = (mode: Mode) => {
    if (busy || !draftReady) return;
    setCopied(false); setError("");
    setProjectMode(selection?.projectId, mode);
  };
  const startPending = useRef(false);
  const [continuousJobId, setContinuousJobId] = useState("");
  const [chainSize, setChainSize] = useState<{ key: string; pixelSize: boolean; size?: AspectRatio }>();
  const start = async (mode: Mode = preferences.mode, reenact?: SubjectInput, generate = false) => {
    if (!selection || !displayImage || !activeProject || blocked || startPending.current) return;
    startPending.current = true;
    const revision = selectionRevision.current, context = referenceContext.current;
    const size = magpie ? requestedImageSize(targetSize) : targetSize;
    setBusy(true);
    setError("");
    try {
      const value = await request<{ selection: Selection; currentSelection: Selection; job: Job }>({
        type: "alchemy:start", referenceIndex: contextFor(mode).referenceIndex, id: selection.id, projectId: activeProject.id, mode, reenact, instruction: taskInstruction(mode), ...(mode === "session" ? { sessionIds: selectedSessions().map(item => item.id) } : {}),
        inputRevision: selection.inputRevision || 0, referenceJobId: modeJob(mode)?.id,
        ...(generate ? { generation: { language: lang, ...(size ? magpie ? { imageSize: { ...size } } : { aspectRatio: { ...size } } : {}) } } : {}),
      });
      setReferences(items => ({ ...items, [value.job.id]: value.selection }));
      updateJob(value.job);
      if (revision !== selectionRevision.current || context !== referenceContext.current) return;
      if (generate) setContinuousJobId(value.job.id);
      selectionRevision.current++;
      setSelection((current) => current?.id === selection.id ? value.currentSelection : current);
      dispatchCreation({ type: "revision", projectId: activeProject.id, revision: value.currentSelection.inputRevision || 0 });
      dispatchCreation({ type: "select", key: `${activeProject.id}:${mode}`, version: value.job.id });
      setCopied(false);
      if (generate && !value.job.autoGeneration) setError("本机服务尚未支持连续生图，本次已提交仅逆向。请在任务结束后重启服务；提示词完成后可单独生图。");
    } catch (e) {
      if (revision === selectionRevision.current && context === referenceContext.current) setError((e as Error).message);
    }
    finally { startPending.current = false; setBusy(false); }
  };
  const showHistory = () => {
    setGalleryOpen(false);
    setHistoryOpen(value => !value);
    setError("");
  };
  const openProject = (item: ProjectSummary) => openProjectInputs(env, item.id);
  const deleteProjects = async (ids: string[]) => {
    setBusy(true);
    setError("");
    selectionRevision.current++;
    projectRevision.current++;
    deletingProjects.current = true;
    try {
      const { deletedIds } = await request<{ deletedIds: string[] }>({ type: "alchemy:delete-projects", ids });
      const removedJobs = activeProject && deletedIds.includes(activeProject.id) ? activeProject.jobs.map((job) => job.id) : [];
      refreshLibrary();
      if (selection?.projectId && deletedIds.includes(selection.projectId)) { setSelection(undefined); setProject(undefined); }
      setProjectModes(items => Object.fromEntries(Object.entries(items).filter(([id]) => !deletedIds.includes(id))));
      dispatchCreation({ type: "delete", projectIds: deletedIds });
      setPromptDrafts((items) => Object.fromEntries(Object.entries(items).filter(([id]) => !removedJobs.includes(id))));
      setReferences((items) => Object.fromEntries(Object.entries(items).filter(([id, value]) => !removedJobs.includes(id) && !deletedIds.includes(value.projectId || ""))));
      setReferenceErrors((items) => Object.fromEntries(Object.entries(items).filter(([id]) => !removedJobs.includes(id))));
    } finally { deletingProjects.current = false; selectionRevision.current++; projectRevision.current++; setBusy(false); }
  };
  const { setProjectsHidden, toggleHiddenProjects } = projectVisibilityActions(env, { selection, project, hiddenProjectIds, showHidden });
  const reverseCancellation = useRef<ReturnType<typeof createReverseCancellation> | undefined>(undefined);
  reverseCancellation.current ??= createReverseCancellation({ request, onUpdate: updateJob, onError: setError, onPending: setCancellingJobs });
  const cancel = () => reverseCancellation.current!(job);
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

  const reverseStatus = reading ? selection?.stage || "正在读取图片…" : running ? `${job?.autoGeneration?.status === "pending" ? job.result ? "正在准备生图…" : "正在逆向，完成后自动生图…" : job?.stage || "正在逆向提示词…"} · 完成后会提醒你`
    : restoring ? "正在恢复原图…" : loadingProject ? "正在读取模板项目…" : cliBusy ? "Agent CLI 正在安装或更新…"
    : modelBusy ? "正在验证模型…" : busy ? "正在提交…" : undefined;

  const targetSize = chainTargetSize({ workspace, pixelSize: magpie, chainSize, drawerKey, job, targetGeneration });
  const reverseAction = deriveReverseAction({ mode: preferences.mode, context: contextFor(preferences.mode),
    hasSelection: !!selection, referenceError, subjectUnavailable: !!subjectUnavailable[subjectKey(preferences.mode)],
    blocked, generationBlocked, promptEditing: !!promptDraft,
    sizeValid: magpie ? validImageSizeRequest(targetSize) : validGenerationRatio(targetSize) });
  const { instructionStale, genericPrompt, needsPrompt, subjectError, genericHint, reverseHint, reverseDisabled, chainDisabled } = reverseAction;
  const reverse = (generate = false) => {
    const submission = reverseSubmission(reverseAction, generate);
    if (submission) void start(preferences.mode, submission.reenact, submission.generate);
  };

  const versionSelector = modeJobs(preferences.mode).length > 0 && <SelectField className="version-select" label="" aria-label="提示词版本" value={job?.id || "new"} disabled={busy}
              onChange={(e) => { setCopied(false); dispatchCreation({ type: "select", key: `${activeProject!.id}:${preferences.mode}`, version: e.target.value }); }}>
              <option value="new">当前输入</option>
              {modeJobs(preferences.mode).map((item, i, items) => <option key={item.id} value={item.id}>{`版本 ${items.length - i}${i === 0 ? " · 最新" : ""}`}</option>)}
            </SelectField>;
  const multiPreview = preferences.mode === "multi-reenact" ? <MultiInputPreview image={displayImage} subjects={multiSubjects} referenceIndex={multiContext.referenceIndex} /> : undefined;
  const drawer = resultDrawerView(drawers, drawerKey, job?.generations);
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
    (resultReturn.current || generationActions?.querySelector<HTMLButtonElement>(".generate-button"))?.focus({ preventScroll: true });
  }, [workspace, drawerOpen, resultPane, generationActions]);
  useEffect(() => {
    if (!workspace || !narrow || !drawerOpen) return;
    if (editor.current?.contains(document.activeElement) || document.activeElement === document.body) resultReturn.current?.focus({ preventScroll: true });
  }, [workspace, narrow, drawerOpen, resultPane]);
  const generationModelBusy = serviceBusy || busy || Object.values(drawers).some(item => item.pending)
    || !!project?.jobs.some(item => item.status === "running" || item.autoGeneration?.status === "pending" || item.generations?.some(generation => generation.status === "running"));
  const generationModelControl = workspace && magpie ? <GenerationModelField model={generationModel} settingsRevision={imageSettingsRevision} disabled={!connected || generationSettingsPending || generationModelBusy} onSave={saveImageSettings} /> : undefined;
  const generationPanel = job?.result ? <GenerationPanel modelControl={generationModelControl} generationModel={generationModel} pixelSize={magpie} key={`${job.id}:${magpie}`} onTargetSelected={() => setTargetGeneration(undefined)} targetGeneration={targetGeneration?.jobId === job.id ? targetGeneration.id : undefined} job={job} lang={lang} workspace={workspace} onAspectRatioChange={size => setChainSize({ key: drawerKey, pixelSize: false, size })} onImageSizeChange={size => setChainSize({ key: drawerKey, pixelSize: true, size })}
                  drawerOpen={drawerOpen} requestError={drawer.error} requestPending={drawer.pending}
                  onRequestState={(pending, error) => dispatchDrawer({ type: pending ? "request" : "settled", key: drawerKey, error })} versionNumber={modeJobs(preferences.mode).length - modeJobs(preferences.mode).findIndex(item => item.id === job.id)} actionsTarget={generationActions} disabledReason={workspace ? promptDraft ? "编辑未保存，请保存或取消提示词修改。" : needsPrompt ? reverseHint || genericHint || "输入已修改，请更新提示词。" : "" : ""} disabled={generationBlocked || !!subjectUnavailable[subjectKey(preferences.mode)] || !!promptDraft || (workspace && needsPrompt) || (job.mode === "multi-reenact" && multiStale)}
                  subjectImage={(job.mode === "recreate" || job.mode === "session") ? undefined : subjectImage(job.mode)}
                  inputPreview={multiPreview}
                  subjects={job.mode === "multi-reenact" ? multiSubjects : undefined}
                  onUpdate={(updated, image, subjects) => {
                    if (subjects) setReferences(items => items[updated.id] ? { ...items, [updated.id]: { ...items[updated.id]!, generationSubjects: subjects } } : items);
                    updateJob(updated);
                    if (image) setReferences((items) => {
                      const saved = items[updated.id];
                      return saved ? { ...items, [updated.id]: { ...saved, generationSubjectImage: image } } : items;
                    });
                  }} /> : null;

  return (
    <RecoveryContext.Provider value={openRecovery}>
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
        <div className="sidebar-bottom"><button className="nav-action" aria-label="设置中心" onClick={() => setSettings(true)}><Icon name="settings" /><span>设置中心</span></button><div className="connection-state"><i className={`online-dot ${connected ? "" : "offline"}`} />{connected ? "本机服务已连接" : "本机未连接"}{connected && cliStatus?.updateAvailable && <button className="text-button" onClick={() => openRecovery("cli")}>{cliStatus.comparisonReference ? "版本参考" : "可更新"}</button>}</div></div>
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
          {connected ? "本机服务已连接" : "本机未连接"}
        </span>
        {activeCount > 0 && <button className="text-button" onClick={() => openNotice()}>{activeCount} 个任务</button>}
        <button className="text-button workspace-entry" disabled={busy || !!subjectUnavailable[subjectKey(preferences.mode)]} onClick={() => void openWorkspace()} title="在工作台继续"><Icon name="expand" />工作台</button>
        <button
          className="icon-button"
          title="设置"
          aria-label="设置"
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
          <button className="text-button" onClick={() => void openWorkspace("settings")}>在工作台管理模型与设置<Icon name="arrow" /></button>
        </section>
      )}
      {error && (
        <div className="error" role="alert">
          {error} <RecoveryAction error={error} />
        </div>
      )}
      {!settings && (!connected || connectionText === "未找到图片逆向技能") && (
        <div className="error" role="alert">{connectionText} <RecoveryAction error={connectionText} /></div>
      )}
      {!settings && !embedded && !connected && connectionText !== initialServiceStatus.connectionText && <StartCommand />}
      {connected && (!selectedModel || reverseAgent === "codex" && cliStatus && !cliStatus.installed) && !settings && <div className="model-notice">
        <span>{reverseAgent === "codex" && cliStatus && !cliStatus.installed ? "未找到 Codex CLI，请先完成安装" : "先为 QC-Reframe 选择并验证模型"}</span>
        <button className="text-button" onClick={() => openRecovery(reverseAgent === "codex" && cliStatus && !cliStatus.installed ? "cli" : "models")}>{reverseAgent === "codex" && cliStatus && !cliStatus.installed ? "检查 Codex" : "选择模型"}</button>
      </div>}

      {(visibilityNotice || (!tasksOpen && visibilityError)) && <ProjectVisibilityToast notice={visibilityNotice} error={tasksOpen ? "" : visibilityError} busy={busy} containerRef={visibilityFeedback}
        onDismiss={() => { setVisibilityNotice(undefined); setVisibilityError(""); }}
        onUndo={() => { if (visibilityNotice) void setProjectsHidden(visibilityNotice.ids, !visibilityNotice.hidden, true).catch(error => setVisibilityError(error.message)); }} />}
      {workspace && sessionPicker === drawerKey && preferences.mode === "session" && <SessionPicker value={selectedSessions()} onClose={() => setSessionPicker(undefined)} onConfirm={ids => saveInput("session", undefined, taskInstruction("session"), "", [], ids)} />}
      {workspace && newProjectOpen && <NewProject busy={busy} error={error} onClose={() => setNewProjectOpen(false)} onUpload={() => referenceInput.current?.click()} />}
      {workspace && settings && <SettingsCenter section={settingsSection} onSectionChange={setSettingsSection} connected={connected} serviceBusy={serviceBusy} onClose={() => setSettings(false)} onConnected={() => setPreferences(value => ({ ...value, paired: true }))} onSaveImageSettings={saveImageSettings} imageSettingsRevision={imageSettingsRevision} />}
      {tasksOpen && <TaskCenter workspace={workspace} visibilityError={visibilityError} unread={reminders.unread} onNoticeOpen={openNotice} showHidden={showHidden} hiddenProjectIds={hiddenProjectIds} busy={busy} onToggleHidden={() => void toggleHiddenProjects()} onClose={() => setTasksOpen(false)} onUpdate={updateJob} onOpen={async (_projectId, _mode, jobId, generationId) => {
        await sync.current?.openTask(jobId, generationId);
      }} />}
      {workspace && galleryOpen ? <ResultGallery connected={connected} revision={dataRevision} showHidden={showHidden} hiddenProjectIds={hiddenProjectIds}
        visibilityToggle={<HiddenProjectsToggle shown={showHidden} disabled={busy || !connected} onToggle={() => void toggleHiddenProjects()} />}
        onOpen={async work => {
          const revision = ++selectionRevision.current;
          setBusy(true); modeRevision.current++;
          try {
            const next = await request<Selection>({ type: "alchemy:open-project", id: work.projectId });
            if (revision !== selectionRevision.current) return;
            dispatchCreation({ type: "revision", projectId: work.projectId, revision: next.inputRevision || 0 });
            setSelection(next); setHistoryOpen(false);
            setProjectMode(work.projectId, work.mode);
            dispatchCreation({ type: "select", key: `${work.projectId}:${work.mode}`, version: work.jobId });
            setTargetGeneration({ jobId: work.jobId, id: work.generationId });
            dispatchDrawer({ type: "toggle", key: `${work.projectId}:${work.mode}:${work.jobId}`, open: true, seen: "" });
            setGalleryOpen(false);
          } finally { modeRevision.current++; setBusy(false); }
        }} /> : <div className={workspace ? "workspace-body" : undefined} data-results-open={drawerOpen} data-history={historyOpen}>
      <div ref={editor} className={workspace ? "workspace-editor" : undefined} inert={workspace && narrow && drawerOpen}>
      {!workspace && draftError && <p className="error" role="alert">{draftError}</p>}
      {generationSettingsError && <p className="error" role="alert">{generationSettingsError}</p>}
      {magpieHint && !galleryOpen && <p className="hint" role="status">{magpieHint}</p>}
      <main className={workspace && !historyOpen && !galleryOpen && selection ? "canvas-main" : undefined}>
        {historyOpen ? (
          <ProjectHistory generationModel={generationModel} hiddenProjectIds={hiddenProjectIds} pixelSize={magpie} batchDisabled={!connected || !selectedModel || generationSettingsPending || !generationReady || modelBusy || cliBusy} onTasks={() => setTasksOpen(true)} searchTarget={projectSearchTarget} workspace={workspace} projects={library.data.items.filter(visibleProject)} page={library.page} total={library.data.total} pageSize={library.data.pageSize} search={library.search} status={library.status} onStatus={library.setStatus} loading={library.loading} loadError={library.error} onPage={library.setPage} onSearch={library.setSearch} onRetry={library.refresh} busy={busy} onOpen={openProject} onDelete={deleteProjects} showHidden={showHidden} onSetHidden={setProjectsHidden} onToggleHidden={() => void toggleHiddenProjects()} />
        ) : workspace && selection ? <CanvasWorkspace onPromptRevealed={() => setTargetPrompt(undefined)} revealPrompt={targetPrompt?.jobId === job?.id ? targetPrompt?.request : undefined} contextKey={drawerKey} mode={preferences.mode}
          sessionTitle={selectedSessions().length === 1 ? selectedSessions()[0]!.title : selectedSessions().length ? `已选 ${selectedSessions().length} 个会话` : undefined} onSessions={() => setSessionPicker(drawerKey)}
          image={displayImage} subjectImage={subjectImage(preferences.mode)} subjects={multiSubjects}
          referenceIndex={contextFor(preferences.mode).referenceIndex} onImageOrder={changeImageOrder}
          selected={canvasSelections[subjectKey(preferences.mode)] || "reference"} onSelect={id => setCanvasSelections(items => ({ ...items, [subjectKey(preferences.mode)]: id }))}
          instruction={taskInstruction(preferences.mode)} onInstruction={value => changeInstruction(preferences.mode, value)}
          disabled={blocked || !!promptDraft} modeDisabled={busy || !draftReady} reverseDisabled={reverseDisabled} running={!!running} continuous={!!job?.autoGeneration || job?.id === continuousJobId} submitting={busy && startPending.current} cancelling={cancelling}
          status={reverseStatus || (promptDraft ? "编辑未保存" : reverseHint || genericHint || (preferences.mode === "session" && job?.sessionContext?.attachmentCount ? `会话含 ${job.sessionContext.attachmentCount} 个附件，未读取附件内容` : "") || (job?.status === "cancelled" ? "已取消" : ""))}
          error={referenceError || subjectError || selection.error || job?.error || job?.autoGeneration?.error} errorTaskId={!referenceError && !subjectError && !selection.error && job?.status === "failed" ? job.id : undefined} stale={instructionStale || (preferences.mode === "multi-reenact" && multiStale) || genericPrompt}
          hasPrompt={!!result} promptEditing={!!promptDraft} reduced={reduced} versions={versionSelector} actionsTarget={reverseActions}
          onMode={saveMode} onSubject={changeSubject}
          onAvailability={available => setSubjectUnavailable(items => ({ ...items, [subjectKey(preferences.mode)]: !available }))}
          onSubjects={changeSubjects}
          onReference={image => applyReferenceUpload(image, preferences.mode, taskInstruction(preferences.mode))}
          onReferenceRotate={image => applyReferenceRotation(image, preferences.mode, taskInstruction(preferences.mode))}
          onSwap={id => { if (preferences.mode !== "recreate" && preferences.mode !== "session") void swapImages(preferences.mode, taskInstruction(preferences.mode), id); }}
          onReverse={() => reverse()} onGenerate={() => reverse(true)} chainDisabled={chainDisabled} onCancel={cancel}
          onRetryReference={referenceError ? () => setReferenceErrors(items => { const next = { ...items }; delete next[job!.id]; return next; }) : undefined}
          prompt={result && job && <PromptEditor taskId={job.id} sheet result={result} draft={promptDraft} lang={lang} copied={copied} saving={!!savingPrompt} disabled={!connected} versionSelector={null} onExport={() => downloadPromptMarkdown(job)}
            onLanguage={setLang} onCopy={copy} onEdit={() => setPromptDrafts(items => ({ ...items, [job.id]: { promptZh: result.promptZh, promptEn: result.promptEn, negativePrompt: result.negativePrompt } }))}
            onDraft={draft => setPromptDrafts(items => ({ ...items, [job.id]: draft }))} onSave={savePrompt} onCancel={() => discardPrompt(job.id)} />}
        /> : !workspace ? <QuickWorkspace pixelSize={magpie} contextKey={drawerKey} revealPrompt={targetPrompt?.jobId === job?.id ? targetPrompt?.request : undefined} targetGeneration={targetGeneration?.jobId === job?.id ? targetGeneration?.id : undefined} selection={displaySelection} title={activeProject?.title} mode={preferences.mode}
          referenceIndex={contextFor(preferences.mode).referenceIndex} onImageOrder={(index, onSaved) => changeImageOrder(index, undefined, onSaved)}
          subject={subjectImage(preferences.mode)} instruction={taskInstruction(preferences.mode)} job={job}
          disabled={blocked || !!promptDraft} modeDisabled={busy || !draftReady} reverseDisabled={reverseDisabled}
          status={reverseStatus || reverseHint} stale={instructionStale || (preferences.mode === "multi-reenact" && multiStale)} cancelling={cancelling} copied={copied} lang={lang} versions={versionSelector}
          onMode={saveMode} onSubject={changeSubject}
          onAvailability={available => setSubjectUnavailable(items => ({ ...items, [subjectKey(preferences.mode)]: !available }))}
          onInstruction={value => changeInstruction(preferences.mode, value)} onReference={file => void uploadReference(file, false)}
          onRotateReference={image => applyReferenceRotation(image, preferences.mode, taskInstruction(preferences.mode))}
          onSwap={() => { if (preferences.mode !== "recreate" && preferences.mode !== "session") void swapImages(preferences.mode, taskInstruction(preferences.mode)); }}
          onReverse={() => reverse()} onGenerate={() => reverse(true)} chainDisabled={chainDisabled} continuous={!!job?.autoGeneration || job?.id === continuousJobId} submitting={busy && startPending.current} onCancel={cancel} onCopy={copy} onLanguage={setLang} onWorkspace={() => void openWorkspace()} onUpdate={updateJob} onGenerationViewUpdate={revealGeneratedImage}
          generationHint={promptDraft ? "未保存的提示词请在工作台继续编辑" : instructionStale ? "输入已修改，请重新生成提示词" : reverseStatus || (!connected ? "请先连接服务" : !generationReady ? "请在工作台配置生图渠道" : "")}
          generationDisabled={generationBlocked || !!promptDraft || needsPrompt || !!subjectUnavailable[subjectKey(preferences.mode)]}
        /> : <section className="empty"><span className="empty-mark"><Icon name="image" /></span><h1>选择一张参考图</h1></section>}

      </main>
      {workspace && !historyOpen && !galleryOpen && resultPane && generationPanel && createPortal(generationPanel, resultPane)}
      </div>
      {workspace && !historyOpen && !galleryOpen && <div className="result-drawer-slot"><aside id="workspace-results" className="workspace-results" ref={setResultPane} aria-label="生成结果抽屉" aria-hidden={!drawerOpen} inert={!drawerOpen} /></div>}
      </div>}
      {workspace && !historyOpen && !galleryOpen && selection && <div className="canvas-primary-actions" role="group" aria-label="生成操作">
        <div className="canvas-reverse-actions" ref={setReverseActions} />
        <div className="canvas-generation-actions" ref={setGenerationActions} role="group" aria-label="图片生成操作">
          {!result && <><GenerationSizeFields modelControl={generationModelControl} generationModel={generationModel} key={`${drawerKey}:${magpie}`} pixelSize={magpie} workspace value={targetSize} onChange={size => setChainSize({ key: drawerKey, pixelSize: magpie, size })} disabled={blocked || !!running} /><button className="primary generate-button" disabled><Icon name="image" />生成图片</button></>}
        </div>
      </div>}
      </div>
    </div>
    </RecoveryContext.Provider>
  );
}
