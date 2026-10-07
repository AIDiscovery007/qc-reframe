import type { Mode, MultiSubject, Project, Selection } from "./types.ts";
import type { WorkspaceDraft } from "./workspace-handoff.ts";

/** Working inputs belong to a project, mode and prompt version. Job references stay immutable. */
export type CreationState = Required<Pick<WorkspaceDraft, "instructions" | "versions" | "subjectDrafts" | "multiSubjectDrafts">> & {
  inputRevisions: Record<string, number>;
};
export const emptyCreationState: CreationState = {
  instructions: {}, versions: {}, subjectDrafts: {}, multiSubjectDrafts: {}, inputRevisions: {},
};
type ProjectViews = Record<string, { versions: Record<string, string>; inputRevision?: number }>;
type CreationAction =
  | { type: "restore"; draft: WorkspaceDraft; merge?: boolean }
  | { type: "views"; views: ProjectViews }
  | { type: "revision"; projectId: string; revision: number }
  | { type: "select"; key: string; version: string }
  | { type: "edit"; key: string; version: string; instruction?: string; subjectImage?: string }
  | { type: "adopt"; selection: Selection; savedMode?: Mode }
  | { type: "delete"; projectIds: string[] };

const without = <T>(items: Record<string, T>, discard: (key: string) => boolean) =>
  Object.fromEntries(Object.entries(items).filter(([key]) => !discard(key)));
const versionKeys = (id: string, versions: Record<string, string>) =>
  Object.fromEntries(Object.entries(versions).map(([mode, version]) => [`${id}:${mode}`, version]));

export function creationContext(state: CreationState, action: CreationAction): CreationState {
  switch (action.type) {
    case "restore": {
      const { draft, merge } = action;
      return { ...state,
        instructions: { ...(merge ? state.instructions : {}), ...draft.instructions },
        subjectDrafts: { ...(merge ? state.subjectDrafts : {}), ...draft.subjectDrafts },
        multiSubjectDrafts: { ...(merge ? state.multiSubjectDrafts : {}), ...draft.multiSubjectDrafts },
        versions: { ...state.versions, ...draft.versions },
      };
    }
    case "views": return { ...state,
      inputRevisions: Object.fromEntries(Object.entries(action.views).map(([id, view]) => [id, view.inputRevision || 0])),
      versions: Object.assign({}, ...Object.entries(action.views).map(([id, view]) => versionKeys(id, view.versions))),
    };
    case "revision": return { ...state, inputRevisions: { ...state.inputRevisions, [action.projectId]: action.revision } };
    case "select": return { ...state, versions: { ...state.versions, [action.key]: action.version } };
    case "edit": {
      const draftKey = `${action.key}:${action.version}`;
      return { ...state, versions: { ...state.versions, [action.key]: action.version },
        instructions: action.instruction === undefined ? state.instructions : { ...state.instructions, [draftKey]: action.instruction },
        subjectDrafts: action.subjectImage === undefined ? state.subjectDrafts : { ...state.subjectDrafts, [draftKey]: action.subjectImage },
      };
    }
    case "adopt": {
      const { selection, savedMode } = action, id = selection.projectId!;
      const newer = (selection.inputRevision || 0) > (state.inputRevisions[id] ?? 0);
      // A save replaces only its working draft; an externally refreshed input invalidates project drafts.
      const key = `${id}:${savedMode}:${selection.inputVersions?.[savedMode!] || "new"}`;
      const discard = (name: string) => savedMode ? name === key : newer && name.startsWith(`${id}:`);
      return { ...state,
        inputRevisions: { ...state.inputRevisions, [id]: selection.inputRevision || 0 },
        versions: newer || savedMode ? { ...state.versions, ...versionKeys(id, selection.inputVersions || {}) } : state.versions,
        instructions: without(state.instructions, discard), subjectDrafts: without(state.subjectDrafts, discard),
        multiSubjectDrafts: without(state.multiSubjectDrafts, discard),
      };
    }
    case "delete": {
      const discard = (key: string) => action.projectIds.some(id => key.startsWith(`${id}:`));
      return { instructions: without(state.instructions, discard), subjectDrafts: without(state.subjectDrafts, discard),
        multiSubjectDrafts: without(state.multiSubjectDrafts, discard), versions: without(state.versions, discard),
        inputRevisions: without(state.inputRevisions, id => action.projectIds.includes(id)) };
    }
  }
}

