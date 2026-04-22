import Phaser from 'phaser';

// Runtime cache for the admin's per-key UI override flags. Fed by
// BootScene from /api/settings/ui-overrides at startup. Consumers
// call `isUiOverrideActive(scene, key)` to decide between a
// generated image (flag on + texture present) and the existing
// Graphics/CSS fallback (anything else).
//
// Two gates on purpose:
//   1) flag — admin explicitly opted into the image
//   2) texture present — the art was actually generated + saved
// Either miss → fall back silently. This keeps the admin-side
// "flip the switch before the image is ready" path harmless and
// means a deploy without generated art keeps working exactly as
// it does today.

let flags: Readonly<Record<string, boolean>> = {};

export function setUiOverrides(values: Record<string, boolean>): void {
  flags = { ...values };
}

export function getUiOverrides(): Readonly<Record<string, boolean>> {
  return flags;
}

export function isUiOverrideOn(key: string): boolean {
  return flags[key] === true;
}

export function hasUiOverrideTexture(scene: Phaser.Scene, key: string): boolean {
  return scene.textures.exists(key);
}

export function isUiOverrideActive(scene: Phaser.Scene, key: string): boolean {
  return isUiOverrideOn(key) && hasUiOverrideTexture(scene, key);
}

// Add a 9-slice image for `key` centered at (x, y) if the override
// is active; otherwise return null and let the caller render its
// Graphics fallback. `slice` controls the corner widths that stay
// un-stretched (brass corners, carved end caps). Defaults are sized
// for the menuUi prompt set: 16px corner inserts for most panels,
// callers can override per-asset.
export interface NineSliceInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const DEFAULT_NINE_SLICE: NineSliceInsets = {
  left: 16,
  right: 16,
  top: 16,
  bottom: 16,
};

export function addNineSliceIfActive(
  scene: Phaser.Scene,
  key: string,
  x: number,
  y: number,
  width: number,
  height: number,
  insets: NineSliceInsets = DEFAULT_NINE_SLICE,
): Phaser.GameObjects.NineSlice | null {
  if (!isUiOverrideActive(scene, key)) return null;
  // Phaser.Scene.Add.nineslice signature:
  //   (x, y, key, frame, width, height, leftW, rightW, topH, bottomH)
  return scene.add.nineslice(
    x,
    y,
    key,
    undefined,
    width,
    height,
    insets.left,
    insets.right,
    insets.top,
    insets.bottom,
  );
}

// Convenience for the HUD top-banner / title-banner case where the
// asset is rendered with the default 0.5/0.5 origin-centered
// positioning and a predictable aspect ratio. Returns the created
// image or null when the override is inactive.
export function addImageIfActive(
  scene: Phaser.Scene,
  key: string,
  x: number,
  y: number,
): Phaser.GameObjects.Image | null {
  if (!isUiOverrideActive(scene, key)) return null;
  return scene.add.image(x, y, key);
}
