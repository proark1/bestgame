import Phaser from 'phaser';
import { BUTTON_VARIANT, COLOR, FONT, SPACING, type ButtonVariant } from './theme.js';
import { isUiOverrideActive } from './uiOverrides.js';
import { isClickDebugEnabled } from './clickDebug.js';
import { resumeAudio, sfxClick } from './audio.js';

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

  // Button visuals are a flat gradient body + stroke. A previous
  // iteration painted a lighter "highlight" strip and a whiter
  // "gloss" band at the top to fake a 3D bevel, but the strips read
  // as the button leaking/mirroring above itself on the HUD. The
  // two graphics slots are left here (unused after paint()) to keep
  // the original add-order stable — callers that relied on the
  // container's child layout would otherwise need to be audited.
  const shadow = scene.add.graphics();
  const bg = scene.add.graphics();
  const highlight = scene.add.graphics();
  const gloss = scene.add.graphics();
  // When the admin has flipped the menuUi override on AND the matching
  // texture is loaded, we render an additional NineSlice image on top
  // of the Graphics fallback and hide the Graphics parts. We never
  // replace Graphics outright because the override might flip off
  // (variant change, etc.); the Graphics objects stay in the container
  // and are re-shown automatically when paint() re-runs.
  let ninesliceBg: Phaser.GameObjects.NineSlice | null = null;
  const text = scene.add.text(0, 0, curLabel, {}).setOrigin(0.5, 0.5);

  // Map button variant → override key. Only primary/secondary have a
  // generated asset today; other variants fall through to Graphics.
  const overrideKeyFor = (v: ButtonVariant): string | null => {
    if (v === 'primary') return 'ui-button-primary-bg';
    if (v === 'secondary') return 'ui-button-secondary-bg';
    return null;
  };

  const paint = (): void => {
    const palette = BUTTON_VARIANT[curVariant]!;
    const w = curW;
    const h = curH;
    const r = SPACING.radiusMd;
    const overrideKey = overrideKeyFor(curVariant);
    const useImage = overrideKey !== null && isUiOverrideActive(scene, overrideKey);

    shadow.clear();
    if (!useImage) {
      // Soft navy-tinted ambient shadow — modern mobile-game feel.
      // Pure-black drop shadows looked harsh on the new pastel scenes.
      if (state !== 'press') {
        shadow.fillStyle(0x1f2148, 0.22);
        shadow.fillRoundedRect(-w / 2, -h / 2 + 4, w, h + 2, r);
      } else {
        shadow.fillStyle(0x1f2148, 0.16);
        shadow.fillRoundedRect(-w / 2, -h / 2 + 2, w, h, r);
      }
    }

    bg.clear();
    if (!useImage) {
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
      bg.lineStyle(1.5, lightenColor(palette.stroke, 0.3), 0.45);
      bg.strokeRoundedRect(
        -w / 2 + palette.strokeWidth,
        -h / 2 + palette.strokeWidth,
        w - palette.strokeWidth * 2,
        h - palette.strokeWidth * 2,
        Math.max(2, r - 2),
      );
    }

    // Previously painted top highlight + gloss strips here to fake a
    // 3D bevel; they were removed because the bright bands over the
    // top half of the button read as the button "bleeding / mirroring"
    // above itself, especially against the HUD chrome. We keep the
    // clears so lingering paint from a prior state (before a re-
    // paint) doesn't remain visible.
    highlight.clear();
    gloss.clear();

    // Image path: create / resize the NineSlice, tint for state
    // feedback (darken on press, desaturate on disabled), and hide
    // the Graphics parts. The prompt set guarantees 256×128 button
    // art with 16px brass corners, so 16/16/16/16 insets are safe.
    if (useImage && overrideKey) {
      if (!ninesliceBg) {
        ninesliceBg = scene.add.nineslice(
          0,
          0,
          overrideKey,
          undefined,
          w,
          h,
          16,
          16,
          16,
          16,
        );
        // Insert below text + shadow is already below in add order;
        // NineSlice is appended to container after this paint().
        container.addAt(ninesliceBg, 0);
      } else {
        ninesliceBg.setSize(w, h);
      }
      ninesliceBg.setVisible(true);
      // State tint: a mild brighten on hover, darken on press, grey
      // wash on disabled. Keep it subtle — the image already reads.
      const tint =
        state === 'hover'
          ? 0xffffff
          : state === 'press'
            ? 0xbfbfbf
            : state === 'disabled'
              ? 0x808080
              : 0xffffff;
      ninesliceBg.setTint(tint);
      ninesliceBg.setAlpha(state === 'disabled' ? 0.7 : 1);
      ninesliceBg.setPosition(0, state === 'press' ? 2 : 0);
    } else if (ninesliceBg) {
      ninesliceBg.setVisible(false);
    }

    text.setStyle({
      fontFamily: FONT.display,
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

  // Phaser's InputManager.pointWithinHitArea adds displayOriginX/Y to
  // the local pointer before containment-testing, so the visible
  // bounds of a center-origin zone correspond to Rectangle(0, 0, w, h)
  // in hit-area space. We explicitly re-stamp that rectangle on every
  // resize. Zone.setSize already resizes the default rect in place
  // when customHitArea is false, but re-stamping in-place via setTo
  // keeps the hit zone correct even if customHitArea ever flips
  // (e.g. during a future setInteractive re-invocation for the
  // disabled-state cursor change), so this code path doesn't silently
  // regress into the (-w/2, -h/2, w, h) shift that caused footer
  // buttons to ignore clicks on their right and bottom halves.
  const refreshHit = (): void => {
    hit.setSize(curW, curH);
    const rect = hit.input?.hitArea as Phaser.Geom.Rectangle | undefined;
    if (rect && typeof rect.setTo === 'function') {
      rect.setTo(0, 0, curW, curH);
    }
  };
  refreshHit();

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
  hit.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
    if (state === 'disabled') return;
    if (isClickDebugEnabled()) {
      // One log per button press when debug is on. Records the
      // container's world position, the hit zone's world transform,
      // and the pointer's game/world coords — plus a pass/fail on
      // whether the pointer actually lands inside the visible
      // rectangle. When the user reports "clicks land in the wrong
      // button" this tells us immediately whether the hit zone and
      // the visible chrome are still aligned.
      const wt = container.getWorldTransformMatrix();
      // Don't non-null-assert hit.input: setInteractive can be
      // cleared (e.g. removeInteractive during a tween teardown)
      // and logging a click mid-teardown shouldn't throw.
      const hitArea = hit.input?.hitArea as Phaser.Geom.Rectangle | undefined;
      console.log('[hive-debug] button pointerdown', {
        label: curLabel,
        pointerWorld: { x: pointer.worldX, y: pointer.worldY },
        pointerGame: { x: pointer.x, y: pointer.y },
        containerWorld: { x: wt.tx, y: wt.ty },
        size: { w: curW, h: curH },
        zoneOrigin: { x: hit.originX, y: hit.originY },
        displayOrigin: { x: hit.displayOriginX, y: hit.displayOriginY },
        hitArea: hitArea
          ? { x: hitArea.x, y: hitArea.y, w: hitArea.width, h: hitArea.height }
          : null,
      });
    }
    state = 'press';
    paint();
    scene.tweens.add({
      targets: container,
      scale: 0.97,
      duration: 60,
      yoyo: true,
      ease: 'Quad.easeOut',
    });
    // Resume-on-gesture: browsers gate AudioContext until the user
    // actually taps. Every button press is a valid gesture, so call
    // resume here once per press and then fire the click sfx. Both
    // calls are silent when audio is muted / unsupported.
    resumeAudio();
    sfxClick();
    opts.onPress();
  });
  hit.on('pointerup', () => {
    if (state === 'disabled') return;
    state = 'hover';
    paint();
  });

  container.add([shadow, bg, highlight, gloss, text, hit]);

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
