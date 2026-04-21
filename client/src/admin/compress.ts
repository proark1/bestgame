// Client-side image compression. Takes a base64-encoded PNG (from
// Gemini), draws it to a canvas, re-encodes to WebP or PNG at the
// requested quality, and returns { base64, sizeBytes }.
//
// Uses OffscreenCanvas where available (faster, doesn't paint) and
// falls back to a detached <canvas> element on older browsers.

export interface CompressOptions {
  format: 'webp' | 'png';
  quality: number; // 0..1, ignored for png
  maxDimension?: number; // optional downscale
}

export interface CompressedImage {
  base64: string;
  sizeBytes: number;
  mimeType: string;
  width: number;
  height: number;
}

export async function compressBase64Image(
  base64: string,
  sourceMime: string,
  opts: CompressOptions,
): Promise<CompressedImage> {
  const img = await decodeImage(base64, sourceMime);
  const { width, height } = fitInto(img.width, img.height, opts.maxDimension);

  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  // Transparent background by default (keeps alpha for WebP + PNG).
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);

  const mimeType = opts.format === 'webp' ? 'image/webp' : 'image/png';
  const blob = await canvasToBlob(canvas, mimeType, opts.quality);
  const sizeBytes = blob.size;
  const base64Out = await blobToBase64(blob);

  return { base64: base64Out, sizeBytes, mimeType, width, height };
}

function fitInto(
  w: number,
  h: number,
  maxDim: number | undefined,
): { width: number; height: number } {
  if (!maxDim || (w <= maxDim && h <= maxDim)) return { width: w, height: h };
  const ratio = w / h;
  if (w >= h) return { width: maxDim, height: Math.round(maxDim / ratio) };
  return { width: Math.round(maxDim * ratio), height: maxDim };
}

export async function decodeImage(
  base64: string,
  mimeType: string,
): Promise<ImageBitmap | HTMLImageElement> {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType || 'image/png' });
  if (typeof createImageBitmap === 'function') {
    return await createImageBitmap(blob);
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = URL.createObjectURL(blob);
  });
}

export function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export async function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return await (canvas as OffscreenCanvas).convertToBlob({ type, quality });
  }
  return await new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas toBlob returned null'))),
      type,
      quality,
    );
  });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Chunked to avoid argument-length limits on large buffers.
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
