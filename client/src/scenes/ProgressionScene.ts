import Phaser from 'phaser';
import type { HiveRuntime } from '../main.js';
import type { BuildingCatalog } from '../net/Api.js';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import {
  drawSceneAmbient,
  drawSceneHud,
  makeScrollBody,
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
import {
  deriveQueenTiers,
  QUEEN_TIER_BUILDING_LABELS,
  QUEEN_TIER_UNIT_LABELS,
  type QueenTierRow,
} from '../codex/queenTiers.js';

// ProgressionScene — a single-screen roadmap of the Queen Chamber
// upgrade path. The codebase already has every component the loop
// needs (Queen upgrade endpoint, unlock tables, costs, resources),
// but no UI surface ties them together. Players hit a soft wall at
// Queen L1 and don't know that L2 unlocks Fire Ant + 5 new defender
// kinds. This scene makes the carrot visible.
//
// All five tiers render at once. The current tier is highlighted; the
// immediate next tier shows its cost and an "Upgrade Queen" button
// that lights up green when the player can afford it. Future tiers
// are dimmed but still expose their unlocks so the player can plan.
//
// Data comes from /me (current Queen level + resources) and the
// existing /player/building/catalog (queenUpgradeCost array). No new
// endpoints — the value is purely surfacing what we already have.

export class ProgressionScene extends Phaser.Scene {
  private body: {
    container: Phaser.GameObjects.Container;
    setContentHeight(h: number): void;
  } | null = null;

  private queenLevel = 1;
  private resources = { sugar: 0, leafBits: 0, aphidMilk: 0 };
  private catalog: BuildingCatalog | null = null;
  private upgrading = false;

  constructor() { super('ProgressionScene'); }

  create(): void {
    fadeInScene(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    drawSceneAmbient(this);
    drawSceneHud(this, 'Queen Path', 'HomeScene');
    this.body = makeScrollBody(this);
    void this.loadData();
  }

  private async loadData(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const [me, catalog] = await Promise.all([
        runtime.api.getPlayerMe(),
        runtime.api.getBuildingCatalog(),
      ]);
      if (!this.scene.isActive()) return;
      const queenBuilding = me.base.buildings.find((b) => b.kind === 'QueenChamber');
      this.queenLevel = queenBuilding?.level ?? 1;
      this.resources = {
        sugar: me.player.sugar,
        leafBits: me.player.leafBits,
        aphidMilk: me.player.aphidMilk,
      };
      this.catalog = catalog;
      this.render(runtime);
    } catch (err) {
      this.renderError((err as Error).message);
    }
  }

  private renderError(msg: string): void {
    if (!this.body) return;
    this.body.container.removeAll(true);
    this.body.container.add(
      crispText(this, 16, 24, `Couldn't load progression: ${msg}`,
        bodyTextStyle(13, COLOR.textDim))
        .setWordWrapWidth(this.scale.width - 48, true),
    );
    this.body.setContentHeight(80);
  }

  private render(runtime: HiveRuntime): void {
    if (!this.body) return;
    this.body.container.removeAll(true);
    const maxW = Math.min(640, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    const tiers = deriveQueenTiers({
      currentQueenLevel: this.queenLevel,
      resources: this.resources,
      costs: this.catalog?.queenUpgradeCost ?? [],
    });

    let y = 0;
    y = this.renderHeader(originX, maxW, y);
    y += 12;
    for (const tier of tiers) {
      y = this.renderTier(originX, maxW, y, tier, runtime);
    }
    this.body.setContentHeight(y + 32);
  }

  private renderHeader(originX: number, maxW: number, y: number): number {
    const h = 88;
    const card = this.add.graphics();
    drawPanel(card, originX, y, maxW, h, {
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
    if (!this.body) return y;
    this.body.container.add(card);
    const pill = this.add.graphics();
    drawPill(pill, originX + 16, y + 14, 110, 22, { brass: true });
    this.body.container.add(pill);
    this.body.container.add(
      crispText(this, originX + 70, y + 25, `QUEEN LEVEL ${this.queenLevel}`,
        labelTextStyle(11, COLOR.textGold)).setOrigin(0.5, 0.5),
    );
    this.body.container.add(
      crispText(this, originX + 18, y + 44,
        'Each Queen tier unlocks new defender buildings and attacker units.',
        displayTextStyle(13, COLOR.textGold, 3)).setOrigin(0, 0),
    );
    this.body.container.add(
      crispText(this, originX + 18, y + 64,
        `🍬 ${this.resources.sugar}   🍃 ${this.resources.leafBits}   🥛 ${this.resources.aphidMilk}`,
        bodyTextStyle(12, COLOR.textPrimary)).setOrigin(0, 0),
    );
    return y + h;
  }

  private renderTier(
    originX: number,
    maxW: number,
    y: number,
    tier: QueenTierRow,
    runtime: HiveRuntime,
  ): number {
    if (!this.body) return y;
    const baseH = 96;
    // Each unlocked kind adds ~18 px so longer lists don't clip.
    const items = tier.buildingsUnlocked.length + tier.unitsUnlocked.length;
    const extraH = Math.max(0, items - 2) * 16;
    const isNext = tier.status === 'locked' && tier.costToReach !== null && tier.level === this.queenLevel + 1;
    const hasAction = tier.status === 'current' || isNext;
    const h = baseH + extraH + (hasAction ? 40 : 0);

    const card = this.add.graphics();
    drawPanel(card, originX, y, maxW, h, {
      topColor: tier.status === 'current'
        ? 0x22382a
        : tier.status === 'completed'
          ? 0x1c2a1d
          : 0x1a1f1e,
      botColor: tier.status === 'completed' ? 0x0d1410 : 0x0c120d,
      stroke: tier.status === 'current'
        ? COLOR.brass
        : tier.status === 'completed'
          ? COLOR.greenHi
          : COLOR.outline,
      strokeWidth: tier.status === 'current' ? 3 : 2,
      highlight: tier.status === 'current' ? COLOR.brass : COLOR.greenHi,
      highlightAlpha: tier.status === 'current' ? 0.18 : 0.06,
      radius: 14,
      shadowOffset: 4,
      shadowAlpha: 0.28,
    });
    this.body.container.add(card);

    const pill = this.add.graphics();
    drawPill(pill, originX + 14, y + 14, 70, 24,
      { brass: tier.status === 'current' || tier.status === 'completed' });
    this.body.container.add(pill);
    this.body.container.add(
      crispText(this, originX + 49, y + 26, `Q${tier.level}`,
        labelTextStyle(13, COLOR.textGold)).setOrigin(0.5, 0.5),
    );

    const statusLabel =
      tier.status === 'current' ? 'Current tier' :
      tier.status === 'completed' ? 'Completed' :
      isNext ? 'Next' : 'Locked';
    const statusColor =
      tier.status === 'current' ? COLOR.textGold :
      tier.status === 'completed' ? '#9be0a8' :
      isNext ? '#fdcd6a' :
      COLOR.textMuted;
    this.body.container.add(
      crispText(this, originX + 96, y + 14, statusLabel,
        labelTextStyle(11, statusColor)).setOrigin(0, 0),
    );

    let textY = y + 32;
    if (tier.buildingsUnlocked.length > 0) {
      this.body.container.add(
        crispText(this, originX + 96, textY,
          `🏗  ${tier.buildingsUnlocked.map(buildingLabel).join(', ')}`,
          bodyTextStyle(12, tier.status === 'locked' ? COLOR.textDim : COLOR.textPrimary))
          .setWordWrapWidth(maxW - 120, true).setOrigin(0, 0),
      );
      textY += 18 + Math.floor(tier.buildingsUnlocked.length / 4) * 16;
    } else if (tier.level > 1) {
      this.body.container.add(
        crispText(this, originX + 96, textY,
          '🏗  No new buildings (cap raises only)',
          bodyTextStyle(12, COLOR.textMuted)).setOrigin(0, 0),
      );
      textY += 18;
    }
    if (tier.unitsUnlocked.length > 0) {
      this.body.container.add(
        crispText(this, originX + 96, textY,
          `🐜  ${tier.unitsUnlocked.map(unitLabel).join(', ')}`,
          bodyTextStyle(12, tier.status === 'locked' ? COLOR.textDim : COLOR.textPrimary))
          .setOrigin(0, 0),
      );
      textY += 18;
    }

    if (hasAction) {
      const btnY = y + h - 22;
      if (tier.status === 'current') {
        this.body.container.add(
          crispText(this, originX + 96, btnY - 2,
            'You are here — keep raiding to fund the next tier.',
            bodyTextStyle(11, COLOR.textMuted)).setOrigin(0, 0.5),
        );
      } else if (isNext && tier.costToReach) {
        const c = tier.costToReach;
        this.body.container.add(
          crispText(this, originX + 96, btnY - 2,
            `Cost: 🍬 ${c.sugar}   🍃 ${c.leafBits}${c.aphidMilk > 0 ? `   🥛 ${c.aphidMilk}` : ''}`,
            bodyTextStyle(12,
              tier.affordable ? '#9be0a8' : '#ff9f9f')).setOrigin(0, 0.5),
        );
        const upBtn = makeHiveButton(this, {
          x: originX + maxW - 92,
          y: btnY,
          width: 160,
          height: 32,
          label: tier.affordable ? '👑  Upgrade Queen' : 'Need more loot',
          variant: tier.affordable ? 'primary' : 'ghost',
          fontSize: 12,
          enabled: tier.affordable && !this.upgrading,
          onPress: () => { void this.upgrade(runtime); },
        });
        this.body.container.add(upBtn.container);
      }
    }
    return y + h + 10;
  }

  private async upgrade(runtime: HiveRuntime): Promise<void> {
    if (this.upgrading) return;
    this.upgrading = true;
    try {
      const res = await runtime.api.upgradeQueen();
      this.queenLevel = res.newQueenLevel;
      this.resources = {
        sugar: res.player.sugar,
        leafBits: res.player.leafBits,
        aphidMilk: res.player.aphidMilk,
      };
      // Refresh runtime.player.base so HomeScene reflects the upgrade
      // when the player navigates back. Server's authoritative; this
      // is just a local mirror.
      if (runtime.player) {
        runtime.player.base = res.base;
        runtime.player.player.sugar = res.player.sugar;
        runtime.player.player.leafBits = res.player.leafBits;
        runtime.player.player.aphidMilk = res.player.aphidMilk;
      }
      this.render(runtime);
    } catch (err) {
      this.renderError(`Upgrade failed: ${(err as Error).message}`);
    } finally {
      this.upgrading = false;
    }
  }

  // Convenience for callers that hit "Upgrade Queen" from the building
  // info modal — they can deep-link here to keep the experience
  // continuous after a successful tier bump.
  static enterFromHome(scene: Phaser.Scene): void {
    fadeToScene(scene, 'ProgressionScene');
  }
}

function unitLabel(kind: string): string {
  return QUEEN_TIER_UNIT_LABELS[kind as keyof typeof QUEEN_TIER_UNIT_LABELS] ?? kind;
}

function buildingLabel(kind: string): string {
  return QUEEN_TIER_BUILDING_LABELS[kind as keyof typeof QUEEN_TIER_BUILDING_LABELS] ?? kind;
}
