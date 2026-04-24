import Phaser from 'phaser';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import type { HiveRuntime } from '../main.js';
import type { QuestsResponse, SeasonMilestone } from '../net/Api.js';
import { crispText } from '../ui/text.js';
import { makeHiveButton } from '../ui/button.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { COLOR, DEPTHS, bodyTextStyle, displayTextStyle, labelTextStyle } from '../ui/theme.js';

const HUD_H = 56;

export class QuestsScene extends Phaser.Scene {
  private loadingText!: Phaser.GameObjects.Text;
  private rowContainer!: Phaser.GameObjects.Container;
  private quests: QuestsResponse | null = null;
  private viewportTop = HUD_H + 20;
  private contentHeight = 0;
  private scrollOffset = 0;
  private scrolling = false;
  private scrollStartY = 0;
  private scrollStartOffset = 0;
  private errorText: Phaser.GameObjects.Text | null = null;

  constructor() {
    super('QuestsScene');
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
      HUD_H + 104,
      'Loading quests...',
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
    glow.fillEllipse(this.scale.width / 2, HUD_H + 180, Math.min(880, this.scale.width * 0.92), 240);
    glow.fillStyle(COLOR.greenHi, 0.05);
    glow.fillEllipse(this.scale.width / 2, this.scale.height - 60, Math.min(960, this.scale.width * 1.05), 220);
  }

  private drawHud(): void {
    const w = this.scale.width;
    const hud = this.add.graphics();
    drawPanel(hud, 0, 0, w, HUD_H, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      stroke: COLOR.brassDeep,
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
      'Quests and Season',
      displayTextStyle(20, COLOR.textGold, 4),
    ).setOrigin(0.5);
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
    this.scrollOffset = Phaser.Math.Clamp(raw, minOffset, 0);
    this.rowContainer.y = this.viewportTop + this.scrollOffset;
  }

