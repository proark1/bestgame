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
  const stroke = style.stroke ?? COLOR.brassDeep;
  const strokeWidth = style.strokeWidth ?? 2;
  const strokeAlpha = style.strokeAlpha ?? 0.85;
  const highlight = style.highlight ?? COLOR.brass;
  const highlightAlpha = style.highlightAlpha ?? 0.25;
  const radius = style.radius ?? SPACING.radiusMd;
  const shadowOffset = style.shadowOffset ?? 4;
  const shadowAlpha = style.shadowAlpha ?? 0.4;

  // Drop shadow
  if (shadowAlpha > 0) {
    g.fillStyle(0x000000, shadowAlpha);
    g.fillRoundedRect(x + 1, y + shadowOffset, w, h + 1, radius);
    g.fillStyle(COLOR.brassDeep, shadowAlpha * 0.22);
    g.fillRoundedRect(x, y + 2, w, h, radius);
  }

  // Gradient fill via two-color top/bottom (same on each side).
  g.fillGradientStyle(topColor, topColor, botColor, botColor, 1);
  g.fillRoundedRect(x, y, w, h, radius);
  g.fillStyle(0xffffff, 0.05);
  g.fillRoundedRect(x + 2, y + 2, w - 4, Math.max(6, Math.min(12, h * 0.18)), radius - 2);

  // Inner top highlight band (bevel)
  if (highlightAlpha > 0) {
    g.fillStyle(highlight, highlightAlpha);
    g.fillRoundedRect(x + strokeWidth, y + strokeWidth, w - strokeWidth * 2, 3, radius - 1);
  }

  // Outer stroke
  g.lineStyle(strokeWidth, stroke, strokeAlpha);
  g.strokeRoundedRect(x, y, w, h, radius);
  g.lineStyle(1, COLOR.strokeLight, 0.18);
  g.strokeRoundedRect(
    x + strokeWidth + 1,
    y + strokeWidth + 1,
    w - strokeWidth * 2 - 2,
    h - strokeWidth * 2 - 2,
    Math.max(2, radius - strokeWidth - 1),
  );
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
  // Soft drop shadow — stays BELOW the pill so the eye reads it as
  // depth, never as top-bleed.
  g.fillStyle(0x000000, 0.55);
  g.fillRoundedRect(x + 1, y + 3, w, h + 1, radius);
  // Main body: vertical gradient with no lighten strip on top.
  g.fillGradientStyle(COLOR.bgPanelHi, COLOR.bgPanelHi, COLOR.bgPanelLo, COLOR.bgPanelLo, 1);
  g.fillRoundedRect(x, y, w, h, radius);
  if (brass) {
    g.lineStyle(1.5, COLOR.brassDeep, 0.9);
    g.strokeRoundedRect(x, y, w, h, radius);
  } else {
    g.lineStyle(1, 0x000000, 0.35);
    g.strokeRoundedRect(x, y, w, h, radius);
  }
}
