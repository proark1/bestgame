import Phaser from 'phaser';
import type { Types } from '@hive/shared';
import { UNIT_CODEX } from '../codex/codexData.js';
import { crispText } from './text.js';
import { drawPanel } from './panel.js';
import {
  COLOR,
  DEPTHS,
  bodyTextStyle,
  displayTextStyle,
  labelTextStyle,
} from './theme.js';

// Read-only unit codex peek. Used by RaidScene's long-press on a deck
// card so a player who can't remember what FireAnt does can hold the
// card and read the entry without leaving the raid. Mirrors the look
// of buildingInfoModal but without any mutation paths (no upgrade,
// no demolish) — codex content only.
//
// Purely Phaser, no DOM. Closes on backdrop tap, on the × button, or
// when the caller invokes the returned close function.

const MODAL_W = 320;
const MODAL_H = 380;

export interface OpenUnitInfoOpts {
  scene: Phaser.Scene;
  kind: Types.UnitKind;
  // Callers that want to suppress default outside-tap-closes behaviour
  // can pass false here; the × button still closes.
  closeOnBackdrop?: boolean;
}

export function openUnitInfoModal(opts: OpenUnitInfoOpts): () => void {
  const { scene, kind } = opts;
  const entry = UNIT_CODEX[kind];
  if (!entry) {
    // Unknown kind — return a no-op closer so callers don't have to
    // null-check. Defending here also means the long-press detector
    // can wire up before all unit codex entries land.
    return () => undefined;
  }

  const W = scene.scale.width;
  const H = scene.scale.height;
  const cx = (W - MODAL_W) / 2;
  const cy = Math.max(40, (H - MODAL_H) / 2);

  const root = scene.add.container(0, 0).setDepth(DEPTHS.resultCard);

  // Backdrop is interactive when closeOnBackdrop is on (default).
  // Codex peek is informational, so the friendliest behaviour is
  // tap-anywhere-to-dismiss.
  const backdrop = scene.add
    .rectangle(0, 0, W, H, 0x000000, 0.55)
    .setOrigin(0, 0);
  if (opts.closeOnBackdrop !== false) {
    backdrop.setInteractive({ useHandCursor: false });
  }
  root.add(backdrop);

  const card = scene.add.graphics();
  drawPanel(card, cx, cy, MODAL_W, MODAL_H, {
    topColor: COLOR.bgPanelHi,
    botColor: COLOR.bgPanelLo,
    stroke: COLOR.brassDeep,
    strokeWidth: 2,
    highlight: COLOR.brass,
    highlightAlpha: 0.14,
    radius: 16,
    shadowOffset: 6,
    shadowAlpha: 0.4,
  });
  root.add(card);

  // Close × in the upper right. Sits above the card, cancels propagation
  // so it doesn't double-fire the backdrop dismiss.
  const closeBtn = scene.add
    .text(cx + MODAL_W - 18, cy + 14, '✕', displayTextStyle(20, COLOR.textGold, 2))
    .setOrigin(1, 0)
    .setInteractive({ useHandCursor: true });
  root.add(closeBtn);

  // Sprite portrait — falls back to placeholder if asset missing.
  const portraitY = cy + 78;
  const hasSprite = scene.textures.exists(entry.spriteKey);
  if (hasSprite) {
    const portrait = scene.add
      .image(cx + MODAL_W / 2, portraitY, entry.spriteKey)
      .setDisplaySize(96, 96);
    root.add(portrait);
  }

  // Name + role + faction row.
  const nameY = portraitY + 64;
  root.add(
    crispText(
      scene,
      cx + MODAL_W / 2,
      nameY,
      entry.name,
      displayTextStyle(20, COLOR.textGold, 3),
    ).setOrigin(0.5, 0),
  );
  root.add(
    crispText(
      scene,
      cx + MODAL_W / 2,
      nameY + 26,
      `${entry.role} · ${entry.faction}`,
      labelTextStyle(11, COLOR.textDim),
    ).setOrigin(0.5, 0),
  );

  // Story + power blurbs. Both wrap to the card width minus padding.
  const padX = 18;
  const bodyStart = nameY + 52;
  const story = crispText(
    scene,
    cx + padX,
    bodyStart,
    entry.story,
    bodyTextStyle(12, COLOR.textPrimary),
  ).setWordWrapWidth(MODAL_W - padX * 2);
  root.add(story);

  const powerStart = bodyStart + story.height + 14;
  root.add(
    crispText(
      scene,
      cx + padX,
      powerStart,
      'POWER',
      labelTextStyle(10, COLOR.textGold),
    ),
  );
  root.add(
    crispText(
      scene,
      cx + padX,
      powerStart + 16,
      entry.power,
      bodyTextStyle(12, COLOR.textDim),
    ).setWordWrapWidth(MODAL_W - padX * 2),
  );

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    root.destroy();
  };

  closeBtn.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, ev?: Phaser.Types.Input.EventData) => {
    ev?.stopPropagation();
    close();
  });
  if (opts.closeOnBackdrop !== false) {
    backdrop.on('pointerdown', close);
  }

  return close;
}
