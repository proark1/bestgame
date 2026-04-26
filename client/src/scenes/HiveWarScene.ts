import Phaser from 'phaser';
import type { HiveRuntime } from '../main.js';
import type {
  HiveWarEnrollment,
  HiveWarSeasonResponse,
} from '../net/Api.js';
import { fadeInScene } from '../ui/transitions.js';
import {
  drawSceneAmbient,
  drawSceneHud,
} from '../ui/sceneFrame.js';
import { makeHiveButton } from '../ui/button.js';
import { crispText } from '../ui/text.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import {
  COLOR,
  bodyTextStyle,
  displayTextStyle,
  labelTextStyle,
} from '../ui/theme.js';

// HiveWarScene — foundation map view for the giant-map hive wars
// feature. Renders the current season's board (board_w × board_h)
// with each enrolled clan painted at its assigned slot. Leader of an
// un-enrolled clan sees an "Enroll my clan" button; everyone else
// sees a read-only map.
//
// Honest scope: attack mechanics are NOT in this scene. The audit
// asked for "weekly hive wars on a giant shared map" — this is the
// foundation (seasons, enrollment, slot grid, scoreboard). Attack
// submission + neighbour targeting + finalisation rewards land on
// top of this in a future PR using the same season + enrollments
// table.

const HUD_H = 56;
const TILE = 64;       // map cell size
const PADDING = 16;

export class HiveWarScene extends Phaser.Scene {
  private container!: Phaser.GameObjects.Container;
  private statusText: Phaser.GameObjects.Text | null = null;
  private seasonData: HiveWarSeasonResponse | null = null;

  constructor() { super('HiveWarScene'); }

  create(): void {
    fadeInScene(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    drawSceneAmbient(this);
    drawSceneHud(this, 'Hive War', 'HomeScene');
    this.container = this.add.container(0, HUD_H + 12);
    this.statusText = crispText(
      this, this.scale.width / 2, HUD_H + 80,
      'Loading hive war…',
      bodyTextStyle(13, COLOR.textDim),
    ).setOrigin(0.5, 0.5);
    void this.loadSeason();
  }

  private async loadSeason(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) {
      this.statusText?.setText('Offline.');
      return;
    }
    try {
      this.seasonData = await runtime.api.getHiveWarSeason();
      if (!this.scene.isActive()) return;
      this.statusText?.destroy();
      this.statusText = null;
      this.renderScene(runtime);
    } catch (err) {
      this.statusText?.setText(`Couldn't load: ${(err as Error).message}`);
    }
  }

  private renderScene(runtime: HiveRuntime): void {
    if (!this.seasonData) return;
    this.container.removeAll(true);
    if (!this.seasonData.season) {
      this.container.add(
        crispText(this, 16, 16, 'No active hive war season. A new one starts soon.',
          bodyTextStyle(13, COLOR.textDim))
          .setWordWrapWidth(this.scale.width - 32, true),
      );
      return;
    }
    this.renderHeader(runtime);
    this.renderBoard();
    this.renderLeaderboard();
  }

  private renderHeader(runtime: HiveRuntime): void {
    if (!this.seasonData?.season) return;
    const w = Math.min(640, this.scale.width - 32);
    const x = (this.scale.width - w) / 2;
    const y = 0;
    const h = 96;
    const card = this.add.graphics();
    drawPanel(card, x, y, w, h, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.18,
      radius: 16,
      shadowOffset: 5,
      shadowAlpha: 0.32,
    });
    this.container.add(card);
    const pill = this.add.graphics();
    drawPill(pill, x + 14, y + 12, 110, 22, { brass: true });
    this.container.add(pill);
    this.container.add(
      crispText(this, x + 69, y + 23,
        this.seasonData.season.state.toUpperCase(),
        labelTextStyle(11, COLOR.textGold)).setOrigin(0.5, 0.5),
    );
    this.container.add(
      crispText(this, x + 16, y + 42, this.seasonData.season.name,
        displayTextStyle(15, COLOR.textGold, 3)),
    );
    const ends = new Date(this.seasonData.season.endsAt);
    const hoursLeft = Math.max(0, Math.floor((ends.getTime() - Date.now()) / 3_600_000));
    this.container.add(
      crispText(this, x + 16, y + 64,
        `${hoursLeft} h remaining · ${this.seasonData.enrollments.length}/${this.seasonData.season.boardW * this.seasonData.season.boardH} clans enrolled`,
        bodyTextStyle(12, COLOR.textPrimary)),
    );