  private async fetchData(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const res = await runtime.api.getQuests();
      if (!this.scene.isActive()) return;
      this.loadingText.destroy();
      this.quests = res;
      this.render();
    } catch (err) {
      if (!this.scene.isActive()) return;
      this.loadingText.setText(`Error: ${(err as Error).message}`);
    }
  }

  private render(): void {
    this.rowContainer.removeAll(true);
    if (!this.quests) return;
    const maxW = Math.min(640, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    let y = 0;

    y = this.renderOverviewCard(originX, maxW, y);
    y += 16;
    y = this.renderSectionHeader('Daily Quests', 'Finish tasks, claim loot, and push your season track.', originX, maxW, y);
    const dailies = this.quests.dailyQuests.quests;
    const renderable = dailies.filter((q) => this.quests!.questDefs.some((d) => d.id === q.id));
    if (renderable.length === 0) {
      // Empty state — the daily roll can legitimately come back empty
      // (seasonal off-days, or a fresh account before the first roll
      // lands). Show a hint instead of a header-only screen.
      y = this.renderEmptyHint(
        originX,
        maxW,
        y,
        'No quests today',
        'New objectives roll every 24 hours. Check back tomorrow, or chase milestone XP below.',
      );
    } else {
      for (const q of renderable) {
        const def = this.quests.questDefs.find((d) => d.id === q.id)!;
        y = this.renderQuestRow(originX, maxW, y, q, def);
      }
    }

    y += 20;
    y = this.renderSectionHeader(
      `Season ${this.quests.season.id}`,
      `${this.quests.season.xp} XP earned so far.`,
      originX,
      maxW,
      y,
    );
    y = this.renderSeasonProgress(originX, maxW, y);
    for (const m of this.quests.season.milestones) {
      y = this.renderMilestoneRow(originX, maxW, y, m);
    }
    this.contentHeight = y + 16;
  }

  private renderOverviewCard(originX: number, maxW: number, y: number): number {
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

    const badge = this.add.graphics();
    drawPill(badge, originX + 16, y + 14, 102, 20, { brass: true });
    this.rowContainer.add(badge);
    this.rowContainer.add(
      crispText(this, originX + 67, y + 24, 'Live track', labelTextStyle(10, '#2a1d08')).setOrigin(0.5, 0.5),
    );

    this.rowContainer.add(
      crispText(this, originX + 18, y + 42, 'Keep your colony moving every day.', displayTextStyle(15, COLOR.textGold, 3))
        .setOrigin(0, 0),
    );
    this.rowContainer.add(
      crispText(
        this,
        originX + 18,
        y + 62,
        'Daily missions pay out resources now, and season milestones reward the long climb.',
        bodyTextStyle(12, COLOR.textPrimary),
      ).setOrigin(0, 0),
    );
    return y + h;
  }

  private renderSectionHeader(
    label: string,
    sublabel: string,
    originX: number,
    maxW: number,
    y: number,
  ): number {
    const pill = this.add.graphics();
    drawPill(pill, originX, y, 154, 24, { brass: true });
    this.rowContainer.add(pill);
    this.rowContainer.add(
      crispText(this, originX + 77, y + 12, label, labelTextStyle(11, '#2a1d08')).setOrigin(0.5, 0.5),
    );
    this.rowContainer.add(
      crispText(this, originX + 166, y + 3, sublabel, bodyTextStyle(12, COLOR.textDim)).setOrigin(0, 0),
    );
    return y + 34;
  }

  // Shared empty-state card. Used for "no daily quests today" so a
  // legitimately-empty day still reads as intentional design, not a
  // broken layout.
  private renderEmptyHint(
    originX: number,
    maxW: number,
    y: number,
    title: string,
    body: string,
  ): number {
    const h = 74;
    const card = this.add.graphics();
    drawPanel(card, originX, y, maxW, h, {
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
    this.rowContainer.add(card);
    this.rowContainer.add(
      crispText(this, originX + 18, y + 14, title, displayTextStyle(15, COLOR.textGold, 3)).setOrigin(0, 0),
    );
    this.rowContainer.add(
      crispText(this, originX + 18, y + 40, body, bodyTextStyle(12, COLOR.textDim))
        .setOrigin(0, 0)
        .setWordWrapWidth(maxW - 36),
    );
    return y + h + 8;
  }

  private renderSeasonProgress(originX: number, maxW: number, y: number): number {
    const top = this.quests?.season.milestones[this.quests.season.milestones.length - 1];
    if (!top || !this.quests) return y;
    const cardH = 56;
    const card = this.add.graphics();
    drawPanel(card, originX, y, maxW, cardH, {
      topColor: COLOR.bgCard,
      botColor: COLOR.bgInset,
      stroke: COLOR.outline,
      strokeWidth: 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.08,
      radius: 14,
      shadowOffset: 4,
      shadowAlpha: 0.24,
    });
    this.rowContainer.add(card);
    const barX = originX + 18;
    const barY = y + 28;
    const barW = maxW - 36;
    const frac = Math.min(1, this.quests.season.xp / top.xpRequired);
    const bar = this.add.graphics();
    bar.fillStyle(COLOR.bgDeep, 0.75);
    bar.fillRoundedRect(barX, barY, barW, 12, 6);
    bar.fillStyle(COLOR.brass, 1);
    bar.fillRoundedRect(barX + 1, barY + 1, Math.max(0, (barW - 2) * frac), 10, 5);
    bar.fillStyle(0xffffff, 0.18);
    bar.fillRoundedRect(barX + 4, barY + 2, Math.max(12, (barW - 8) * frac), 3, 2);
    this.rowContainer.add(bar);
    this.rowContainer.add(
      crispText(
        this,
        originX + 18,
        y + 10,
        `Season progress: ${this.quests.season.xp} / ${top.xpRequired} XP`,
        bodyTextStyle(12, COLOR.textPrimary),
      ).setOrigin(0, 0),
    );
    return y + cardH + 10;
  }

  private renderQuestRow(
    originX: number,
    maxW: number,
    y: number,
    q: { id: string; progress: number; claimed: boolean },
    def: { id: string; label: string; goal: number; rewardSugar: number; rewardLeaf: number; rewardXp: number },
  ): number {
    const rowH = 104;
    const complete = q.progress >= def.goal;
    const bg = this.add.graphics();
    drawPanel(bg, originX, y, maxW, rowH, {
      topColor: q.claimed ? 0x1a281c : complete ? 0x203725 : COLOR.bgCard,
      botColor: q.claimed ? 0x0e160f : complete ? 0x142016 : COLOR.bgInset,
      stroke: complete ? COLOR.greenHi : COLOR.outline,
      strokeWidth: 2,
      highlight: complete ? COLOR.brass : COLOR.greenHi,
      highlightAlpha: 0.1,
      radius: 14,
      shadowOffset: 4,
      shadowAlpha: 0.28,
    });
    this.rowContainer.add(bg);

    const statePill = this.add.graphics();
    drawPill(statePill, originX + 16, y + 12, q.claimed ? 90 : complete ? 88 : 78, 20, {
      brass: complete || q.claimed,
    });
    this.rowContainer.add(statePill);
    this.rowContainer.add(
      crispText(
        this,
        originX + (q.claimed ? 61 : complete ? 60 : 55),
        y + 22,
        q.claimed ? 'Claimed' : complete ? 'Ready' : 'Active',
        q.claimed || complete
          ? labelTextStyle(10, '#2a1d08')
          : labelTextStyle(10, COLOR.textPrimary),
      ).setOrigin(0.5, 0.5),
    );

    this.rowContainer.add(
      crispText(this, originX + 16, y + 38, def.label, displayTextStyle(15, COLOR.textGold, 3)).setOrigin(0, 0),
    );
    this.rowContainer.add(
      crispText(
        this,
        originX + 16,
        y + 62,
        `Rewards: S ${def.rewardSugar}  L ${def.rewardLeaf}  XP ${def.rewardXp}`,
        bodyTextStyle(12, COLOR.textDim),
      ).setOrigin(0, 0),
    );

    const barX = originX + 16;
    const barY = y + 82;
    const barW = maxW - 132;
    const frac = Math.min(1, q.progress / def.goal);
    const bar = this.add.graphics();
    bar.fillStyle(COLOR.bgDeep, 0.75);
    bar.fillRoundedRect(barX, barY, barW, 12, 6);
    bar.fillStyle(complete ? COLOR.brass : COLOR.greenHi, 1);
    bar.fillRoundedRect(barX + 1, barY + 1, Math.max(0, (barW - 2) * frac), 10, 5);
    bar.fillStyle(0xffffff, 0.18);
    bar.fillRoundedRect(barX + 4, barY + 2, Math.max(12, (barW - 8) * frac), 3, 2);
    this.rowContainer.add(bar);
    this.rowContainer.add(
      crispText(
        this,
        originX + maxW - 118,
        y + 68,
        `${q.progress}/${def.goal}`,
        labelTextStyle(12, COLOR.textPrimary),
      ).setOrigin(1, 0.5),
    );

    const btn = makeHiveButton(this, {
      x: originX + maxW - 62,
      y: y + 34,
      width: 92,
      height: 34,
      label: q.claimed ? 'Claimed' : 'Claim',
      variant: q.claimed ? 'ghost' : 'primary',
      fontSize: 12,
      enabled: !q.claimed && complete,
      onPress: () => void this.claimQuest(q.id),
    });
    this.rowContainer.add(btn.container);
    return y + rowH + 8;
  }

  private renderMilestoneRow(
    originX: number,
    maxW: number,
    y: number,
    m: SeasonMilestone,
  ): number {
    const rowH = 62;
    const xp = this.quests?.season.xp ?? 0;
    const claimed = this.quests?.season.milestonesClaimed.includes(m.id) ?? false;
    const unlocked = xp >= m.xpRequired;
    const bg = this.add.graphics();
    drawPanel(bg, originX, y, maxW, rowH, {
      topColor: claimed ? 0x1a281c : unlocked ? 0x203725 : COLOR.bgCard,
      botColor: claimed ? 0x0e160f : unlocked ? 0x142016 : COLOR.bgInset,
      stroke: unlocked ? COLOR.greenHi : COLOR.outline,
      strokeWidth: 2,
      highlight: unlocked ? COLOR.brass : COLOR.greenHi,
      highlightAlpha: 0.08,
      radius: 12,
      shadowOffset: 3,
      shadowAlpha: 0.22,
    });
    this.rowContainer.add(bg);

    this.rowContainer.add(
      crispText(this, originX + 16, y + 11, m.label, bodyTextStyle(13, COLOR.textPrimary)).setOrigin(0, 0),
    );
    this.rowContainer.add(
      crispText(
        this,
        originX + 16,
        y + 34,
        `Unlock at ${m.xpRequired} XP  |  Rewards: S ${m.rewardSugar}  L ${m.rewardLeaf}`,
        bodyTextStyle(11, unlocked ? COLOR.textDim : COLOR.textMuted),
      ).setOrigin(0, 0),
    );

    const btn = makeHiveButton(this, {
      x: originX + maxW - 62,
      y: y + rowH / 2,
      width: 92,
      height: 34,
      label: claimed ? 'Claimed' : 'Claim',
      variant: claimed ? 'ghost' : 'primary',
      fontSize: 12,
      enabled: unlocked && !claimed,
      onPress: () => void this.claimMilestone(m.id),
    });
    this.rowContainer.add(btn.container);
    return y + rowH + 8;
  }

  private async claimQuest(questId: string): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const res = await runtime.api.claimQuest(questId);
      if (!this.scene.isActive() || !this.quests) return;
      this.quests.dailyQuests = res.dailyQuests;
      this.quests.season.xp = res.seasonXp;
      if (runtime.player) {
        runtime.player.player.sugar = res.resources.sugar;
        runtime.player.player.leafBits = res.resources.leafBits;
        runtime.player.player.seasonXp = res.seasonXp;
      }
      this.clearError();
      this.render();
    } catch (err) {
      this.showError((err as Error).message);
    }
  }

  private async claimMilestone(milestoneId: number): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const res = await runtime.api.claimSeasonMilestone(milestoneId);
      if (!this.scene.isActive() || !this.quests) return;
      this.quests.season.milestonesClaimed = res.milestonesClaimed;
      if (runtime.player) {
        runtime.player.player.sugar = res.resources.sugar;
        runtime.player.player.leafBits = res.resources.leafBits;
        runtime.player.player.seasonMilestonesClaimed = res.milestonesClaimed;
      }
      this.clearError();
      this.render();
    } catch (err) {
      this.showError((err as Error).message);
    }
  }

  private clearError(): void {
    this.errorText?.setVisible(false);
  }

  private showError(msg: string): void {
    if (this.errorText) {
      this.errorText.setText(msg).setVisible(true);
    } else {
      this.errorText = crispText(
        this,
        this.scale.width / 2,
        this.viewportTop - 6,
        msg,
        bodyTextStyle(12, COLOR.textError),
      ).setOrigin(0.5);
    }
  }
}
