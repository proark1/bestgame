import type { Types } from '@hive/shared';

// Placement costs for each building kind at level 1. These are the
// prices /api/player/building debits when the player places a new
// building. Upgrade costs (future) will scale with level.
//
// Cheapest: walls + traps (defensive). Most expensive: vaults (economy),
// Queen Chamber (never placed at runtime — starter base only).

export interface PlacementCost {
  sugar: number;
  leafBits: number;
  aphidMilk: number;
}

export const BUILDING_PLACEMENT_COSTS: Record<Types.BuildingKind, PlacementCost> = {
  QueenChamber:    { sugar: 99999, leafBits: 99999, aphidMilk: 0 }, // not player-placeable
  DewCollector:    { sugar: 200,   leafBits: 40,    aphidMilk: 0 },
  MushroomTurret:  { sugar: 350,   leafBits: 80,    aphidMilk: 0 },
  LeafWall:        { sugar: 100,   leafBits: 60,    aphidMilk: 0 },
  PebbleBunker:    { sugar: 500,   leafBits: 150,   aphidMilk: 0 },
  LarvaNursery:    { sugar: 400,   leafBits: 120,   aphidMilk: 0 },
  SugarVault:      { sugar: 600,   leafBits: 100,   aphidMilk: 0 },
  TunnelJunction:  { sugar: 250,   leafBits: 50,    aphidMilk: 0 },
  DungeonTrap:     { sugar: 150,   leafBits: 30,    aphidMilk: 0 },
  // New defensive kinds. Priced on a "slot-value" scale — a RootSnare
  // one-shot is cheap, an AcidSpitter is mortar-tier expensive, a
  // SpiderNest is our premium late-game defender.
  AcidSpitter:     { sugar: 700,   leafBits: 200,   aphidMilk: 0 },
  SporeTower:      { sugar: 550,   leafBits: 160,   aphidMilk: 0 },
  RootSnare:       { sugar: 180,   leafBits: 40,    aphidMilk: 0 },
  HiddenStinger:   { sugar: 900,   leafBits: 260,   aphidMilk: 0 },
  SpiderNest:      { sugar: 1200,  leafBits: 320,   aphidMilk: 0 },
  ThornHedge:      { sugar: 220,   leafBits: 110,   aphidMilk: 0 },
};

// Default footprint + hp per kind. Keeps the sim snapshot honest when
// the client just sends { kind, anchor } — server fills in the rest.
export const BUILDING_DEFAULTS: Record<
  Types.BuildingKind,
  { w: number; h: number; hp: number; spans?: Types.Layer[] }
> = {
  QueenChamber:   { w: 2, h: 2, hp: 800, spans: [0, 1] },
  DewCollector:   { w: 1, h: 1, hp: 200 },
  MushroomTurret: { w: 1, h: 1, hp: 400 },
  LeafWall:       { w: 1, h: 1, hp: 600 },
  PebbleBunker:   { w: 1, h: 1, hp: 900 },
  LarvaNursery:   { w: 1, h: 1, hp: 300 },
  SugarVault:     { w: 1, h: 1, hp: 350 },
  TunnelJunction: { w: 1, h: 1, hp: 250 },
  DungeonTrap:    { w: 1, h: 1, hp: 100 },
  // New defensive kinds. Footprints mirror their visual weight in the
  // atlas: AcidSpitter and SpiderNest are chunky 2×2 structures; the
  // rest sit on a single tile. Keep in sync with BUILDING_STATS hpMax.
  AcidSpitter:    { w: 2, h: 2, hp: 350 },
  SporeTower:     { w: 1, h: 1, hp: 280 },
  RootSnare:      { w: 1, h: 1, hp: 1 },
  HiddenStinger:  { w: 1, h: 1, hp: 220 },
  SpiderNest:     { w: 2, h: 2, hp: 260 },
  ThornHedge:     { w: 1, h: 1, hp: 1100 },
};

// Hard ceiling on buildings per base. Shared between POST
// /api/player/building (which rejects placement past this) and PUT
// /api/player/base (which rejects a sync past this). Keeping one
// source of truth avoids the "can sync 60 but can't place new" bug.
export const MAX_BUILDINGS_PER_BASE = 60;

// Players can't hand-place a Queen Chamber (one-per-base, granted at
// account creation). Everything else is fair game.
export const PLAYER_PLACEABLE: readonly Types.BuildingKind[] = [
  'DewCollector',
  'MushroomTurret',
  'LeafWall',
  'PebbleBunker',
  'LarvaNursery',
  'SugarVault',
  'TunnelJunction',
  'DungeonTrap',
  // Expanded defensive roster — all player-placeable (gated by queen
  // level in buildingRules.ts:QUOTA_BY_TIER, not here).
  'AcidSpitter',
  'SporeTower',
  'RootSnare',
  'HiddenStinger',
  'SpiderNest',
  'ThornHedge',
] as const;

export function isPlayerPlaceable(kind: Types.BuildingKind): boolean {
  return (PLAYER_PLACEABLE as readonly string[]).includes(kind);
}
