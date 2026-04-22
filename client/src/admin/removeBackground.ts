// Client-side background removal. Takes a base64 image (typically a
// freshly-generated Gemini candidate), detects the dominant backdrop by
// sampling the image borders, and flood-fills from the edge through
// pixels matching that backdrop within a tolerance. Only pixels
// reachable from the border become transparent — this is the crucial
// difference vs a naive "every color-matching pixel" pass, which would
// punch holes inside the subject whenever the subject happens to
// contain similar colors (e.g. an ant on a green tile eating a green
// leaf). A small feather band at the flood frontier keeps outlines
// clean instead of jagged.
//
// Always re-encodes to PNG because the lossy WebP path destroys the
// alpha edge we just cut.

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

  // If the border is already fully transparent, medianBackgroundRef
  // returns an impossible reference that won't match anything; skip
  // the flood to avoid wasted work on a no-op.
  if (ref.r < 0) {
    return encode(canvas, width, height);
  }

  // BFS flood from the image edges. A pixel is enqueued iff it is
  // within the outer (tolerance + feather) radius of the reference;
  // strict inside-tolerance pixels become fully transparent, frontier
  // pixels inside the feather ring get a linear alpha ramp. Pixels
  // outside the outer radius (i.e. the subject) are never enqueued,
  // so no hole can ever form in the interior of the subject.
  const visited = new Uint8Array(width * height);
  // Stack is fine for flood-fill on sub-megapixel Gemini outputs.
  const stack: number[] = [];

  // Enqueue a pixel iff it hasn't been visited AND either (a) it's
  // already transparent — semantically background, traverse through
  // it so the flood can cross pre-existing transparent regions — or
  // (b) it's within the outer-tolerance of the background reference.
  // Dequeueing a transparent pixel is a no-op on its own alpha (0 *
  // anything = 0) but still propagates the flood to its neighbours,
  // which is the whole point.
  const maybePush = (x: number, y: number): void => {
    const idx = y * width + x;
    if (visited[idx]) return;
    const i = idx * 4;
    if (pixels[i + 3]! === 0) {
      visited[idx] = 1;
      stack.push(x, y);
      return;
    }
    if (distanceSq(pixels, i, ref) >= outerSq) return;
    visited[idx] = 1;
    stack.push(x, y);
  };

  for (let x = 0; x < width; x++) {
    maybePush(x, 0);
    maybePush(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    maybePush(0, y);
    maybePush(width - 1, y);
  }

  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    const i = (y * width + x) * 4;
    const dSq = distanceSq(pixels, i, ref);
    if (dSq <= tSq) {
      pixels[i + 3] = 0;
    } else {
      // Inside the feather band: ramp alpha from 0 at tolerance to
      // the original alpha at outer. Only the flood-reachable frontier
      // gets feathered — similar-colored interior pixels are never
      // visited.
      const d = Math.sqrt(dSq);
      const t = (d - tolerance) / feather;
      pixels[i + 3] = Math.round(pixels[i + 3]! * t);
    }

    // 4-connected neighbours. maybePush() gates on the outer radius,
    // so the flood cleanly stops at the subject silhouette.
    if (x > 0) maybePush(x - 1, y);
    if (x < width - 1) maybePush(x + 1, y);
    if (y > 0) maybePush(x, y - 1);
    if (y < height - 1) maybePush(x, y + 1);
  }

  ctx.putImageData(imageData, 0, 0);
  return encode(canvas, width, height);
}

async function encode(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  width: number,
  height: number,
): Promise<RemovedBackgroundImage> {
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

function distanceSq(
  pixels: Uint8ClampedArray,
  i: number,
  ref: { r: number; g: number; b: number },
): number {
  const dr = pixels[i]! - ref.r;
  const dg = pixels[i + 1]! - ref.g;
  const db = pixels[i + 2]! - ref.b;
  return dr * dr + dg * dg + db * db;
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
