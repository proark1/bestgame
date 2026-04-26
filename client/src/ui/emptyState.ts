import Phaser from 'phaser';
import { drawPanel } from './panel.js';
import {
  COLOR,
  bodyTextStyle,
  displayTextStyle,
  labelTextStyle,
} from './theme.js';

// Empty-state widget — illustrative panel + caption used when a list
// or feed has no entries yet. Replaces the "plain dark text on dark
// bg" empty state with something that reads as INTENTIONAL rather
// than broken. Pure drawn UI (no asset dependency); a vector
// illustration is wrapped behind one big rounded card.
//
// Used by RaidHistoryScene, ClanScene member list, ReplayFeedScene,
// HiveWarScene, RaidScene tactics panel.

export interface EmptyStateOptions {
  scene: Phaser.Scene;
  x: number;
  y: number;
  width: number;
  // Big ASCII / glyph drawn at the top of the card. Single character
  // or a 2-char emoji works well; we render at 48 px so anything
  // larger looks lumpy. Examples:
  //   📜 (history), 🐜 (clan), ⭐ (replays), 🌐 (hive war), ⑂ (tactics)
  glyph: string;
  // One-line title in display style. Short and active voice.
  title: string;
  // Optional second-line body — can wrap. Keep it under ~120 chars.
  body?: string;
}

export interface EmptyStateHandle {
  // Total height the widget consumed — caller adds this to its
  // running y cursor to lay out anything below.
  height: number;
  // Container the widget rendered into. Caller can add it to a scroll
  // body via container.add(handle.container).
  container: Phaser.GameObjects.Container;
}

export function drawEmptyState(opts: EmptyStateOptions): EmptyStateHandle {
  const { scene, x, y, width, glyph, title, body } = opts;
  const padX = 18;
  const glyphSize = 48;
  // Title + body lines — pre-measure roughly so the card's height
  // adapts when the body wraps to a 2nd line.
  const bodyWraps = body && body.length > 56;
  const h = 64 + glyphSize + (body ? (bodyWraps ? 36 : 22) : 0);

  const container = scene.add.container(0, 0);
  const card = scene.add.graphics();
  drawPanel(card, x, y, width, h, {
    topColor: COLOR.bgPanelHi,
    botColor: COLOR.bgPanelLo,
    stroke: COLOR.brassDeep,
    strokeWidth: 2,
    highlight: COLOR.brass,
    highlightAlpha: 0.12,
    radius: 14,
    shadowOffset: 4,
    shadowAlpha: 0.28,
  });
  container.add(card);

  // Glyph circle — a soft amber halo behind the icon so the empty
  // state feels like an intentional illustration, not a missing
  // image. The glyph itself is plain Unicode, so this works on
  // every device without a sprite roundtrip.
  const cx = x + width / 2;
  const cy = y + 16 + glyphSize / 2;
  const halo = scene.add.graphics();
  halo.fillStyle(COLOR.brass, 0.18);
  halo.fillCircle(cx, cy, glyphSize / 2 + 8);
  container.add(halo);
  const glyphText = scene.add
    .text(cx, cy, glyph, {
      fontFamily: 'ui-monospace, monospace',
      fontSize: `${glyphSize}px`,
      color: COLOR.textGold,
    })
    .setOrigin(0.5, 0.5);
  container.add(glyphText);

  const titleY = y + 16 + glyphSize + 12;
  const titleText = scene.add
    .text(cx, titleY, title, displayTextStyle(14, COLOR.textGold, 2))
    .setOrigin(0.5, 0);
  container.add(titleText);

  if (body) {
    const bodyText = scene.add
      .text(cx, titleY + 22, body, {
        ...bodyTextStyle(12, COLOR.textPrimary),
        align: 'center',
        wordWrap: { width: width - padX * 2 },
      })
      .setOrigin(0.5, 0);
    container.add(bodyText);
  }

  // Suppress ESLint label-warning by using the import.
  void labelTextStyle;
  return { height: h, container };
}
