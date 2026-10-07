import { useId } from "react";
import type { Mode } from "../../lib/types";

export const defaultInstructions: Record<Mode, string> = {
  session: "提取参考图的风格，结合所选会话的完整上下文，生成符合本次创作目标的图片提示词。",
  style: "提取参考图的配色、光影、笔触和材质表现，生成可迁移的风格提示词；如提供主体图，保留主体的身份、内容、姿态、表情、服饰、构图与背景结构，仅迁移参考图的画法。",
  recreate: "分析参考图的主体、内容、构图、配色、光影与材质，生成可独立用于文生图的完整复刻提示词。",
  reenact: "以主体图提供主体身份，以参考图提供风格、构图、姿态与关系，生成风格转换与主体重演提示词。",
  "multi-reenact": "将各主体融合在同一画面中，重演参考模板的画风、构图、姿态与光影，保留每张主体图指定的特征。",
};

export default function TaskInstruction({ value, disabled, onChange }: {
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const id = useId();
  return <div className="task-instruction">
    <textarea id={id} name="instruction" aria-label="任务指令" rows={3} maxLength={20000} value={value} disabled={disabled}
      placeholder="描述本次逆向的目标，以及希望保留或调整的内容。" onChange={event => onChange(event.target.value)} />
  </div>;
}
