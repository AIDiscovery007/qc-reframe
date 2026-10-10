export const MAX_IMAGE_DIMENSION = 10000;
export const MAX_IMAGE_PIXELS = 40000000;

export function validImageSize(value) {
  return value === undefined || !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => key === 'width' || key === 'height')
    && [value.width, value.height].every(size => Number.isInteger(size) && size >= 1 && size <= MAX_IMAGE_DIMENSION)
    && value.width * value.height <= MAX_IMAGE_PIXELS;
}
