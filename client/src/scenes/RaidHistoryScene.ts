import Phaser from 'phaser';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import type { HiveRuntime } from '../main.js';
import type { RaidHistoryEntry } from '../net/Api.js';
import { crispText } from '../ui/text.js';
import { makeHiveButton } from '../ui/button.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { COLOR, DEPTHS, bodyTextStyle, displayTextStyle, labelTextStyle } from '../ui/theme.js';

const HUD_H = 56;

export class RaidHistoryScene extends Phaser.Scene {
  private rowContainer!: Phaser.GameObjects.Container;
  private loadingText!: Phaser.GameObjects.Text;
  private contentHeight = 0;
  private viewportTop = HUD_H + 24;
  private scrollOffset = 0;
  private scrolling = false;
  private scrollStartY = 0;
  private scrollStartOffset = 0;

  constructor() {
    super('RaidHistoryScene');
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
      HUD_H + 88,
      'Loading recent raids...',
      bodyTextStyle(14, COLOR.textDim),
    ).setOrigin(0.5);
    this.wireScroll();
    void this.fetchData();
  }

  private drawAmbient(): void {
    const g = this.add.graphics().setDepth(DEPTHS.background);
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
    const glow = this.add.graphics().setDepth(DEPTHS.ambient);
    glow.fillStyle(COLOR.brass, 0.05);
    glow.fillEllipse(this.scale.width / 2, HUD_H + 140, Math.min(860, this.scale.width * 0.9), 220);
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
      this.setScroll(this.scrollStartOffset + (p.y - this.scrollStartY));
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
      'Recent Raids',
      displayTextStyle(20, COLOR.textGold, 4),
    ).setOrigin(0.5);
  }

  private async fetchData(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) {
      this.loadingText.setText('Offline - no history');
      return;
    }
    try {
      const raids = await runtime.api.getRaidHistory(30);
      if (!this.scene.isActive()) return;
      this.loadingText.destroy();
      if (raids.length === 0) {
        this.renderEmptyState();
        return;
      }
      this.renderRows(raids);
    } catch (err) {
      if (!this.scene.isActive()) return;
      this.loadingText.setText(`Error: ${(err as Error).message}`);
    }
  }

  private renderEmptyState(): void {
    const w = Math.min(560, this.scale.width - 32);
    const x = (this.scale.width - w) / 2;
    const y = 0;
    const card = this.add.graphics();
    drawPanel(card, x, y, w, 86, {
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
    const pill = this.add.graphics();
    drawPill(pill, x + 16, y + 14, 84, 20, { brass: true });
    this.rowContainer.add(card);
    this.rowContainer.add(pill);
    this.rowContainer.add(
      crispText(this, x + 58, y + 24, 'History', labelTextStyle(10, COLOR.textGold)).setOrigin(0.5, 0.5),
    );
    this.rowContainer.add(
      crispText(this, this.scale.width / 2, y + 48, 'No raids yet - launch your first attack from the home screen.', bodyTextStyle(14, COLOR.textPrimary))
        .setOrigin(0.5, 0.5),
    );
    this.contentHeight = 100;
  }

  private renderRows(raids: RaidHistoryEntry[]): void {
    this.rowContainer.removeAll(true);
    const maxW = Math.min(620, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    let y = 0;

    y = this.renderOverviewCard(originX, maxW, y, raids.length);
    y += 16;

    raids.forEach((r, i) => {
      y = this.renderRaidRow(originX, maxW, y, r, i);
    });
    this.contentHeight = y + 16;
  }

  private renderOverviewCard(originX: number, maxW: number, y: number, count: number): number {
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
    drawPill(pill, originX + 16, y + 14, 92, 20, { brass: true });
    this.rowContainer.add(pill);
    this.rowContainer.add(
      crispText(this, originX + 62, y + 24, 'Battle log', labelTextStyle(10, COLOR.textGold)).setOrigin(0.5, 0.5),
    );
    this.rowContainer.add(
      crispText(this, originX + 18, y + 42, 'Track your wins, losses, and loot swings.', displayTextStyle(15, COLOR.textGold, 3))
        .setOrigin(0, 0),
    );
    this.rowContainer.add(
      crispText(this, originX + 18, y + 62, `Showing your latest ${count} raid outcomes from both attack and defense.`, bodyTextStyle(12, COLOR.textPrimary))
        .setOrigin(0, 0),
    );
    return y + h;
  }

  private renderRaidRow(
    originX: number,
    maxW: number,
    y: number,
    r: RaidHistoryEntry,
    i: number,
  ): number {
    const rowH = 82;
    const isAttacker = r.role === 'attacker';
    const isWin = isAttacker ? r.stars > 0 : r.stars === 0;
    const bg = this.add.graphics();
    drawPanel(bg, originX, y, maxW, rowH, {
      topColor: isWin
        ? isAttacker ? 0x263922 : 0x213324
        : isAttacker ? 0x362120 : 0x3b2525,
      botColor: i % 2 === 0 ? COLOR.bgInset : 0x0c120d,
      stroke: isWin ? COLOR.greenHi : COLOR.red,
      strokeWidth: 2,
      highlight: isWin ? COLOR.brass : 0xffa0a0,
      highlightAlpha: 0.08,
      radius: 12,
      shadowOffset: 3,
      shadowAlpha: 0.2,
    });
    this.rowContainer.add(bg);

    const outcomePill = this.add.graphics();
    drawPill(outcomePill, originX + 14, y + 14, 86, 22, { brass: isWin });
    this.rowContainer.add(outcomePill);
    this.rowContainer.add(
      crispText(
        this,
        originX + 57,
        y + 25,
        isWin ? 'Success' : 'Setback',
        isWin ? labelTextStyle(11, COLOR.textGold) : labelTextStyle(11, COLOR.textPrimary),
      ).setOrigin(0.5, 0.5),
    );

    this.rowContainer.add(
      crispText(
        this,
        originX + 112,
        y + 13,
        `${isAttacker ? 'Against' : 'Defended vs'} ${r.opponentName}`,
        bodyTextStyle(14, COLOR.textPrimary),
      ).setOrigin(0, 0),
    );

    const stars = `${r.stars}/3 stars`;
    const deltaColor =
      r.trophyDelta > 0 ? '#83c76b' : r.trophyDelta < 0 ? '#ff9f9f' : COLOR.textDim;
    const deltaSign = r.trophyDelta > 0 ? '+' : '';
    this.rowContainer.add(
      crispText(
        this,
        originX + 112,
        y + 37,
        `${stars}  |  Sugar ${r.sugarLooted}  |  Leaf ${r.leafLooted}`,
        bodyTextStyle(12, isWin ? COLOR.textGold : COLOR.textDim),
      ).setOrigin(0, 0),
    );
    this.rowContainer.add(
      crispText(
        this,
        originX + maxW - 18,
        y + 22,
        `${deltaSign}${r.trophyDelta}`,
        displayTextStyle(16, deltaColor, 3),
      ).setOrigin(1, 0.5),
    );
    this.rowContainer.add(
      crispText(
        this,
        originX + maxW - 18,
        y + 56,
        formatRelative(r.createdAt),
        labelTextStyle(10, COLOR.textMuted),
      ).setOrigin(1, 0.5),
    );
    return y + rowH + 8;
  }
}

function formatRelative(isoTs: string): string {
  const t = new Date(isoTs).getTime();
  const deltaSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (deltaSec < 60) return 'just now';
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}
