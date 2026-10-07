import { useId } from "react";

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
