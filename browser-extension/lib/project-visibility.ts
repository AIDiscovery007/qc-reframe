import type { Project, Selection } from "./types";

type Ref<T> = { current: T };
type Update<T> = T | ((current: T) => T);
export type VisibilityNotice = { ids: string[]; hidden: boolean; undone: boolean };
export type ProjectVisibilityEnv = {
  request<T>(message: Record<string, unknown>): Promise<T>;
  document: Pick<Document, "activeElement">;
  requestAnimationFrame(callback: () => void): unknown;
  /** One visibility mutation at a time; duplicates are dropped, never queued. */
  visibilityPending: Ref<boolean>;
  visibilityRevision: Ref<number>; selectionRevision: Ref<number>; projectRevision: Ref<number>; deletingProjects: Ref<boolean>;
  visibilityFeedback: Ref<HTMLElement | null>;
  setBusy(value: boolean): void;
  setVisibilityError(value: string): void;
  setVisibilityNotice(value: VisibilityNotice | undefined): void;
  setHiddenProjectIds(update: (ids: string[]) => string[]): void;
  setProject(value: Update<Project | undefined>): void;
  setSelection(value: Selection | undefined): void;
  setHistoryOpen(value: boolean): void;
  setPreferences(update: <T extends { showHiddenProjects?: boolean }>(value: T) => T): void;
  /** Reloads project lists and health after a committed change. */
  refresh(): void;
};
export type VisibilityView = { selection?: Selection; project?: Project; hiddenProjectIds: string[]; showHidden: boolean };

/**
 * Hiding/restoring projects and switching the hidden-project scope. Only server-confirmed IDs change
 * local state, and a response never replaces a project the user opened while the request was pending.
 */
export function projectVisibilityActions(env: ProjectVisibilityEnv, { selection, project, hiddenProjectIds, showHidden }: VisibilityView) {
  const setProjectsHidden = async (ids: string[], hidden: boolean, undo = false) => {
    if (env.visibilityPending.current) return [];
    const changed = [...new Set(ids)].filter(id => hiddenProjectIds.includes(id) !== hidden);
    if (!changed.length) {
      if (undo) { env.setVisibilityNotice(undefined); env.setVisibilityError("项目状态已恢复，无需撤销。"); }
      return [];
    }
    env.visibilityPending.current = true;
    const focus = env.document.activeElement;
    const keyboardFocus = focus?.matches(":focus-visible");
    env.setBusy(true); env.setVisibilityError("");
    const revision = ++env.selectionRevision.current;
    env.projectRevision.current++;
    env.deletingProjects.current = true;
    try {
      const response = await env.request<{ updatedIds: string[] }>({ type: "alchemy:set-project-hidden", ids: changed, hidden });
      const updatedIds = [...new Set(response.updatedIds)].filter(id => changed.includes(id));
      env.setHiddenProjectIds(previous => hidden ? [...new Set([...previous, ...updatedIds])] : previous.filter(id => !updatedIds.includes(id)));
      env.setProject(current => current && updatedIds.includes(current.id) ? { ...current, hidden } : current);
      if (hidden && !showHidden && selection?.projectId && updatedIds.includes(selection.projectId) && revision === env.selectionRevision.current) {
        env.setSelection(undefined); env.setProject(undefined); env.setHistoryOpen(true);
      }
      if (updatedIds.length) {
        const remaining = changed.filter(id => !updatedIds.includes(id));
        env.setVisibilityNotice(undo && remaining.length ? { ids: remaining, hidden: !hidden, undone: false } : { ids: updatedIds, hidden, undone: undo });
        if (undo && remaining.length) env.setVisibilityError(`还有 ${remaining.length} 个项目未撤销，请重试。`);
        env.requestAnimationFrame(() => { if (keyboardFocus && focus && (!focus.isConnected || focus.matches(":disabled"))) env.visibilityFeedback.current?.focus(); });
      }
      env.refresh();
      if (!updatedIds.length) {
        env.setVisibilityNotice(undefined);
        throw new Error("项目状态未变化，请刷新后重试。");
      }
      return updatedIds;
    } finally {
      env.visibilityPending.current = false; env.deletingProjects.current = false;
      env.selectionRevision.current++; env.projectRevision.current++; env.setBusy(false);
    }
  };
  const toggleHiddenProjects = async () => {
    if (env.visibilityPending.current) return;
    env.visibilityPending.current = true;
    env.setBusy(true); env.setVisibilityError("");
    env.visibilityRevision.current++;
    env.projectRevision.current++;
    const revision = env.selectionRevision.current;
    try {
      const shown = await env.request<boolean>({ type: "alchemy:show-hidden-projects", show: !showHidden });
      env.visibilityRevision.current++;
      env.setPreferences(previous => ({ ...previous, showHiddenProjects: shown }));
      if (!shown && revision === env.selectionRevision.current && (project?.hidden || (selection?.projectId && hiddenProjectIds.includes(selection.projectId)))) {
        env.selectionRevision.current++; env.setSelection(undefined); env.setProject(undefined); env.setHistoryOpen(true);
      }
    } catch (e) { env.setVisibilityError((e as Error).message); }
    finally { env.visibilityPending.current = false; env.setBusy(false); }
  };
  return { setProjectsHidden, toggleHiddenProjects };
}
