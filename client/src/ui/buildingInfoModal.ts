import Phaser from 'phaser';
import { Types, Sim } from '@hive/shared';
import type { HiveRuntime } from '../main.js';
import { crispText } from './text.js';
import { drawPanel, drawPill } from './panel.js';
import { makeHiveButton } from './button.js';
import { openConfirm } from './confirmModal.js';
import {
  COLOR,
  DEPTHS,
  bodyTextStyle,
  displayTextStyle,
  labelTextStyle,
} from './theme.js';

// Building info + upgrade modal. Opens when the player taps one of
// their own buildings on HomeScene. Shows stats (HP, damage, range,
// production, cooldown) and offers an upgrade button (debits resources
// and bumps the level via /api/player/upgrade-building) plus a
// demolish button for non-Queen buildings.
//
// Purely Phaser — no DOM — so the modal layers cleanly on top of
// the game board in the same scene. Closes on backdrop tap.

const MODAL_W = 360;
const MODAL_H = 440;
const MAX_BUILDING_LEVEL = 10;

// Friendly human-readable labels for each building kind. Keeps the
// codex's marketing-blurb names out of the modal — here we want a
// short noun that fits in a header.
const KIND_LABELS: Partial<Record<Types.BuildingKind, string>> = {
  QueenChamber: 'Queen Chamber',
  DewCollector: 'Dew Collector',
  MushroomTurret: 'Mushroom Turret',
  LeafWall: 'Leaf Wall',
  PebbleBunker: 'Pebble Bunker',
  LarvaNursery: 'Larva Nursery',
  SugarVault: 'Sugar Vault',
  TunnelJunction: 'Tunnel Junction',
  DungeonTrap: 'Dungeon Trap',
  AcidSpitter: 'Acid Spitter',
  SporeTower: 'Spore Tower',
  RootSnare: 'Root Snare',
  HiddenStinger: 'Hidden Stinger',
  SpiderNest: 'Spider Nest',
  ThornHedge: 'Thorn Hedge',
};

// Per-second production for economy buildings. Mirrors the server
// (server/api/src/routes/player.ts::INCOME_PER_SECOND) so what the
// player sees matches what they actually earn. Scales linearly with
// level the same way the server does.
const INCOME: Partial<
  Record<Types.BuildingKind, { sugar: number; leafBits: number }>
> = {
  DewCollector: { sugar: 8, leafBits: 0 },
  LarvaNursery: { sugar: 0, leafBits: 3 },
  SugarVault: { sugar: 2, leafBits: 0 },
};

// Computed stats at a given level — UI-side mirror of the shared sim's
// LEVEL_STAT_PERCENT table. We read the base stat from Sim.BUILDING_STATS
// and scale with level to render "current vs next" previews.
function statMultiplier(level: number): number {
  return Sim.levelStatPercent(Math.max(1, level)) / 100;
}

export interface OpenBuildingInfoOpts {
  scene: Phaser.Scene;
  runtime: HiveRuntime;
  building: Types.Building;
  onUpdated: (base: Types.Base) => void;
  onDemolish?: (base: Types.Base) => void;
}

