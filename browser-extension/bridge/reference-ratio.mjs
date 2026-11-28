import sharp from "sharp";
import { referenceAspectRatio } from "../lib/recreate-edit.mjs";

/**
 * Display aspect ratio of a stored reference image, after EXIF orientation.
 * The ratio is only a hint for 「自动」: a missing or undecodable file leaves the size automatic instead of failing generation.
 */
export async function referenceRatio(path) {
  if (!path) return undefined;
  const metadata = await sharp(path).metadata().catch(() => undefined);
  if (!metadata) return undefined;
  const { width, height, orientation } = metadata;
  return orientation >= 5 ? referenceAspectRatio(height, width) : referenceAspectRatio(width, height);
}
