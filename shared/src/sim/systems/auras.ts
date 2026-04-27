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
  // walked out of range last tick should drop the buff.
  for (const u of state.units) {
    if (u.auraAttackSpeedPct) u.auraAttackSpeedPct = 0;
    if (u.auraBuildingDamagePct) u.auraBuildingDamagePct = 0;
  }

  // Pass 2: for each hero, walk allied units and apply effects.
  // The double-loop is O(H × U) where H ≤ 2 (max equipped) so the
  // overall cost is at most 2 × ~50 = 100 distance checks per tick.
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
      if (ally.id === hero.id) continue;
      if (ally.hp <= 0) continue;
      // Squared-distance check avoids a sqrt; both args are Fixed
      // so the comparison stays bit-exact.
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
          // perSec / 30 = per-tick HP credit, scaled into Fixed.
          // Compute as (perSec * FIXED_ONE) / 30 then floor — but
          // we're already in Fixed land via fromInt so just divide.
          const perTick = (mul(fromInt(aura.perSec), fromInt(1)) / TICKS_PER_SEC) | 0;
          ally.hp = ally.hp + perTick;
          if (ally.hp > ally.hpMax) ally.hp = ally.hpMax;
          break;
        }
        case 'hpBonus': {
          // One-shot: bump hpMax + heal the same amount the first
          // tick we see this ally close to this hero. Track the
          // applied bonus on the unit so we don't re-apply each
          // tick. Empty default = not yet applied.
          const cur = ally.auraHpBonusApplied ?? 0;
          if (cur < aura.pct) {
            const delta = aura.pct - cur;
            const bonus = (mul(ally.hpMax, fromInt(delta)) / 100) | 0;
            ally.hpMax = ally.hpMax + bonus;
            ally.hp = ally.hp + bonus;
            ally.auraHpBonusApplied = aura.pct;
          }
          break;
        }
      }
    }
  }
}
