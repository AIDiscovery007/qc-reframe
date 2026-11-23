import type { CreationAction } from "./creation-context.ts";
import type { Job, Project, Selection } from "./types";

type Ref<T> = { current: T };

/** What a surface knows about the open project's durable inputs during one render. */
export type InputView = {
  project?: Project;
  selection?: Selection;
  viewsReady: boolean;
  inputRevisions: Record<string, number>;
  /** Bumped by every explicit open, so reopening the same revision still rehydrates. */
  reload: number;
};
export type ProjectInputsEnv = {
  request<T>(message: Record<string, unknown>): Promise<T>;
  selectionRevision: Ref<number>;
  dispatchCreation(action: CreationAction): void;
  setSelection(value: Selection | undefined): void;
  setError(value: string): void;
};

/** A loaded working input is never replaced silently when another window committed a newer revision. */
export const inputConflict = (selection: Selection | undefined, project: Project | undefined) =>
  !!selection?.inputs && (project?.inputRevision || 0) > (selection.inputRevision || 0);

export const hydrationDependencies = ({ project, selection, viewsReady, reload }: InputView) =>
  [project?.id, project?.inputRevision, viewsReady, selection?.id, reload];

/** Loads durable inputs for the open project once per revision; returns the effect cleanup. */
export function hydrateProjectInput(env: ProjectInputsEnv, view: InputView) {
  const { project, selection, viewsReady, inputRevisions } = view;
  if (!project || !viewsReady) return;
  const id = project.id, revision = project.inputRevision || 0;
  if (revision <= (inputRevisions[id] ?? 0) && selection?.inputs !== undefined) return;
  if (inputConflict(selection, project)) { env.setError("项目输入已在其他窗口更新，请重新打开项目后继续。"); return; }
  let cancelled = false;
  const snapshot = env.selectionRevision.current;
  void env.request<Selection>({ type: "alchemy:project-reference", id }).then(next => {
    if (cancelled || snapshot !== env.selectionRevision.current) return;
    env.dispatchCreation({ type: "adopt", selection: next });
    env.setSelection({ ...next, inputs: next.inputs || {} });
  }).catch(error => { if (!cancelled) env.setError(error.message); });
  return () => { cancelled = true; };
}

/** Loads a historical job's frozen reference once; a navigation cleanup discards the late snapshot. */
export function restoreJobReference(env: {
  request<T>(message: Record<string, unknown>): Promise<T>;
  setReferences(update: (items: Record<string, Selection>) => Record<string, Selection>): void;
  setReferenceErrors(update: (items: Record<string, string>) => Record<string, string>): void;
}, job: Job | undefined, known: boolean) {
  if (!job || known) return;
  let cancelled = false;
  void env.request<Selection>({ type: "alchemy:reference", id: job.id }).then(
    value => { if (!cancelled) env.setReferences(items => ({ ...items, [job.id]: value })); },
    (error: Error) => { if (!cancelled) env.setReferenceErrors(items => ({ ...items, [job.id]: error.message })); },
  );
  return () => { cancelled = true; };
}

/** Reopening is the explicit recovery path for a stale window: inputs are dropped and rehydrated. */
export async function openProject(env: ProjectInputsEnv & {
  setBusy(value: boolean): void;
  setInputReload(update: (value: number) => number): void;
  setHistoryOpen(value: boolean): void;
  setGalleryOpen(value: boolean): void;
}, id: string) {
  const revision = ++env.selectionRevision.current;
  env.setBusy(true);
  env.setError("");
  try {
    const next = await env.request<Selection>({ type: "alchemy:open-project", id });
    if (revision !== env.selectionRevision.current) return;
    env.setSelection({ ...next, inputs: undefined });
    env.setInputReload(value => value + 1);
    env.setHistoryOpen(false); env.setGalleryOpen(false);
  } catch (e) { env.setError((e as Error).message); }
  finally { env.setBusy(false); }
}
