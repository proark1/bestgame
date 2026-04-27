// Hero combat stats — Fixed-point mirror of HERO_CATALOG. The
// catalog uses readable integer numbers for the codex / shop UI;
// the sim needs Fixed (Q16.16) so combat math stays deterministic
// across engines.
//
// Aura radii also live here as Fixed tiles. The auras system
// (systems/auras.ts) walks every hero unit each tick and applies
// the matching effect to allied units within range.

import { fromInt, fromFloat } from './fixed.js';
import type { Fixed } from './fixed.js';
import type { UnitStats } from '../types/units.js';
import { HERO_CATALOG, type HeroKind } from '../types/heroes.js';

export interface HeroStats extends UnitStats {
  // Aura radius converted to Fixed tiles for in-tick distance checks.
  auraRadius: Fixed;
}

export const HERO_STATS_FIXED: Record<HeroKind, HeroStats> = {
  Mantis: {
    hpMax: fromInt(HERO_CATALOG.Mantis.hpMax / 10),
    speed: fromFloat(0.10),
    attackRange: fromFloat(0.9),
    attackDamage: fromInt(HERO_CATALOG.Mantis.attackDamage / 5),
    attackCooldownTicks: HERO_CATALOG.Mantis.attackCooldownTicks,
    canFly: HERO_CATALOG.Mantis.canFly,
    canDig: HERO_CATALOG.Mantis.canDig,
    auraRadius: fromInt(HERO_CATALOG.Mantis.aura.radius),
  },
  HerculesBeetle: {
    hpMax: fromInt(HERO_CATALOG.HerculesBeetle.hpMax / 10),
    speed: fromFloat(0.05),
    attackRange: fromFloat(0.8),
    attackDamage: fromInt(HERO_CATALOG.HerculesBeetle.attackDamage / 5),
    attackCooldownTicks: HERO_CATALOG.HerculesBeetle.attackCooldownTicks,
    canFly: HERO_CATALOG.HerculesBeetle.canFly,
    canDig: HERO_CATALOG.HerculesBeetle.canDig,
    auraRadius: fromInt(HERO_CATALOG.HerculesBeetle.aura.radius),
  },
  WaspQueen: {
    hpMax: fromInt(HERO_CATALOG.WaspQueen.hpMax / 10),
    speed: fromFloat(0.12),
    attackRange: fromFloat(2.0),
    attackDamage: fromInt(HERO_CATALOG.WaspQueen.attackDamage / 5),
    attackCooldownTicks: HERO_CATALOG.WaspQueen.attackCooldownTicks,
    canFly: HERO_CATALOG.WaspQueen.canFly,
    canDig: HERO_CATALOG.WaspQueen.canDig,
    auraRadius: fromInt(HERO_CATALOG.WaspQueen.aura.radius),
  },
  StagBeetle: {
    hpMax: fromInt(HERO_CATALOG.StagBeetle.hpMax / 10),
    speed: fromFloat(0.08),
    attackRange: fromFloat(0.8),
    attackDamage: fromInt(HERO_CATALOG.StagBeetle.attackDamage / 5),
    attackCooldownTicks: HERO_CATALOG.StagBeetle.attackCooldownTicks,
    canFly: HERO_CATALOG.StagBeetle.canFly,
    canDig: HERO_CATALOG.StagBeetle.canDig,
    auraRadius: fromInt(HERO_CATALOG.StagBeetle.aura.radius),
  },
};

// Stats lookup that handles both regular swarm units (UNIT_STATS)
// and heroes (HERO_STATS_FIXED). Combat / deploy / pheromone-follow
// route through this so no caller has to remember the dual table.
export function getUnitStats(
  u: { kind: import('../types/units.js').UnitKind; heroKind?: HeroKind },
  fallback: UnitStats,
): UnitStats {
  if (u.heroKind) return HERO_STATS_FIXED[u.heroKind];
  return fallback;
}

// Heal / HP-bonus auras need the catalog directly (the per-hero
// magnitude isn't stored in HERO_STATS_FIXED to avoid duplicating
// the discriminated-union shape). Re-export for callers.
export { HERO_CATALOG } from '../types/heroes.js';
