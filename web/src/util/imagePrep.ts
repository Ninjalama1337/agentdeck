/**
 * Shrinks large photos before upload. A phone camera delivers 4–10 MB at
 * 12+ megapixels: slow to send over mobile data and far more pixels than a
 * model looks at. Screenshots and other small images pass through untouched.
 */

/** Longest edge kept — above it an image is scaled down. */
export const MAX_EDGE = 2576;
/** Files above this size are re-encoded even when their edges fit. */
export const MAX_BYTES = 3.5 * 1024 * 1024;
const JPEG_QUALITY = 0.9;
const SHRINKABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Size of a `width`×`height` image scaled to fit `maxEdge` on its longer side (never enlarged). */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** File name with the extension matching a re-encoded type. */
export function renameForType(name: string, type: string): string {
  const ext = type === 'image/png' ? '.png' : '.jpg';
  if (name.toLowerCase().endsWith(ext) || (ext === '.jpg' && /\.jpeg$/i.test(name))) return name;
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}${ext}`;
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, JPEG_QUALITY));
}

/**
 * Returns a smaller copy of an oversized photo, or the file itself when it is
 * fine as it is, not an image the browser can re-encode, or anything fails.
 */
export async function prepareImage(file: File): Promise<File> {
  if (!SHRINKABLE.has(file.type) || typeof createImageBitmap !== 'function') return file;
  let bitmap: ImageBitmap | undefined;
  try {
    // Honours the EXIF rotation of camera photos.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const size = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);
    if (size.width === bitmap.width && file.size <= MAX_BYTES) return file;

    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);

    // PNG stays lossless (crisp text in screenshots) unless that is still too big.
    let blob = file.type === 'image/png' ? await encode(canvas, 'image/png') : null;
    if (!blob || blob.size > MAX_BYTES) blob = await encode(canvas, 'image/jpeg');
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], renameForType(file.name, blob.type), { type: blob.type, lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
