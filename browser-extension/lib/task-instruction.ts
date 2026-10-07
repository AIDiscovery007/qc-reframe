import type { Mode } from "./types";
import { orderedImageIds } from "./image-order.ts";

export const defaultInstructions: Record<Mode, string> = {
  session: "提取参考图的风格，结合所选会话的完整上下文，生成符合本次创作目标的图片提示词。",
  style: "提取参考图的配色、光影、笔触和材质表现，生成可迁移的风格提示词；如提供主体图，保留主体的身份、内容、姿态、表情、服饰、构图与背景结构，仅迁移参考图的画法。",
  recreate: "分析参考图的主体、内容、构图、配色、光影与材质，生成可独立用于文生图的完整复刻提示词。",
  reenact: "以主体图提供主体身份，以参考图提供风格、构图、姿态与关系，生成风格转换与主体重演提示词。",
  "multi-reenact": "将各主体融合在同一画面中，重演参考模板的画风、构图、姿态与光影，保留每张主体图指定的特征。",
};

export function numberedDefaultInstruction(mode: Mode, subjectCount: number, referenceIndex: number) {
  const images = orderedImageIds(Array.from({ length: subjectCount }, (_, index) => String(index)), referenceIndex);
  const reference = `图 ${images.indexOf("reference") + 1}`;
  const subjects = images.flatMap((id, index) => id === "reference" ? [] : [`图 ${index + 1}`]);
  let instruction = defaultInstructions[mode].replaceAll("参考图", `${reference}（参考图）`).replaceAll("参考模板", `${reference}（参考模板）`);
  if (mode === "multi-reenact" && subjects.length) instruction = instruction.replace("各主体", `${subjects.join("、")}提供的各主体`);
  else if (subjects.length) instruction = instruction.replaceAll("主体图", `${subjects[0]}（主体图）`);
  return instruction;
}

// Only exact built-in defaults are managed. Never rewrite arbitrary user-authored image numbers.
const managedDefaults = Object.fromEntries(Object.keys(defaultInstructions).map(key => {
  const mode = key as Mode, texts = new Set([defaultInstructions[mode]]);
  for (let count = 0; count <= (mode === "multi-reenact" ? 6 : mode === "style" || mode === "reenact" ? 1 : 0); count++)
    for (let index = 0; index <= count; index++) texts.add(numberedDefaultInstruction(mode, count, index));
  return [mode, texts];
})) as Record<Mode, Set<string>>;
managedDefaults.reenact.add("以图 1 为主体，以图 2 为风格参考模板，生成基于图 1 的风格转换与主体重演提示词。");

export function adaptDefaultInstruction(value: string, mode: Mode, subjectCount: number, referenceIndex: number) {
  return managedDefaults[mode].has(value) ? numberedDefaultInstruction(mode, subjectCount, referenceIndex) : value;
}
