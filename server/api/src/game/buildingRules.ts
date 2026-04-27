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
  // Traps now read as TUNNEL ambushes — placed only underground so
  // surface raids can't be insta-snared, and the attacker who digs
  // through to the loot vault has to walk through the trap field.
  // Pairs with the new layer-flow design: surface = wall + turret
  // killbox, underground = trap-rich loot heart.
  DungeonTrap: [1],
  DewCollector: [0],
  LarvaNursery: [1],
  SugarVault: [1],
  TunnelJunction: [0, 1],
  // Expanded defensive roster. AcidSpitter + SporeTower + HiddenStinger
  // are surface-only (they shoot into the open air). SpiderNest lives
  // underground — defenders crawl up tunnels to fight. ThornHedge is
  // surface-only (it's a wall). RootSnare moves underground with the
  // other traps so surface stays "walls + turrets" and underground is
  // the trap-and-loot zone.
  AcidSpitter: [0],
  SporeTower: [0],
  RootSnare: [1],
  HiddenStinger: [0],
  SpiderNest: [1],
  ThornHedge: [0],
  // Premium producer hides underground next to vault + nursery.
  AphidFarm: [1],
  // Dedicated underground storage. LeafSilo + MilkPot live next to
  // the existing underground producers so the "economy zone" of
  // the base stays in one place.
  LeafSilo: [1],
  MilkPot: [1],
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
  // New defensive kinds — index = queen level - 1 (so first slot is L2).
  // Pacing: one unlock per tier keeps progression stepwise instead of a
  // "L2 is everything" wall. AcidSpitter + SporeTower arrive at L2 to
  // answer early flyer rushes; HiddenStinger + RootSnare at L3 give
  // ambush options; SpiderNest + ThornHedge at L4 form the late-game
  // core.
  AcidSpitter:    [0, 1, 2, 3, 4],
  SporeTower:     [0, 1, 2, 3, 4],
  RootSnare:      [0, 0, 2, 4, 6],
  HiddenStinger:  [0, 0, 1, 2, 3],
  SpiderNest:     [0, 0, 0, 1, 2],
  ThornHedge:     [0, 0, 0, 4, 8],
  // Aphid farm is a late-game economy unlock — Q4 grants the first
  // slot, Q5 a second. Single farm at first so the milk economy
  // ramps slowly even after the player can build one.
  AphidFarm:      [0, 0, 0, 1, 2],
  // LeafSilo unlocks at Q2 alongside the early defensive roster so
  // a player whose nurseries cap at L1 can still keep accumulating
  // raid loot. MilkPot unlocks at Q4 with AphidFarm — milk only
  // exists once you can produce it, so the storage doesn't matter
  // before then.
  LeafSilo:       [0, 1, 2, 3, 4],
  MilkPot:        [0, 0, 0, 1, 2],
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

// Per-kind Queen level at which an attacker unit becomes deployable.
// Kinds not listed default to level 1 (available from account start).
// MiniScarab + NestSpider are never player-deployable — they spawn
// via behaviors in shared/src/sim/systems/combat.ts.
//
// Pacing mirrors QUOTA_BY_TIER unlocks: FireAnt + Termite at L2/L3
// answer the new early-tier defenders; Dragonfly at L3 when SporeTower
// isn't yet on the defender's board; Mantis + Scarab land at L4/L5 as
// late-game power picks. This keeps the "I just hit Queen L3, what can
// I do now?" loop loud.
export const UNIT_UNLOCK_QUEEN_LEVEL: Partial<Record<Types.UnitKind, number>> = {
  FireAnt: 2,
  Termite: 3,
  Dragonfly: 3,
  Mantis: 4,
  Scarab: 5,
};

// Hidden-from-roster units: summoned by behaviors, not by the player.
// Client upgrade / deploy UIs filter these out. Kept in sync with
// UNIT_BEHAVIOR.hiddenFromRoster in shared/src/sim/stats.ts.
export const ROSTER_HIDDEN_UNITS: readonly Types.UnitKind[] = [
  'MiniScarab',
  'NestSpider',
];

export function isRosterHidden(kind: Types.UnitKind): boolean {
  return ROSTER_HIDDEN_UNITS.includes(kind);
}

// Minimum Queen level required to deploy this unit kind. 1 means
// "available from start" (matches every original roster entry). The
// client uses this to lock / grey-out cards in the deck picker so the
// restriction is visible before the player tries and fails.
export function unlockQueenLevelFor(kind: Types.UnitKind): number {
  return UNIT_UNLOCK_QUEEN_LEVEL[kind] ?? 1;
}

export function isUnitUnlocked(kind: Types.UnitKind, qLevel: number): boolean {
  if (isRosterHidden(kind)) return false;
  return qLevel >= unlockQueenLevelFor(kind);
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
