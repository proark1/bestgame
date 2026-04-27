// Hero auras (PR D). Walks every hero unit and applies its aura to
// allied units within its radius. Runs each tick BEFORE combat so
// aura buffs are reflected in the same tick they're earned.
//
// Determinism rules:
//   - All distance / HP arithmetic uses Fixed (Q16.16). No floats.
//   - Iteration order is the canonical state.units order (id-sorted),
//     never a Map / Set.
//   - Buffs are *replaced* each tick by walking all heroes; a unit
//     that walked out of range last tick has its flags reset at the
//     top of this pass, so leaving the aura instantly drops the
//     buff (matches CoC's rage-spell behavior more than its
//     "permanent until death" jump-spell behavior).
//
// Aura kinds (see shared/src/types/heroes.ts):
//   - attackSpeed     → sets unit.auraAttackSpeedPct, combat reads
//                       it to scale attackCooldownTicks down.
//   - hpBonus         → applied as a one-shot HP top-up the first
//                       tick a unit enters range. Tracked via
//                       hpMax bump so the bonus persists if the
//                       hero dies (matches "buff lingers" feel).
//   - heal            → drips Fixed HP per tick (clamped at hpMax).
//   - buildingDamage  → sets unit.auraBuildingDamagePct, combat
//                       scales attackDamage when the target is a
//                       building.

import type { SimState } from '../state.js';
import { HERO_CATALOG, HERO_STATS_FIXED } from '../heroStats.js';
import { fromInt, mul, sub, add } from '../fixed.js';

// Pre-converted "30 ticks = 1 sec" constant. Tick rate is fixed at
// 30 Hz; the heal aura's "10 HP/sec" lands as a 10/30 Fixed per
// tick. We pre-compute this in Fixed so the inner loop has no
// per-tick rounding ambiguity.
const TICKS_PER_SEC = 30;

export function applyAuras(state: SimState): void {
  // Pass 1: reset every unit's per-tick aura flags. A unit that
  // walked out of range last tick should drop the buff. Heal rate
  // is recorded across pass 2 and applied once in pass 3 so two
  // healers don't double-tick a unit's HP.
  for (const u of state.units) {
    if (u.auraAttackSpeedPct) u.auraAttackSpeedPct = 0;
    if (u.auraBuildingDamagePct) u.auraBuildingDamagePct = 0;
    if (u.auraHealPerTick) u.auraHealPerTick = 0;
  }

  // Pass 2: for each hero, walk allied units and apply effects.
  // Heroes ARE included as their own allies — a Hercules-style
  // tank gets their own +HP, a Wasp Queen heals herself. This
  // matches the CoC convention where a hero's aura covers their
  // own footprint. The double-loop is O(H × U) where H ≤ 2 (max
  // equipped) so the overall cost is at most 2 × ~50 = 100
  // distance checks per tick.
  for (const hero of state.units) {
    if (!hero.heroKind) continue;
    if (hero.hp <= 0) continue;
    const def = HERO_CATALOG[hero.heroKind];
    const stats = HERO_STATS_FIXED[hero.heroKind];
    const radius = stats.auraRadius;
    const radius2 = mul(radius, radius);
    const aura = def.aura;

    for (const ally of state.units) {
      if (ally.owner !== hero.owner) continue;
      if (ally.hp <= 0) continue;
      // Squared-distance check avoids a sqrt; both args are Fixed
      // so the comparison stays bit-exact. A hero's own (dx, dy)
      // is (0, 0) so the radius check trivially passes — they
      // benefit from their own aura.
      const dx = sub(ally.x, hero.x);
      const dy = sub(ally.y, hero.y);
      const d2 = add(mul(dx, dx), mul(dy, dy));
      if (d2 > radius2) continue;

      switch (aura.kind) {
        case 'attackSpeed': {
          // Take the strongest active boost — multiple heroes of
          // the same aura kind do not stack (matches CoC rage
          // overlap rules).
          const cur = ally.auraAttackSpeedPct ?? 0;
          if (aura.pct > cur) ally.auraAttackSpeedPct = aura.pct;
          break;
        }
        case 'buildingDamage': {
          const cur = ally.auraBuildingDamagePct ?? 0;
          if (aura.pct > cur) ally.auraBuildingDamagePct = aura.pct;
          break;
        }
        case 'heal': {
          // Record the strongest per-tick heal so multi-healer
          // overlaps don't compound. Pass 3 below applies the
          // recorded rate exactly once per unit.
          const perTick = (fromInt(aura.perSec) / TICKS_PER_SEC) | 0;
          const cur = ally.auraHealPerTick ?? 0;
          if (perTick > cur) ally.auraHealPerTick = perTick;
          break;
        }
        case 'hpBonus': {
          // One-shot: bump hpMax + heal the same amount the first
          // tick we see this ally close to this hero. The bonus is
          // computed RELATIVE TO BASE so that moving from a 10%
          // aura to a 20% one yields exactly 20% over base, not
          // 10% × 1.10 = 21% (compounding). The math:
          //   hpMax_now = base * (100 + cur) / 100
          //   bonus     = base * delta / 100
          //             = hpMax_now * delta / (100 + cur)
          // which keeps the calculation inside the existing
          // hpMax-relative form without needing a separate
          // base-HP cache on the unit.
          const cur = ally.auraHpBonusApplied ?? 0;
          if (cur < aura.pct) {
            const delta = aura.pct - cur;
            const bonus = (mul(ally.hpMax, fromInt(delta)) / (100 + cur)) | 0;
            ally.hpMax = ally.hpMax + bonus;
            ally.hp = ally.hp + bonus;
            ally.auraHpBonusApplied = aura.pct;
          }
          break;
        }
      }
    }
  }

  // Pass 3: drip the strongest heal rate per unit. Done after the
  // hero loop so the value reflects the max across every healer
  // active this tick (rather than the sum from per-hero adds).
  for (const u of state.units) {
    const rate = u.auraHealPerTick ?? 0;
    if (rate <= 0) continue;
    if (u.hp <= 0) continue;
    u.hp = u.hp + rate;
    if (u.hp > u.hpMax) u.hp = u.hpMax;
  }
}
