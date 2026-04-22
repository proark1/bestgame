// Shared walk-cycle helpers used by both the bulk generator
// (main.ts generateWalkCycle) and the per-pose WalkCycleEditor.
//
// Walk-cycle geometry is intentionally duplicated here instead of
// imported from @hive/client/src/assets/atlas.ts: the admin bundle
// is a separate Vite entry point with no dependency on the game
// runtime. Keep this block in sync with atlas.ts if the strip
// layout ever changes — the server-side CHECK 1..16 covers a wide
// range, so the risk is a silent client/admin mismatch, not a save
// failure.

import {
  blobToBase64,
  canvasToBlob,
  decodeImage,
  makeCanvas,
} from './compress.js';
import type { GeminiImage } from './api.js';

export const WALK_FRAME_W = 128;
export const WALK_FRAME_H = 128;
export const WALK_FRAME_COUNT = 2;
export const WALK_STRIP_WIDTH = WALK_FRAME_W * WALK_FRAME_COUNT;

// Per-frame prompt composer. `description` is the pose-specific
// text from prompts.json (`walkCycles.${kind}_poseA`). Used for
// the FIRST pose, which has no reference image yet — the style
// lock does all the framing work.
export function composeWalkPosePrompt(
  description: string,
  styleLock: string,
): string {
  return [
    `Subject: ${description}`,
    `Style: ${styleLock}`,
    `Canvas: exactly ${WALK_FRAME_W}x${WALK_FRAME_H} pixels, fully transparent background (RGBA alpha=0 outside the subject), no sky, no ground plane, no solid backdrop, no border, no text, no watermark.`,
    `Composition: single subject, centered, facing viewer, small soft oval shadow directly below feet. Identical camera, identical scale, identical palette to the single-frame sibling sprite so the two poses share a cohesive walk cycle.`,
  ].join(' ');
}

// Variation-prompt composer. Used for pose B, fired with pose A
// attached as a reference image. The text leans on "treat the
// reference as ground truth" language — Gemini keeps character /
// colors / outline / camera identical and modifies only the legs
// (or wings) per the pose-specific description.
export function composeWalkPoseVariationPrompt(description: string): string {
  return [
    `Use the attached image as the DEFINITIVE visual reference for the subject. Keep the character, face, body proportions, colors/palette, outline thickness, outfit, accessories (leaf, crown, backpack, stinger, etc.), camera angle, scale, vertical position, drop shadow, and canvas size ALL IDENTICAL to the reference.`,
    `The ONLY thing that should change: ${description}`,
    `Canvas: same as the reference — exactly ${WALK_FRAME_W}x${WALK_FRAME_H} pixels, fully transparent background (RGBA alpha=0 outside the subject), no sky, no ground plane, no solid backdrop, no border, no text, no watermark.`,
    `If the subject has no legs (e.g. a flying unit), change only the wing position / beat per the description. Do not add, remove, or redraw anything else.`,
  ].join(' ');
}

// Draw each pose onto a WALK_FRAME_W-wide slot of a horizontal
// strip, returning the composed strip as a base64 PNG. Input
// frames come from Gemini at various native sizes; drawImage fits
// each into its WALK_FRAME_W × WALK_FRAME_H slot so the final
// spritesheet geometry is exact.
export async function compositeWalkStrip(
  frames: readonly GeminiImage[],
): Promise<string> {
  const totalW = WALK_FRAME_W * frames.length;
  const canvas = makeCanvas(totalW, WALK_FRAME_H);
  const ctx = canvas.getContext('2d', { alpha: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.clearRect(0, 0, totalW, WALK_FRAME_H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (let i = 0; i < frames.length; i++) {
    const img = await decodeImage(frames[i]!.data, frames[i]!.mimeType);
    ctx.drawImage(
      img as CanvasImageSource,
      i * WALK_FRAME_W,
      0,
      WALK_FRAME_W,
      WALK_FRAME_H,
    );
  }
  const blob = await canvasToBlob(canvas, 'image/png', 1);
  return blobToBase64(blob);
}

// Split an already-on-disk walk strip back into its constituent
// poses so the editor can open with something useful rendered
// when the user clicks "Tweak". Returns one GeminiImage per
// WALK_FRAME_W column. On any decode/fetch failure, returns null
// — caller falls back to empty previews, which is harmless.
export async function splitWalkStrip(
  url: string,
  frameCount = WALK_FRAME_COUNT,
): Promise<GeminiImage[] | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const img = await createImageBitmap(blob);
    const out: GeminiImage[] = [];
    for (let i = 0; i < frameCount; i++) {
      const canvas = makeCanvas(WALK_FRAME_W, WALK_FRAME_H);
      const ctx = canvas.getContext('2d', { alpha: true }) as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (!ctx) return null;
      ctx.clearRect(0, 0, WALK_FRAME_W, WALK_FRAME_H);
      // Source geometry assumes a 256×128 (2-frame) or 128*N strip.
      // Fit each frame into the admin's WALK_FRAME_W slot so sizes
      // match what compose writes back out.
      const srcFrameW = img.width / frameCount;
      ctx.drawImage(
        img,
        i * srcFrameW,
        0,
        srcFrameW,
        img.height,
        0,
        0,
        WALK_FRAME_W,
        WALK_FRAME_H,
      );
      const frameBlob = await canvasToBlob(canvas, 'image/png', 1);
      out.push({ data: await blobToBase64(frameBlob), mimeType: 'image/png' });
    }
    return out;
  } catch {
    return null;
  }
}
