export const MAX_IMAGE_DIMENSION = 10000;
export const MAX_IMAGE_PIXELS = 40000000;

export function validImageSize(value) {
  return value === undefined || !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => key === 'width' || key === 'height')
    && [value.width, value.height].every(size => Number.isInteger(size) && size >= 1 && size <= MAX_IMAGE_DIMENSION)
    && value.width * value.height <= MAX_IMAGE_PIXELS;
}

// Request intent is distinct from the bounded, normalized size passed to an adapter.
export function validImageSizeRequest(value) {
  return value == null || typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => key === 'width' || key === 'height')
    && [value.width, value.height].every(size => size === null || typeof size === 'number');
}

export function requestedImageSize(value) {
  return validImageSizeRequest(value) && value && [value.width, value.height].every(size => Number.isFinite(size) && size > 0)
    ? { width: value.width, height: value.height } : undefined;
}

export function magpieSizeProfile(model = '') {
  const name = model.split('/').at(-1);
  if (/^(gpt-image-2(?:-2026-04-21)?|gpt-image-2\.5-(?:flare|sunburst)(?:-2026-09-08)?)$/.test(name)) return 'gpt';
  if (/^gemini-(?:3-pro|3\.1-flash)-image(?:-preview)?$/.test(name)) return 'gemini';
  return 'unknown';
}

// These are pixel carriers for Magpie's aspectOf conversion, not Gemini resolution promises.
const geminiPresets = [
  ['1:1', 1024, 1024], ['2:3', 1024, 1536], ['3:2', 1536, 1024],
  ['3:4', 960, 1280], ['4:3', 1280, 960], ['4:5', 1024, 1280],
  ['5:4', 1280, 1024], ['9:16', 864, 1536], ['16:9', 1536, 864], ['21:9', 1792, 768],
];

export function magpieSizePresets(model) {
  const profile = magpieSizeProfile(model);
  if (profile === 'unknown') return [];
  if (profile === 'gemini') return geminiPresets.map(([label, width, height]) => ({ label, value: { width, height } }));
  return [
    ...geminiPresets.filter(([ratio]) => ratio !== '21:9').map(([, w, h]) => ['常用尺寸', w, h]),
    ['2K', 2048, 2048], ['2K', 2048, 1152], ['2K', 1152, 2048], ['2K', 2560, 1440], ['2K', 1440, 2560],
    ['4K', 3840, 2160], ['4K', 2160, 3840],
  ].map(([group, width, height]) => ({ group, label: `${width} × ${height} px${width * height > 3686400 ? '（实验）' : ''}`, value: { width, height } }));
}

function legalGptSize({ width, height }) {
  return width % 16 === 0 && height % 16 === 0 && Math.max(width, height) <= 3840
    && Math.max(width, height) <= 3 * Math.min(width, height)
    && width * height >= 655360 && width * height <= 8294400;
}

export function normalizeMagpieSize(model, value) {
  const profile = magpieSizeProfile(model);
  const sizeRule = `magpie-${profile}-2026-10-v1`;
  const requested = requestedImageSize(value);
  if (!requested || profile === 'unknown') return { submittedImageSize: null, sizeRule, experimental: false };
  const ratio = Math.log(requested.width) - Math.log(requested.height);
  if (profile === 'gemini') {
    let best = geminiPresets[0], distance = Infinity;
    for (const candidate of geminiPresets) {
      const delta = Math.abs(Math.log(candidate[1] / candidate[2]) - ratio);
      if (delta < distance - 1e-12) { best = candidate; distance = delta; }
    }
    return { submittedImageSize: { width: best[1], height: best[2] }, sizeRule, aspectRatio: best[0], experimental: false };
  }
  let result = requested;
  if (!legalGptSize(requested)) {
    const area = Math.log(requested.width) + Math.log(requested.height);
    let best;
    // Product-defined distance: composition has four times the weight of pixel area.
    // Enumerating the bounded lattice guarantees a global minimum, including edge/area intersections.
    for (let width = 16; width <= 3840; width += 16) {
      for (let height = 16; height <= 3840; height += 16) {
        if (!legalGptSize({ width, height })) continue;
        const ratioError = Math.log(width / height) - ratio, areaError = Math.abs(Math.log(width * height) - area);
        const score = 4 * ratioError ** 2 + areaError ** 2;
        const rank = [score, areaError, width * height, width];
        const before = !best || rank.some((value, index) => value < best[index] - 1e-12 && rank.slice(0, index).every((value, previous) => Math.abs(value - best[previous]) <= 1e-12));
        if (before) { best = rank; result = { width, height }; }
      }
    }
  }
  return { submittedImageSize: { ...result }, sizeRule, experimental: result.width * result.height > 3686400 };
}
