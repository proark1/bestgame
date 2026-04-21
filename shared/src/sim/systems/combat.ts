import { abs, add, sub, mul, div, dist2, fromInt } from '../fixed.js';
import type { Fixed } from '../fixed.js';
import { BUILDING_STATS, UNIT_STATS } from '../stats.js';
import type { SimState } from '../state.js';

// Combat system — resolves unit↔building and building↔unit attacks.
// Runs after pheromoneFollow so targeting is up to date.
//
// Kept intentionally simple for the MVP: no splash damage, no projectiles
// (hits resolve instantly), no healing. Add in week 2 once determinism gate
// is stable.

export function combatSystem(state: SimState): void {
  // Unit attacks building.
  for (let i = 0; i < state.units.length; i++) {
    const u = state.units[i]!;
    if (u.hp <= 0) continue;
    if (u.attackCooldown > 0) u.attackCooldown--;
    if (u.targetBuildingId === 0) continue;

    // Find target building by id. Buildings are few (~10) so linear scan
    // is cheap and avoids Map iteration-order concerns.
    let targetIdx = -1;
    for (let j = 0; j < state.buildings.length; j++) {
      if (state.buildings[j]!.id === u.targetBuildingId) {
        targetIdx = j;
        break;
      }
    }
    if (targetIdx < 0) {
      u.targetBuildingId = 0;
      continue;
    }
    const b = state.buildings[targetIdx]!;
    if (b.hp <= 0) {
      u.targetBuildingId = 0;
      continue;
    }
    const stats = UNIT_STATS[u.kind];
    // Building center: anchor + footprint/2. Using `>> 1` on the Fixed
    // footprint width keeps this in integer math; plain `/ 2` would lean
    // on the FPU and drift across engines.
    const bx = add(fromInt(b.anchorX), fromInt(b.w) >> 1);
    const by = add(fromInt(b.anchorY), fromInt(b.h) >> 1);
    const d2: Fixed = dist2(u.x, u.y, bx, by);
    const rangeSq = mul(stats.attackRange, stats.attackRange);
    if (d2 > rangeSq) {
      // Move toward building — simple linear approach, no pathfinding.
      // Avoid sqrt in the hot path: normalize via Chebyshev distance
      // (the larger of |dx|, |dy|) and scale step by the component ratios.
      // Crucially, use Fixed mul/div — a plain `dx * step` would overflow
      // int32 and break determinism.
      const dx = sub(bx, u.x);
      const dy = sub(by, u.y);
      const adx = abs(dx);
      const ady = abs(dy);
      const cheb = adx > ady ? adx : ady;
      if (cheb > 0) {
        const step = stats.speed;
        const rx = div(dx, cheb); // Fixed ratio in [-FIXED_ONE, FIXED_ONE]
        const ry = div(dy, cheb);
        u.x = add(u.x, mul(rx, step));
        u.y = add(u.y, mul(ry, step));
      }
      continue;
    }
    // In range — attack.
    if (u.attackCooldown === 0) {
      b.hp = sub(b.hp, stats.attackDamage);
      u.attackCooldown = stats.attackCooldownTicks;
      if (b.hp <= 0) {
        b.hp = 0;
        // Drop loot to attacker.
        const bstats = BUILDING_STATS[b.kind];
        state.attackerSugarLooted += bstats.dropsSugarOnDestroy;
        state.attackerLeafBitsLooted += bstats.dropsLeafBitsOnDestroy;
      }
    }
  }

  // Building attacks unit.
  for (let j = 0; j < state.buildings.length; j++) {
    const b = state.buildings[j]!;
    if (b.hp <= 0) continue;
    const bstats = BUILDING_STATS[b.kind];
    if (!bstats.canAttack) continue;
    if (b.attackCooldown > 0) {
      b.attackCooldown--;
      continue;
    }
    // Acquire nearest living attacker unit within range and same layer.
    const bx = add(fromInt(b.anchorX), fromInt(b.w) >> 1);
    const by = add(fromInt(b.anchorY), fromInt(b.h) >> 1);
    const rangeSq = mul(bstats.attackRange, bstats.attackRange);
    let bestIdx = -1;
    let bestD2: Fixed = rangeSq + 1;
    for (let i = 0; i < state.units.length; i++) {
      const u = state.units[i]!;
      if (u.hp <= 0) continue;
      if (u.owner !== 0) continue;
      const reachable =
        u.layer === b.layer || (b.spans && b.spans.includes(u.layer));
      if (!reachable) continue;
      const d2 = dist2(u.x, u.y, bx, by);
      if (d2 <= rangeSq && d2 < bestD2) {
        bestD2 = d2;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const target = state.units[bestIdx]!;
      target.hp = sub(target.hp, bstats.attackDamage);
      if (target.hp < 0) target.hp = 0;
      b.attackCooldown = bstats.attackCooldownTicks;
    }
  }
}
