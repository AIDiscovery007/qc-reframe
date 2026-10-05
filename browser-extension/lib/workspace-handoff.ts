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
