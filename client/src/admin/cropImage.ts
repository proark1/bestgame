// Auto-trim transparent space around a sprite and re-center the
// subject in the original canvas. Run after Remove BG / Remove grays
// so the admin can guarantee the character/building sits inside the
// 128×128 box without empty side margins — important for the per-tile
// grid rendering on the game board, where any padding shows up as a
// visible gap between the sprite and its grid cell.
//
// Algorithm:
// 1. Decode the source PNG/WebP onto a canvas.
// 2. Walk the alpha channel to find the tightest non-transparent
//    bounding box (alpha > threshold). A small padding is added so
//    extreme outline pixels are not clipped.
// 3. Crop to that box, then re-paint into a fresh canvas of the
//    original dimensions, centered. The subject scale is preserved
//    by default; an optional `fit` mode can scale up to fill more of
//    the canvas if the source had heavy padding.
// 4. Re-encode as PNG to preserve alpha.
//
// Returns null if the image is fully transparent (no subject to crop).

import {
  blobToBase64,
  canvasToBlob,
  decodeImage,
  makeCanvas,
} from './compress.js';

export interface CroppedImage {
  base64: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  // Tight bounding-box of the subject in the source image, in pixels.
  // Useful for surfacing "subject was X×Y" feedback in the UI.
  subjectBox: { x: number; y: number; w: number; h: number };
  sizeBytes: number;
}

export interface CropOptions {
  // Alpha threshold (0–255) for "this pixel counts as subject". Pixels
  // below this are treated as background. 8 is permissive enough to
  // catch faint outline anti-aliasing without snapping to a stray gray
  // dot at the edge.
  alphaThreshold?: number;
  // Padding (in pixels) added around the bounding box before cropping
  // so the subject's outermost outline pixels survive AA blending.
  pad?: number;
  // 'preserve' keeps the subject at its native scale and only re-
  // centers it. 'fit' scales the cropped subject up to fill ~90% of
  // the smaller canvas dimension — use this when the source had a lot
  // of dead space around a small subject.
  mode?: 'preserve' | 'fit';
  // Target fill ratio when mode='fit'. Default 0.9 leaves a tiny
  // breathing margin so the subject doesn't bleed into the canvas
  // edge after scaling.
  fitRatio?: number;
}

export async function autoCropAndCenter(
  base64: string,
  mimeType: string,
  opts: CropOptions = {},
): Promise<CroppedImage | null> {
  const alphaThreshold = opts.alphaThreshold ?? 8;
  const pad = Math.max(0, opts.pad ?? 2);
  const mode = opts.mode ?? 'preserve';
  const fitRatio = Math.max(0.1, Math.min(1, opts.fitRatio ?? 0.9));

  const img = await decodeImage(base64, mimeType);
  const W = img.width;
  const H = img.height;
  if (W === 0 || H === 0) return null;

  const sourceCanvas = makeCanvas(W, H);
  const srcCtx = sourceCanvas.getContext('2d', { alpha: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!srcCtx) throw new Error('2D canvas unavailable');
  srcCtx.clearRect(0, 0, W, H);
  srcCtx.drawImage(img as CanvasImageSource, 0, 0, W, H);
  const data = srcCtx.getImageData(0, 0, W, H).data;

  // Find tight bounding box by scanning alpha.
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < H; y++) {
    const rowOffset = y * W * 4;
    for (let x = 0; x < W; x++) {
      const a = data[rowOffset + x * 4 + 3]!;
      if (a > alphaThreshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxY < 0) return null; // fully transparent

  // Apply padding then clamp to the source bounds.
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(W - 1, maxX + pad);
  maxY = Math.min(H - 1, maxY + pad);
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  // Re-paint into a fresh canvas of the original dimensions so the
  // sprite always reports the same atlas size to the rest of the
  // pipeline (BootScene + composite walk strip both rely on a stable
  // 128×128 frame).
  const out = makeCanvas(W, H);
  const outCtx = out.getContext('2d', { alpha: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!outCtx) throw new Error('2D canvas unavailable');
  outCtx.clearRect(0, 0, W, H);
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = 'high';

  if (mode === 'preserve') {
    const dx = Math.round((W - cropW) / 2);
    const dy = Math.round((H - cropH) / 2);
    outCtx.drawImage(
      sourceCanvas as CanvasImageSource,
      minX, minY, cropW, cropH,
      dx, dy, cropW, cropH,
    );
  } else {
    // Scale the subject up to occupy ~fitRatio of the smaller side
    // while preserving aspect ratio.
    const target = Math.min(W, H) * fitRatio;
    const scale = Math.min(target / cropW, target / cropH);
    const dw = Math.max(1, Math.round(cropW * scale));
    const dh = Math.max(1, Math.round(cropH * scale));
    const dx = Math.round((W - dw) / 2);
    const dy = Math.round((H - dh) / 2);
    outCtx.drawImage(
      sourceCanvas as CanvasImageSource,
      minX, minY, cropW, cropH,
      dx, dy, dw, dh,
    );
  }

  const blob = await canvasToBlob(out, 'image/png', 1);
  const outBase64 = await blobToBase64(blob);
  return {
    base64: outBase64,
    mimeType: 'image/png',
    width: W,
    height: H,
    subjectBox: { x: minX, y: minY, w: cropW, h: cropH },
    sizeBytes: blob.size,
  };
}
