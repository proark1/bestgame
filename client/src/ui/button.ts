import Phaser from 'phaser';
import { BUTTON_VARIANT, SPACING, type ButtonVariant } from './theme.js';

// Shared game-button factory. Graphics-drawn rounded rectangle with a
// two-band gradient fill, thick outer stroke, inner highlight, drop
// shadow, and a stroked Text label. All four interaction states
// (idle / hover / press / disabled) repaint the same Graphics object
// rather than tint a sprite — when the underlying sprite was a
// procedural placeholder that tint-revealed the bare rectangle
// underneath on hover, which is the bug this factory closes.
//
// Used by HomeScene, RaidScene, ArenaScene footer buttons, result
// modal actions, deck cards — anywhere the game needs a tappable
// element that reads as a Clash-of-Clans-style chunky button.

export interface HiveButtonOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  variant?: ButtonVariant;
  fontSize?: number;
  onPress: () => void;
  // When set, the button renders desaturated and swallows pointer
  // events. Updated via `.setEnabled()` after creation.
  enabled?: boolean;
}

export interface HiveButton {
  container: Phaser.GameObjects.Container;
  setPosition: (x: number, y: number) => HiveButton;
  setLabel: (s: string) => HiveButton;
  setSize: (w: number, h: number) => HiveButton;
  setEnabled: (enabled: boolean) => HiveButton;
  setVariant: (variant: ButtonVariant) => HiveButton;
  destroy: () => void;
}

type State = 'idle' | 'hover' | 'press' | 'disabled';

export function makeHiveButton(
  scene: Phaser.Scene,
  opts: HiveButtonOptions,
): HiveButton {
  const container = scene.add.container(opts.x, opts.y);
  let curW = opts.width;
  let curH = opts.height;
  let curVariant: ButtonVariant = opts.variant ?? 'secondary';
  let curLabel = opts.label;
  let curFontSize = opts.fontSize ?? 15;
  let enabled = opts.enabled ?? true;
  let state: State = enabled ? 'idle' : 'disabled';

  const shadow = scene.add.graphics();
  const bg = scene.add.graphics();
  const highlight = scene.add.graphics();
  const text = scene.add.text(0, 0, curLabel, {}).setOrigin(0.5, 0.5);

  const paint = (): void => {
    const palette = BUTTON_VARIANT[curVariant]!;
    const w = curW;
    const h = curH;
    const r = SPACING.radiusMd;

    shadow.clear();
    if (state !== 'press') {
      // Drop shadow below the button for a "chunky floating" feel.
      // Smaller + darker on press so the button looks pushed into
      // the surface.
      shadow.fillStyle(0x000000, 0.45);
      shadow.fillRoundedRect(-w / 2 + 2, -h / 2 + 4, w, h + 2, r);
    } else {
      shadow.fillStyle(0x000000, 0.3);
      shadow.fillRoundedRect(-w / 2 + 1, -h / 2 + 2, w, h, r);
    }

    bg.clear();
    const topFill =
      state === 'hover'
        ? palette.fillTopHover
        : state === 'press'
          ? palette.fillTopPress
          : state === 'disabled'
            ? blend(palette.fillTop, 0x303030, 0.55)
            : palette.fillTop;
    const botFill =
      state === 'hover'
        ? palette.fillBotHover
        : state === 'press'
          ? palette.fillBotPress
          : state === 'disabled'
            ? blend(palette.fillBot, 0x303030, 0.55)
            : palette.fillBot;
    // Gradient via fillGradientStyle. Phaser supports 4-corner
    // gradients on rects; we want top/bottom so left+right corners
    // of the same band match.
    bg.fillGradientStyle(topFill, topFill, botFill, botFill, 1);
    bg.fillRoundedRect(-w / 2, -h / 2, w, h, r);
    bg.lineStyle(palette.strokeWidth, palette.stroke, 1);
    bg.strokeRoundedRect(-w / 2, -h / 2, w, h, r);

    highlight.clear();
    // Inner top highlight — 2px of lighter color just inside the
    // stroke. Sells the "3D bevel" look. Hidden in press state.
    if (state !== 'press' && state !== 'disabled') {
      const lighter = lightenColor(topFill, 0.35);
      highlight.fillStyle(lighter, 0.6);
      highlight.fillRoundedRect(
        -w / 2 + palette.strokeWidth,
        -h / 2 + palette.strokeWidth,
        w - palette.strokeWidth * 2,
        Math.max(4, Math.min(h * 0.35, 10)),
        r - palette.strokeWidth / 2,
      );
    }

    text.setStyle({
      fontFamily: 'ui-monospace, monospace',
      fontSize: `${curFontSize}px`,
      color: state === 'disabled' ? '#8a9688' : palette.textColor,
      fontStyle: 'bold',
      stroke: palette.textStroke,
      strokeThickness: palette.textStrokeThickness,
    } satisfies Phaser.Types.GameObjects.Text.TextStyle);
    text.setText(curLabel);
    text.setPosition(0, state === 'press' ? 2 : 0);
  };
  paint();

  const hit = scene.add
    .zone(0, 0, curW, curH)
    .setOrigin(0.5, 0.5)
    .setInteractive({ useHandCursor: enabled });

  const refreshHit = (): void => {
    hit.setSize(curW, curH);
    hit.input!.hitArea = new Phaser.Geom.Rectangle(-curW / 2, -curH / 2, curW, curH);
  };

  hit.on('pointerover', () => {
    if (state === 'disabled') return;
    state = 'hover';
    paint();
  });
  hit.on('pointerout', () => {
    if (state === 'disabled') return;
    state = 'idle';
    paint();
  });
  hit.on('pointerdown', () => {
    if (state === 'disabled') return;
    state = 'press';
    paint();
    scene.tweens.add({
      targets: container,
      scale: 0.97,
      duration: 60,
      yoyo: true,
      ease: 'Quad.easeOut',
    });
    opts.onPress();
  });
  hit.on('pointerup', () => {
    if (state === 'disabled') return;
    state = 'hover';
    paint();
  });

  container.add([shadow, bg, highlight, text, hit]);

  const api: HiveButton = {
    container,
    setPosition: (nx, ny) => {
      container.setPosition(nx, ny);
      return api;
    },
    setLabel: (s) => {
      curLabel = s;
      paint();
      return api;
    },
    setSize: (nw, nh) => {
      curW = nw;
      curH = nh;
      paint();
      refreshHit();
      return api;
    },
    setEnabled: (next) => {
      enabled = next;
      state = next ? 'idle' : 'disabled';
      hit.setInteractive({ useHandCursor: next });
      paint();
      return api;
    },
    setVariant: (v) => {
      curVariant = v;
      paint();
      return api;
    },
    destroy: () => container.destroy(),
  };
  return api;
}

// Blend two 0xRRGGBB colors at ratio [0, 1]. Used for disabled-state
// washout (blend toward a grey).
function blend(a: number, b: number, ratio: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * ratio);
  const g = Math.round(ag + (bg - ag) * ratio);
  const bC = Math.round(ab + (bb - ab) * ratio);
  return (r << 16) | (g << 8) | bC;
}

// Lighten a color toward white by `t` in [0, 1].
function lightenColor(color: number, t: number): number {
  return blend(color, 0xffffff, Math.max(0, Math.min(1, t)));
}
