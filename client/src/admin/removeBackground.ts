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

// ─── Near-white / gray filler pass ───────────────────────────────
// Second-stage cleanup for images where the first "Remove BG" pass
// left behind pale gray or off-white residue — typically haze along
// the character silhouette, or filler patches tucked into crevices
// between body parts (e.g. between two legs, between an antenna
// and the head).
//
// The critical property: this flood ALSO starts from the image
// border and crosses already-transparent pixels. That means any
// gray patch that is isolated INSIDE the character silhouette
// (surrounded by colored skin / outline — eye whites, horn
// highlights, metallic accents) is never reached and stays intact.
// Only gray pixels connected to the outside via other gray / already-
// transparent pixels are cleared.
//
// Two checks decide whether a pixel counts as "filler":
//   - low chroma (max(r,g,b) - min(r,g,b) < chromaMax): skips any
//     pixel that still carries color. Saturated pixels like eye
//     gems, brass highlights, red accents never match.
//   - high lightness ((r+g+b)/3 > lightnessMin): skips dark
//     pixels. The character's outlines and shadow bands are dark,
//     so they block the flood.
// Tuned defaults (chromaMax=28, lightnessMin=140) match Gemini's
// typical "soft gray haze" output.

export interface RemoveNearWhiteOptions {
  // max RGB channel spread (saturation proxy). 0 = only pure gray;
  // higher allows slightly tinted grays. 28 keeps clearly-colored
  // pixels safe.
  chromaMax?: number;
  // minimum average brightness for a pixel to count as filler.
  // 140 means mid-gray and above; below that we assume it's a
  // shadow or an outline band that the first pass intentionally
  // kept.
  lightnessMin?: number;
  // soft alpha ramp at the flood frontier, to avoid a hard jagged
  // edge on partially-filler pixels. Alpha = 0 inside the strict
  // band, ramps back to the original alpha over `feather` units of
  // brightness above lightnessMin.
  feather?: number;
}

export async function removeNearWhite(
  base64: string,
  sourceMime: string,
  opts: RemoveNearWhiteOptions = {},
): Promise<RemovedBackgroundImage> {
  const chromaMax = opts.chromaMax ?? 28;
  const lightnessMin = opts.lightnessMin ?? 140;
  const feather = opts.feather ?? 20;

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

  // Returns 1 if the pixel is squarely inside the filler band, a
  // [0, 1) value inside the feather band (mapped to residual
  // alpha), or 0 if it's clearly not filler (flood stops here).
  const fillerScore = (i: number): number => {
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma > chromaMax) return 0;
    const lightness = (r + g + b) / 3;
    if (lightness < lightnessMin) return 0;
    if (lightness >= lightnessMin + feather) return 1;
    // Ramp: barely-above-lightnessMin = weakly filler. Return a
    // value in (0, 1] that the dequeue step will turn into the
    // *remaining* alpha (so the edge softens instead of snapping).
    return (lightness - lightnessMin) / feather;
  };

  const visited = new Uint8Array(width * height);
  const stack: number[] = [];

  // Seed flood from any border pixel that is already transparent or
  // filler. Already-transparent pixels are traversed through so we
  // can cross into interior filler patches that reach the outside
  // via a thin transparent corridor.
  const maybePush = (x: number, y: number): void => {
    const idx = y * width + x;
    if (visited[idx]) return;
    const i = idx * 4;
    if (pixels[i + 3]! === 0) {
      visited[idx] = 1;
      stack.push(x, y);
      return;
    }
    if (fillerScore(i) <= 0) return;
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
    const score = fillerScore(i);
    if (score >= 1) {
      pixels[i + 3] = 0;
    } else if (score > 0) {
      // Feather: residual alpha = original * (1 - score). A pixel
      // right at the brightness threshold keeps most of its alpha;
      // clearly-filler pixels go to 0.
      pixels[i + 3] = Math.round(pixels[i + 3]! * (1 - score));
    }

    if (x > 0) maybePush(x - 1, y);
    if (x < width - 1) maybePush(x + 1, y);
    if (y > 0) maybePush(x, y - 1);
    if (y < height - 1) maybePush(x, y + 1);
  }

  ctx.putImageData(imageData, 0, 0);
  return encode(canvas, width, height);
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

// ─── Erase ALL white pixels (interior too) ─────────────────────────
// Sister to removeNearWhite, but with no flood-fill connectivity
// gate — every pixel that scores as filler gets its alpha zeroed,
// regardless of whether it sits outside the silhouette or deep
// inside the character. Use when Gemini bakes a stubborn white
// patch into the body itself (e.g. a chest highlight that reads as
// "missing alpha", a cheek hot-spot, an internal eye-glare blob)
// that the connectivity-gated removeNearWhite intentionally leaves
// alone.
//
// Destructive by design — eye gems, brass highlights, and metal
// rims that share the same low-chroma / high-lightness signature
// will also disappear. The button on the sprite card warns the
// admin before applying it. Tighter defaults than removeNearWhite
// (chromaMax=20, lightnessMin=210) so only near-pure whites are
// hit; the admin can re-generate or re-load if the result eats
// too much.

export interface EraseAllWhiteOptions {
  chromaMax?: number;
  lightnessMin?: number;
  feather?: number;
}

export async function eraseAllWhite(
  base64: string,
  sourceMime: string,
  opts: EraseAllWhiteOptions = {},
): Promise<RemovedBackgroundImage> {
  const chromaMax = opts.chromaMax ?? 20;
  const lightnessMin = opts.lightnessMin ?? 210;
  const feather = opts.feather ?? 25;

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

  // No flood, no visited array — just a single linear pass that
  // dims (or zeroes) every white-enough pixel. Feather softens the
  // boundary so the kept silhouette doesn't get a hard ring of
  // half-killed pixels around it.
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3]! === 0) continue;
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma > chromaMax) continue;
    const lightness = (r + g + b) / 3;
    if (lightness < lightnessMin) continue;
    if (lightness >= lightnessMin + feather) {
      pixels[i + 3] = 0;
    } else {
      const t = (lightness - lightnessMin) / feather;
      pixels[i + 3] = Math.round(pixels[i + 3]! * (1 - t));
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return encode(canvas, width, height);
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
