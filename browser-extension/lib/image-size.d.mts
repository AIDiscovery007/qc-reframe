export const MAX_IMAGE_DIMENSION: 10000;
export const MAX_IMAGE_PIXELS: 40000000;
export function validImageSize(value: unknown): boolean;
export function validImageSizeRequest(value: unknown): boolean;
export function requestedImageSize(value: unknown): { width: number; height: number } | undefined;
export function magpieSizeProfile(model?: string): 'gpt' | 'gemini' | 'unknown';
export function magpieSizePresets(model?: string): { label: string; value: { width: number; height: number }; group?: string }[];
export function normalizeMagpieSize(model: string | undefined, value: unknown): {
  submittedImageSize: { width: number; height: number } | null;
  sizeRule: string;
  aspectRatio?: string;
  experimental: boolean;
};
