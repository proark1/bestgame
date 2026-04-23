import Phaser from 'phaser';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import type { HiveRuntime } from '../main.js';
import type { LeaderboardEntry } from '../net/Api.js';
import { crispText } from '../ui/text.js';
import { makeHiveButton } from '../ui/button.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { COLOR, bodyTextStyle, displayTextStyle, labelTextStyle } from '../ui/theme.js';

const HUD_H = 56;

export class LeaderboardScene extends Phaser.Scene {
  private rowContainer!: Phaser.GameObjects.Container;
  private loadingText!: Phaser.GameObjects.Text;
  private contentHeight = 0;
  private viewportTop = HUD_H + 24;
  private scrollOffset = 0;
  private scrolling = false;
  private scrollStartY = 0;
  private scrollStartOffset = 0;

  constructor() {
    super('LeaderboardScene');
  }

  create(): void {
    fadeInScene(this);
    installSceneClickDebug(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    this.drawAmbient();
    this.drawHud();
    this.rowContainer = this.add.container(0, this.viewportTop);
    this.loadingText = crispText(
      this,
      this.scale.width / 2,
      HUD_H + 92,
      'Loading standings...',
      bodyTextStyle(14, COLOR.textDim),
    ).setOrigin(0.5);

    this.wireScroll();
    void this.fetchData();
  }

  private drawAmbient(): void {
    const g = this.add.graphics().setDepth(-100);
    const top = 0x203224;
    const bot = 0x070d08;
    const bands = 18;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      const r = Math.round(((top >> 16) & 0xff) + (((bot >> 16) & 0xff) - ((top >> 16) & 0xff)) * t);
      const gc = Math.round(((top >> 8) & 0xff) + (((bot >> 8) & 0xff) - ((top >> 8) & 0xff)) * t);
      const b = Math.round((top & 0xff) + ((bot & 0xff) - (top & 0xff)) * t);
      g.fillStyle((r << 16) | (gc << 8) | b, 1);
      g.fillRect(
        0,
        Math.floor((i * this.scale.height) / bands),
        this.scale.width,
        Math.ceil(this.scale.height / bands) + 1,
      );
    }
    const glow = this.add.graphics().setDepth(-99);
    glow.fillStyle(COLOR.brass, 0.05);
    glow.fillEllipse(this.scale.width / 2, HUD_H + 140, Math.min(820, this.scale.width * 0.88), 220);
  }

