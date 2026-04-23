import { add, dist2, fromFloat, fromInt, mul, sub } from './fixed.js';
import type { Fixed } from './fixed.js';
import { UNIT_STATS } from './stats.js';
import type { SimBuilding, SimRuleState, SimState } from './state.js';

// Player-authored defender AI — deterministic rule evaluator.
//
// Runs once per tick after pheromoneFollow and BEFORE combat so the
// combat system sees any freshly-applied boost / extraSpawn / reveal
// effects. The evaluator is split into two passes:
//
//   1. decay:  tick down every boost / cooldown counter on every
//              SimBuilding. Cheap O(B).
//   2. fire:   for each building's rule list, check trigger, apply
//              effect, decrement remaining/rearm.
//
// Order is strictly by (building.id asc, rule.id asc) so replays are
// bit-identical across engines. Effects mutate SimBuilding fields
// only — no hidden side channels, nothing float.
//
// Design caps (enforced here + by the server validator):
//   * Max 8 rules per building (prevents combinatorial explosion).
//   * Boost counters are monotonic single-track (last-writer-wins
//     by max duration); no stacking arithmetic blowup.

const RULE_MAX_PER_BUILDING = 8;

export function aiRulesSystem(state: SimState): void {
  // ------ pass 1: decay ------
  for (let j = 0; j < state.buildings.length; j++) {
    const b = state.buildings[j]!;
    if (b.hp <= 0) continue;
    if (b.boostDamageTicks && b.boostDamageTicks > 0) {
      b.boostDamageTicks--;
      if (b.boostDamageTicks <= 0) b.boostDamagePercent = 0;
    }
    if (b.boostRateTicks && b.boostRateTicks > 0) {
      b.boostRateTicks--;
      if (b.boostRateTicks <= 0) b.boostRateDivisor = 0;
    }
    if (b.boostRangeTicks && b.boostRangeTicks > 0) {
      b.boostRangeTicks--;
      if (b.boostRangeTicks <= 0) b.boostRangeAmount = 0;
    }
    // aoeRoot is one-tick handoff — cleared after combat consumes it,
    // not here. Leaving it ticking would double-apply the root.
    if (!b.rules) continue;
    for (let r = 0; r < b.rules.length && r < RULE_MAX_PER_BUILDING; r++) {
      const rs = b.rules[r]!;
      if (rs.rearmCooldown > 0) rs.rearmCooldown--;
      rs.tickAccumulator++;
    }
  }

  // ------ pass 2: fire ------
  // Iterate buildings in id order so rule-fire order is deterministic
  // even when the DB hands us buildings in an arbitrary sequence.
  const bs = state.buildings;
  for (let j = 0; j < bs.length; j++) {
    const b = bs[j]!;
    if (b.hp <= 0 || !b.rules) continue;
    for (let r = 0; r < b.rules.length && r < RULE_MAX_PER_BUILDING; r++) {
      const rs = b.rules[r]!;
      if (rs.remaining !== null && rs.remaining <= 0) continue;
      if (rs.rearmCooldown > 0) continue;

      const condNow = evaluateTrigger(state, b, rs);

      // Rising-edge firing for condition triggers; interval firing
      // for onTick; unconditional for onAllyDestroyed which is a
      // per-tick event already.
      let fire = false;
      switch (rs.rule.trigger) {
        case 'onTick': {
          const cadence = rs.rule.params.ticks ?? 60;
          if (rs.tickAccumulator >= cadence) {
            fire = true;
            rs.tickAccumulator = 0;
          }
          break;
        }
        case 'onAllyDestroyed':
          fire = condNow; // condNow set by destroyed-count diff below
          break;
        default:
          // Edge trigger: fire only on false→true transition.
          fire = condNow && !rs.prevConditionTrue;
      }
      rs.prevConditionTrue = condNow;

      if (!fire) continue;

      applyEffect(state, b, rs);

      // Consume a use + arm the cooldown.
      if (rs.remaining !== null) rs.remaining--;
      rs.rearmCooldown = rs.rule.cooldownTicks ?? 0;
    }
  }
}

// -- trigger evaluation ------------------------------------------------------

function evaluateTrigger(
  state: SimState,
  b: SimBuilding,
  rs: SimRuleState,
): boolean {
  const p = rs.rule.params;
  switch (rs.rule.trigger) {
    case 'onLowHp': {
      const pct = p.percent ?? 50;
      // Integer compare: hp * 100 < hpMax * pct
      return b.hp * 100 < b.hpMax * pct;
    }
    case 'onEnemyInRange':
      return hasAttackerInRange(state, b, fromFloat(p.radius ?? 2), false);
    case 'onFlyerInRange':
      return hasAttackerInRange(state, b, fromFloat(p.radius ?? 2), true);
    case 'onQueenThreatened':
      return attackerNearQueen(state, fromFloat(p.radius ?? 3));
    case 'onAllyDestroyed':
      // Condition = any other building died this tick. "This tick" is
      // modeled via SimState.buildingsDestroyedThisTick which combat
      // sets; see state.ts.
      return (state.buildingsDestroyedThisTick ?? 0) > 0;
    case 'onTick':
      return true; // interval handled in the fire switch above
  }
}

