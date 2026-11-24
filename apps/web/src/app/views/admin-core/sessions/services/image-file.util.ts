/**
 * Raster-image detection for in-app previews (code editor + git explorer).
 * SVG is intentionally excluded: it stays editable as XML text.
 */
const RASTER_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'];

export function isRasterImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return RASTER_IMAGE_EXTS.includes(ext);
}

export function toDataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}
