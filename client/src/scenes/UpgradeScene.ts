import Phaser from 'phaser';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import type { Types } from '@hive/shared';
import type { HiveRuntime } from '../main.js';
import type { UnitUpgradeEntry } from '../net/Api.js';

// Upgrade screen: list every upgradeable unit with its current level,
// the cost of the next level, and a button to commit the upgrade.
// Server owns the cost math; we only render and explain the curve.

const HUD_H = 56;

export class UpgradeScene extends Phaser.Scene {
  private rowContainer!: Phaser.GameObjects.Container;
  private loadingText!: Phaser.GameObjects.Text;
  private resourceBanner!: Phaser.GameObjects.Text;
  private tipText!: Phaser.GameObjects.Text;
  private summaryText!: Phaser.GameObjects.Text;
  private contentHeight = 0;
  private viewportTop = HUD_H + 96;
  private scrollOffset = 0;
  private scrolling = false;
  private scrollStartY = 0;
  private scrollStartOffset = 0;
  private units: UnitUpgradeEntry[] = [];
  private resources = { sugar: 0, leafBits: 0 };
  private errorText: Phaser.GameObjects.Text | null = null;

  constructor() {
    super('UpgradeScene');
  }

  create(): void {
    fadeInScene(this);
    installSceneClickDebug(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    this.drawHud();
    this.resourceBanner = this.add
      .text(this.scale.width / 2, HUD_H + 18, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#c3e8b0',
      })
      .setOrigin(0.5);
    this.tipText = this.add
      .text(
        this.scale.width / 2,
        HUD_H + 42,
        'Build a few core units early. Later levels take longer on purpose.',
        {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '12px',
          color: '#9dc88b',
        },
      )
      .setOrigin(0.5);
    this.summaryText = this.add
      .text(this.scale.width / 2, HUD_H + 64, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '11px',
        color: '#d5e8c7',
      })
      .setOrigin(0.5);
    this.rowContainer = this.add.container(0, this.viewportTop);
    this.loadingText = this.add
      .text(this.scale.width / 2, this.viewportTop + 36, 'Loading upgrade catalog...', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#c3e8b0',
      })
      .setOrigin(0.5);
    this.wireScroll();
    void this.fetchData();
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
    const g = this.add.graphics();
    g.fillStyle(0x0a120c, 1);
    g.fillRect(0, 0, this.scale.width, HUD_H);
    g.fillStyle(0x1a2b1a, 1);
    g.fillRect(0, HUD_H - 2, this.scale.width, 2);
    this.add
      .text(16, HUD_H / 2, '<- Home', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#c3e8b0',
        backgroundColor: '#1a2b1a',
        padding: { left: 10, right: 10, top: 6, bottom: 6 },
      })
      .setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => fadeToScene(this, 'HomeScene'));
    this.add
      .text(this.scale.width / 2, HUD_H / 2, 'Upgrades', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '18px',
        color: '#ffd98a',
      })
      .setOrigin(0.5);
  }

  private async fetchData(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) {
      this.loadingText.setText('Offline - no upgrades');
      return;
    }
    try {
      const res = await runtime.api.getUpgrades();
      if (!this.scene.isActive()) return;
      this.loadingText.destroy();
      this.units = res.units;
      this.resources = res.resources;
      this.render();
    } catch (err) {
      if (!this.scene.isActive()) return;
      this.loadingText.setText(`Error: ${(err as Error).message}`);
    }
  }

  private render(): void {
    this.rowContainer.removeAll(true);
    this.resourceBanner.setText(
      `Sugar ${this.resources.sugar}   Leaf ${this.resources.leafBits}`,
    );

    const maxW = Math.min(560, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    const rowH = 86;

    // Queen level drives unit unlock gating. Pull it from the runtime-
    // cached base so the badge agrees with the server's gate.
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    const queen = runtime?.player?.base.buildings.find(
      (b) => b.kind === 'QueenChamber',
    );
    const attackerQueenLevel = Math.max(1, Math.min(5, queen?.level ?? 1));
    const affordableCount = this.units.filter((u) => {
      if (u.level >= u.maxLevel || !u.nextCost) return false;
      return (
        this.resources.sugar >= u.nextCost.sugar &&
        this.resources.leafBits >= u.nextCost.leafBits
      );
    }).length;
    const lockedCount = this.units.filter(
      (u) => (u.unlockQueenLevel ?? 1) > attackerQueenLevel,
    ).length;
    const maxedCount = this.units.filter((u) => u.level >= u.maxLevel).length;
    this.summaryText.setText(
      `Affordable now: ${affordableCount}   Locked by Queen: ${lockedCount}   Maxed: ${maxedCount}`,
    );

    let finalY = 0;
    this.units.forEach((u, i) => {
      const requiredQL = u.unlockQueenLevel ?? 1;
      const locked = requiredQL > attackerQueenLevel;
      const y = i * (rowH + 8);
      const maxed = u.level >= u.maxLevel || u.nextCost === null;
      const canAfford =
        !maxed &&
        u.nextCost !== null &&
        this.resources.sugar >= u.nextCost.sugar &&
        this.resources.leafBits >= u.nextCost.leafBits;
      const stage = upgradeStage(u.level, u.maxLevel, maxed);
      const progress = Math.max(0, Math.min(1, (u.level - 1) / (u.maxLevel - 1)));
      const shortageSugar = Math.max(
        0,
        (u.nextCost?.sugar ?? 0) - this.resources.sugar,
      );
      const shortageLeaf = Math.max(
        0,
        (u.nextCost?.leafBits ?? 0) - this.resources.leafBits,
      );
      const status = locked
        ? `Unlocks for raids at Queen L${requiredQL}`
        : maxed
          ? 'Fully upgraded and battle ready.'
          : canAfford
            ? 'Affordable now. Good early pickup before the later grind.'
            : `Need ${shortageSugar} sugar and ${shortageLeaf} leaf more.`;

      const bg = this.add.graphics();
      bg.fillStyle(
        locked ? 0x1c2220 : maxed ? 0x233d24 : canAfford ? 0x1a2b1a : 0x2a1e1e,
        1,
      );
      bg.lineStyle(1, locked ? 0x5b6762 : canAfford ? 0x5ba445 : 0x2c5a23, 1);
      bg.fillRoundedRect(originX, y, maxW, rowH, 8);
      bg.strokeRoundedRect(originX, y, maxW, rowH, 8);
      this.rowContainer.add(bg);

      const icon = this.add
        .image(originX + 36, y + rowH / 2 - 4, `unit-${u.kind}`)
        .setDisplaySize(48, 48)
        .setAlpha(locked ? 0.45 : 1);
      this.rowContainer.add(icon);
      if (locked) {
        this.rowContainer.add(
          this.text(
            originX + 36,
            y + rowH / 2 + 18,
            `LOCK L${requiredQL}`,
            '#d98080',
            10,
            0.5,
            0.5,
          ),
        );
      }

      this.rowContainer.add(
        this.text(
          originX + 72,
          y + 14,
          prettyName(u.kind),
          '#e6f5d2',
          14,
          0,
          0,
        ),
      );
      this.rowContainer.add(
        this.text(
          originX + 72,
          y + 34,
          `lv ${u.level}${u.level === u.maxLevel ? ' (MAX)' : ` -> lv ${u.level + 1}`}`,
          maxed ? '#ffd98a' : '#c3e8b0',
          12,
          0,
          0,
        ),
      );
      this.rowContainer.add(
        this.text(
          originX + 72,
          y + 54,
          `${stage.label}  ${status}`,
          locked ? '#b5b8b7' : maxed ? '#ffd98a' : canAfford ? '#cfe9bb' : '#d9a0a0',
          11,
          0,
          0,
        ),
      );

      const barX = originX + 72;
      const barY = y + rowH - 16;
      const barW = Math.max(120, maxW - 260);
      const track = this.add.graphics();
      track.fillStyle(0x0d130f, 1);
      track.fillRoundedRect(barX, barY, barW, 8, 4);
      track.fillStyle(stage.barColor, locked ? 0.35 : 0.95);
      track.fillRoundedRect(barX, barY, Math.max(8, Math.floor(barW * progress)), 8, 4);
      this.rowContainer.add(track);
      this.rowContainer.add(
        this.text(
          barX + barW + 8,
          barY + 4,
          `${u.level}/${u.maxLevel}`,
          '#9dc88b',
          10,
          0,
          0.5,
        ),
      );

      if (!maxed && u.nextCost) {
        this.rowContainer.add(
          this.text(
            originX + maxW - 130,
            y + rowH / 2 - 4,
            `${u.nextCost.sugar} sugar\n${u.nextCost.leafBits} leaf`,
            canAfford ? '#ffd98a' : '#d98080',
            11,
            1,
            0.5,
          ),
        );

        const btnW = 90;
        const btnH = 36;
        const btnX = originX + maxW - 12 - btnW;
        const btnY = y + 14;
        const btn = this.add.graphics();
        btn.fillStyle(canAfford ? 0x3a7f3a : 0x2a1e1e, 1);
        btn.lineStyle(2, canAfford ? 0xffd98a : 0x3a3a3a, 1);
        btn.fillRoundedRect(btnX, btnY, btnW, btnH, 6);
        btn.strokeRoundedRect(btnX, btnY, btnW, btnH, 6);
        this.rowContainer.add(btn);
        this.rowContainer.add(
          this.text(
            btnX + btnW / 2,
            btnY + btnH / 2,
            'Upgrade',
            canAfford ? '#ffffff' : '#7a7a7a',
            13,
            0.5,
            0.5,
          ),
        );
        if (canAfford) {
          const hit = this.add
            .zone(btnX + btnW / 2, btnY + btnH / 2, btnW, btnH)
            .setOrigin(0.5)
            .setInteractive({ useHandCursor: true });
          hit.on('pointerdown', () => void this.commit(u.kind));
          this.rowContainer.add(hit);
        }
      } else {
        this.rowContainer.add(
          this.text(
            originX + maxW - 16,
            y + rowH / 2 - 4,
            'MAXED',
            '#ffd98a',
            12,
            1,
            0.5,
          ),
        );
      }

      finalY = y + rowH;
    });
    this.contentHeight = finalY + 16;
  }

  private async commit(kind: Types.UnitKind): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const res = await runtime.api.upgradeUnit(kind);
      if (!this.scene.isActive()) return;
      if (runtime.player) {
        runtime.player.player.sugar = res.resources.sugar;
        runtime.player.player.leafBits = res.resources.leafBits;
        runtime.player.player.unitLevels = res.unitLevels as Partial<
          Record<Types.UnitKind, number>
        >;
      }
      this.resources = res.resources;
      const local = this.units.find((u) => u.kind === kind);
      if (local) local.level = res.newLevel;
      this.render();
    } catch (err) {
      this.showError((err as Error).message);
    }
  }

  // A single error text element is reused across upgrade failures so
  // repeated bad taps do not keep stacking messages.
  private showError(msg: string): void {
    if (this.errorText) {
      this.errorText.setText(msg).setVisible(true);
    } else {
      this.errorText = this.add
        .text(this.scale.width / 2, this.viewportTop - 16, msg, {
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

function prettyName(kind: string): string {
  return kind.replace(/([A-Z])/g, ' $1').trim();
}

function upgradeStage(
  level: number,
  maxLevel: number,
  maxed: boolean,
): { label: string; barColor: number } {
  if (maxed) return { label: 'Max power', barColor: 0xd3aa46 };
  const ratio = (level - 1) / Math.max(1, maxLevel - 1);
  if (ratio < 0.34) return { label: 'Early ramp', barColor: 0x53a553 };
  if (ratio < 0.67) return { label: 'Mid climb', barColor: 0xc78e3b };
  return { label: 'Late grind', barColor: 0xb45656 };
}