// Opens the modal. Returns a close fn in case the caller wants to
// close it externally (e.g. scene shutdown). Safe to ignore —
// backdrop-tap + × button already handle the common case.
export function openBuildingInfoModal(opts: OpenBuildingInfoOpts): () => void {
  const { scene, runtime, building } = opts;
  const W = scene.scale.width;
  const H = scene.scale.height;

  const root = scene.add.container(0, 0).setDepth(DEPTHS.resultCard);

  // Dim backdrop — tap anywhere outside the card to close.
  const backdrop = scene.add
    .rectangle(0, 0, W, H, 0x000000, 0.62)
    .setOrigin(0, 0)
    .setInteractive();
  root.add(backdrop);

  // Modal card. Reuses the result-card palette for visual coherence
  // with the rest of the game.
  const cx = (W - MODAL_W) / 2;
  const cy = (H - MODAL_H) / 2;
  const card = scene.add.graphics();
  drawPanel(card, cx, cy, MODAL_W, MODAL_H, {
    topColor: COLOR.bgPanelHi,
    botColor: COLOR.bgPanelLo,
    stroke: COLOR.brassDeep,
    strokeWidth: 3,
    highlight: COLOR.brass,
    highlightAlpha: 0.16,
    radius: 18,
    shadowOffset: 6,
    shadowAlpha: 0.42,
  });
  root.add(card);

  const close = (): void => {
    root.destroy(true);
  };
  backdrop.on('pointerdown', close);

  // Header: kind label + level pill. Re-rendered on upgrade so we
  // wrap everything after the backdrop inside a `body` container we
  // can swap out.
  const bodyContainer = scene.add.container(cx, cy);
  root.add(bodyContainer);

  const renderBody = (b: Types.Building): void => {
    bodyContainer.removeAll(true);

    const title = KIND_LABELS[b.kind] ?? b.kind;
    const level = b.level ?? 1;

    bodyContainer.add(
      crispText(scene, MODAL_W / 2, 20, title, displayTextStyle(20, COLOR.textGold, 4))
        .setOrigin(0.5, 0),
    );

    // Level pill
    const pill = scene.add.graphics();
    drawPill(pill, MODAL_W / 2 - 50, 56, 100, 24, { brass: true });
    bodyContainer.add(pill);
    bodyContainer.add(
      crispText(scene, MODAL_W / 2, 68, `Level ${level}`, labelTextStyle(11, '#2a1d08'))
        .setOrigin(0.5, 0.5),
    );

    // Close ×
    const closeX = crispText(scene, MODAL_W - 16, 14, '×',
      displayTextStyle(22, COLOR.textPrimary, 2))
      .setOrigin(1, 0)
      .setInteractive({ useHandCursor: true });
    closeX.on('pointerdown', close);
    bodyContainer.add(closeX);

    // Stats list.
    const stats = Sim.BUILDING_STATS[b.kind];
    const mult = statMultiplier(level);
    let sy = 100;
    const addStat = (label: string, value: string): void => {
      bodyContainer.add(
        crispText(scene, 22, sy, label, labelTextStyle(11, COLOR.textMuted)),
      );
      bodyContainer.add(
        crispText(scene, MODAL_W - 22, sy, value, bodyTextStyle(13, COLOR.textPrimary))
          .setOrigin(1, 0),
      );
      sy += 22;
    };

    if (stats) {
      const hpMax = b.hpMax ?? Math.round(stats.hpMax * mult);
      const hp = b.hp ?? hpMax;
      addStat('Hit points', `${hp} / ${hpMax}`);
      if (stats.canAttack) {
        const dmgPerHit = Sim.toFloat(stats.attackDamage) * mult;
        const attacksPerSec = 30 / stats.attackCooldownTicks;
        addStat('Damage per hit', dmgPerHit.toFixed(1));
        addStat('Attacks / sec', attacksPerSec.toFixed(2));
        addStat('Range (tiles)', Sim.toFloat(stats.attackRange).toFixed(1));
      }
      if (stats.dropsSugarOnDestroy > 0) {
        addStat('Sugar stored', String(stats.dropsSugarOnDestroy));
      }
      if (stats.dropsLeafBitsOnDestroy > 0) {
        addStat('Leaf bits stored', String(stats.dropsLeafBitsOnDestroy));
      }
    }
    const income = INCOME[b.kind];
    if (income) {
      const mult = Math.max(1, level);
      if (income.sugar > 0) addStat('Sugar / sec', `+${income.sugar * mult}`);
      if (income.leafBits > 0) addStat('Leaf / sec', `+${income.leafBits * mult}`);
    }

    // "At next level" preview — nudges the upgrade button.
    if (b.kind !== 'QueenChamber' && level < MAX_BUILDING_LEVEL) {
      sy += 8;
      bodyContainer.add(
        crispText(scene, 22, sy, 'At next level',
          labelTextStyle(11, COLOR.textGold)),
      );
      sy += 20;
      const nextMult = statMultiplier(level + 1);
      const pctGain = Math.round((nextMult / mult - 1) * 100);
      bodyContainer.add(
        crispText(scene, 22, sy,
          `+${pctGain}% HP and damage; production scales +1 slot.`,
          bodyTextStyle(11, COLOR.textDim),
        ).setWordWrapWidth(MODAL_W - 44, true),
      );
      sy += 26;
    }

    // Actions. Queen Chamber routes to the dedicated queen-upgrade
    // endpoint; every other kind uses /upgrade-building.
    const isQueen = b.kind === 'QueenChamber';
    const atMax = level >= MAX_BUILDING_LEVEL;
    const actionsY = MODAL_H - 80;

    if (isQueen) {
      bodyContainer.add(
        crispText(scene, 22, actionsY - 28,
          'Queen upgrades unlock new building slots and tiers.',
          bodyTextStyle(11, COLOR.textDim),
        ).setWordWrapWidth(MODAL_W - 44, true),
      );
      const btn = makeHiveButton(scene, {
        x: MODAL_W / 2,
        y: actionsY + 4,
        width: MODAL_W - 44,
        height: 44,
        label: atMax ? 'Max level' : 'Upgrade Queen',
        variant: atMax ? 'ghost' : 'primary',
        fontSize: 14,
        onPress: () => {
          if (atMax) return;
          void doQueenUpgrade(scene, runtime, close, opts.onUpdated);
        },
      });
      bodyContainer.add(btn.container);
    } else {
      const upgradeLabel = atMax
        ? 'Max level'
        : `Upgrade — ${estimateCost(b).sugar} sugar`;
      const btn = makeHiveButton(scene, {
        x: MODAL_W / 2 - 84,
        y: actionsY + 4,
        width: 180,
        height: 44,
        label: upgradeLabel,
        variant: atMax ? 'ghost' : 'primary',
        fontSize: 13,
        onPress: () => {
          if (atMax) return;
          void doUpgrade(scene, runtime, b, (base, upd) => {
            const fresh = base.buildings.find((x) => x.id === b.id);
            if (fresh) renderBody(fresh);
            opts.onUpdated(base);
            void upd;
          });
        },
      });
      bodyContainer.add(btn.container);

      const demBtn = makeHiveButton(scene, {
        x: MODAL_W / 2 + 96,
        y: actionsY + 4,
        width: 140,
        height: 44,
        label: 'Demolish',
        variant: 'danger',
        fontSize: 13,
        onPress: () => {
          void openConfirm({
            title: 'Demolish this building?',
            body: 'You will not get the resources back. This action cannot be undone.',
            confirmLabel: 'Demolish',
            danger: true,
          }).then((confirmed) => {
            if (!confirmed) return;
            void doDemolish(runtime, b, (base) => {
              close();
              opts.onDemolish?.(base);
            });
          });
        },
      });
      bodyContainer.add(demBtn.container);
    }
  };

  renderBody(building);

  return close;
}

