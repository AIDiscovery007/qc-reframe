import type { resolveCreation } from "./creation-context";
import type { Mode, SubjectInput } from "./types";

export function deriveReverseAction({ mode, context, hasSelection, referenceError, subjectUnavailable,
  blocked, generationBlocked, promptEditing, sizeValid }: {
  mode: Mode;
  context: ReturnType<typeof resolveCreation>;
  hasSelection: boolean;
  referenceError?: string;
  subjectUnavailable: boolean;
  blocked: boolean;
  generationBlocked: boolean;
  promptEditing: boolean;
  sizeValid: boolean;
}) {
  const { job, image, subjectImage, subjects, instruction, subjectError } = context;
  const instructionStale = context.instructionStale || context.orderStale;
  const genericPrompt = !!job?.result && mode === "style" && !job.reenact;
  const needsPrompt = !job?.result || instructionStale || (mode === "multi-reenact" && context.multiStale) || genericPrompt;
  const genericHint = mode === "style" && !subjectImage ? "添加主体图后可逆向并生图；也可仅逆向通用风格" : "";
  const reverseHint = !hasSelection ? "先选择一张参考图。" : referenceError ? "历史参考图不可用，请重新上传参考图。" : !image ? "等待参考图读取完成。"
    : subjectError ? subjectError
    : subjectUnavailable ? "主体图尚未就绪，请完成上传。"
    : mode === "reenact" && !subjectImage ? "先上传主体图。"
    : mode === "multi-reenact" && (subjects.length < 2 || subjects.some(item => !item.subjectImage)) ? "请添加至少 2 张可用的主体图。"
    : mode === "session" && !context.sessions.length ? "先选择对话会话。"
    : !instruction.trim() ? "填写任务指令后可生成提示词。"
    : "";
  const reverseDisabled = blocked || !!reverseHint || promptEditing;
  const chainDisabled = reverseDisabled || generationBlocked || (mode === "style" && !subjectImage) || !sizeValid;
  let reenact: SubjectInput | undefined;
  if (mode === "multi-reenact") reenact = { subjects, basePrompt: instruction };
  else if ((mode === "style" || mode === "reenact") && subjectImage) reenact = { subjectImage, basePrompt: instruction };
  return { instructionStale, genericPrompt, needsPrompt, subjectError, genericHint, reverseHint, reverseDisabled, chainDisabled, reenact };
}
