import { readFile } from "node:fs/promises";
import sharp from "sharp";

// Included verbatim in the tool instructions so code-mode callers need not guess the return shape.
export function showInspection(result, text, image) {
  if (typeof result === "string") {
    const start = result.indexOf("data:image/");
    if (start < 0) { text(result); return; }
    const url = result.slice(start).trim();
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url)) throw new Error("Invalid inspection image payload; do not print it as text.");
    if (start) text(result.slice(0, start).trim());
    image(url);
  } else if (Array.isArray(result)) {
    for (const item of result) showInspection(item, text, image);
  } else if (result?.contentItems || result?.content) {
    showInspection(result.contentItems || result.content, text, image);
  } else if (result?.type === "inputImage") {
    image(result.imageUrl);
  } else if (result?.type === "input_image") {
    image(result.image_url);
  } else if (result?.type === "image") {
    image(result);
  } else if (["inputText", "input_text", "text"].includes(result?.type)) {
    showInspection(result.text, text, image);
  } else {
    throw new Error("Unknown inspection result shape; do not dump image data as text.");
  }
}

// Paths come only from the actual localImage input list, never tool arguments.
// Limits default to Codex's; an Agent with a smaller per-image payload passes its own edge and PNG byte caps.
export function createImageInspection(imagePaths, { maxEdge = 2048, maxPixels = 4_000_000, maxBytes = Infinity } = {}) {
  const paths = [...imagePaths];
  const pixelLabel = maxPixels % 1_000_000 ? `${maxPixels} pixels` : `${maxPixels / 1_000_000} million pixels`;
  return {
    spec: {
      type: "function",
      name: "alchemy_inspect_image",
      description: `Read an input image or crop and magnify a detail. First inspect each image without bbox to learn its oriented dimensions. Then inspect key regions using bbox in those original oriented pixels, never preview pixels. Returns actual PNG pixels and metadata. Optional sample reports original ROI sRGB statistics, not semantic colour labels. Nearest-neighbour enlargement reveals existing pixels only; it cannot recover missing detail. Read-only, no files or network.
When called via functions.exec, the result may be a STRING containing metadata followed by a PNG data URL, or structured image blocks. A successful call alone does not display the image. NEVER text(), stringify(), or log the whole result or base64. Use the following tested helper in each exec cell, passing the exec text and image helpers. It displays both supported return formats without another inspection call:
${showInspection.toString()}
showInspection(await tools.alchemy_inspect_image({image: 1}), text, image);
Retain the result in the current cell if display handling fails; repair the display without calling the image tool again. Batch independent regions when useful; revisit images only for a visual question or the final whole-image check.`,
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: {
          image: { type: "integer", minimum: 1, maximum: paths.length, description: "1-based image number in the actual input order." },
          bbox: {
            type: "object", additionalProperties: false,
            properties: {
              x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 },
              width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 },
            },
            required: ["x", "y", "width", "height"],
          },
          scale: { type: "number", minimum: 1, maximum: 4, description: `Requested magnification; output is capped at ${maxEdge} per edge and ${pixelLabel}${Number.isFinite(maxBytes) ? ", and shrunk further when the PNG would exceed the Agent's image size limit" : ""}.` },
          sample: { type: "boolean", description: "Sample original ROI RGB median/min/max before resizing. Requires bbox of at most 1 million pixels. Transparent pixels excluded; partial alpha kept without background compositing." },
        },
        required: ["image"],
      },
    },
    async call(args, { signal } = {}) {
      signal?.throwIfAborted();
      if (!args || Array.isArray(args) || typeof args !== "object" || Object.keys(args).some(k => !["image", "bbox", "scale", "sample"].includes(k)))
        throw new Error("仅接受 image、bbox、scale 和 sample，不接受路径或 URL。");
      if (!Number.isInteger(args.image) || args.image < 1 || args.image > paths.length)
        throw new Error("image 必须是本次输入图片的有效编号（从 1 开始）。");
      const scale = args.scale ?? 1;
      if (typeof scale !== "number" || !Number.isFinite(scale) || scale < 1 || scale > 4)
        throw new Error("scale 必须在 1 至 4 之间。");
      if (args.sample !== undefined && typeof args.sample !== "boolean") throw new Error("sample 必须是布尔值。");
      let source, metadata;
      try {
        source = await readFile(paths[args.image - 1], { signal });
        signal?.throwIfAborted();
        metadata = await sharp(source, { limitInputPixels: 64_000_000 }).metadata();
        signal?.throwIfAborted();
        if (!["jpeg", "png", "webp", "gif", "tiff", "heif", "avif"].includes(metadata.format)) throw new Error();
      } catch {
        signal?.throwIfAborted();
        throw new Error("无法读取本次输入图片，或图片超过 6400 万像素；请使用受支持的栅格图片。");
      }
      const rotated = metadata.orientation >= 5 && metadata.orientation <= 8;
      const width = rotated ? metadata.height : metadata.width;
      const height = rotated ? metadata.width : metadata.height;
      const bbox = args.bbox === undefined ? { x: 0, y: 0, width, height } : args.bbox;
      if (!bbox || Array.isArray(bbox) || typeof bbox !== "object" || Object.keys(bbox).length !== 4 ||
          !["x", "y", "width", "height"].every(k => Number.isInteger(bbox[k])) ||
          bbox.x < 0 || bbox.y < 0 || bbox.width < 1 || bbox.height < 1 || bbox.x + bbox.width > width || bbox.y + bbox.height > height)
        throw new Error(`bbox 必须在 EXIF 校正后的 ${width} × ${height} 原图像素范围内，包含整数 x、y、width、height。`);
      let factor = Math.min(scale, maxEdge / bbox.width, maxEdge / bbox.height, Math.sqrt(maxPixels / (bbox.width * bbox.height)));
      let outputWidth = Math.max(1, Math.floor(bbox.width * factor));
      let outputHeight = Math.max(1, Math.floor(bbox.height * factor));
      if (args.sample && (!args.bbox || bbox.width * bbox.height > 1_000_000))
        throw new Error("颜色采样需要 bbox，且区域不能超过 100 万原图像素；请选择更小的代表性区域。");
      const crop = sharp(source, { limitInputPixels: 64_000_000 }).autoOrient()
        .extract({ left: bbox.x, top: bbox.y, width: bbox.width, height: bbox.height })
        .withIccProfile("srgb");
      let png = await crop.clone().resize(outputWidth, outputHeight, { kernel: "nearest", fit: "fill" }).png().toBuffer();
      signal?.throwIfAborted();
      // Noisy crops compress poorly; shrink until the PNG fits instead of letting the Agent reject the whole request.
      while (png.length > maxBytes && (outputWidth > 1 || outputHeight > 1)) {
        factor *= Math.max(0.5, Math.min(0.9, Math.sqrt(maxBytes / png.length) * 0.95));
        outputWidth = Math.max(1, Math.floor(bbox.width * factor));
        outputHeight = Math.max(1, Math.floor(bbox.height * factor));
        png = await crop.clone().resize(outputWidth, outputHeight, { kernel: "nearest", fit: "fill" }).png().toBuffer();
        signal?.throwIfAborted();
      }
      if (png.length > maxBytes) throw new Error("检查结果超过 Agent 的图片大小限制，请选择更小的区域。");
      let sample;
      if (args.sample) {
        const pixels = await crop.clone().ensureAlpha().raw().toBuffer();
        signal?.throwIfAborted();
        const bins = Array.from({ length: 3 }, () => new Uint32Array(256));
        let count = 0, transparent = 0, partialAlpha = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (!pixels[i + 3]) { transparent++; continue; }
          count++;
          if (pixels[i + 3] < 255) partialAlpha++;
          for (let channel = 0; channel < 3; channel++) bins[channel][pixels[i + channel]]++;
        }
        const channels = bins.map(histogram => {
          if (!count) return null;
          let total = 0, lower, upper;
          for (let value = 0; value < 256; value++) {
            total += histogram[value];
            if (lower === undefined && total > Math.floor((count - 1) / 2)) lower = value;
            if (total > Math.floor(count / 2)) { upper = value; break; }
          }
          return { median: (lower + upper) / 2, min: histogram.findIndex(n => n > 0), max: histogram.findLastIndex(n => n > 0) };
        });
        sample = { colourspace: "sRGB", channels: ["R", "G", "B"], statistics: channels, pixels: count, excludedTransparentPixels: transparent, partialAlphaPixels: partialAlpha,
          interpretation: "Original ROI before resizing; fully transparent pixels excluded, partial-alpha RGB not composited. Per-channel statistics may not represent a visible semantic colour; choose a visually verified homogeneous region." };
      }
      return {
        success: true,
        contentItems: [
          { type: "inputText", text: JSON.stringify({
            image: args.image, source: { width: metadata.width, height: metadata.height, format: metadata.format, exifOrientation: metadata.orientation ?? 1, hasIccProfile: !!metadata.icc, colourspace: metadata.space, pages: metadata.pages ?? 1 },
            oriented: { width, height }, bbox,
            output: { width: outputWidth, height: outputHeight, requestedScale: scale, scaleX: outputWidth / bbox.width, scaleY: outputHeight / bbox.height, resampling: "nearest", colourspace: "sRGB", colourHandling: metadata.icc ? "Embedded source ICC converted to sRGB; source profile name not extracted." : "No source ICC; decoder colourspace/default profile used, original colour accuracy is unverified.", renderingIntent: "Sharp default; not independently verified." },
            ...(sample ? { sample } : {}),
            coordinates: "Origin top-left after EXIF orientation; x right, y down. bbox uses original oriented pixels. First frame only for multi-frame images. Magnification adds no source detail.",
          }) },
          { type: "inputImage", imageUrl: `data:image/png;base64,${png.toString("base64")}` },
        ],
      };
    },
  };
}
