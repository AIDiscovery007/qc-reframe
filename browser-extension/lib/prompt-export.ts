import { orderedImageIds } from "./image-order.ts";
import { modeLabels } from "./mode-labels.ts";
import type { Job } from "./types";

/** A portable prompt sheet: attachment order follows the job's frozen image order, never the current input. */
export function promptMarkdown(job: Job) {
  const r = job.result;
  if (!r) return undefined;
  const subjectIds = job.mode === "multi-reenact" ? (job.reenact?.subjects || []).map((_, i) => `主体 ${i + 1}`) : job.reenact ? ["主体图"] : [];
  const order = orderedImageIds(subjectIds, job.referenceIndex ?? subjectIds.length);
  const inputs = job.mode === "recreate" ? "\n使用方法：仅使用下方提示词生图，无需附图。\n"
    : `\n使用方法：按顺序附${order.map((id, i) => `图 ${i + 1}（${id === "reference" ? "参考图" : id}）`).join("、")}，再使用下方提示词。此 Markdown 不包含图片文件或会话原文。\n`;
  return `# ${r.title}\n\n来源：${job.sourceUrl || "网页图片"}\n模式：${modeLabels[job.mode]}\n${inputs}\n## 视觉观察\n${r.observations.map((x) => `- ${x}`).join("\n")}\n\n## 中文提示词\n${r.promptZh}\n\n## English prompt\n${r.promptEn}\n\n## 排除项\n${r.negativePrompt || "无"}\n\n## 不确定性\n${r.uncertainties.join("\n") || "无额外说明"}\n`;
}

export function downloadPromptMarkdown(job: Job) {
  const markdown = promptMarkdown(job);
  if (!markdown) return;
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `qc-reframe-${job.id.slice(0, 8)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
