import Phaser from 'phaser';
import { Sim, type Types } from '@hive/shared';
import type { HiveRuntime } from '../main.js';
import type { UnitUpgradeEntry } from '../net/Api.js';
import { makeHiveButton } from '../ui/button.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { crispText } from '../ui/text.js';
import {
  COLOR,
  bodyTextStyle,
  displayTextStyle,
  labelTextStyle,
  SPACING,
} from '../ui/theme.js';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';

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
  private heroPanel!: Phaser.GameObjects.Graphics;
  private contentHeight = 0;
  private viewportTop = HUD_H + 132;
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
    this.drawBackdrop();
    this.drawHud();

    this.heroPanel = this.add.graphics();
    this.resourceBanner = crispText(
      this,
      this.scale.width / 2,
      HUD_H + 28,
      '',
      displayTextStyle(18, COLOR.textGold, 3),
    ).setOrigin(0.5);
    this.tipText = crispText(
      this,
      this.scale.width / 2,
      HUD_H + 56,
      'Build a few core units early. Higher tiers are a long-tail investment.',
      bodyTextStyle(13, COLOR.textDim),
    ).setOrigin(0.5);
    this.summaryText = crispText(
      this,
      this.scale.width / 2,
      HUD_H + 82,
      '',
      labelTextStyle(11, COLOR.textMuted),
    ).setOrigin(0.5);
    this.drawHeroChrome();

    this.rowContainer = this.add.container(0, this.viewportTop);
    this.loadingText = crispText(
      this,
      this.scale.width / 2,
      this.viewportTop + 36,
      'Loading upgrade catalog...',
      displayTextStyle(14, COLOR.textDim, 3),
    ).setOrigin(0.5);

    this.wireScroll();
    void this.fetchData();
  }

  private drawBackdrop(): void {
    const g = this.add.graphics().setDepth(-10);
    const bands = 22;
    const top = COLOR.bgPanelHi;
    const bottom = COLOR.bgDeep;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      g.fillStyle(lerpColor(top, bottom, t), 1);
      g.fillRect(
        0,
        Math.floor((i * this.scale.height) / bands),
        this.scale.width,
        Math.ceil(this.scale.height / bands) + 1,
      );
    }

    const glow = this.add.graphics().setDepth(-9);
    glow.fillStyle(COLOR.brass, 0.06);
    glow.fillEllipse(
      this.scale.width / 2,
      HUD_H + 160,
      Math.min(this.scale.width * 0.9, 720),
      260,
    );
    glow.fillStyle(COLOR.greenHi, 0.06);
    glow.fillEllipse(
      this.scale.width / 2,
      this.scale.height - 80,
      Math.min(this.scale.width * 1.1, 900),
      260,
    );
  }

  private drawHud(): void {
    const hud = this.add.graphics();
    hud.fillGradientStyle(
      COLOR.bgPanelHi,
      COLOR.bgPanelHi,
      COLOR.bgPanelLo,
      COLOR.bgPanelLo,
      1,
    );
    hud.fillRect(0, 0, this.scale.width, HUD_H);
    hud.fillStyle(0x000000, 0.35);
    hud.fillRect(0, HUD_H, this.scale.width, 3);

    makeHiveButton(this, {
      x: 86,
      y: HUD_H / 2,
      width: 132,
      height: 38,
      label: 'Home',
      variant: 'ghost',
      fontSize: 14,
      onPress: () => fadeToScene(this, 'HomeScene'),
    });

    crispText(
      this,
      this.scale.width / 2,
      HUD_H / 2 - 6,
      'Unit Forge',
      displayTextStyle(22, COLOR.textGold, 4),
    ).setOrigin(0.5);
    crispText(
      this,
      this.scale.width / 2,
      HUD_H / 2 + 14,
      'Strengthen your roster and plan the long climb',
      labelTextStyle(11, COLOR.textDim),
    ).setOrigin(0.5);
  }

  private drawHeroChrome(): void {
    const w = Math.min(640, this.scale.width - 24);
    const x = (this.scale.width - w) / 2;
    const y = HUD_H + 12;
    this.heroPanel.clear();
    drawPanel(this.heroPanel, x, y, w, 96, {
      topColor: 0x233624,
      botColor: 0x101810,
      highlight: COLOR.brass,
      highlightAlpha: 0.18,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      radius: SPACING.radiusLg,
      shadowOffset: 5,
      shadowAlpha: 0.42,
    });
    this.heroPanel.fillStyle(COLOR.brass, 0.16);
    this.heroPanel.fillRect(x + 18, y + 48, w - 36, 2);

    const pillW = Math.min(280, w - 60);
    drawPill(
      this.heroPanel,
      this.scale.width / 2 - pillW / 2,
      HUD_H + 16,
      pillW,
      28,
      { brass: true },
    );
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
    this.drawHeroChrome();
    this.resourceBanner.setText(
      `Sugar ${this.resources.sugar}   Leaf ${this.resources.leafBits}`,
    );

    const maxW = Math.min(640, this.scale.width - 24);
    const originX = (this.scale.width - maxW) / 2;
    const rowH = 114;

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
      const y = i * (rowH + 10);
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
            ? 'Affordable now. Good pickup before the late-game grind.'
            : `Need ${shortageSugar} more sugar and ${shortageLeaf} more leaf.`;

      const card = this.add.graphics();
      drawPanel(card, originX, y, maxW, rowH, {
        topColor: locked
          ? 0x202624
          : maxed
            ? 0x223824
            : canAfford
              ? 0x233923
              : 0x2b201c,
        botColor: locked
          ? 0x111514
          : maxed
            ? 0x101b10
            : canAfford
              ? 0x111a10
              : 0x18100d,
        stroke: locked ? 0x54615c : canAfford ? 0x4b7b3f : 0x69483a,
        strokeWidth: 2,
        highlight: locked ? 0x83908b : canAfford ? COLOR.greenHi : COLOR.brass,
        highlightAlpha: 0.14,
        radius: 14,
        shadowOffset: 4,
        shadowAlpha: 0.35,
      });
      this.rowContainer.add(card);

      const portraitFrame = this.add.graphics();
      drawPill(portraitFrame, originX + 14, y + 18, 60, 60, { brass: !locked });
      this.rowContainer.add(portraitFrame);

      const icon = this.add
        .image(originX + 44, y + 48, `unit-${u.kind}`)
        .setDisplaySize(48, 48)
        .setAlpha(locked ? 0.45 : 1);
      this.rowContainer.add(icon);

      if (locked) {
        const lockChip = this.add.graphics();
        drawPill(lockChip, originX + 18, y + 72, 52, 18, { brass: false });
        this.rowContainer.add(lockChip);
        this.rowContainer.add(
          crispText(
            this,
            originX + 44,
            y + 81,
            `L${requiredQL}`,
            labelTextStyle(10, '#d5a7a7'),
          ).setOrigin(0.5),
        );
      }

      this.rowContainer.add(
        crispText(
          this,
          originX + 92,
          y + 18,
          prettyName(u.kind),
          displayTextStyle(16, COLOR.textPrimary, 3),
        ).setOrigin(0, 0),
      );
      this.rowContainer.add(
        crispText(
          this,
          originX + 92,
          y + 42,
          `Level ${u.level}${u.level === u.maxLevel ? ' / MAX' : ` -> ${u.level + 1}`}`,
          labelTextStyle(12, maxed ? COLOR.textGold : COLOR.textDim),
        ).setOrigin(0, 0),
      );
      // Stat delta preview — what the upgrade actually buys, in concrete
      // numbers (HP + DMG). Suppressed when locked (player hasn't reached
      // the unlock tier — irrelevant noise) or maxed (no next stat). Per
      // GDD §6.9, players should never spend without seeing the gain.
      const statDelta = !maxed && !locked ? this.formatStatDelta(u.kind, u.level) : null;
      if (statDelta) {
        this.rowContainer.add(
          crispText(
            this,
            originX + 92,
            y + 60,
            statDelta,
            labelTextStyle(11, COLOR.textGold),
          ).setOrigin(0, 0),
        );
      }
      this.rowContainer.add(
        crispText(
          this,
          originX + 92,
          y + (statDelta ? 78 : 62),
          status,
          bodyTextStyle(
            12,
            locked ? '#b8bcbc' : maxed ? COLOR.textGold : canAfford ? '#d7efc5' : '#e5b0a0',
          ),
        ).setOrigin(0, 0),
      );

      const badgeW = 102;
      const badge = this.add.graphics();
      drawPill(badge, originX + maxW - badgeW - 16, y + 14, badgeW, 22, { brass: true });
      this.rowContainer.add(badge);
      this.rowContainer.add(
        crispText(
          this,
          originX + maxW - badgeW / 2 - 16,
          y + 25,
          stage.label,
          labelTextStyle(11, stage.textColor),
        ).setOrigin(0.5),
      );

      const barX = originX + 92;
      const barY = y + rowH - 22;
      const barW = Math.max(170, maxW - 286);
      const track = this.add.graphics();
      drawPill(track, barX, barY, barW, 12, { brass: false });
      track.fillStyle(stage.barColor, locked ? 0.35 : 0.96);
      track.fillRoundedRect(barX + 2, barY + 2, Math.max(10, Math.floor((barW - 4) * progress)), 8, 4);
      this.rowContainer.add(track);
      this.rowContainer.add(
        crispText(
          this,
          barX + barW + 10,
          barY + 6,
          `${u.level}/${u.maxLevel}`,
          labelTextStyle(10, COLOR.textDim),
        ).setOrigin(0, 0.5),
      );

      if (!maxed && u.nextCost) {
        const costChip = this.add.graphics();
        drawPanel(costChip, originX + maxW - 168, y + 44, 92, 46, {
          topColor: 0x172117,
          botColor: 0x0f150f,
          stroke: canAfford ? COLOR.brassDeep : 0x5e3d36,
          strokeWidth: 2,
          highlight: canAfford ? COLOR.brass : 0xe5b0a0,
          highlightAlpha: 0.12,
          radius: 10,
          shadowOffset: 2,
          shadowAlpha: 0.26,
        });
        this.rowContainer.add(costChip);
        this.rowContainer.add(
          crispText(
            this,
            originX + maxW - 122,
            y + 58,
            `${u.nextCost.sugar} sugar`,
            labelTextStyle(10, canAfford ? COLOR.textGold : '#e5b0a0'),
          ).setOrigin(0.5),
        );
        this.rowContainer.add(
          crispText(
            this,
            originX + maxW - 122,
            y + 76,
            `${u.nextCost.leafBits} leaf`,
            labelTextStyle(10, canAfford ? '#cfe9bb' : '#e5b0a0'),
          ).setOrigin(0.5),
        );

        const button = makeHiveButton(this, {
          x: originX + maxW - 44,
          y: y + 67,
          width: 76,
          height: 34,
          label: 'Upgrade',
          variant: canAfford ? 'primary' : 'ghost',
          fontSize: 12,
          enabled: canAfford,
          onPress: () => void this.commit(u.kind),
        });
        this.rowContainer.add(button.container);
      } else {
        const maxChip = this.add.graphics();
        drawPill(maxChip, originX + maxW - 110, y + 54, 86, 24, { brass: true });
        this.rowContainer.add(maxChip);
        this.rowContainer.add(
          crispText(
            this,
            originX + maxW - 67,
            y + 66,
            'MAXED',
            labelTextStyle(11, COLOR.textGold),
          ).setOrigin(0.5),
        );
      }

      finalY = y + rowH;
    });

    this.contentHeight = finalY + 20;
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
      if (this.errorText) this.errorText.setVisible(false);

      // Re-fetch the authoritative upgrade catalog so the next-cost,
      // affordability, and MAX state stay in sync after each purchase.
      const refreshed = await runtime.api.getUpgrades();
      if (!this.scene.isActive()) return;
      this.units = refreshed.units;
      this.resources = refreshed.resources;
      this.render();
    } catch (err) {
      this.showError((err as Error).message);
    }
  }

  private showError(msg: string): void {
    if (this.errorText) {
      this.errorText.setText(msg).setVisible(true);
    } else {
      this.errorText = crispText(
        this,
        this.scale.width / 2,
        this.viewportTop - 20,
        msg,
        bodyTextStyle(12, COLOR.textError),
      ).setOrigin(0.5);
    }
  }

  // "HP 40→47 · DMG 6.0→7.0" — concrete preview of what the next level
  // buys. Stats use Sim.UNIT_STATS (base) × Sim.levelStatPercent (per-
  // level multiplier) so the numbers match what the deterministic sim
  // will use at deploy time. Returns null when the unit isn't in
  // UNIT_STATS (defensive guard for hidden / unlisted kinds).
  private formatStatDelta(kind: Types.UnitKind, level: number): string | null {
    const stats = Sim.UNIT_STATS[kind];
    if (!stats) return null;
    const curMult = Sim.levelStatPercent(level) / 100;
    const nextMult = Sim.levelStatPercent(level + 1) / 100;
    const baseHp = Sim.toFloat(stats.hpMax);
    const baseDmg = Sim.toFloat(stats.attackDamage);
    const curHp = Math.round(baseHp * curMult);
    const nextHp = Math.round(baseHp * nextMult);
    const curDmg = baseDmg * curMult;
    const nextDmg = baseDmg * nextMult;
    return `HP ${curHp}→${nextHp} · DMG ${curDmg.toFixed(1)}→${nextDmg.toFixed(1)}`;
  }
}

function prettyName(kind: string): string {
  return kind.replace(/([A-Z])/g, ' $1').trim();
}

function upgradeStage(
  level: number,
  maxLevel: number,
  maxed: boolean,
): { label: string; barColor: number; textColor: string } {
  if (maxed) {
    return { label: 'Max power', barColor: 0xd3aa46, textColor: COLOR.textGold };
  }
  const ratio = (level - 1) / Math.max(1, maxLevel - 1);
  if (ratio < 0.34) {
    return { label: 'Early ramp', barColor: 0x53a553, textColor: '#d7efc5' };
  }
  if (ratio < 0.67) {
    return { label: 'Mid climb', barColor: 0xc78e3b, textColor: '#ffe1a8' };
  }
  return { label: 'Late grind', barColor: 0xb45656, textColor: '#f0b1a3' };
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
