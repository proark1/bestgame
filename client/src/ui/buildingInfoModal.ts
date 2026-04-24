import Phaser from 'phaser';
import { Types, Sim } from '@hive/shared';
import type { HiveRuntime } from '../main.js';
import type { BuildingCatalog } from '../net/Api.js';
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
// Modal is tall enough to fit three stacked action buttons at the
// bottom (Upgrade / Move / Demolish) plus the stats column above. If
// the "at next level" preview gets longer, bump this, not the button
// heights — the buttons' size matches the player's expectation from
// the rest of the game.
const MODAL_H = 540;
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

// Per-second production table — pulled from the server's catalog
// response at open time (see openBuildingInfoModal). A fallback table
// is kept for older servers that predate the catalog fields so the
// modal still renders something sensible when we can't reach them.
const INCOME_FALLBACK: Partial<
  Record<Types.BuildingKind, { sugar: number; leafBits: number; aphidMilk: number }>
> = {
  DewCollector: { sugar: 8, leafBits: 0, aphidMilk: 0 },
  LarvaNursery: { sugar: 0, leafBits: 3, aphidMilk: 0 },
  SugarVault: { sugar: 2, leafBits: 0, aphidMilk: 0 },
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
  // Fired when the player taps "Move". The modal closes itself first;
  // the caller is responsible for kicking off the in-scene placement-
  // preview flow and issuing the /building/:id/move API call on a
  // valid tile tap.
  onMoveRequest?: (building: Types.Building) => void;
}

