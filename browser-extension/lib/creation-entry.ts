import type { query, request } from "./client";
import type { Job, Selection } from "./types";
import type { WorkspaceHandoff } from "./workspace-handoff";

type Entry = { handoff: string } | { task: string };
type EntryEvent =
  | { kind: "handoff-source"; handoff: WorkspaceHandoff }
  | { kind: "handoff"; handoff: WorkspaceHandoff; selection: Selection | undefined; freshness: "fresh" | "stale" | "unavailable" }
  | { kind: "reminder"; job: Job; selection: Selection }
  | { kind: "error"; message: string };

export function createEntryReader(io: { request: typeof request; query: typeof query; revision: () => number }) {
  let disposed = false;
  return {
    async read(entry: Entry, accept: (event: EntryEvent) => void): Promise<void> {
      const revision = io.revision();
      const current = () => !disposed && revision === io.revision();
      if (!current()) return;
      try {
        if ("task" in entry) {
          const job = await io.query<Job>(`/jobs/${entry.task}`);
          if (!current()) return;
          const selection = await io.request<Selection>({ type: "alchemy:project-reference", id: job.projectId });
          if (current()) accept({ kind: "reminder", job, selection });
          return;
        }

        const handoff = await io.request<WorkspaceHandoff | undefined>({ type: "alchemy:workspace-handoff", id: entry.handoff });
        if (!current()) return;
        if (!handoff) throw new Error("接续草稿已失效，请从快捷面板重新打开工作台");
        accept({ kind: "handoff-source", handoff });
        // Source adoption can itself navigate or dispose the reader.
        if (!current()) return;
        const source = handoff.selection;
        let selection: Selection | undefined;
        let freshness: "fresh" | "stale" | "unavailable" = "unavailable";
        if (source?.projectId) {
          try {
            const reference = await io.request<Selection>({ type: "alchemy:project-reference", id: source.projectId });
            if (!current()) return;
            freshness = (source.inputRevision || 0) === (reference.inputRevision || 0) ? "fresh" : "stale";
            selection = freshness === "stale" ? { ...reference, inputs: undefined } : reference;
          } catch (error) {
            if (!current()) return;
            selection = { ...source, error: (error as Error).message };
          }
        } else if (source) selection = { ...source, error: "参考图尚未保存，请重新上传" };
        if (current()) accept({ kind: "handoff", handoff, selection, freshness });
      } catch (error) {
        if (current()) accept({ kind: "error", message: (error as Error).message });
      }
    },
    dispose() { disposed = true; },
  };
}
