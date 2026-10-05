export type SessionSummary = { id: string; title: string; updatedAt: number };
export type SessionIndexIssue = { code: "content_limit" | "response_limit" | "page_limit" | "index_capacity" | "changed" | "timeout" | "read_failed"; count: number };
export type SessionIndexStatus = { state: "empty" | "stale" | "building" | "partial" | "ready"; indexed: number; processed?: number; total: number; failed: number; issues?: SessionIndexIssue[]; updatedAt: number | null; error?: string };
export type SessionSearchResult = SessionSummary & { match?: "title" | "content"; snippet?: string };
export type SessionPage = { data: SessionSearchResult[]; nextCursor: string | null; index?: SessionIndexStatus };
export type SessionContext = { sources: SessionSummary[]; snapshotId?: string; hash?: string; capturedAt?: string; messageCount?: number; attachmentCount?: number };

export type Mode = "style" | "recreate" | "reenact" | "multi-reenact" | "session";
export type MultiSubject = { id: string; subjectImage: string; role: string; detail: string };
export type SavedSubject = Omit<MultiSubject, "subjectImage"> & { subjectAsset: string };
export type SubjectInput = {
  subjectImage?: string;
  subjects?: MultiSubject[];
  basePrompt: string; // User task instruction; keep the field name for saved jobs.
  promptSourceJobId?: string;
};
export type Preferences = { token: string; mode: Mode };
export type ProjectInput = {
  sessions?: SessionSummary[]; instruction: string; subjectError?: string; subjectImage?: string; subjects?: MultiSubject[] };
export type Selection = {
  id: string;
  projectId?: string;
  inputRevision?: number;
  inputVersions?: Partial<Record<Mode, string>>;
  inputs?: Partial<Record<Mode, ProjectInput>>;
  sourceUrl: string;
  image?: string;
  capture?: "original" | "screenshot";
  stage?: string;
  error?: string;
  jobId?: string;
  instruction?: string;
  reenact?: SubjectInput; // Shared two-image input; retain the saved field name.
  subjectError?: string;
  generationSubjectImage?: string;
  generationSubjects?: MultiSubject[];
};
export type Result = {
  title: string;
  observations: string[];
  promptZh: string;
  promptEn: string;
  negativePrompt: string;
  uncertainties: string[];
};
export type Job = {
  sessionContext?: SessionContext;
  id: string;
  projectId?: string;
  imageAsset?: string;
  subjectAsset?: string;
  mode: Mode;
  instruction?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  stage: string;
  createdAt: string;
  sourceUrl: string;
  capture: "original" | "screenshot";
  result?: Result;
  error?: string;
  threadId?: string;
  model?: string;
  reasoningEffort?: string;
  reenact?: Omit<SubjectInput, "subjectImage" | "subjects"> & { subjects?: SavedSubject[] };
  generations?: Generation[];
};
export type ProjectSummary = {
  id: string;
  imageAsset?: string;
  inputRevision?: number;
  inputVersions?: Partial<Record<Mode, string>>;
  hidden?: boolean;
  title: string;
  createdAt: string;
  updatedAt: string;
  sourceUrl: string;
  capture: "original" | "screenshot";
  jobCount: number;
  busy: boolean;
  revision?: string;
  cover?: { jobId: string; generationId: string; imageAsset?: string };
  modes: Partial<Record<Mode, { status: string; hasImage: boolean }>>;
};
export type ImageThumbnail = {
  image: string;
  source?: { kind: "reference" } | { kind: "generation"; jobId: string; generationId: string };
};
export type Project = ProjectSummary & { jobs: Job[] };
export type ProjectPage = { items: ProjectSummary[]; total: number; page: number; pageSize: number; revision: string };
export type AspectRatio = { width: number; height: number };
export type Generation = {
  id: string;
  subjects?: SavedSubject[];
  imageAsset?: string;
  subjectAsset?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  stage: string;
  createdAt: string;
  language: "zh" | "en";
  aspectRatio?: AspectRatio;
  prompt: string;
  negativePrompt: string;
  threadId?: string;
  model?: string;
  reasoningEffort?: string;
  extension?: "png" | "jpeg" | "webp";
  subjectExtension?: "png" | "jpeg" | "webp";
  revisedPrompt?: string;
  error?: string;
};
export type CollectionResult = { projectId: string; created: boolean };
export type ImageTarget = {
  captureId?: string;
  src: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
    viewportWidth: number;
    viewportHeight: number;
  };
};

export type ModelCatalog = {
  accountLabel?: string;
  selected: string | null;
  reasoningEffort?: string;
  verifiedAt?: string;
  models: { model: string; label: string; isDefault: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[]; status: "verified" | "unverified" | "unavailable" }[];
  verification?: { model: string; reasoningEffort?: string; status: "running" | "completed" | "failed"; error?: string };
};

export type GalleryWork = {
  id: string;
  hidden?: boolean;
  projectId: string;
  projectTitle: string;
  jobId: string;
  generationId: string;
  mode: Mode;
  version: number;
  title: string;
  createdAt: string;
  width: number;
  height: number;
};
export type GalleryPage = {
  items: GalleryWork[];
  total: number;
  totalWorks: number;
  projectCount: number;
  projects: { id: string; title: string }[];
  revision: string;
  offset: number;
  limit: number;
};
