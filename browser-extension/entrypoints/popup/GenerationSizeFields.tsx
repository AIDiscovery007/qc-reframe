import { useId, useState } from "react";
import { validImageSize } from "../../lib/image-size.mjs";
import { validGenerationRatio } from "../../lib/generation-session";
import { parseImageDimensions } from "../../lib/generation-size";
import type { ImageSize } from "../../lib/types";
import SelectField from "./SelectField";

const ratios = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"];
const pixels = ["1024:1024", "1536:1024", "1024:1536", "2048:2048"];

export default function GenerationSizeFields({ pixelSize = false, value, onChange, disabled, workspace = false }: {
  pixelSize?: boolean; value?: ImageSize; onChange(size?: ImageSize): void; disabled?: boolean; workspace?: boolean;
}) {
  const presets = pixelSize ? pixels : ratios;
  const initial = value ? `${value.width}:${value.height}` : "auto";
  const [choice, setChoice] = useState(presets.includes(initial) || initial === "auto" ? initial : "custom");
  const [width, setWidth] = useState(String(value?.width || (pixelSize ? 1024 : 1)));
  const [height, setHeight] = useState(String(value?.height || (pixelSize ? 1024 : 1)));
  const [touched, setTouched] = useState(false);
  const hintId = useId();
  const valid = pixelSize ? validImageSize(value) : validGenerationRatio(value);
  const message = pixelSize ? "宽高各为 1–10000 的整数，总像素不超过 4000 万；实际尺寸以模型返回为准。" : "宽高请填 1–10000 的整数，比例范围为 1:20–20:1。";
  return <div className="generation-ratio" data-pixel-size={pixelSize || undefined}>
    {choice === "custom" && <p id={hintId} className={`ratio-hint${touched && !valid ? " ratio-error" : ""}`} role={touched && !valid ? "status" : undefined}>{message}</p>}
    <div className="generation-ratio-fields">
      <SelectField label={pixelSize || workspace ? "目标尺寸" : "图片比例"} aria-label={pixelSize || workspace ? "目标尺寸" : "图片比例"} title={pixelSize ? "像素尺寸；自动使用 Magpie 网关默认" : "按宽高比例生成，实际像素以结果为准"} value={choice} disabled={disabled} onChange={event => {
        const next = event.target.value;
        setChoice(next); setTouched(false);
        onChange(next === "auto" ? undefined : next === "custom" ? parseImageDimensions(width, height) : parseImageDimensions(...next.split(":") as [string, string]));
      }}>
        <option value="auto">{pixelSize ? "自动（网关默认）" : "自动"}</option>
        {presets.map(option => <option key={option} value={option}>{pixelSize ? `${option.replace(":", " × ")} px` : option}</option>)}
        <option value="custom">自定义</option>
      </SelectField>
      {choice === "custom" && <div className="custom-ratio">
        <label>宽<input type="number" inputMode="numeric" required min={1} max={10000} step={1} value={width} disabled={disabled} aria-label={pixelSize ? "像素宽" : "比例宽"} aria-invalid={touched && !valid} aria-describedby={hintId} onBlur={() => setTouched(true)} onChange={event => { setWidth(event.target.value); onChange(parseImageDimensions(event.target.value, height)); }} /></label>
        <span aria-hidden="true">{pixelSize ? "×" : ":"}</span>
        <label>高<input type="number" inputMode="numeric" required min={1} max={10000} step={1} value={height} disabled={disabled} aria-label={pixelSize ? "像素高" : "比例高"} aria-invalid={touched && !valid} aria-describedby={hintId} onBlur={() => setTouched(true)} onChange={event => { setHeight(event.target.value); onChange(parseImageDimensions(width, event.target.value)); }} /></label>
      </div>}
    </div>
  </div>;
}