  private wireScroll(): void {
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.y < this.viewportTop) return;
      this.scrolling = true;
      this.scrollStartY = p.y;
      this.scrollStartOffset = this.scrollOffset;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.scrolling || !p.isDown) return;
      const dy = p.y - this.scrollStartY;
      this.setScroll(this.scrollStartOffset + dy);
    });
    this.input.on('pointerup', () => {
      this.scrolling = false;
    });
    this.input.on(
      'wheel',
      (_p: Phaser.Input.Pointer, _obj: unknown[], _dx: number, dy: number) => {
        this.setScroll(this.scrollOffset - dy);
      },
    );
  }

  private setScroll(raw: number): void {
    const viewportH = this.scale.height - this.viewportTop - 16;
    const minOffset = Math.min(0, viewportH - this.contentHeight);
    const clamped = Math.max(minOffset, Math.min(0, raw));
    this.scrollOffset = clamped;
    this.rowContainer.setY(this.viewportTop + clamped);
  }

  private drawHud(): void {
    const w = this.scale.width;
    const hud = this.add.graphics();
    drawPanel(hud, 0, 0, w, HUD_H, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      strokeWidth: 0,
      highlight: COLOR.brass,
      highlightAlpha: 0.12,
      radius: 0,
      shadowOffset: 0,
      shadowAlpha: 0,
    });
    hud.fillStyle(0x000000, 0.4);
    hud.fillRect(0, HUD_H, w, 3);

    makeHiveButton(this, {
      x: 72,
      y: HUD_H / 2,
      width: 120,
      height: 36,
      label: 'Home',
      variant: 'ghost',
      fontSize: 13,
      onPress: () => fadeToScene(this, 'HomeScene'),
    });

    crispText(
      this,
      this.scale.width / 2,
      HUD_H / 2,
      'Leaderboard',
      displayTextStyle(20, COLOR.textGold, 4),
    ).setOrigin(0.5);
  }

  private async fetchData(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) {
      this.loadingText.setText('Offline - no standings');
      return;
    }
    try {
      const res = await runtime.api.getLeaderboard(50);
      if (!this.scene.isActive()) return;
      this.loadingText.destroy();
      this.renderRows(res.top, res.me?.playerId ?? null, res.me);
    } catch (err) {
      if (!this.scene.isActive()) return;
      this.loadingText.setText(`Error: ${(err as Error).message}`);
    }
  }

  private renderRows(
    rows: LeaderboardEntry[],
    mePlayerId: string | null,
    me: LeaderboardEntry | null,
  ): void {
    this.rowContainer.removeAll(true);
    const maxW = Math.min(640, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    const rowH = 56;
    let y = 0;

    y = this.renderOverviewCard(originX, maxW, y, rows.length, me);
    y += 16;

    const header = this.add.graphics();
    drawPanel(header, originX, y, maxW, 44, {
      topColor: COLOR.bgCard,
      botColor: COLOR.bgInset,
      stroke: COLOR.outline,
      strokeWidth: 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.08,
      radius: 12,
      shadowOffset: 3,
      shadowAlpha: 0.2,
    });
    this.rowContainer.add(header);
    this.rowContainer.add(
      crispText(this, originX + 18, y + 14, 'Rank', labelTextStyle(12, COLOR.textGold)).setOrigin(0, 0),
    );
    this.rowContainer.add(
      crispText(this, originX + 90, y + 14, 'Commander', labelTextStyle(12, COLOR.textGold)).setOrigin(0, 0),
    );
    this.rowContainer.add(
      crispText(this, originX + maxW - 20, y + 14, 'Trophies', labelTextStyle(12, COLOR.textGold)).setOrigin(1, 0),
    );
    y += 52;

    if (rows.length === 0) {
      // Empty state — brand-new seasons (or a server with no recent
      // raids) would otherwise land the user on a header-only page.
      this.rowContainer.add(
        crispText(
          this,
          this.scale.width / 2,
          y + 28,
          'No commanders on the board yet.',
          displayTextStyle(15, COLOR.textDim, 3),
        ).setOrigin(0.5, 0),
      );
      this.rowContainer.add(
        crispText(
          this,
          this.scale.width / 2,
          y + 56,
          'Raid a base to log your first trophies — you might take the top slot.',
          bodyTextStyle(12, COLOR.textMuted),
        ).setOrigin(0.5, 0),
      );
      y += 96;
    }

    rows.forEach((r, i) => {
      y = this.renderRow(originX, maxW, y, rowH, r, i, r.playerId === mePlayerId);
    });

    if (me && !rows.some((r) => r.playerId === mePlayerId)) {
      this.rowContainer.add(
        crispText(this, this.scale.width / 2, y + 10, 'You are just below the visible top list.', bodyTextStyle(12, COLOR.textMuted))
          .setOrigin(0.5, 0.5),
      );
      y += 24;
      y = this.renderRow(originX, maxW, y, rowH, me, rows.length, true, true);
    }

    this.contentHeight = y + 16;
  }

  private renderOverviewCard(
    originX: number,
    maxW: number,
    y: number,
    count: number,
    me: LeaderboardEntry | null,
  ): number {
    const h = 84;
    const card = this.add.graphics();
    drawPanel(card, originX, y, maxW, h, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.14,
      radius: 16,
      shadowOffset: 5,
      shadowAlpha: 0.32,
    });
    this.rowContainer.add(card);

    const pill = this.add.graphics();
    drawPill(pill, originX + 16, y + 14, 96, 20, { brass: true });
    this.rowContainer.add(pill);
    this.rowContainer.add(
      crispText(this, originX + 64, y + 24, 'Season rank', labelTextStyle(10, '#2a1d08')).setOrigin(0.5, 0.5),
    );

    this.rowContainer.add(
      crispText(this, originX + 18, y + 42, 'Climb the trophy ladder and defend your place.', displayTextStyle(15, COLOR.textGold, 3))
        .setOrigin(0, 0),
    );
    this.rowContainer.add(
      crispText(
        this,
        originX + 18,
        y + 62,
        me
          ? `Viewing top ${count}. Your current rank is #${me.rank} with ${me.trophies} trophies.`
          : `Viewing top ${count} players across the colony wars ladder.`,
        bodyTextStyle(12, COLOR.textPrimary),
      ).setOrigin(0, 0),
    );
    return y + h;
  }

  private renderRow(
    originX: number,
    maxW: number,
    y: number,
    rowH: number,
    r: LeaderboardEntry,
    i: number,
    isMe: boolean,
    forceHighlight = false,
  ): number {
    const bg = this.add.graphics();
    drawPanel(bg, originX, y, maxW, rowH, {
      topColor: isMe ? 0x2a3b20 : i % 2 === 0 ? COLOR.bgCard : COLOR.bgInset,
      botColor: isMe ? 0x182112 : 0x0d150f,
      stroke: isMe || forceHighlight ? COLOR.brassDeep : COLOR.outline,
      strokeWidth: isMe || forceHighlight ? 2 : 1,
      highlight: isMe || forceHighlight ? COLOR.brass : COLOR.greenHi,
      highlightAlpha: isMe || forceHighlight ? 0.14 : 0.06,
      radius: 12,
      shadowOffset: 3,
      shadowAlpha: 0.2,
    });
    this.rowContainer.add(bg);

    const rankPill = this.add.graphics();
    drawPill(rankPill, originX + 14, y + 14, 48, 24, { brass: r.rank <= 3 || isMe });
    this.rowContainer.add(rankPill);
    this.rowContainer.add(
      crispText(
        this,
        originX + 38,
        y + 26,
        `#${r.rank}`,
        r.rank <= 3 || isMe
          ? labelTextStyle(11, '#2a1d08')
          : labelTextStyle(11, COLOR.textPrimary),
      ).setOrigin(0.5, 0.5),
    );

    this.rowContainer.add(
      crispText(
        this,
        originX + 80,
        y + 12,
        isMe ? `${r.displayName} (you)` : r.displayName,
        bodyTextStyle(14, isMe ? COLOR.textGold : COLOR.textPrimary),
      ).setOrigin(0, 0),
    );
    this.rowContainer.add(
      crispText(
        this,
        originX + 80,
        y + 33,
        `${factionName(r.faction)}`,
        bodyTextStyle(11, COLOR.textDim),
      ).setOrigin(0, 0),
    );
    this.rowContainer.add(
      crispText(
        this,
        originX + maxW - 20,
        y + rowH / 2,
        `${r.trophies}`,
        displayTextStyle(16, COLOR.textGold, 3),
      ).setOrigin(1, 0.5),
    );
    return y + rowH + 8;
  }
}

function factionName(faction: string): string {
  switch (faction) {
    case 'Ants':
      return 'Ants';
    case 'Bees':
      return 'Bees';
    case 'Beetles':
      return 'Beetles';
    case 'Spiders':
      return 'Spiders';
    default:
      return faction || 'Unknown';
  }
}
