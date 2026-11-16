/** Image extensions we can preview directly (must match IMAGE_EXTS on the Rust side) */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

function extOf(rel: string): string {
  const name = rel.split('/').pop() ?? rel
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Raster images only. SVG is UTF-8 text, so it keeps opening as text (editable); preview is an extra outlet. */
export function isImagePath(rel: string): boolean {
  // Use hasOwn: prototype keys like `'constructor' in {}` must not count as image extensions
  return Object.hasOwn(IMAGE_MIME, extOf(rel))
}

/** SVG still opens as text (editable) and merely allows switching to an image preview. It cannot join IMAGE_MIME: that would create a read-only image tab. */
export function isSvgPath(rel: string): boolean {
  return extOf(rel) === 'svg'
}

export function imageMime(rel: string): string {
  return IMAGE_MIME[extOf(rel)] ?? 'application/octet-stream'
}