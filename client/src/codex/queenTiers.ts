import type { Types } from '@hive/shared';

// Single source of truth for "what unlocks at each Queen Chamber
// level". Mirrors server-side `QUOTA_BY_TIER` and
// `UNIT_UNLOCK_QUEEN_LEVEL` (server/api/src/game/buildingRules.ts).
// Kept on the client because the shared catalog response doesn't
// itemise unlocks per tier — the table is small enough to mirror,
// and the server still rejects locked deploys at submit time.
//
// Used by:
//   - client/src/ui/buildingInfoModal.ts (Queen Chamber upgrade preview)
//   - client/src/scenes/ProgressionScene.ts (full tier-by-tier roadmap)
export const QUEEN_UNLOCKS_BY_TIER: Record<
  number,
  { buildings: Types.BuildingKind[]; units: Types.UnitKind[] }
> = {
  2: {
    buildings: ['PebbleBunker', 'DungeonTrap', 'TunnelJunction', 'AcidSpitter', 'SporeTower'],
    units: ['FireAnt'],
  },
  3: {
    buildings: ['RootSnare', 'HiddenStinger'],
    units: ['Termite', 'Dragonfly'],
  },
  4: {
    buildings: ['SpiderNest', 'ThornHedge', 'AphidFarm'],
    units: ['Mantis'],
  },
  5: {
    buildings: [],
    units: ['Scarab'],
  },
};

// Friendly labels — same coverage as buildingInfoModal's local
// tables. Missing keys fall back to the raw kind id, which is
// acceptable for any future addition before a label gets curated.
export const QUEEN_TIER_UNIT_LABELS: Partial<Record<Types.UnitKind, string>> = {
  FireAnt: 'Fire Ant',
  Termite: 'Termite',
  Dragonfly: 'Dragonfly',
  Mantis: 'Mantis',
  Scarab: 'Scarab',
};

export const QUEEN_TIER_BUILDING_LABELS: Partial<Record<Types.BuildingKind, string>> = {
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
  AphidFarm: 'Aphid Farm',
};

export const MIN_QUEEN_LEVEL = 1;
export const MAX_QUEEN_LEVEL = 5;

export interface QueenTierCost {
  sugar: number;
  leafBits: number;
  aphidMilk: number;
}

export interface QueenTierRow {
  level: number; // 1..5
  status: 'completed' | 'current' | 'locked';
  // Cost to advance INTO this tier (i.e., from level-1 → level).
  // Null for level 1 (you start there) and for any tier whose cost
  // index is outside the supplied curve.
  costToReach: QueenTierCost | null;
  // Affordability flag, only meaningful when status === 'locked'
  // and this is the immediate next tier.
  affordable: boolean;
  buildingsUnlocked: Types.BuildingKind[];
  unitsUnlocked: Types.UnitKind[];
}

export interface DeriveTiersInput {
  currentQueenLevel: number;
  resources: { sugar: number; leafBits: number; aphidMilk: number };
  // Per-step costs as returned by the server catalog
  // (queenUpgradeCost in BuildingCatalog). costs[i] is the
  // (i+1)→(i+2) cost; e.g. costs[0] = 1→2.
  costs: ReadonlyArray<QueenTierCost> | null | undefined;
}

// Pure data derivation — "given a player's current state, hand back
// the 5 tier rows ready to render." Extracted so a single test pins
// the rules (status banding, cost lookup, affordability check)
// without having to spin up a Phaser scene.
export function deriveQueenTiers(input: DeriveTiersInput): QueenTierRow[] {
  const current = clampLevel(input.currentQueenLevel);
  const costs = input.costs ?? [];
  const out: QueenTierRow[] = [];
  for (let lvl = MIN_QUEEN_LEVEL; lvl <= MAX_QUEEN_LEVEL; lvl++) {
    const status: QueenTierRow['status'] =
      lvl < current ? 'completed' : lvl === current ? 'current' : 'locked';
    // costs[lvl - 2] is the cost to step INTO level `lvl` from
    // (lvl - 1). Level 1 has no cost-to-reach.
    const costEntry = lvl >= 2 ? costs[lvl - 2] ?? null : null;
    const isImmediateNext = lvl === current + 1;
    const affordable =
      isImmediateNext && costEntry
        ? input.resources.sugar >= costEntry.sugar &&
          input.resources.leafBits >= costEntry.leafBits &&
          input.resources.aphidMilk >= costEntry.aphidMilk
        : false;
    const unlocks = QUEEN_UNLOCKS_BY_TIER[lvl] ?? { buildings: [], units: [] };
    out.push({
      level: lvl,
      status,
      costToReach: costEntry,
      affordable,
      buildingsUnlocked: unlocks.buildings,
      unitsUnlocked: unlocks.units,
    });
  }
  return out;
}

function clampLevel(n: number): number {
  if (!Number.isFinite(n)) return MIN_QUEEN_LEVEL;
  const f = Math.floor(n);
  if (f < MIN_QUEEN_LEVEL) return MIN_QUEEN_LEVEL;
  if (f > MAX_QUEEN_LEVEL) return MAX_QUEEN_LEVEL;
  return f;
}