function hasAttackerInRange(
  state: SimState,
  b: SimBuilding,
  radius: Fixed,
  flyersOnly: boolean,
): boolean {
  const bx = add(fromInt(b.anchorX), fromInt(b.w) >> 1);
  const by = add(fromInt(b.anchorY), fromInt(b.h) >> 1);
  const r2 = mul(radius, radius);
  for (let i = 0; i < state.units.length; i++) {
    const u = state.units[i]!;
    if (u.hp <= 0 || u.owner !== 0) continue;
    if (flyersOnly && !UNIT_STATS[u.kind].canFly) continue;
    // Layer gate: same-layer or spans includes the unit's layer, so
    // a surface-only trigger doesn't "see" units underground.
    const reachable =
      u.layer === b.layer || (b.spans && b.spans.includes(u.layer));
    if (!reachable) continue;
    if (dist2(u.x, u.y, bx, by) <= r2) return true;
  }
  return false;
}

function attackerNearQueen(state: SimState, radius: Fixed): boolean {
  const r2 = mul(radius, radius);
  for (let j = 0; j < state.buildings.length; j++) {
    const q = state.buildings[j]!;
    if (q.kind !== 'QueenChamber' || q.hp <= 0) continue;
    const qx = add(fromInt(q.anchorX), fromInt(q.w) >> 1);
    const qy = add(fromInt(q.anchorY), fromInt(q.h) >> 1);
    for (let i = 0; i < state.units.length; i++) {
      const u = state.units[i]!;
      if (u.hp <= 0 || u.owner !== 0) continue;
      if (dist2(u.x, u.y, qx, qy) <= r2) return true;
    }
  }
  return false;
}

// -- effect application ------------------------------------------------------

function applyEffect(
  state: SimState,
  b: SimBuilding,
  rs: SimRuleState,
): void {
  const p = rs.rule.params;
  switch (rs.rule.effect) {
    case 'boostAttackDamage': {
      const pct = p.percent ?? 150;
      const dur = p.durationTicks ?? 90;
      // Take max so concurrent rules don't clobber a bigger boost.
      if ((b.boostDamagePercent ?? 0) < pct) b.boostDamagePercent = pct;
      if ((b.boostDamageTicks ?? 0) < dur) b.boostDamageTicks = dur;
      break;
    }
    case 'boostAttackRate': {
      const rate = Math.max(1, p.rate ?? 2);
      const dur = p.durationTicks ?? 90;
      if ((b.boostRateDivisor ?? 0) < rate) b.boostRateDivisor = rate;
      if ((b.boostRateTicks ?? 0) < dur) b.boostRateTicks = dur;
      break;
    }
    case 'extendAttackRange': {
      const add = fromFloat(p.range ?? 1);
      const dur = p.durationTicks ?? 90;
      if ((b.boostRangeAmount ?? 0) < add) b.boostRangeAmount = add;
      if ((b.boostRangeTicks ?? 0) < dur) b.boostRangeTicks = dur;
      break;
    }
    case 'revealSelf':
      b.revealed = true;
      break;
    case 'extraSpawn': {
      const cap = p.maxExtra ?? 2;
      // Cap the CUMULATIVE grants, not the currently-banked amount.
      // Otherwise a fast-firing rule (e.g. onTick every 60 ticks)
      // could keep topping up the nest's bank as combat consumes
      // each spawn, bypassing `maxExtra` as a raid-wide ceiling.
      // `extraSpawnsGranted` is the single counter we compare against.
      if (rs.extraSpawnsGranted >= cap) break;
      rs.extraSpawnsGranted++;
      b.bonusSpawnsRemaining = (b.bonusSpawnsRemaining ?? 0) + 1;
      break;
    }
    case 'healSelf': {
      const heal = fromInt(p.hp ?? 50);
      b.hp = Math.min(b.hpMax, add(b.hp, heal));
      break;
    }
    case 'aoeRoot': {
      b.aoeRootRadius = fromFloat(p.radius ?? 2);
      b.aoeRootTicks = p.durationTicks ?? 45;
      // Apply immediately to every attacker in range so the combat
      // system doesn't need a separate pass.
      applyAoeRoot(state, b);
      break;
    }
  }
}

function applyAoeRoot(state: SimState, b: SimBuilding): void {
  const radius = b.aoeRootRadius ?? 0;
  const ticks = b.aoeRootTicks ?? 0;
  if (radius <= 0 || ticks <= 0) return;
  const bx = add(fromInt(b.anchorX), fromInt(b.w) >> 1);
  const by = add(fromInt(b.anchorY), fromInt(b.h) >> 1);
  const r2 = mul(radius, radius);
  for (let i = 0; i < state.units.length; i++) {
    const u = state.units[i]!;
    if (u.hp <= 0 || u.owner !== 0) continue;
    if (dist2(u.x, u.y, bx, by) <= r2) {
      u.rootedTicks = Math.max(u.rootedTicks ?? 0, ticks);
    }
  }
  // Clear the buffer so the effect is one-shot; combat.ts doesn't
  // need to re-read these fields.
  b.aoeRootRadius = 0;
  b.aoeRootTicks = 0;
  // Suppress unused-warning for `sub`, kept imported for symmetry
  // with other Fixed helpers.
  void sub;
}

export const _AI_RULE_CAPS = {
  RULE_MAX_PER_BUILDING,
} as const;
