import type { CreationState } from "./creation-context";
import type { RecoverySection } from "./codex-status";
import type { Job, Mode, MultiSubject, Selection } from "./types";

export type PromptDraft = Pick<NonNullable<Job["result"]>, "promptZh" | "promptEn" | "negativePrompt">;
export type WorkspaceDraft = {
  multiSubjectDrafts?: Record<string, MultiSubject[]>;
  subjectDrafts?: Record<string, string>;
  promptDrafts?: Record<string, PromptDraft>;
  instructions?: Record<string, string>;
  versions?: Record<string, string>;
  lang?: "zh" | "en";
};
export type WorkspaceContext = { mode: Mode; selection: Pick<Selection, "id" | "projectId" | "sourceUrl" | "capture" | "inputRevision"> | null };
export type WorkspaceHandoff = WorkspaceContext & { draft?: WorkspaceDraft; createdAt: number };

/** A handoff names its source by reference; image data never travels with it. */
export const workspaceContext = (mode: Mode, selection?: Selection): WorkspaceContext => ({ mode, selection: selection ? {
  id: selection.id, projectId: selection.projectId, sourceUrl: selection.sourceUrl, capture: selection.capture, inputRevision: selection.inputRevision,
} : null });

/** Unsaved working state, pinned to the version currently shown so the receiving surface opens the same lane. */
export function draftSnapshot(creation: Pick<CreationState, "multiSubjectDrafts" | "subjectDrafts" | "instructions" | "versions">,
  { promptDrafts, lang, shown }: { promptDrafts: Record<string, PromptDraft>; lang: "zh" | "en"; shown?: { key: string; version: string } }): WorkspaceDraft {
  const { multiSubjectDrafts, subjectDrafts, instructions, versions } = creation;
  return { multiSubjectDrafts, subjectDrafts, instructions, promptDrafts, lang,
    versions: shown ? { ...versions, [shown.key]: shown.version } : versions };
}

/** Only the source project's drafts move to the workspace; other projects' edits stay where they were made. */
export function projectDraft(draft: WorkspaceDraft, projectKey: string | undefined, jobIds: string[]): WorkspaceDraft {
  const prefix = `${projectKey}:`;
  const own = <T,>(items: Record<string, T> = {}) => Object.fromEntries(Object.entries(items).filter(([key]) => key.startsWith(prefix)));
  return { multiSubjectDrafts: own(draft.multiSubjectDrafts), subjectDrafts: own(draft.subjectDrafts), instructions: own(draft.instructions),
    versions: own(draft.versions), lang: draft.lang,
    promptDrafts: Object.fromEntries(Object.entries(draft.promptDrafts || {}).filter(([id]) => jobIds.includes(id))) };
}

/** Opens (or focuses) the workspace once at a time; a blocked surface reports why instead of handing off. */
export function createWorkspaceOpener(io: {
  request(message: Record<string, unknown>): Promise<unknown>;
  setBusy(value: boolean): void;
  setError(value: string): void;
}) {
  let pending = false;
  return async ({ blocked, view, section, context, draft }: {
    blocked: boolean; view?: "tasks" | "settings"; section?: RecoverySection; context: WorkspaceContext; draft: WorkspaceDraft;
  }) => {
    if (pending) return;
    if (blocked) { io.setError("正在处理当前输入，请完成后再打开工作台"); return; }
    pending = true;
    io.setBusy(true); io.setError("");
    try { await io.request({ type: "alchemy:open-workspace", view, section, context, draft }); }
    catch (e) { io.setError((e as Error).message); }
    finally { pending = false; io.setBusy(false); }
  };
}
