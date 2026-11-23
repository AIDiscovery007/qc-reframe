import { createEntryReader } from "./creation-entry.ts";
import { restoredQuickDraft, type CreationAction } from "./creation-context.ts";
import type { UiState } from "./client";
import type { RecoverySection } from "./codex-status";
import type { ResultDrawerAction } from "./result-drawer";
import type { TaskNotice } from "./task-reminders";
import type { Mode, Project, Selection } from "./types";
import type { PromptDraft, WorkspaceDraft, WorkspaceHandoff } from "./workspace-handoff";

type Ref<T> = { current: T };
type Preferences = UiState["preferences"];
type ProjectViews = Record<string, { mode: Mode; versions: Record<string, string>; inputRevision?: number }>;

/** Everything the surface writes or reads; App passes its state setters and revision refs. */
export type SurfaceSyncEnv = {
  workspace: boolean;
  request<T>(message: Record<string, unknown>): Promise<T>;
  query<T>(path: string): Promise<T>;
  readState(selectionId?: string, selectionJobId?: string): Promise<UiState>;
  pollWhileVisible(refresh: () => Promise<number>): () => void;
  location: Pick<Location, "search" | "hash" | "pathname">;
  history: Pick<History, "replaceState">;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
  modeRevision: Ref<number>; visibilityRevision: Ref<number>; selectionRevision: Ref<number>; deletingProjects: Ref<boolean>;
  dispatchCreation(action: CreationAction): void;
  dispatchDrawer(action: ResultDrawerAction): void;
  setPreferences(update: (value: Preferences) => Preferences): void;
  setProjectModes(value: Record<string, Mode>): void;
  setProjectMode(projectId: string | undefined, mode: Mode): void;
  setViewsReady(value: boolean): void;
  setSelection(value: Selection | undefined | ((current: Selection | undefined) => Selection | undefined)): void;
  setProject(value: Project | undefined): void;
  setPromptDrafts(value: Record<string, PromptDraft> | ((current: Record<string, PromptDraft>) => Record<string, PromptDraft>)): void;
  setLang(value: "zh" | "en"): void;
  setDraftReady(value: boolean): void;
  setDraftError(value: string): void;
  setError(value: string): void;
  setSettings(value: boolean): void;
  setSettingsSection(value: RecoverySection): void;
  setNewProjectOpen(value: boolean): void;
  setHistoryOpen(value: boolean): void;
  setGalleryOpen(value: boolean): void;
  setTasksOpen(value: boolean): void;
  setTargetGeneration(value: { jobId: string; id: string } | undefined): void;
  setTargetPrompt(value: { jobId: string; request: number } | undefined): void;
};
export type SurfaceSync = ReturnType<typeof createSurfaceSync>;

const settingsSections = new Set<RecoverySection>(["models", "generation", "connection", "pi-cli"]);

/**
 * Keeps one Reframe surface (quick panel or workspace) in step with the background: restores
 * drafts and project views, consumes handoff/reminder entries, and polls the global selection.
 * A surface that navigated on its own ignores the global selection until a new image is collected.
 */
