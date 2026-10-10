import { requestedImageSize } from "./image-size.mjs";
import type { AspectRatio, Generation, ImageSize, ImageProvider } from "./types";

type SizeSource = { provider?: ImageProvider; aspectRatio?: AspectRatio; imageSize?: ImageSize };

// Pixel requests and legacy ratios have separate meanings, even when the numbers match.
export function inheritedGenerationSize(pixelSize: boolean, source?: SizeSource) {
  const fromPixels = source?.provider === "magpie" || source?.imageSize !== undefined;
  const size = pixelSize ? fromPixels ? source?.imageSize : undefined : fromPixels ? undefined : source?.aspectRatio;
  return pixelSize ? requestedImageSize(size) : size ? { ...size } : undefined;
}

export function parseImageDimensions(width: string, height: string): ImageSize {
  const integer = (value: string) => /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  return { width: integer(width), height: integer(height) };
}

export function parsePixelDimensions(width: string, height: string): ImageSize | undefined {
  return requestedImageSize({ width: Number(width), height: Number(height) });
}

export function generationSizeDescription(generation: Generation) {
  const requested = generation.provider === "magpie" || generation.imageSize
    ? generation.imageSize ? `请求尺寸：${generation.imageSize.width} × ${generation.imageSize.height} px` : "请求尺寸：Magpie 网关默认"
    : generation.aspectRatio ? `请求比例：${generation.aspectRatio.width}:${generation.aspectRatio.height}` : "请求比例：自动";
  const submitted = generation.sizeRule ? generation.submittedImageSize ? ` · 提交尺寸：${generation.submittedImageSize.width} × ${generation.submittedImageSize.height} px` : " · 提交尺寸：自动（网关默认）" : "";
  return `${requested}${submitted}${generation.outputSize ? ` · 实际图片：${generation.outputSize.width} × ${generation.outputSize.height} px` : ""}`;
}