    // Enroll button — only renders when the viewer can act on it.
    // Leader-only check happens server-side; client just shows the
    // CTA when no enrollment exists for the viewer's clan.
    const canEnroll =
      this.seasonData.season.state === 'open' && this.seasonData.myEnrollment === null;
    if (canEnroll) {
      const btn = makeHiveButton(this, {
        x: x + w - 110,
        y: y + h / 2,
        width: 180,
        height: 36,
        label: 'Enroll my clan',
        variant: 'primary',
        fontSize: 13,
        onPress: () => { void this.enroll(runtime); },
      });
      this.container.add(btn.container);
    } else if (this.seasonData.myEnrollment) {
      this.container.add(
        crispText(this, x + w - 16, y + h / 2,
          `🏰 Slot (${this.seasonData.myEnrollment.slotX}, ${this.seasonData.myEnrollment.slotY}) · ${this.seasonData.myEnrollment.score} pts`,
          bodyTextStyle(12, COLOR.textGold)).setOrigin(1, 0.5),
      );
    }
  }

  private renderBoard(): void {
    if (!this.seasonData?.season) return;
    const { boardW, boardH } = this.seasonData.season;
    const myClanId = this.seasonData.myClanId;
    const boardPxW = boardW * TILE;
    const boardPxH = boardH * TILE;
    const offsetX = Math.max(PADDING, (this.scale.width - boardPxW) / 2);
    const offsetY = 110;

    // Backdrop + grid lines
    const bg = this.add.graphics();
    bg.fillStyle(0x162216, 0.95);
    bg.fillRoundedRect(offsetX - 4, offsetY - 4, boardPxW + 8, boardPxH + 8, 10);
    bg.lineStyle(1, COLOR.brassDeep, 0.4);
    for (let i = 0; i <= boardW; i++) {
      bg.beginPath();
      bg.moveTo(offsetX + i * TILE, offsetY);
      bg.lineTo(offsetX + i * TILE, offsetY + boardPxH);
      bg.strokePath();
    }
    for (let j = 0; j <= boardH; j++) {
      bg.beginPath();
      bg.moveTo(offsetX, offsetY + j * TILE);
      bg.lineTo(offsetX + boardPxW, offsetY + j * TILE);
      bg.strokePath();
    }
    this.container.add(bg);

    // One node per enrollment. Highlighted if it's the viewer's
    // clan; otherwise a flat amber pill with the tag.
    for (const e of this.seasonData.enrollments) {
      this.renderEnrollmentNode(offsetX, offsetY, e, e.clanId === myClanId);
    }
  }

  private renderEnrollmentNode(
    boardX: number,
    boardY: number,
    e: HiveWarEnrollment,
    isMe: boolean,
  ): void {
    const cx = boardX + e.slotX * TILE + TILE / 2;
    const cy = boardY + e.slotY * TILE + TILE / 2;
    const node = this.add.graphics();
    node.fillStyle(isMe ? 0x3a7f3a : 0x3a3520, 1);
    node.lineStyle(2, isMe ? 0xffd98a : COLOR.brassDeep, 1);
    node.fillCircle(cx, cy, 22);
    node.strokeCircle(cx, cy, 22);
    this.container.add(node);
    this.container.add(
      crispText(this, cx, cy - 2,
        e.clanTag.slice(0, 4) || '???',
        labelTextStyle(10, isMe ? '#fff' : '#ffd98a'))
        .setOrigin(0.5, 0.5),
    );
    this.container.add(
      crispText(this, cx, cy + 10, `${e.score}`,
        labelTextStyle(8, '#cee1b4')).setOrigin(0.5, 0.5),
    );
  }

  private renderLeaderboard(): void {
    if (!this.seasonData?.season) return;
    const w = Math.min(640, this.scale.width - 32);
    const x = (this.scale.width - w) / 2;
    const top = 110 + this.seasonData.season.boardH * TILE + 24;
    const rows = this.seasonData.enrollments.slice(0, 5);
    if (rows.length === 0) {
      this.container.add(
        crispText(this, x, top, 'No clans enrolled yet — be the first.',
          bodyTextStyle(12, COLOR.textMuted)),
      );
      return;
    }
    this.container.add(
      crispText(this, x, top, 'Top clans',
        labelTextStyle(11, COLOR.textGold)),
    );
    rows.forEach((e, i) => {
      const rowY = top + 22 + i * 22;
      this.container.add(
        crispText(this, x, rowY,
          `${i + 1}. [${e.clanTag}] ${e.clanName}`,
          bodyTextStyle(12, COLOR.textPrimary)),
      );
      this.container.add(
        crispText(this, x + w - 16, rowY,
          `${e.score} pts`,
          bodyTextStyle(12, COLOR.textGold))
          .setOrigin(1, 0),
      );
    });
  }

  private async enroll(runtime: HiveRuntime): Promise<void> {
    if (!this.seasonData?.season) return;
    try {
      await runtime.api.hiveWarEnroll(this.seasonData.season.id);
      // Refresh; the server response gives us the slot but
      // re-loading is cheap and keeps the leaderboard in sync.
      this.seasonData = await runtime.api.getHiveWarSeason();
      if (!this.scene.isActive()) return;
      this.renderScene(runtime);
    } catch (err) {
      this.statusText?.setText?.(`Enroll failed: ${(err as Error).message}`);
    }
  }
}