export function createSurfaceSync(env: SurfaceSyncEnv) {
  const { workspace, request, query, selectionRevision } = env;
  let cancelled = false;
  let ready = false;
  let stopPolling = () => {};
  let previous: Selection | undefined;
  let initialized = false;
  let ownContext = false;
  let lastGlobalSelection: string | null | undefined;
  let quickRestored = workspace;
  let savedQuick: WorkspaceHandoff | undefined;
  const entryReader = createEntryReader({ request, query, revision: () => selectionRevision.current });
  const restoreDraft = (draft?: WorkspaceDraft, merge = false) => {
    if (!draft) return;
    env.dispatchCreation({ type: "restore", draft, merge });
    env.setPromptDrafts(merge ? value => ({ ...value, ...draft.promptDrafts }) : draft.promptDrafts || {});
    env.setLang(draft.lang || "zh");
  };
  const refresh = async () => {
    try {
      const revision = env.modeRevision.current;
      const visibility = env.visibilityRevision.current;
      const snapshotRevision = selectionRevision.current;
      const value = await env.readState(previous?.image ? previous.id : undefined, previous?.jobId);
      if (cancelled || snapshotRevision !== selectionRevision.current) return 1500;
      const firstRefresh = !initialized;
      const globalSelection = value.selection?.id || null;
      const selectionChanged = lastGlobalSelection !== undefined && globalSelection !== lastGlobalSelection;
      lastGlobalSelection = globalSelection;
      env.setPreferences(current => ({ ...value.preferences,
        mode: firstRefresh && !ownContext && revision === env.modeRevision.current && revision % 2 === 0
          ? savedQuick && savedQuick.selection?.projectId === value.selection?.projectId && savedQuick.selection?.id === value.selection?.id ? savedQuick.mode : value.preferences.mode
          : current.mode,
        showHiddenProjects: visibility === env.visibilityRevision.current ? value.preferences.showHiddenProjects : current.showHiddenProjects,
      }));
      initialized = true;
      env.setDraftReady(quickRestored);
      if (workspace && (ownContext || !firstRefresh)) return 1500;
      if (!workspace && ownContext) {
        if (!selectionChanged) return 1500;
        ownContext = false;
      }
      if (env.deletingProjects.current || snapshotRevision !== selectionRevision.current) return 1500;
      if (!value.selection) {
        previous = undefined;
        env.setSelection(undefined);
        env.setProject(undefined);
      } else {
        const next = { ...value.selection,
          image: value.selection.image || (previous?.id === value.selection.id ? previous.image : undefined),
        };
        if (previous?.id !== next.id) { if (!firstRefresh) { env.setHistoryOpen(false); env.setGalleryOpen(false); } env.setError(""); }
        previous = next;
        env.setSelection(current => current?.projectId === next.projectId && current?.inputs && (next.inputRevision || 0) > (current.inputRevision || 0)
          ? current : current?.id === next.id ? { ...next, inputs: current.inputs } : next);
      }
    } catch (e) { if (!cancelled) env.setError((e as Error).message); }
    return 1500;
  };
  const navigateReminder = async (params: URLSearchParams) => {
    const revision = ++selectionRevision.current;
    env.setSettings(false); env.setNewProjectOpen(false);
    if (params.get("tasks") === "unread") { env.setTasksOpen(true); return; }
    const taskId = params.get("task");
    if (!taskId || !/^[\da-f-]{36}$/.test(taskId)) return;
    ownContext = true;
    await entryReader.read({ task: taskId }, event => {
      if (event.kind === "error") { env.setError(event.message); return; }
      if (event.kind !== "reminder") return;
      const { job: target, selection: reference } = event;
      previous = reference; env.setSelection(reference);
      env.dispatchCreation({ type: "revision", projectId: reference.projectId!, revision: reference.inputRevision || 0 });
      env.setHistoryOpen(false); env.setGalleryOpen(false); env.setTasksOpen(false); env.setError("");
      env.setProjectMode(target.projectId, target.mode);
      env.dispatchCreation({ type: "select", key: `${target.projectId}:${target.mode}`, version: target.id });
      const generationId = params.get("generation");
      const image = !!generationId && !!target.generations?.some(item => item.id === generationId);
      env.setTargetGeneration(image ? { jobId: target.id, id: generationId! } : undefined);
      env.setTargetPrompt(image ? undefined : { jobId: target.id, request: revision });
      env.dispatchDrawer({ type: "toggle", key: `${target.projectId}:${target.mode}:${target.id}`, open: image, seen: "" });
    });
  };
  const navigateHandoff = async (params: URLSearchParams, merge = true) => {
    const id = params.get("handoff");
    selectionRevision.current++;
    ownContext = true;
    if (id === null) return;
    await entryReader.read({ handoff: id }, event => {
      if (event.kind === "error") { env.setError(event.message); return; }
      if (event.kind === "handoff-source") {
        const { handoff } = event;
        env.setSettings(false); env.setNewProjectOpen(false); env.setHistoryOpen(false); env.setGalleryOpen(false); env.setTasksOpen(false); env.setError("");
        env.setProjectMode(handoff.selection?.projectId, handoff.mode);
        previous = handoff.selection || undefined;
        env.setSelection(previous);
        if (!previous) env.setProject(undefined);
        return;
      }
      if (event.kind !== "handoff") return;
      const { handoff, selection: reference, freshness } = event;
      const projectId = handoff.selection?.projectId;
      if (freshness === "fresh" && projectId && reference) {
        restoreDraft(handoff.draft, merge);
        env.dispatchCreation({ type: "revision", projectId, revision: reference.inputRevision || 0 });
      } else if (freshness === "stale" && projectId) {
        env.dispatchCreation({ type: "revision", projectId, revision: -1 });
        env.setError("项目输入已更新，已打开最新输入；旧窗口草稿未覆盖当前项目。");
      }
      if (freshness !== "unavailable") previous = reference;
      env.setSelection(reference);
      if (params.get("view") === "settings") {
        const section = params.get("section") as RecoverySection | null;
        env.setSettingsSection(section && settingsSections.has(section) ? section : "cli");
        env.setSettings(true);
      }
      if (params.get("view") === "tasks") env.setTasksOpen(true);
    });
  };
  const onHashChange = () => {
    const { location } = env;
    if (!workspace || !/^#(?:reminder|workspace)=/.test(location.hash)) return;
    const params = new URLSearchParams(location.hash.slice(location.hash.indexOf("=") + 1));
    env.history.replaceState(null, "", location.pathname + location.search);
    void (params.has("handoff") ? navigateHandoff(params) : navigateReminder(params));
  };
  const consumeSearch = (params: URLSearchParams, keys: string[]) => {
    for (const key of keys) params.delete(key);
    env.history.replaceState(null, "", env.location.pathname + (params.size ? `?${params}` : "") + env.location.hash);
  };
  const initialize = async () => {
    let views: ProjectViews = {};
    try {
      views = await request<ProjectViews>({ type: "alchemy:project-views" }) || {};
      if (cancelled) return;
      env.setProjectModes(Object.fromEntries(Object.entries(views).map(([id, view]) => [id, view.mode])));
      env.dispatchCreation({ type: "views", views });
      env.setViewsReady(true);
    } catch (error) { if (!cancelled) env.setError(`项目选择恢复失败：${(error as Error).message}`); }
    const params = new URLSearchParams(env.location.search);
    if (workspace && (params.has("task") || params.get("tasks") === "unread")) {
      await navigateReminder(params);
      consumeSearch(params, ["task", "tasks", "generation"]);
    }
    if (workspace && params.has("handoff")) {
      await navigateHandoff(params, false);
      consumeSearch(params, ["handoff", "view"]);
    }
    if (!workspace) {
      try {
        savedQuick = await request<WorkspaceHandoff | undefined>({ type: "alchemy:quick-draft" });
        if (cancelled) return;
        const projectId = savedQuick?.selection?.projectId;
        const current = projectId ? await request<Selection>({ type: "alchemy:project-reference", id: projectId }) : undefined;
        if (cancelled) return;
        const stale = !!projectId && (savedQuick?.selection?.inputRevision || 0) !== (current?.inputRevision || 0);
        if (projectId && !stale) env.dispatchCreation({ type: "revision", projectId, revision: current?.inputRevision || 0 });
        if (savedQuick?.draft) restoreDraft(restoredQuickDraft(savedQuick.draft, projectId, stale, views));
        if (savedQuick && !views[savedQuick.selection?.projectId || ""]) env.setProjectMode(savedQuick.selection?.projectId, savedQuick.mode);
      } catch (error) {
        if (!cancelled) env.setDraftError(`草稿恢复失败：${(error as Error).message}`);
      }
      quickRestored = true;
    }
    if (cancelled) return;
    ready = true;
    stopPolling = env.pollWhileVisible(refresh);
    if (workspace) { env.window.addEventListener("hashchange", onHashChange); onHashChange(); }
  };
  const route = (params: URLSearchParams) => {
    if (!ready) { env.setError("正在恢复界面，请稍后重试"); return Promise.resolve(); }
    return navigateReminder(params);
  };
  return {
    start() { void initialize(); },
    dispose() {
      cancelled = true; ready = false;
      entryReader.dispose(); stopPolling();
      env.window.removeEventListener("hashchange", onHashChange);
    },
    /** Opens a toast/unread entry inside this surface; never opens a tab or changes the host URL. */
    openNotice(notice?: Pick<TaskNotice, "jobId" | "generationId">) {
      return route(new URLSearchParams(notice
        ? { task: notice.jobId, ...(notice.generationId ? { generation: notice.generationId } : {}) }
        : { tasks: "unread" }));
    },
    /** Task-center navigation; silently waits for initialization instead of reporting an error. */
    async openTask(jobId: string, generationId?: string) {
      if (ready) await navigateReminder(new URLSearchParams({ task: jobId, ...(generationId ? { generation: generationId } : {}) }));
    },
    navigateReminder,
    navigateHandoff,
    onHashChange,
  };
}