// Mirrors the server's cost curve: placement-cost × upgradeCostMult(level).
// We don't have upgradeCostMult in the shared package, so we re-declare
// the exact same table here. Keep in sync with server/api/src/game/
// progression.ts::LEVEL_COST_MULT — if the server curve changes the
// button's previewed cost would desynchronize.
const LEVEL_COST_MULT: ReadonlyArray<number> = [
  0.5, 1.0, 1.6, 2.6, 4.2, 6.8, 11.0, 17.8, 28.8,
];
// Base costs from server/api/src/game/buildingCosts.ts::BUILDING_PLACEMENT_COSTS.
// A single source of truth on the server is the authority; this map
// is purely for the "Upgrade — NNN sugar" button label so the player
// sees the cost before committing. Server re-verifies on submit.
const BASE_COST: Partial<Record<Types.BuildingKind, { sugar: number; leafBits: number }>> = {
  DewCollector:    { sugar: 200,  leafBits: 40 },
  MushroomTurret:  { sugar: 350,  leafBits: 80 },
  LeafWall:        { sugar: 100,  leafBits: 60 },
  PebbleBunker:    { sugar: 500,  leafBits: 150 },
  LarvaNursery:    { sugar: 400,  leafBits: 120 },
  SugarVault:      { sugar: 600,  leafBits: 100 },
  TunnelJunction:  { sugar: 250,  leafBits: 50 },
  DungeonTrap:     { sugar: 150,  leafBits: 30 },
  AcidSpitter:     { sugar: 700,  leafBits: 200 },
  SporeTower:      { sugar: 550,  leafBits: 160 },
  RootSnare:       { sugar: 180,  leafBits: 40 },
  HiddenStinger:   { sugar: 900,  leafBits: 260 },
  SpiderNest:      { sugar: 1200, leafBits: 320 },
  ThornHedge:      { sugar: 220,  leafBits: 110 },
};

