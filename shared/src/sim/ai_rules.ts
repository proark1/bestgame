import { add, dist2, div, fromFloat, fromInt, mul, sub } from './fixed.js';
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
  // Cross-layer buildings (spans !== null) appear in `state.buildings`
  // once per layer, all sharing the same id. We only fire each id's
  // rule list ONCE per tick — otherwise a trapdoor that spans both
  // layers would fire twice and undo its own forceLayerSwap.
  const bs = state.buildings;
  let lastFiredId = 0;
  for (let j = 0; j < bs.length; j++) {
    const b = bs[j]!;
    if (b.hp <= 0 || !b.rules) continue;
    if (b.id === lastFiredId) continue; // already fired this id (layer twin)
    lastFiredId = b.id;
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
    case 'onCrossLayerEntry':
      return hasLayerCrosserInRange(state, b, fromFloat(p.radius ?? 2));
    case 'onPathNearby':
      return hasPathNearby(state, b, fromFloat(p.radius ?? 2));
  }
}

// Geometry-aware path detection — true if any active pheromone path
// passes within `radius` of the building's center. We test each
// segment of every path against the building tile, so the rule fires
// the moment the player commits the path (not when units arrive).
// Same-layer constraint: a surface trap shouldn't react to an
// underground path; spanning buildings ignore the layer check.
//
// Squared distances throughout — Fixed division is expensive and the
// existing trigger helpers (hasAttackerInRange) use the same trick.
function hasPathNearby(
  state: SimState,
  b: SimBuilding,
  radius: Fixed,
): boolean {
  if (state.paths.length === 0) return false;
  const bx = add(fromInt(b.anchorX), fromInt(b.w) >> 1);
  const by = add(fromInt(b.anchorY), fromInt(b.h) >> 1);
  const r2 = mul(radius, radius);
  const buildingSpans = b.spans && b.spans.length >= 2;
  for (let pi = 0; pi < state.paths.length; pi++) {
    const path = state.paths[pi]!;
    // Same-layer (or spanning) gate. The path's spawnLayer is the
    // layer its units start on; this is a per-path constant for
    // v1, even though units carrying the dig modifier flip
    // mid-walk. Reading spawnLayer here is correct — we react to
    // the PLAN, and the plan's spawn intent is what's visible to
    // the defender at draw time.
    if (!buildingSpans && path.spawnLayer !== b.layer) continue;
    const pts = path.points;
    if (pts.length < 2) continue;
    for (let k = 0; k < pts.length - 1; k++) {
      if (segmentDistSquared(bx, by, pts[k]!.x, pts[k]!.y, pts[k + 1]!.x, pts[k + 1]!.y) <= r2) {
        return true;
      }
    }
  }
  return false;
}

// Squared distance from point (px, py) to the segment (ax, ay)-(bx2,
// by2). All Fixed; inlined to avoid a hot-path closure allocation.
// Standard projection-clamp algorithm: parametrise the segment as
// (a + t·(b-a)) for t ∈ [0,1], project the point, clamp t, return the
// squared distance to the clamped foot. Determinism: integer-only
// (Fixed mul/div), no float drift.
function segmentDistSquared(
  px: Fixed, py: Fixed,
  ax: Fixed, ay: Fixed,
  bx2: Fixed, by2: Fixed,
): Fixed {
  const ABx = sub(bx2, ax);
  const ABy = sub(by2, ay);
  const APx = sub(px, ax);
  const APy = sub(py, ay);
  const ab2 = add(mul(ABx, ABx), mul(ABy, ABy));
  if (ab2 === 0) {
    // Degenerate segment — distance to either endpoint.
    return add(mul(APx, APx), mul(APy, APy));
  }
  // t = clamp((AP · AB) / |AB|², 0, 1) — both numerator and ab2 are
  // Fixed-encoded squared values, so the ratio is unit-less; we use
  // div() which keeps the Fixed encoding (`a << 16 / b`).
  const tNumer = add(mul(APx, ABx), mul(APy, ABy));
  let t: Fixed;
  if (tNumer <= 0) t = 0;
  else if (tNumer >= ab2) t = (1 << 16);
  else t = div(tNumer, ab2);
  const fx = add(ax, mul(ABx, t));
  const fy = add(ay, mul(ABy, t));
  const dx = sub(px, fx);
  const dy = sub(py, fy);
  return add(mul(dx, dx), mul(dy, dy));
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

// Rising-edge layer detection — true if any attacker that flipped
// layers this tick sits within `radius` of the building. The tick
// flag is cleared at the top of pheromone_follow on the next tick,
// so reading it here in the AI pass (which runs *after*
// pheromone_follow within the same tick) yields a fresh signal.
function hasLayerCrosserInRange(
  state: SimState,
  b: SimBuilding,
  radius: Fixed,
): boolean {
  const bx = add(fromInt(b.anchorX), fromInt(b.w) >> 1);
  const by = add(fromInt(b.anchorY), fromInt(b.h) >> 1);
  const r2 = mul(radius, radius);
  for (let i = 0; i < state.units.length; i++) {
    const u = state.units[i]!;
    if (u.hp <= 0 || u.owner !== 0) continue;
    if (!u.layerCrossedThisTick) continue;
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
    case 'forceLayerSwap': {
      applyForceLayerSwap(state, b, fromFloat(p.radius ?? 2));
      break;
    }
  }
}

// Trapdoor — flip the layer of every attacker within radius. Iterated
// in id order for determinism. Only applied to units that can dig
// (canDig=true), so this is the "you tried to dig past me, you got
// bounced" combo and not a free relocation of every attacker on the
// board. We also set layerCrossedThisTick so the kicked unit's own
// transition is observable by other onCrossLayerEntry rules — but we
// don't recurse: each rule fires at most once per tick per building.
function applyForceLayerSwap(
  state: SimState,
  b: SimBuilding,
  radius: Fixed,
): void {
  const bx = add(fromInt(b.anchorX), fromInt(b.w) >> 1);
  const by = add(fromInt(b.anchorY), fromInt(b.h) >> 1);
  const r2 = mul(radius, radius);
  for (let i = 0; i < state.units.length; i++) {
    const u = state.units[i]!;
    if (u.hp <= 0 || u.owner !== 0) continue;
    if (!UNIT_STATS[u.kind].canDig) continue;
    if (dist2(u.x, u.y, bx, by) > r2) continue;
    u.layer = u.layer === 0 ? 1 : 0;
    u.layerCrossedThisTick = true;
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
