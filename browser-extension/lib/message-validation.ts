import type { MultiSubject } from "./types";

// Pure checks for UI messages; the background rejects malformed input before it touches storage or the bridge.
export const modes = ["style", "recreate", "reenact", "multi-reenact", "session"];
const subjectRoles = ["自动", "人物", "物品", "服饰", "场景", "细节"];
const validSubjectImage = (image: unknown) => {
  if (typeof image !== "string" || image.length > 3 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) return false;
  const data = image.slice(image.indexOf(",") + 1);
  return data.length % 4 === 0 && data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0) <= 2 * 1024 * 1024;
};
export const validSubjects = (subjects: unknown, minimum = 2): subjects is MultiSubject[] => Array.isArray(subjects)
  && subjects.length >= minimum && subjects.length <= 6
  && subjects.every(subject => subject && typeof subject === "object" && !Array.isArray(subject)
    && typeof subject.id === "string" && /^[\w-]{1,100}$/.test(subject.id)
    && (validSubjectImage(subject.subjectImage) || minimum === 0 && subject.subjectImage === "") && subjectRoles.includes(subject.role)
    && typeof subject.detail === "string" && subject.detail.length <= 2000)
  && new Set(subjects.map(subject => subject.id)).size === subjects.length;

export const validateDraft = (draft: any) => {
  if (draft !== undefined && (typeof draft !== "object" || draft === null || Array.isArray(draft) || new TextEncoder().encode(JSON.stringify(draft)).length > 8 * 1024 * 1024))
    throw new Error("草稿过大，请在工作台保存后重试");
  if (draft?.multiSubjectDrafts !== undefined && (!draft.multiSubjectDrafts || typeof draft.multiSubjectDrafts !== "object" || Array.isArray(draft.multiSubjectDrafts)
    || Object.values(draft.multiSubjectDrafts).some(subjects => !validSubjects(subjects, 0))))
    throw new Error("多图草稿无效，请重新选择主体图");
};
export const handoffContext = (context: any) => {
  if (!context || !modes.includes(context.mode)) throw new Error("无效工作台模式");
  const value = context.selection;
  if (value !== null && (!value || typeof value.id !== "string" || value.id.length > 100 || (value.projectId !== undefined && !/^[\da-f]{64}$/.test(value.projectId))
    || (value.inputRevision !== undefined && (!Number.isSafeInteger(value.inputRevision) || value.inputRevision < 0))))
    throw new Error("无效工作台项目");
  return { mode: context.mode, selection: value ? { id: value.id, projectId: value.projectId, sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl : "", capture: value.capture, inputRevision: value.inputRevision } : null };
};
