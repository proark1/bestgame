import Phaser from 'phaser';
import { COLOR, DEPTHS } from './theme.js';

// Floating gain/loss chip — the "+12 sugar" / "-50 leaf" text that
// animates from a source point (e.g. the harvested building, the
// raided base, the just-placed wall) toward a target point (typically
// the matching HUD resource pill). Sells the value change instead of
// the wallet just snapping to a new number.
//
// Each chip is its own Phaser.Text added directly to the scene so it
// draws above whatever container it logically belongs to. Tween
// destroys the text on completion to keep the display list tidy.

export type FloatKind = 'sugar' | 'leaf' | 'milk' | 'trophy' | 'generic';

export interface FloatNumberOptions {
  scene: Phaser.Scene;
  // World/screen coords where the chip first appears. Caller decides
  // which space — the helper just adds to the scene root.
  x: number;
  y: number;
  // Numeric delta to render. Positive becomes "+N", negative "-N",
  // zero is a no-op (early-return to avoid pointless tweens).
  amount: number;
  kind: FloatKind;
  // Optional drift target — if set, the chip drifts toward (toX, toY)
  // instead of straight up. Used to send the chip toward the matching
  // resource pill at the top-right.
  toX?: number;
  toY?: number;
  // Total animation duration in ms. Default 850.
  durationMs?: number;
}

const COLORS: Record<FloatKind, string> = {
  sugar: COLOR.textGold,
  leaf: '#c8f2a0',
  milk: '#dfe8ff',
  trophy: '#ffd98a',
  generic: '#ffffff',
};

const GLYPHS: Record<FloatKind, string> = {
  sugar: '🍯',
  leaf: '🍃',
  milk: '🥛',
  trophy: '▲',
  generic: '',
};

export function spawnFloatNumber(opts: FloatNumberOptions): void {
  const { scene, x, y, amount, kind } = opts;
  if (!Number.isFinite(amount) || amount === 0) return;
  const sign = amount > 0 ? '+' : '−';
  const glyph = GLYPHS[kind];
  const label = glyph
    ? `${sign}${Math.abs(amount).toLocaleString()} ${glyph}`
    : `${sign}${Math.abs(amount).toLocaleString()}`;
  const text = scene.add
    .text(x, y, label, {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '14px',
      color: amount > 0 ? COLORS[kind] : '#ff8d8d',
      stroke: '#0c1410',
      strokeThickness: 3,
      fontStyle: 'bold',
    })
    .setOrigin(0.5, 1)
    .setDepth(DEPTHS.toast)
    .setAlpha(0);

  const dx = (opts.toX ?? x) - x;
  const dy = (opts.toY ?? (y - 56)) - y;
  const duration = opts.durationMs ?? 850;

  // Quick fade-in pulse so the chip pops on, then drifts toward the
  // target while fading out.
  scene.tweens.add({
    targets: text,
    alpha: 1,
    scale: 1.1,
    duration: 120,
    ease: 'Cubic.easeOut',
    onComplete: () => {
      scene.tweens.add({
        targets: text,
        x: x + dx,
        y: y + dy,
        alpha: 0,
        scale: 0.85,
        duration: duration - 120,
        ease: 'Sine.easeIn',
        onComplete: () => text.destroy(),
      });
    },
  });
}
