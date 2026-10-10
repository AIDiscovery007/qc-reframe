import type { AspectRatio, Generation, ImageSize, ImageProvider } from "./types";

type SizeSource = { provider?: ImageProvider; aspectRatio?: AspectRatio; imageSize?: ImageSize };

// Pixel requests and legacy ratios have separate meanings, even when the numbers match.
export function inheritedGenerationSize(pixelSize: boolean, source?: SizeSource) {
  const fromPixels = source?.provider === "magpie" || source?.imageSize !== undefined;
  const size = pixelSize ? fromPixels ? source?.imageSize : undefined : fromPixels ? undefined : source?.aspectRatio;
  return size ? { ...size } : undefined;
}

export function parseImageDimensions(width: string, height: string): ImageSize {
  const integer = (value: string) => /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  return { width: integer(width), height: integer(height) };
}

export function generationSizeDescription(generation: Generation) {
  const requested = generation.provider === "magpie" || generation.imageSize
    ? generation.imageSize ? `请求尺寸：${generation.imageSize.width} × ${generation.imageSize.height} px` : "请求尺寸：Magpie 网关默认"
    : generation.aspectRatio ? `请求比例：${generation.aspectRatio.width}:${generation.aspectRatio.height}` : "请求比例：自动";
  return `${requested}${generation.outputSize ? ` · 实际图片：${generation.outputSize.width} × ${generation.outputSize.height} px` : ""}`;
}