function estimateCost(b: Types.Building): { sugar: number; leafBits: number } {
  const base = BASE_COST[b.kind];
  const level = b.level ?? 1;
  const mult = LEVEL_COST_MULT[level - 1] ?? 28.8;
  if (!base) return { sugar: 0, leafBits: 0 };
  return {
    sugar: Math.floor(base.sugar * mult),
    leafBits: Math.floor(base.leafBits * mult),
  };
}

async function doUpgrade(
  scene: Phaser.Scene,
  runtime: HiveRuntime,
  b: Types.Building,
  onDone: (base: Types.Base, newLevel: number) => void,
): Promise<void> {
  try {
    const r = await runtime.api.upgradeBuilding(b.id);
    if (runtime.player) {
      runtime.player.player.sugar = r.player.sugar;
      runtime.player.player.leafBits = r.player.leafBits;
      runtime.player.player.aphidMilk = r.player.aphidMilk;
      runtime.player.player.trophies = r.player.trophies;
      runtime.player.base = r.base;
    }
    onDone(r.base, r.newLevel);
  } catch (err) {
    flashToast(scene, (err as Error).message);
  }
}

async function doQueenUpgrade(
  scene: Phaser.Scene,
  runtime: HiveRuntime,
  close: () => void,
  onUpdated: (base: Types.Base) => void,
): Promise<void> {
  try {
    const r = await runtime.api.upgradeQueen();
    if (runtime.player) {
      runtime.player.player.sugar = r.player.sugar;
      runtime.player.player.leafBits = r.player.leafBits;
      runtime.player.player.aphidMilk = r.player.aphidMilk;
      runtime.player.player.trophies = r.player.trophies;
      runtime.player.base = r.base;
    }
    close();
    onUpdated(r.base);
  } catch (err) {
    flashToast(scene, (err as Error).message);
  }
}

async function doDemolish(
  runtime: HiveRuntime,
  b: Types.Building,
  onDone: (base: Types.Base) => void,
): Promise<void> {
  try {
    const r = await runtime.api.deleteBuilding(b.id);
    if (runtime.player) {
      runtime.player.base = r.base;
    }
    onDone(r.base);
  } catch (err) {
    console.warn('demolish failed', err);
  }
}

function flashToast(scene: Phaser.Scene, msg: string): void {
  const t = scene.add
    .text(scene.scale.width / 2, scene.scale.height - 60, msg, {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '13px',
      color: '#0f1b10',
      backgroundColor: '#ffd98a',
      padding: { left: 12, right: 12, top: 6, bottom: 6 },
    })
    .setOrigin(0.5)
    .setDepth(DEPTHS.toast);
  scene.tweens.add({
    targets: t,
    alpha: { from: 1, to: 0 },
    delay: 1600,
    duration: 400,
    onComplete: () => t.destroy(),
  });
}
