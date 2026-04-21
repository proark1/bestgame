import type { Types } from '@hive/shared';

// Per-unit upgrade cost. Target: a full upgrade tree takes ~dozens of
// raids to bankroll, so that progression is paced. Each level roughly
// doubles the sugar cost; leafBits is a secondary gate that makes
// multi-level jumps more tangible for cheap units.
//
// Level 1 is free (starter). `upgradeCost(kind, currentLevel)` returns
// the cost to go from currentLevel → currentLevel + 1.

export interface UpgradeCost {
  sugar: number;
  leafBits: number;
}

// Cap on level so the progression curve stays bounded. Beyond level 10
// the cost table would be astronomical anyway.
export const MAX_UNIT_LEVEL = 10;

// Base sugar cost per unit kind at level 1 → 2. Doubles each level.
const BASE_SUGAR: Partial<Record<Types.UnitKind, number>> = {
  WorkerAnt: 150,
  SoldierAnt: 300,
  DirtDigger: 400,
  Forager: 200,
  Wasp: 500,
  HoneyTank: 700,
  ShieldBeetle: 800,
  BombBeetle: 600,
  Roller: 550,
  Jumper: 450,
  WebSetter: 500,
  Ambusher: 650,
};

const BASE_LEAF: Partial<Record<Types.UnitKind, number>> = {
  WorkerAnt: 30,
  SoldierAnt: 80,
  DirtDigger: 120,
  Forager: 60,
  Wasp: 150,
  HoneyTank: 220,
  ShieldBeetle: 250,
  BombBeetle: 180,
  Roller: 170,
  Jumper: 130,
  WebSetter: 160,
  Ambusher: 200,
};

export function isUpgradeableUnit(kind: Types.UnitKind): boolean {
  return kind in BASE_SUGAR;
}

export function upgradeCost(kind: Types.UnitKind, currentLevel: number): UpgradeCost | null {
  if (!isUpgradeableUnit(kind)) return null;
  if (currentLevel >= MAX_UNIT_LEVEL) return null;
  const multiplier = Math.pow(2, currentLevel - 1); // 1→2 costs 1×, 2→3 costs 2×, …
  return {
    sugar: Math.floor(BASE_SUGAR[kind]! * multiplier),
    leafBits: Math.floor(BASE_LEAF[kind]! * multiplier),
  };
}

// Full catalog for the UI: for each upgradeable kind, cost at level 1.
// The client pairs this with the player's current levels to render
// the table. Server stays the source of truth for cost scaling.
export function upgradeCatalog(): Record<
  string,
  { baseSugar: number; baseLeafBits: number; maxLevel: number }
> {
  const out: Record<string, { baseSugar: number; baseLeafBits: number; maxLevel: number }> = {};
  for (const k of Object.keys(BASE_SUGAR) as Types.UnitKind[]) {
    out[k] = {
      baseSugar: BASE_SUGAR[k]!,
      baseLeafBits: BASE_LEAF[k]!,
      maxLevel: MAX_UNIT_LEVEL,
    };
  }
  return out;
}

// Stat scaling when a unit is deployed. Each level adds a scaling
// factor — kept simple: level N = (1 + 0.2 * (N - 1)) × base. Applied
// to hp + attackDamage so upgrades are felt on both sides of combat
// (bigger hp pool, heavier hits).
export function statMultiplier(level: number): number {
  const clamped = Math.max(1, Math.min(MAX_UNIT_LEVEL, level));
  return 1 + 0.2 * (clamped - 1);
}
