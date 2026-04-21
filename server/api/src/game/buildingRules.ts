import type { Types } from '@hive/shared';

// Town-builder PvP constraints: per-kind layer rules + quotas that
// scale with Queen Chamber level. Models the "town hall tier" loop
// from Clash-of-Clans style games where unlocking a stronger base
// tier widens the building roster.
//
// Queen level 1 is every new account; upgrading via POST
// /player/upgrade-queen advances through 2..5 gated by cumulative
// resource cost. A higher queen tier raises the per-kind cap AND
// unlocks kinds that had zero slots before.

export const MAX_QUEEN_LEVEL = 5;
export const MIN_QUEEN_LEVEL = 1;

// Which layers each kind can legally occupy. Surface = 0 (daylight,
// defensive grid); underground = 1 (safe economy). Cross-layer
// buildings (Queen + TunnelJunction) list both.
//
// Theme: defensive buildings read the open air → surface. Production
// and storage hide underground. Traps work either place.
export const ALLOWED_LAYERS: Record<Types.BuildingKind, readonly Types.Layer[]> = {
  QueenChamber: [0, 1],
  MushroomTurret: [0],
  LeafWall: [0],
  PebbleBunker: [0],
  DungeonTrap: [0, 1],
  DewCollector: [0],
  LarvaNursery: [1],
  SugarVault: [1],
  TunnelJunction: [0, 1],
};

// Maximum count per kind at queen level N (1..MAX_QUEEN_LEVEL).
// Index = level - 1. QueenChamber is always 1 (never player-placeable
// but included so catalog queries don't short-circuit on missing key).
export const QUOTA_BY_TIER: Record<Types.BuildingKind, readonly number[]> = {
  QueenChamber:   [1, 1, 1, 1, 1],
  MushroomTurret: [1, 2, 3, 4, 5],
  LeafWall:       [4, 8, 12, 16, 20],
  PebbleBunker:   [0, 1, 2, 2, 3],
  DungeonTrap:    [0, 2, 4, 6, 8],
  DewCollector:   [1, 2, 3, 4, 5],
  LarvaNursery:   [1, 2, 3, 4, 5],
  SugarVault:     [1, 1, 2, 2, 3],
  TunnelJunction: [0, 1, 2, 3, 4],
};

// Cost to upgrade the Queen from level N to N+1. Index = fromLevel-1,
// so QUEEN_UPGRADE_COST[0] is 1→2. Four entries because L5 is the cap.
//
// Curve is exponential-ish but hand-tuned: first upgrade is cheap to
// hook, L4→L5 is a real investment (40-ish raids' worth of loot).
export const QUEEN_UPGRADE_COST: ReadonlyArray<{
  sugar: number;
  leafBits: number;
  aphidMilk: number;
}> = [
  { sugar: 500,   leafBits: 200,  aphidMilk: 0 },
  { sugar: 1500,  leafBits: 600,  aphidMilk: 0 },
  { sugar: 4000,  leafBits: 1500, aphidMilk: 0 },
  { sugar: 10000, leafBits: 3500, aphidMilk: 0 },
];

export function queenLevel(base: Types.Base): number {
  const queen = base.buildings.find((b) => b.kind === 'QueenChamber');
  const lvl = queen?.level ?? MIN_QUEEN_LEVEL;
  return Math.max(MIN_QUEEN_LEVEL, Math.min(MAX_QUEEN_LEVEL, Math.floor(lvl)));
}

export function countOfKind(base: Types.Base, kind: Types.BuildingKind): number {
  let n = 0;
  for (const b of base.buildings) {
    // Count placed buildings regardless of hp — destroyed buildings
    // still occupy a slot until the player manually clears them.
    // (The picker also shouldn't pretend a destroyed slot is free.)
    if (b.kind === kind) n++;
  }
  return n;
}

export function quotaFor(kind: Types.BuildingKind, qLevel: number): number {
  const tier = Math.max(MIN_QUEEN_LEVEL, Math.min(MAX_QUEEN_LEVEL, qLevel));
  const row = QUOTA_BY_TIER[kind];
  return row[tier - 1] ?? 0;
}

export function isLayerAllowed(kind: Types.BuildingKind, layer: Types.Layer): boolean {
  return ALLOWED_LAYERS[kind].includes(layer);
}

// Package the full rules table for the client catalog. Kept
// serializable (plain objects + arrays) so JSON round-trip is clean.
export function buildingRulesPayload(): Record<
  string,
  { allowedLayers: number[]; quotaByTier: number[] }
> {
  const out: Record<
    string,
    { allowedLayers: number[]; quotaByTier: number[] }
  > = {};
  for (const k of Object.keys(ALLOWED_LAYERS) as Types.BuildingKind[]) {
    out[k] = {
      allowedLayers: [...ALLOWED_LAYERS[k]],
      quotaByTier: [...QUOTA_BY_TIER[k]],
    };
  }
  return out;
}
