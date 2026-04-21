import Phaser from 'phaser';

// DPR-aware text factory. Phaser 3.60+ dropped the game-level
// `resolution` config knob, so the canonical way to get crisp text on
// a Retina or 4K display is per-text `setResolution()` at
// window.devicePixelRatio. Calling this instead of `scene.add.text`
// directly means every label in the game picks up the DPR without
// each caller remembering to.
//
// Cap at 3× — above that the texture cost stops being worth the
// marginal sharpness gain and some mobile GPUs start complaining
// about oversized text atlases.

export function devicePixelScale(): number {
  const raw = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(raw, 3);
}

export function crispText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  style: Phaser.Types.GameObjects.Text.TextStyle = {},
): Phaser.GameObjects.Text {
  const t = scene.add.text(x, y, text, style);
  t.setResolution(devicePixelScale());
  return t;
}

// Drop-in for existing `scene.add.text(...).setOrigin(...)` chains.
// Usage: crispText(this, x, y, label, style).setOrigin(0.5);
//
// The helper returns the Phaser Text so Phaser's fluent chain
// (.setOrigin, .setInteractive, .setDepth, etc.) keeps working
// unmodified.
