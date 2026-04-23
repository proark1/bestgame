import Phaser from 'phaser';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import type { HiveRuntime } from '../main.js';
import type { QuestsResponse, SeasonMilestone } from '../net/Api.js';

// Quests + season screen.
//
// Top: today's 3 daily quests, each a row with progress bar + claim
// button. Below: the season XP bar and a scrollable milestone list
// with per-tier rewards + claim buttons. Everything server-authored;
// this scene just renders + dispatches claim requests.
//
// Kept visually close to UpgradeScene so the game has a consistent
// "list-with-right-side-claim-button" pattern.

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
    this.drawHud();
    this.rowContainer = this.add.container(0, this.viewportTop);
    this.loadingText = this.add
      .text(this.scale.width / 2, HUD_H + 100, 'Loading quests…', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#c3e8b0',
      })
      .setOrigin(0.5);
    this.wireScroll();
    void this.fetchData();
  }

  private drawHud(): void {
    const bg = this.add.graphics();
    bg.fillStyle(0x1a2b1a, 1);
    bg.fillRect(0, 0, this.scale.width, HUD_H);
    bg.lineStyle(2, 0x2c5a23, 1);
    bg.lineBetween(0, HUD_H, this.scale.width, HUD_H);

    this.add
      .text(this.scale.width / 2, HUD_H / 2, 'Quests & Season', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '18px',
        color: '#ffd98a',
      })
      .setOrigin(0.5);

    const back = this.add
      .text(16, HUD_H / 2, '← Back', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#c3e8b0',
      })
      .setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true });
    back.on('pointerdown', () => fadeToScene(this, 'HomeScene'));
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
    const maxW = Math.min(560, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    let y = 0;

    // Daily quests section.
    y = this.renderSectionHeader('Today\'s Quests', originX, maxW, y);
    for (const q of this.quests.dailyQuests.quests) {
      const def = this.quests.questDefs.find((d) => d.id === q.id);
      if (!def) continue;
      y = this.renderQuestRow(originX, maxW, y, q, def);
    }

    y += 16;
    y = this.renderSectionHeader(
      `Season ${this.quests.season.id} · ${this.quests.season.xp} XP`,
      originX,
      maxW,
      y,
    );
    // Season progress bar across the milestone range.
    const top = this.quests.season.milestones[this.quests.season.milestones.length - 1];
    if (top) {
      const barW = maxW - 24;
      const frac = Math.min(1, this.quests.season.xp / top.xpRequired);
      const bar = this.add.graphics();
      bar.fillStyle(0x1a1208, 0.7);
      bar.fillRoundedRect(originX + 12, y, barW, 10, 3);
      bar.fillStyle(0xffd98a, 1);
      bar.fillRoundedRect(originX + 13, y + 1, Math.max(0, (barW - 2) * frac), 8, 3);
      this.rowContainer.add(bar);
      y += 24;
    }
    for (const m of this.quests.season.milestones) {
      y = this.renderMilestoneRow(originX, maxW, y, m);
    }
    this.contentHeight = y + 16;
  }

  private renderSectionHeader(
    label: string,
    originX: number,
    maxW: number,
    y: number,
  ): number {
    const t = this.add
      .text(originX + maxW / 2, y + 12, label, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '15px',
        color: '#ffd98a',
      })
      .setOrigin(0.5, 0);
    this.rowContainer.add(t);
    return y + 36;
  }

  private renderQuestRow(
    originX: number,
    maxW: number,
    y: number,
    q: { id: string; progress: number; claimed: boolean },
    def: { id: string; label: string; goal: number; rewardSugar: number; rewardLeaf: number; rewardXp: number },
  ): number {
    const rowH = 78;
    const complete = q.progress >= def.goal;
    const bg = this.add.graphics();
    bg.fillStyle(q.claimed ? 0x16221a : complete ? 0x233d24 : 0x1a2b1a, 1);
    bg.lineStyle(1, complete ? 0x5ba445 : 0x2c5a23, 1);
    bg.fillRoundedRect(originX, y, maxW, rowH, 8);
    bg.strokeRoundedRect(originX, y, maxW, rowH, 8);
    this.rowContainer.add(bg);

    this.rowContainer.add(
      this.text(originX + 14, y + 10, def.label, '#e6f5d2', 14, 0, 0),
    );
    this.rowContainer.add(
      this.text(
        originX + 14,
        y + 32,
        `+${def.rewardSugar}🍬 +${def.rewardLeaf}🍃 +${def.rewardXp} XP`,
        '#c3e8b0',
        11,
        0,
        0,
      ),
    );
    // Progress bar
    const barW = maxW - 28;
    const frac = Math.min(1, q.progress / def.goal);
    const bar = this.add.graphics();
    bar.fillStyle(0x1a1208, 0.7);
    bar.fillRoundedRect(originX + 14, y + 52, barW, 10, 3);
    bar.fillStyle(complete ? 0xffd98a : 0x5ba445, 1);
    bar.fillRoundedRect(originX + 15, y + 53, Math.max(0, (barW - 2) * frac), 8, 3);
    this.rowContainer.add(bar);
    this.rowContainer.add(
      this.text(
        originX + maxW - 14,
        y + 38,
        `${q.progress}/${def.goal}`,
        '#c3e8b0',
        11,
        1,
        0.5,
      ),
    );

    // Claim button (right side)
    if (complete) {
      const btnW = 80;
      const btnH = 28;
      const bx = originX + maxW - 14 - btnW;
      const by = y + 8;
      const btn = this.add.graphics();
      btn.fillStyle(q.claimed ? 0x2a2a2a : 0x3a7f3a, 1);
      btn.lineStyle(2, q.claimed ? 0x555555 : 0xffd98a, 1);
      btn.fillRoundedRect(bx, by, btnW, btnH, 6);
      btn.strokeRoundedRect(bx, by, btnW, btnH, 6);
      this.rowContainer.add(btn);
      this.rowContainer.add(
        this.text(
          bx + btnW / 2,
          by + btnH / 2,
          q.claimed ? 'Claimed' : 'Claim',
          q.claimed ? '#777' : '#ffffff',
          12,
          0.5,
          0.5,
        ),
      );
      if (!q.claimed) {
        const hit = this.add
          .zone(bx + btnW / 2, by + btnH / 2, btnW, btnH)
          .setOrigin(0.5)
          .setInteractive({ useHandCursor: true });
        hit.on('pointerdown', () => void this.claimQuest(q.id));
        this.rowContainer.add(hit);
      }
    }
    return y + rowH + 8;
  }

  private renderMilestoneRow(
    originX: number,
    maxW: number,
    y: number,
    m: SeasonMilestone,
  ): number {
    const rowH = 44;
    const xp = this.quests?.season.xp ?? 0;
    const claimed = this.quests?.season.milestonesClaimed.includes(m.id) ?? false;
    const unlocked = xp >= m.xpRequired;
    const bg = this.add.graphics();
    bg.fillStyle(claimed ? 0x16221a : unlocked ? 0x233d24 : 0x1a2b1a, 1);
    bg.lineStyle(1, unlocked ? 0x5ba445 : 0x2c5a23, 1);
    bg.fillRoundedRect(originX, y, maxW, rowH, 8);
    bg.strokeRoundedRect(originX, y, maxW, rowH, 8);
    this.rowContainer.add(bg);
    this.rowContainer.add(
      this.text(originX + 14, y + rowH / 2, m.label, '#e6f5d2', 13, 0, 0.5),
    );
    this.rowContainer.add(
      this.text(
        originX + 150,
        y + rowH / 2,
        `${m.xpRequired} XP`,
        unlocked ? '#ffd98a' : '#7a8a7a',
        12,
        0,
        0.5,
      ),
    );
    this.rowContainer.add(
      this.text(
        originX + 260,
        y + rowH / 2,
        `+${m.rewardSugar}🍬 +${m.rewardLeaf}🍃`,
        '#c3e8b0',
        12,
        0,
        0.5,
      ),
    );

    if (unlocked) {
      const btnW = 80;
      const btnH = 28;
      const bx = originX + maxW - 14 - btnW;
      const by = y + (rowH - btnH) / 2;
      const btn = this.add.graphics();
      btn.fillStyle(claimed ? 0x2a2a2a : 0x3a7f3a, 1);
      btn.lineStyle(2, claimed ? 0x555555 : 0xffd98a, 1);
      btn.fillRoundedRect(bx, by, btnW, btnH, 6);
      btn.strokeRoundedRect(bx, by, btnW, btnH, 6);
      this.rowContainer.add(btn);
      this.rowContainer.add(
        this.text(
          bx + btnW / 2,
          by + btnH / 2,
          claimed ? 'Claimed' : 'Claim',
          claimed ? '#777' : '#ffffff',
          12,
          0.5,
          0.5,
        ),
      );
      if (!claimed) {
        const hit = this.add
          .zone(bx + btnW / 2, by + btnH / 2, btnW, btnH)
          .setOrigin(0.5)
          .setInteractive({ useHandCursor: true });
        hit.on('pointerdown', () => void this.claimMilestone(m.id));
        this.rowContainer.add(hit);
      }
    }
    return y + rowH + 6;
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
      this.render();
    } catch (err) {
      this.showError((err as Error).message);
    }
  }

  private showError(msg: string): void {
    if (this.errorText) {
      this.errorText.setText(msg).setVisible(true);
    } else {
      this.errorText = this.add
        .text(this.scale.width / 2, this.viewportTop - 4, msg, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '12px',
          color: '#d94c4c',
        })
        .setOrigin(0.5);
    }
  }

  private text(
    x: number,
    y: number,
    s: string,
    color: string,
    size: number,
    ox: number,
    oy: number,
  ): Phaser.GameObjects.Text {
    return this.add
      .text(x, y, s, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: `${size}px`,
        color,
      })
      .setOrigin(ox, oy);
  }
}
