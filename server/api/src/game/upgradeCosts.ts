import type { Types } from '@hive/shared';
import {
  MAX_UNIT_LEVEL,
  levelStatPercent,
  upgradeCostMult,
} from './progression.js';
import { unlockQueenLevelFor } from './buildingRules.js';

// Per-unit upgrade cost. Per-kind base prices live here; the shape of
// the cost curve (how price scales with level) lives in progression.ts
// so balance passes can tune the curve in one place for every unit.
//
// Level 1 is free (starter). `upgradeCost(kind, currentLevel)` returns
// the cost to go from currentLevel → currentLevel + 1.

export interface UpgradeCost {
  sugar: number;
  leafBits: number;
}

export { MAX_UNIT_LEVEL };

// Base sugar cost per unit kind — the "1.0×" point on the cost curve.
// The curve multiplier from progression.ts scales this by 0.5× at the
// first upgrade up to 28.8× at the last, so e.g. a SoldierAnt costs
// 150 sugar to go L1→L2 and 8640 sugar to go L9→L10.
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
  // Expanded attacker roster. Base costs roughly track unlock tier:
  // L2 unlocks cost ~450, L3 ~600, L4 ~850, L5 ~1000. MiniScarab /
  // NestSpider are intentionally absent — they're spawned by
  // behaviors and never in the upgrade catalog.
  FireAnt: 450,
  Termite: 600,
  Dragonfly: 650,
  Mantis: 850,
  Scarab: 1000,
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
  FireAnt: 140,
  Termite: 190,
  Dragonfly: 200,
  Mantis: 280,
  Scarab: 330,
};

export function isUpgradeableUnit(kind: Types.UnitKind): boolean {
  // hasOwnProperty.call guards against a client sending a prototype
  // name like "toString" or "__proto__" — those would pass the naked
  // `in` operator and trip upgradeCost's string lookups.
  return Object.prototype.hasOwnProperty.call(BASE_SUGAR, kind);
}

export function upgradeCost(kind: Types.UnitKind, currentLevel: number): UpgradeCost | null {
  if (!isUpgradeableUnit(kind)) return null;
  const multiplier = upgradeCostMult(currentLevel);
  if (multiplier === null) return null;
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
  { baseSugar: number; baseLeafBits: number; maxLevel: number; unlockQueenLevel: number }
> {
  const out: Record<
    string,
    { baseSugar: number; baseLeafBits: number; maxLevel: number; unlockQueenLevel: number }
  > = {};
  for (const k of Object.keys(BASE_SUGAR) as Types.UnitKind[]) {
    out[k] = {
      baseSugar: BASE_SUGAR[k]!,
      baseLeafBits: BASE_LEAF[k]!,
      maxLevel: MAX_UNIT_LEVEL,
      // Queen level required to deploy this kind. UI uses it to grey
      // out upgrade cards and deck slots before the gate opens.
      unlockQueenLevel: unlockQueenLevelFor(k),
    };
  }
  return out;
}

// Stat scaling when a unit is deployed. Returns a float for UI use
// (e.g. "your soldier deals 1.35× damage at L4"). The deterministic
// sim uses the underlying integer-percent table directly —
// see shared/src/sim/progression.ts::LEVEL_STAT_PERCENT.
export function statMultiplier(level: number): number {
  return levelStatPercent(level) / 100;
}
