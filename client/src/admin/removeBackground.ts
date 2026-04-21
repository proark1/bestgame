// Client-side background removal. Takes a base64 image (typically a
// freshly-generated Gemini candidate), detects the dominant backdrop by
// sampling the image borders, and writes alpha=0 for pixels matching that
// backdrop within a tolerance. A small feather band around the threshold
// keeps outlines clean instead of jagged.
//
// Always re-encodes to PNG because the lossy WebP path destroys the alpha
// edge we just cut.

import { blobToBase64, canvasToBlob, decodeImage, makeCanvas } from './compress.js';

export interface RemoveBackgroundOptions {
  tolerance?: number; // sRGB Euclidean distance, default 24
  feather?: number; // width (in the same distance metric) of the alpha ramp
}

export interface RemovedBackgroundImage {
  base64: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  sizeBytes: number;
}

export async function removeBackground(
  base64: string,
  sourceMime: string,
  opts: RemoveBackgroundOptions = {},
): Promise<RemovedBackgroundImage> {
  const tolerance = opts.tolerance ?? 24;
  const feather = opts.feather ?? 12;

  const img = await decodeImage(base64, sourceMime);
  const width = img.width;
  const height = img.height;
  if (width === 0 || height === 0) throw new Error('empty image');

  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(img as CanvasImageSource, 0, 0);

  const imageData = ctx.getImageData(0, 0, width, height);
  const pixels = imageData.data;

  const ref = medianBackgroundRef(pixels, width, height);
  const tSq = tolerance * tolerance;
  const outer = tolerance + feather;
  const outerSq = outer * outer;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const a = pixels[i + 3]!;
    if (a === 0) continue; // already transparent
    const dr = r - ref.r;
    const dg = g - ref.g;
    const db = b - ref.b;
    const dSq = dr * dr + dg * dg + db * db;
    if (dSq <= tSq) {
      pixels[i + 3] = 0;
    } else if (dSq < outerSq) {
      // linear ramp between tolerance and outer
      const d = Math.sqrt(dSq);
      const t = (d - tolerance) / feather;
      pixels[i + 3] = Math.round(a * t);
    }
  }

  ctx.putImageData(imageData, 0, 0);

  const blob = await canvasToBlob(canvas, 'image/png', 1);
  const out = await blobToBase64(blob);
  return {
    base64: out,
    mimeType: 'image/png',
    width,
    height,
    sizeBytes: blob.size,
  };
}

// Samples 8 reference points around the border and returns the channel-wise
// median. More robust than a corner-only sample when one corner happens to
// be occupied by the subject.
function medianBackgroundRef(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): { r: number; g: number; b: number } {
  const xs = [0, width - 1, Math.floor(width / 2)];
  const ys = [0, height - 1, Math.floor(height / 2)];
  const points: Array<[number, number]> = [];
  for (const x of xs) {
    for (const y of ys) {
      if (x === xs[2] && y === ys[2]) continue; // skip center
      points.push([x, y]);
    }
  }
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (const [x, y] of points) {
    const i = (y * width + x) * 4;
    const a = pixels[i + 3]!;
    if (a < 16) continue; // already-transparent border pixel tells us nothing
    rs.push(pixels[i]!);
    gs.push(pixels[i + 1]!);
    bs.push(pixels[i + 2]!);
  }
  if (rs.length === 0) {
    // whole border is already transparent — pick an impossible reference so
    // nothing gets clobbered.
    return { r: -999, g: -999, b: -999 };
  }
  return { r: median(rs), g: median(gs), b: median(bs) };
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}