// Opens the modal. Returns a close fn in case the caller wants to
// close it externally (e.g. scene shutdown). Safe to ignore —
// backdrop-tap + × button already handle the common case.
//
// Balance tables (income per second + upgrade cost curve + per-kind
// base cost) are fetched from the server's /player/building/catalog
// endpoint on open, so the modal stays in sync with server-side
// balance changes without a client redeploy. While the fetch is in
// flight, a fallback table keeps the opening render usable; we
// re-render the card once the catalog arrives.
export function openBuildingInfoModal(opts: OpenBuildingInfoOpts): () => void {
  const { scene, runtime, building } = opts;
  // Balance tables (income per second + per-kind costs + level-cost
  // curve) come from the server catalog. Kicked off async so the modal
  // opens instantly with the fallback tables and upgrades to the
  // authoritative numbers when the fetch resolves.
  let catalog: BuildingCatalog | null = null;
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
    const incomeMap = catalog?.incomePerSecond ?? INCOME_FALLBACK;
    const income = incomeMap[b.kind];
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
    // endpoint; every other kind gets a symmetric 3-button stack:
    // Upgrade (green) / Move (ghost) / Demolish (red). Same width +
    // height across the three so the player reads them as equally
    // reachable alternatives — matches the Clash-style "primary
    // action stack" the rest of the UI uses.
    const isQueen = b.kind === 'QueenChamber';
    const atMax = level >= MAX_BUILDING_LEVEL;
    const actionBtnW = MODAL_W - 44;
    const actionBtnH = 44;
    const actionGap = 8;
    const actionsBottomY = MODAL_H - 24;
    const actionsStartY = isQueen
      ? actionsBottomY - actionBtnH / 2
      : actionsBottomY - actionBtnH * 3 - actionGap * 2 + actionBtnH / 2;

    if (isQueen) {
      bodyContainer.add(
        crispText(scene, 22, actionsStartY - actionBtnH / 2 - 28,
          'Queen upgrades unlock new building slots and tiers.',
          bodyTextStyle(11, COLOR.textDim),
        ).setWordWrapWidth(MODAL_W - 44, true),
      );
      const btn = makeHiveButton(scene, {
        x: MODAL_W / 2,
        y: actionsStartY,
        width: actionBtnW,
        height: actionBtnH,
        label: atMax ? 'Max level' : 'Upgrade Queen',
        variant: atMax ? 'ghost' : 'secondary',
        fontSize: 14,
        onPress: () => {
          if (atMax) return;
          void doQueenUpgrade(scene, runtime, close, opts.onUpdated);
        },
      });
      bodyContainer.add(btn.container);
    } else {
      // Cost line sits just above the action stack so the Upgrade
      // button label stays short ("Upgrade") and visually matches
      // the Demolish button rather than being twice as wide.
      const costLineY = actionsStartY - actionBtnH / 2 - 18;
      if (!atMax) {
        const cost = estimateCost(b, catalog);
        bodyContainer.add(
          crispText(
            scene,
            MODAL_W / 2,
            costLineY,
            `Next level: ${cost.sugar} sugar · ${cost.leafBits} leaf`,
            bodyTextStyle(12, COLOR.textDim),
          ).setOrigin(0.5, 0.5),
        );
      } else {
        bodyContainer.add(
          crispText(
            scene,
            MODAL_W / 2,
            costLineY,
            'This building is at max level.',
            bodyTextStyle(12, COLOR.textDim),
          ).setOrigin(0.5, 0.5),
        );
      }

      // Upgrade — same shape as Demolish, green instead of red.
      const upgradeBtn = makeHiveButton(scene, {
        x: MODAL_W / 2,
        y: actionsStartY,
        width: actionBtnW,
        height: actionBtnH,
        label: atMax ? 'Max level' : 'Upgrade',
        variant: atMax ? 'ghost' : 'secondary',
        fontSize: 14,
        onPress: () => {
          if (atMax) return;
          void doUpgrade(scene, runtime, b, (base) => {
            const fresh = base.buildings.find((x) => x.id === b.id);
            if (fresh) renderBody(fresh);
            opts.onUpdated(base);
          });
        },
      });
      bodyContainer.add(upgradeBtn.container);

      // Move — closes the modal and hands control back to the caller
      // so it can enter placement-preview mode on the board. The
      // scene is responsible for actually calling /building/:id/move;
      // the modal only delivers the "user wants to move this" intent.
      const moveBtn = makeHiveButton(scene, {
        x: MODAL_W / 2,
        y: actionsStartY + actionBtnH + actionGap,
        width: actionBtnW,
        height: actionBtnH,
        label: 'Move',
        variant: 'ghost',
        fontSize: 14,
        onPress: () => {
          close();
          opts.onMoveRequest?.(b);
        },
      });
      bodyContainer.add(moveBtn.container);

      // Demolish — red, confirm-gated. Same size as Upgrade / Move
      // above so all three read as siblings of equal weight.
      const demBtn = makeHiveButton(scene, {
        x: MODAL_W / 2,
        y: actionsStartY + (actionBtnH + actionGap) * 2,
        width: actionBtnW,
        height: actionBtnH,
        label: 'Demolish',
        variant: 'danger',
        fontSize: 14,
        onPress: () => {
          void openConfirm({
            title: 'Demolish this building?',
            body: 'You will not get the resources back. This action cannot be undone.',
            confirmLabel: 'Demolish',
            danger: true,
          }).then((confirmed) => {
            if (!confirmed) return;
            void doDemolish(scene, runtime, b, (base) => {
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

  // Upgrade to the authoritative balance tables asap. If the scene
  // tears down before the fetch resolves (user closed the modal or
  // left the scene), check that the root container is still in the
  // display list before touching it.
  runtime.api
    .getBuildingCatalog()
    .then((c) => {
      catalog = c;
      if (!root.active) return;
      const current =
        runtime.player?.base.buildings.find((x) => x.id === building.id) ??
        building;
      renderBody(current);
    })
    .catch(() => {
      // Keep the fallback numbers; nothing actionable on a failed fetch.
    });

  return close;
}

// Cost preview — reads both the cost curve and the per-kind base
// price from the server catalog so the "Upgrade — NNN sugar" label
// tracks any balance change on the server side. Returns zeros when
// the catalog hasn't loaded yet (rare race on slow networks); the
// server is still authoritative on the actual debit at submit time.
function estimateCost(
  b: Types.Building,
  catalog: BuildingCatalog | null,
): { sugar: number; leafBits: number } {
  if (!catalog?.baseCost || !catalog.levelCostMult) return { sugar: 0, leafBits: 0 };
  const base = catalog.baseCost[b.kind];
  if (!base) return { sugar: 0, leafBits: 0 };
  const level = b.level ?? 1;
  const mult =
    catalog.levelCostMult[level - 1] ??
    catalog.levelCostMult[catalog.levelCostMult.length - 1] ??
    1;
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
  scene: Phaser.Scene,
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
    // Surface failures to the player rather than silently swallowing
    // them — demolition often fails for recoverable reasons (network
    // blip, 409 on a just-raided base) and the player needs to know
    // why the building is still there.
    flashToast(scene, (err as Error).message);
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
