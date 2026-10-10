import { useId, useState, type ReactNode } from "react";
import { magpieSizePresets, magpieSizeProfile } from "../../lib/image-size.mjs";
import { validGenerationRatio } from "../../lib/generation-session";
import { parseImageDimensions, parsePixelDimensions } from "../../lib/generation-size";
import type { ImageSize } from "../../lib/types";
import SelectField from "./SelectField";

const ratios = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"];

export default function GenerationSizeFields({ modelControl, generationModel, pixelSize = false, value, onChange, disabled, workspace = false }: {
  modelControl?: ReactNode; generationModel?: string; pixelSize?: boolean; value?: ImageSize; onChange(size?: ImageSize): void; disabled?: boolean; workspace?: boolean;
}) {
  const presets: { label: string; key: string; value: ImageSize; group?: string }[] = pixelSize ? magpieSizePresets(generationModel).map(item => ({ ...item, key: `${item.value.width}:${item.value.height}` }))
    : ratios.map(ratio => ({ label: ratio, key: ratio, value: parseImageDimensions(...ratio.split(":") as [string, string]) }));
  const initial = value ? `${value.width}:${value.height}` : "auto";
  const [custom, setCustom] = useState(initial !== "auto" && !presets.some(item => item.key === initial));
  const choice = custom ? "custom" : initial === "auto" || presets.some(item => item.key === initial) ? initial : "custom";
  const [width, setWidth] = useState(String(value?.width || (pixelSize ? 1024 : 1)));
  const [height, setHeight] = useState(String(value?.height || (pixelSize ? 1024 : 1)));
  const [touched, setTouched] = useState(false);
  const hintId = useId();
  const valid = pixelSize || validGenerationRatio(value);
  const parse = pixelSize ? parsePixelDimensions : parseImageDimensions;
  return <div className="generation-ratio" data-pixel-size={pixelSize || undefined} data-size-profile={pixelSize ? magpieSizeProfile(generationModel) : undefined}>
    {!pixelSize && choice === "custom" && <p id={hintId} className={`ratio-hint${touched && !valid ? " ratio-error" : ""}`} role={touched && !valid ? "status" : undefined}>宽高请填 1–10000 的整数，比例范围为 1:20–20:1。</p>}
    <div className="generation-ratio-fields">
      <SelectField label={pixelSize || workspace ? "目标尺寸" : "图片比例"} aria-label={pixelSize || workspace ? "目标尺寸" : "图片比例"} title={pixelSize ? "按当前模型适配尺寸，实际图片以返回结果为准" : "按宽高比例生成，实际像素以结果为准"} value={choice} disabled={disabled} onChange={event => {
        const next = event.target.value;
        setCustom(next === "custom"); setTouched(false);
        if (next === "auto") onChange(undefined);
        else if (next === "custom") onChange(parse(width, height));
        else {
          const preset = presets.find(item => item.key === next)!;
          setWidth(String(preset.value.width)); setHeight(String(preset.value.height)); onChange({ ...preset.value });
        }
      }}>
        <option value="auto">{pixelSize ? "自动（网关默认）" : "自动"}</option>
        {[...new Set(presets.map(option => option.group))].map(group => group
          ? <optgroup key={group} label={group}>{presets.filter(option => option.group === group).map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</optgroup>
          : presets.filter(option => !option.group).map(option => <option key={option.key} value={option.key}>{option.label}</option>))}
        <option value="custom">自定义</option>
      </SelectField>
      {modelControl}
      {choice === "custom" && <div className="custom-ratio">
        <label>宽<input type="number" inputMode={pixelSize ? "decimal" : "numeric"} required={!pixelSize} min={pixelSize ? undefined : 1} max={pixelSize ? undefined : 10000} step={pixelSize ? "any" : 1} value={width} disabled={disabled} aria-label={pixelSize ? "像素宽" : "比例宽"} aria-invalid={touched && !valid} aria-describedby={pixelSize ? undefined : hintId} onBlur={() => setTouched(true)} onChange={event => { setWidth(event.target.value); onChange(parse(event.target.value, height)); }} /></label>
        <span aria-hidden="true">{pixelSize ? "×" : ":"}</span>
        <label>高<input type="number" inputMode={pixelSize ? "decimal" : "numeric"} required={!pixelSize} min={pixelSize ? undefined : 1} max={pixelSize ? undefined : 10000} step={pixelSize ? "any" : 1} value={height} disabled={disabled} aria-label={pixelSize ? "像素高" : "比例高"} aria-invalid={touched && !valid} aria-describedby={pixelSize ? undefined : hintId} onBlur={() => setTouched(true)} onChange={event => { setHeight(event.target.value); onChange(parse(width, event.target.value)); }} /></label>
      </div>}
    </div>
  </div>;
}