/** Reject stale quick-input drafts while retaining independent prompt edits and other projects. */
export function restoredQuickDraft(draft: WorkspaceDraft, projectId: string | undefined, stale: boolean, views: ProjectViews): WorkspaceDraft {
  const discard = (key: string) => stale && key.startsWith(`${projectId}:`);
  return { ...draft, instructions: without(draft.instructions || {}, discard),
    subjectDrafts: without(draft.subjectDrafts || {}, discard), multiSubjectDrafts: without(draft.multiSubjectDrafts || {}, discard),
    versions: without(draft.versions || {}, key => discard(key) || !!views[key.slice(0, key.indexOf(":"))]),
  };
}

export function resolveCreation(state: CreationState, selection: Selection | undefined, project: Project | undefined,
  references: Record<string, Selection>, mode: Mode, defaultInstruction: string) {
  const jobs = project?.id === selection?.projectId ? project?.jobs.filter(job => job.mode === mode) || [] : [];
  const key = `${selection?.projectId || selection?.id}:${mode}`;
  const job = state.versions[key] === "new" ? undefined : jobs.find(job => job.id === state.versions[key]) || jobs[0];
  const draftKey = `${key}:${job?.id || "new"}`;
  const input = !job || job.id === selection?.inputVersions?.[mode] ? selection?.inputs?.[mode] : undefined;
  const reference = job && references[job.id];
  const subjectImage = state.subjectDrafts[draftKey] ?? (input ? input.subjectImage || "" : undefined)
    ?? reference?.generationSubjectImage ?? reference?.reenact?.subjectImage ?? "";
  const subjects = state.multiSubjectDrafts[draftKey] ?? input?.subjects ?? reference?.generationSubjects ?? reference?.reenact?.subjects ?? [];
  const instruction = state.instructions[draftKey] ?? input?.instruction ?? job?.instruction ?? job?.reenact?.basePrompt ?? defaultInstruction;
  const savedSubjects = reference?.reenact?.subjects || [];
  const instructionStale = !!job?.result && instruction.trim() !== (job.instruction ?? job.reenact?.basePrompt ?? defaultInstruction).trim();
  const multiStale = !!job?.result && (subjects.length !== savedSubjects.length || subjects.some((item, index) => {
    const saved = savedSubjects[index];
    return !saved || item.id !== saved.id || item.subjectImage !== saved.subjectImage || item.role !== saved.role || item.detail !== saved.detail;
  }) || instruction.trim() !== (job.instruction ?? job.reenact?.basePrompt)?.trim());
  return { key, draftKey, jobs, job, input, subjectImage, subjects, instruction, instructionStale, multiStale,
    sessions: input?.sessions ?? job?.sessionContext?.sources ?? [], image: job ? reference?.image : selection?.image };
}

type InputSave = {
  selection: Selection; mode: Mode; referenceJobId?: string; image?: string; instruction: string;
  subjectImage?: string; subjects?: MultiSubject[]; sessionIds?: string[];
};

/** One writer owns the in-flight input commit. Navigation invalidates delivery, never the durable write. */
export function createInputWriter(send: (message: Record<string, unknown>) => Promise<Selection>,
  scope: () => { context: object; revision: number }) {
  let pending = false;
  return {
    get pending() { return pending; },
    async save(input: InputSave, commit: (selection: Selection) => void) {
      if (pending || !input.selection.projectId) throw new Error("当前无法修改图片，请稍后重试");
      const started = scope();
      pending = true;
      try {
        const { selection, mode, referenceJobId, image, instruction, subjectImage, subjects, sessionIds } = input;
        const next = await send({ type: "alchemy:update-project-input", projectId: selection.projectId,
          expectedRevision: selection.inputRevision || 0, referenceJobId, image, mode, instruction,
          ...(mode === "session" ? { sessionIds } : mode === "multi-reenact" ? { subjects } : mode !== "recreate" ? { subjectImage } : {}),
        });
        const current = scope();
        if (started.context !== current.context || started.revision !== current.revision) return;
        commit(next);
        return next;
      } finally { pending = false; }
    },
  };
}
