import Phaser from 'phaser';
import { COLOR, SPACING } from './theme.js';

// Rectangular "card" surface used by HUD strips, resource pills,
// tooltip bubbles, and modal frames. Centralized here so all
// panels share the same drop-shadow weight + bevel highlight +
// rounded-corner radius, which is what gives the UI its
// consistent "chunky CoC panel" feel.

export interface PanelStyle {
  // Fill gradient (top → bottom). Defaults to the theme's dark
  // panel gradient.
  topColor?: number;
  botColor?: number;
  // Outer border.
  stroke?: number;
  strokeWidth?: number;
  strokeAlpha?: number;
  // Highlight band along the top edge for the bevel look.
  highlight?: number;
  highlightAlpha?: number;
  // Drop shadow params (offset + alpha).
  shadowOffset?: number;
  shadowAlpha?: number;
  // Corner radius.
  radius?: number;
}

export function drawPanel(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  style: PanelStyle = {},
): void {
  const topColor = style.topColor ?? COLOR.bgPanelHi;
  const botColor = style.botColor ?? COLOR.bgPanelLo;
  const stroke = style.stroke ?? COLOR.strokeDark;
  const strokeWidth = style.strokeWidth ?? 1;
  const strokeAlpha = style.strokeAlpha ?? 0.18;
  const highlight = style.highlight ?? 0xffffff;
  const highlightAlpha = style.highlightAlpha ?? 0.55;
  const radius = style.radius ?? SPACING.radiusMd;
  const shadowOffset = style.shadowOffset ?? 4;
  const shadowAlpha = style.shadowAlpha ?? 0.18;

  // Soft modern drop shadow — navy-tinted instead of pure black so it
  // doesn't punch a hole in light-pastel scenes.
  if (shadowAlpha > 0) {
    g.fillStyle(0x1f2148, shadowAlpha);
    g.fillRoundedRect(x + 1, y + shadowOffset, w, h + 1, radius);
  }

  // Gradient fill via two-color top/bottom (same on each side).
  g.fillGradientStyle(topColor, topColor, botColor, botColor, 1);
  g.fillRoundedRect(x, y, w, h, radius);

  // Inner top highlight band — soft white bevel that reads as a
  // glassy gloss on the white/cream cards.
  if (highlightAlpha > 0) {
    g.fillStyle(highlight, highlightAlpha);
    g.fillRoundedRect(
      x + strokeWidth + 1,
      y + strokeWidth + 1,
      w - strokeWidth * 2 - 2,
      Math.max(4, Math.min(10, h * 0.14)),
      Math.max(2, radius - 1),
    );
  }

  // Outer stroke — single soft navy line; the heavy double-stroke +
  // brass rim from the old theme felt dated against pastel cards.
  g.lineStyle(strokeWidth, stroke, strokeAlpha);
  g.strokeRoundedRect(x, y, w, h, radius);
}

// Resource-pill panel — wider-than-tall capsule used for sugar/leaf/
// milk counters in the HUD. Distinct from drawPanel because the
// highlight + radius defaults are tuned for a small (~32 px) height.
// Set `brass: false` for top-bar callers that want a quieter dark
// pill (no gold stroke, no bright top highlight) — the HUD got too
// noisy with brass on every resource pill + both chips.
export function drawPill(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  style: { brass?: boolean } = {},
): void {
  // Flat pill: dark body + optional brass outline, with only a soft
  // drop shadow below. The earlier "glass / mirror" highlights (a
  // white gloss strip and a brass rim along the top) were removed
  // because they read as the button "leaking" upward in the HUD —
  // the user specifically asked for no gloss/mirror on top.
  const brass = style.brass ?? true;
  const radius = h / 2;
  // Soft navy-tinted shadow that reads as ambient occlusion on light
  // surfaces (heavy black shadows look harsh on cream cards).
  g.fillStyle(0x1f2148, 0.18);
  g.fillRoundedRect(x + 1, y + 3, w, h + 1, radius);
  // Body: vertical gradient using the panel theme tokens.
  g.fillGradientStyle(COLOR.bgPanelHi, COLOR.bgPanelHi, COLOR.bgPanelLo, COLOR.bgPanelLo, 1);
  g.fillRoundedRect(x, y, w, h, radius);
  if (brass) {
    // Coral border on accent pills — picks up the new primary palette.
    g.lineStyle(1.5, 0xee5e7c, 0.85);
    g.strokeRoundedRect(x, y, w, h, radius);
  } else {
    g.lineStyle(1, COLOR.strokeDark, 0.22);
    g.strokeRoundedRect(x, y, w, h, radius);
  }
}
