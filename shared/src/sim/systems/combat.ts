import { abs, add, sub, mul, div, dist2, fromInt, fromFloat } from '../fixed.js';
import type { Fixed } from '../fixed.js';
import { BUILDING_STATS, BUILDING_BEHAVIOR, UNIT_STATS, UNIT_BEHAVIOR } from '../stats.js';
import { HERO_STATS_FIXED } from '../heroStats.js';
import { levelStatPercent } from '../progression.js';
import type { SimState, SimBuilding } from '../state.js';
import type { Unit, UnitKind, UnitStats } from '../../types/units.js';

// Stats lookup that handles both regular swarm units and heroes.
// Heroes carry a heroKind tag and use HERO_STATS_FIXED instead of
// UNIT_STATS[kind] so their HP / damage / range / cooldown reflect
// the hero catalog. PR D introduced heroes; combat reads through
// this helper everywhere it previously read UNIT_STATS[u.kind] so
// the same combat loop works for both populations.
function unitStatsFor(u: Unit): UnitStats {
  if (u.heroKind) return HERO_STATS_FIXED[u.heroKind];
  return UNIT_STATS[u.kind];
}

// Apply the hero attack-speed aura to a freshly-set cooldown. The
// aura field is a percent (e.g. 25) — divide cooldown by
// (100 + pct) / 100 ⇔ multiply by 100 / (100 + pct). Done in
// integer math (no Fixed) since attackCooldown is plain ticks.
function applyAttackSpeedBuff(baseTicks: number, pct: number): number {
  if (!pct || pct <= 0) return baseTicks;
  const scaled = (baseTicks * 100) / (100 + pct);
  // Floor at 1 tick so a 100% buff doesn't deadlock the loop on a
  // zero cooldown.
  return Math.max(1, Math.floor(scaled));
}

// Combat system — resolves unit↔building, building↔unit, and
// defender-unit↔attacker-unit attacks. Runs after pheromoneFollow so
// targeting is up to date.
//
// Beyond the MVP plain-damage loop, this module now handles the
// expanded defensive roster: splash (AcidSpitter), anti-air
// (SporeTower), stealth reveal (HiddenStinger), one-shot traps
// (RootSnare), periodic spawns (SpiderNest → NestSpider), and the
// corresponding attacker gimmicks (FireAnt burn DoT, Termite vs-
// building bonus, Scarab death-spawn, ThornHedge burn reflect).
// Every branch is gated on BUILDING_BEHAVIOR / UNIT_BEHAVIOR so
// existing kinds keep their original behaviour — no numeric drift.

// Integer-only stat scaling (matches applyDeploy). Applied to attacker-
// owned units' attack damage so upgrades hit harder as levels rise.
// The level-percent table lives in progression.ts.
function scaleFixedByPercent(value: Fixed, percent: number): Fixed {
  return (mul(value, fromInt(percent)) / 100) | 0;
}

// Building center in Fixed tile coords. Hot-path helper, pulled out so
// the three combat loops don't each re-derive it.
function buildingCenterX(b: SimBuilding): Fixed {
  return add(fromInt(b.anchorX), fromInt(b.w) >> 1);
}
function buildingCenterY(b: SimBuilding): Fixed {
  return add(fromInt(b.anchorY), fromInt(b.h) >> 1);
}

// Per-kill cross-layer combo bonus. A unit that spawned on layer X
// and killed a building on layer Y (where X !== Y, AND the building
// isn't a layer-spanning structure like the queen) earns a flat
// sugar bonus on top of the normal drop. Reads `spawnLayer`
// (recorded by deploy.ts at unit-creation time) so the comparison is
// robust to the dig modifier or a forceLayerSwap trapdoor flipping
// `u.layer` mid-raid. The base drop is unchanged so existing balance
// is intact; this is purely additive on the cross-layer combo.
const CROSS_LAYER_KILL_SUGAR_BONUS = 40;

function applyCrossLayerKillBonus(
  state: SimState,
  killer: Unit,
  building: SimBuilding,
): void {
  const spawn = killer.spawnLayer ?? killer.layer;
  if (spawn === building.layer) return;
  // Layer-spanning buildings (queen, anything with spans) are
  // available from either side, so a kill there isn't a real
  // "swarm went underground to crack this" play. Skip.
  if (building.spans && building.spans.length >= 2) return;
  state.attackerSugarLooted += CROSS_LAYER_KILL_SUGAR_BONUS;
  state.attackerCrossLayerKills = (state.attackerCrossLayerKills ?? 0) + 1;
}

// Building is targetable by attacker-owned units iff it exists, has hp,
// AND either isn't stealth or has already revealed. Stealth buildings
// stay invisible to target acquisition until the reveal latches.
function attackerCanSee(b: SimBuilding): boolean {
  if (b.hp <= 0) return false;
  const beh = BUILDING_BEHAVIOR[b.kind];
  if (beh?.stealth && !b.revealed) return false;
  return true;
}

export function combatSystem(
  state: SimState,
  attackerUnitLevels?: Partial<Record<UnitKind, number>>,
): void {
  // -------------------------------------------------------------------
  // Pre-pass: building burn DoT (FireAnt). Separate from the unit pass
  // because burn targets are buildings, not units.
  // -------------------------------------------------------------------
  for (let j = 0; j < state.buildings.length; j++) {
    const b = state.buildings[j]!;
    if (b.hp <= 0) continue;
    if (b.burnTicks && b.burnTicks > 0 && b.burnDamagePerTick) {
      b.hp = sub(b.hp, b.burnDamagePerTick);
      b.burnTicks--;
      if (b.burnTicks <= 0) b.burnDamagePerTick = 0;
      if (b.hp <= 0) {
        b.hp = 0;
        const bstats = BUILDING_STATS[b.kind];
        state.attackerSugarLooted += bstats.dropsSugarOnDestroy;
        state.attackerLeafBitsLooted += bstats.dropsLeafBitsOnDestroy;
        state.buildingsDestroyedThisTick = (state.buildingsDestroyedThisTick ?? 0) + 1;
      }
    }
  }

  // -------------------------------------------------------------------
  // Pre-pass: per-unit tick-based effects.
  //   - Burn DoT ticks down, drips burnDamagePerTick.
  //   - Root ticks down (clamps speed in pheromone_follow).
  //   - Lifespan ticks down (NestSpider auto-expires).
  // Kept in a single walk so we touch each unit once.
  // -------------------------------------------------------------------
  for (let i = 0; i < state.units.length; i++) {
    const u = state.units[i]!;
    if (u.hp <= 0) continue;
    if (u.burnTicks && u.burnTicks > 0 && u.burnDamagePerTick) {
      u.hp = sub(u.hp, u.burnDamagePerTick);
      if (u.hp < 0) u.hp = 0;
      u.burnTicks--;
      if (u.burnTicks <= 0) {
        u.burnDamagePerTick = 0;
      }
    }
    if (u.rootedTicks && u.rootedTicks > 0) {
      u.rootedTicks--;
    }
    if (u.ambushTicks && u.ambushTicks > 0) {
      u.ambushTicks--;
    }
    // Dig animation timer. While > 0 the unit is tunnelling at the
    // marker; pheromone_follow holds position and flips layer when
    // the counter hits 0. The countdown lives in combat.ts (not
    // pheromone_follow) so the same loop that decrements ambush
    // handles dig — keeps the timing pipeline obvious.
    if (u.diggingTicks && u.diggingTicks > 0) {
      u.diggingTicks--;
    }
    // Reuse pathProgress's sibling fields; lifespan expiry for
    // defender-side units (NestSpider) is handled in the SpiderNest
    // spawn loop below — they're tagged with `lifespanTicks` at spawn.
    const lifespan = (u as Unit & { lifespanTicks?: number }).lifespanTicks;
    if (lifespan !== undefined && lifespan > 0) {
      const next = lifespan - 1;
      (u as Unit & { lifespanTicks?: number }).lifespanTicks = next;
      if (next <= 0) u.hp = 0;
    }
  }

  // -------------------------------------------------------------------
  // 1. Attacker units → buildings.
  //
  // Includes the Termite vs-building multiplier, FireAnt burn
  // application, ThornHedge reflect-burn, and stealth-target filtering.
  // The attacker-vs-defender-unit branch is handled in (3) below.
  // -------------------------------------------------------------------
  for (let i = 0; i < state.units.length; i++) {
    const u = state.units[i]!;
    if (u.hp <= 0) continue;
    if (u.owner !== 0) continue; // attackers only; defenders handled in (3)
    if (u.attackCooldown > 0) u.attackCooldown--;
    if (u.targetBuildingId === 0) continue;

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
    // Defensive owner check. In raid mode, every building is owner=1
    // and every attacker is owner=0 so this is a no-op. In symmetric
    // arena (SimConfig.secondSnapshot) a stale targetBuildingId could
    // otherwise point at an ally building; drop and let pheromoneFollow
    // reacquire on the next tick.
    if (b.owner === u.owner) {
      u.targetBuildingId = 0;
      continue;
    }
    if (!attackerCanSee(b)) {
      // Target gone or still hidden — drop it, pheromoneFollow will
      // reacquire next tick.
      u.targetBuildingId = 0;
      continue;
    }
    const stats = unitStatsFor(u);
    const bx = buildingCenterX(b);
    const by = buildingCenterY(b);
    const d2: Fixed = dist2(u.x, u.y, bx, by);
    const rangeSq = mul(stats.attackRange, stats.attackRange);
    if (d2 > rangeSq) {
      // Move toward building (rooted units skip this step — they're
      // stuck until the root expires).
      if (u.rootedTicks && u.rootedTicks > 0) continue;
      const dx = sub(bx, u.x);
      const dy = sub(by, u.y);
      const adx = abs(dx);
      const ady = abs(dy);
      const cheb = adx > ady ? adx : ady;
      if (cheb > 0) {
        const step = stats.speed;
        const rx = div(dx, cheb);
        const ry = div(dy, cheb);
        u.x = add(u.x, mul(rx, step));
        u.y = add(u.y, mul(ry, step));
      }
      continue;
    }
    if (u.attackCooldown === 0) {
      const pct = levelStatPercent(attackerUnitLevels?.[u.kind]);
      let dmg = scaleFixedByPercent(stats.attackDamage, pct);
      // Termite: anti-building multiplier stacks on top of level scaling.
      const ub = UNIT_BEHAVIOR[u.kind];
      if (ub?.vsBuildingPercent) {
        dmg = scaleFixedByPercent(dmg, ub.vsBuildingPercent);
      }
      // Hero buildingDamage aura — applies only to building hits, so
      // it lives here rather than in unitStatsFor. StagBeetle's +20%
      // is the canonical case.
      if (u.auraBuildingDamagePct && u.auraBuildingDamagePct > 0) {
        dmg = scaleFixedByPercent(dmg, 100 + u.auraBuildingDamagePct);
      }
      b.hp = sub(b.hp, dmg);
      u.attackCooldown = applyAttackSpeedBuff(
        stats.attackCooldownTicks,
        u.auraAttackSpeedPct ?? 0,
      );

      // FireAnt burn: lay a DoT on the building. Subsequent hits re-up
      // the burn (take the max of current + new so stacks don't fall
      // off mid-rotation). Building-burn ticks down in the pre-pass.
      if (ub?.burnTicks && ub.burnDamagePerTick) {
        b.burnTicks = Math.max(b.burnTicks ?? 0, ub.burnTicks);
        b.burnDamagePerTick = Math.max(b.burnDamagePerTick ?? 0, ub.burnDamagePerTick);
      }

      // ThornHedge: melee-contact reflect — the wall lays a burn back
      // onto the attacker. Only triggers when the unit is in melee
      // range (we're already in-range here) and is a real hit.
      const bb = BUILDING_BEHAVIOR[b.kind];
      if (bb?.reflectBurnTicks && bb.reflectBurnDamagePerTick) {
        u.burnTicks = Math.max(u.burnTicks ?? 0, bb.reflectBurnTicks);
        u.burnDamagePerTick = Math.max(
          u.burnDamagePerTick ?? 0,
          bb.reflectBurnDamagePerTick,
        );
      }
      if (b.hp <= 0) {
        b.hp = 0;
        const bstats = BUILDING_STATS[b.kind];
        state.attackerSugarLooted += bstats.dropsSugarOnDestroy;
        state.attackerLeafBitsLooted += bstats.dropsLeafBitsOnDestroy;
        state.buildingsDestroyedThisTick = (state.buildingsDestroyedThisTick ?? 0) + 1;
        // Cross-layer combo bonus — direct-kill path. The unit `u`
        // is the killer; if their spawn layer differs from the
        // building's layer (and the building isn't a layer-spanning
        // structure available from either side), award the bonus.
        applyCrossLayerKillBonus(state, u, b);
      }
    }
  }

  // -------------------------------------------------------------------
  // 1b. Attacker units → defender-side units (NestSpider).
  //
  // Runs after the building-attack pass so buildings stay the primary
  // target: an attacker that hit a building this tick has its cooldown
  // reset and won't engage a defender until next tick. Attackers that
  // DIDN'T find or reach a building this tick (cooldown still 0) will
  // swing at any defender unit inside their melee range. This makes
  // NestSpider actually killable and lights up FireAnt burn / Termite
  // behaviours on defender units.
  // -------------------------------------------------------------------
  for (let i = 0; i < state.units.length; i++) {
    const u = state.units[i]!;
    if (u.hp <= 0 || u.attackCooldown > 0) continue;
    const stats = unitStatsFor(u);
    const rangeSq = mul(stats.attackRange, stats.attackRange);
    let bestIdx = -1;
    let bestD2: Fixed = rangeSq + 1;
    for (let k = 0; k < state.units.length; k++) {
      const t = state.units[k]!;
      // Same-owner skip (was hardcoded `t.owner !== 1` paired with
      // outer `u.owner !== 0`). Owner-relative filter generalises to
      // arena where either side can have units of either owner.
      if (t.hp <= 0 || t.owner === u.owner) continue;
      if (t.layer !== u.layer) continue;
      const d2 = dist2(u.x, u.y, t.x, t.y);
      if (d2 <= rangeSq && d2 < bestD2) {
        bestD2 = d2;
        bestIdx = k;
      }
    }
    if (bestIdx < 0) continue;
    const target = state.units[bestIdx]!;
    const pct = levelStatPercent(attackerUnitLevels?.[u.kind]);
    const dmg = scaleFixedByPercent(stats.attackDamage, pct);
    target.hp = sub(target.hp, dmg);
    if (target.hp < 0) target.hp = 0;
    u.attackCooldown = applyAttackSpeedBuff(
      stats.attackCooldownTicks,
      u.auraAttackSpeedPct ?? 0,
    );
    // FireAnt-style burn applied to defender units. Building-side burn
    // lives above in loop 1; this is the unit-side branch that makes
    // FireAnt genuinely useful against a NestSpider swarm.
    const ub = UNIT_BEHAVIOR[u.kind];
    if (ub?.burnTicks && ub.burnDamagePerTick) {
      target.burnTicks = Math.max(target.burnTicks ?? 0, ub.burnTicks);
      target.burnDamagePerTick = Math.max(
        target.burnDamagePerTick ?? 0,
        ub.burnDamagePerTick,
      );
    }
  }

  // -------------------------------------------------------------------
  // 2. Buildings → attacker units.
  //
  // Adds antiAirOnly filter (SporeTower), splash radius (AcidSpitter),
  // HiddenStinger reveal, and RootSnare single-shot root+damage.
  // -------------------------------------------------------------------
  for (let j = 0; j < state.buildings.length; j++) {
    const b = state.buildings[j]!;
    if (b.hp <= 0) continue;
    const bstats = BUILDING_STATS[b.kind];
    if (!bstats.canAttack) continue;
    const beh = BUILDING_BEHAVIOR[b.kind];

    if (b.attackCooldown > 0) {
      b.attackCooldown--;
      continue;
    }
    const bx = buildingCenterX(b);
    const by = buildingCenterY(b);
    // Player-authored AI boost: `extendAttackRange` buffs stack onto
    // the base range while the boost is active. Squaring once per
    // building keeps the hot-loop inner math identical.
    const effectiveRange =
      b.boostRangeAmount && b.boostRangeAmount > 0
        ? add(bstats.attackRange, b.boostRangeAmount)
        : bstats.attackRange;
    const rangeSq = mul(effectiveRange, effectiveRange);

    // Acquire nearest living attacker within range. Respect antiAirOnly
    // and layer reachability. For stealth buildings we use the same
    // acquisition (they see attackers just fine; it's attackers that
    // can't see them).
    let bestIdx = -1;
    let bestD2: Fixed = rangeSq + 1;
    for (let i = 0; i < state.units.length; i++) {
      const u = state.units[i]!;
      if (u.hp <= 0) continue;
      // Owner filter: a building only fires on units of the OPPOSING
      // owner. In raid mode (all buildings owner=1) this is identical
      // to the previous `u.owner !== 0` hardcode. Symmetric arena
      // makes both sides authoritative without a second branch.
      if (u.owner === b.owner) continue;
      if (beh?.antiAirOnly && !unitStatsFor(u).canFly) continue;
      const reachable =
        u.layer === b.layer || (b.spans && b.spans.includes(u.layer));
      if (!reachable) continue;
      const d2 = dist2(u.x, u.y, bx, by);
      if (d2 <= rangeSq && d2 < bestD2) {
        bestD2 = d2;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) continue;

    // Reveal a hidden building the tick it first acquires a target.
    if (beh?.stealth && !b.revealed) {
      b.revealed = true;
    }

    const primary = state.units[bestIdx]!;

    // Player-authored AI `boostAttackDamage` multiplies the base
    // damage value. Stored as integer percent (150 = 1.5×); applied
    // through the same scaleFixedByPercent helper unit-side uses so
    // the rounding is identical.
    const effectiveDamage =
      b.boostDamagePercent && b.boostDamagePercent > 0
        ? scaleFixedByPercent(bstats.attackDamage, b.boostDamagePercent)
        : bstats.attackDamage;

    // Single-target damage (or splash center).
    primary.hp = sub(primary.hp, effectiveDamage);
    if (primary.hp < 0) primary.hp = 0;

    // Splash: additional units inside splashRadius of the primary.
    if (beh?.splashRadius && beh.splashRadius > 0) {
      const splashSq = mul(beh.splashRadius, beh.splashRadius);
      for (let i = 0; i < state.units.length; i++) {
        if (i === bestIdx) continue;
        const u = state.units[i]!;
        // Owner filter is RELATIVE to the firing building so splash
        // doesn't friendly-fire allies and works for both sides in
        // symmetric arena. Hardcoded `u.owner !== 0` would let an
        // owner=0 splash damage its own owner=0 units.
        if (u.hp <= 0 || u.owner === b.owner) continue;
        // Splash still respects antiAir (spit only catches flyers
        // for SporeTower + splash variant; AcidSpitter has no
        // antiAirOnly, so this just stays permissive).
        if (beh.antiAirOnly && !unitStatsFor(u).canFly) continue;
        const d2 = dist2(u.x, u.y, primary.x, primary.y);
        if (d2 <= splashSq) {
          u.hp = sub(u.hp, effectiveDamage);
          if (u.hp < 0) u.hp = 0;
        }
      }
    }

    // RootSnare: trap root + one-shot self-destruct.
    if (beh?.rootTicks) {
      primary.rootedTicks = Math.max(primary.rootedTicks ?? 0, beh.rootTicks);
    }
    if (beh?.singleUse) {
      b.triggered = true;
      b.hp = 0;
      // Don't credit loot drop — traps are a defender asset, not loot.
    }

    // Player-authored AI `boostAttackRate` divides the base cooldown
    // for the duration of the boost — faster reload. Clamp to 1 so a
    // divisor of e.g. 2 on a cooldown of 1 doesn't pin at 0 and fire
    // every tick forever.
    const cdDivisor = b.boostRateDivisor && b.boostRateDivisor > 1
      ? b.boostRateDivisor
      : 1;
    b.attackCooldown = Math.max(1, (bstats.attackCooldownTicks / cdDivisor) | 0);
  }

  // -------------------------------------------------------------------
  // 3. Defender-side units (NestSpider) → attacker units.
  //
  // Simple AI: acquire nearest attacker on same/reachable layer, move
  // in via Chebyshev-normalized step, attack when in range.
  // -------------------------------------------------------------------
  for (let i = 0; i < state.units.length; i++) {
    const u = state.units[i]!;
    if (u.hp <= 0) continue;
    if (u.owner !== 1) continue;
    if (u.attackCooldown > 0) u.attackCooldown--;

    const stats = unitStatsFor(u);
    // Find nearest attacker on same layer.
    let bestIdx = -1;
    let bestD2: Fixed = fromInt(9999);
    for (let k = 0; k < state.units.length; k++) {
      if (k === i) continue;
      const t = state.units[k]!;
      if (t.hp <= 0 || t.owner !== 0) continue;
      if (t.layer !== u.layer) continue;
      const d2 = dist2(u.x, u.y, t.x, t.y);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestIdx = k;
      }
    }
    if (bestIdx < 0) continue;
    const target = state.units[bestIdx]!;
    const rangeSq = mul(stats.attackRange, stats.attackRange);
    if (bestD2 > rangeSq) {
      if (u.rootedTicks && u.rootedTicks > 0) continue;
      const dx = sub(target.x, u.x);
      const dy = sub(target.y, u.y);
      const adx = abs(dx);
      const ady = abs(dy);
      const cheb = adx > ady ? adx : ady;
      if (cheb > 0) {
        const step = stats.speed;
        const rx = div(dx, cheb);
        const ry = div(dy, cheb);
        u.x = add(u.x, mul(rx, step));
        u.y = add(u.y, mul(ry, step));
      }
      continue;
    }
    if (u.attackCooldown === 0) {
      target.hp = sub(target.hp, stats.attackDamage);
      if (target.hp < 0) target.hp = 0;
      u.attackCooldown = stats.attackCooldownTicks;
    }
  }

  // -------------------------------------------------------------------
  // 4. SpiderNest periodic spawns.
  //
  // Each tick while a raid is live, tick every nest's spawn cooldown;
  // when it hits 0, spawn a defender if alive count < max.
  //
  // Single pre-pass over units computes both (a) whether any attacker
  // is alive AND (b) per-kind alive counts for defender-side units.
  // This keeps the whole nest branch O(U + B) instead of O(U × B):
  // a previous revision re-scanned state.units inside each nest loop.
  // -------------------------------------------------------------------
  // Per-owner alive counts. In raid mode (owner=0 attackers, owner=1
  // defenders) `liveByOwner[0]` is the original `anyLiveAttacker`
  // boolean as a count, and `aliveByOwnerKind[1][kind]` is the
  // original defender bucket. Generalising to per-owner keeps the
  // SpiderNest spawn loop's "is there an enemy on the field?" + "do I
  // already have N spawned units alive?" checks correct in symmetric
  // arena, where either side can host nests.
  const liveByOwner: [number, number] = [0, 0];
  const aliveByOwnerKind: [Partial<Record<UnitKind, number>>, Partial<Record<UnitKind, number>>] = [{}, {}];
  for (let i = 0; i < state.units.length; i++) {
    const u = state.units[i]!;
    if (u.hp <= 0) continue;
    liveByOwner[u.owner]++;
    const bucket = aliveByOwnerKind[u.owner];
    bucket[u.kind] = (bucket[u.kind] ?? 0) + 1;
  }
  // Only spawn while an enemy is in play — avoids the nest quietly
  // producing free defenders during the lull between deploy waves when
  // no enemy units exist yet. "Enemy" is owner-relative so a symmetric
  // arena nest on either side fires correctly.
  // We unconditionally enter the loop and gate per-nest on
  // `liveByOwner[1 - b.owner] > 0` so a single base with no enemies
  // (the pre-deploy phase) keeps the original "preload" guard.
  for (let j = 0; j < state.buildings.length; j++) {
    const b = state.buildings[j]!;
    if (b.hp <= 0) continue;
    const beh = BUILDING_BEHAVIOR[b.kind];
    if (!beh?.spawnIntervalTicks || !beh.spawnKind) continue;
    if (liveByOwner[1 - b.owner] === 0) continue;

    if (b.spawnCooldown === undefined) b.spawnCooldown = 0;
    if (b.spawnCooldown > 0) {
      b.spawnCooldown--;
      continue;
    }

    // Player-authored AI `extraSpawn` effect: if this nest has
    // banked bonus spawns, allow alive-count to temporarily exceed
    // maxAlive by consuming one. This is what makes "on low hp,
    // spit out one more defender" rules actually matter in the
    // fight. bonus spawns do NOT re-arm the spawn cooldown — they
    // fire immediately and exit.
    const maxAlive = beh.spawnMaxAlive ?? 999;
    const aliveCount = aliveByOwnerKind[b.owner][beh.spawnKind] ?? 0;
    const bonus = b.bonusSpawnsRemaining ?? 0;
    if (aliveCount >= maxAlive && bonus <= 0) {
      // Don't reset cooldown — we'll retry every tick until a defender
      // dies, which matches CoC-style clan castle urgency.
      continue;
    }
    if (bonus > 0) {
      b.bonusSpawnsRemaining = bonus - 1;
    }

    // Stagger successive spawns on x so multiple defenders from the
    // same nest don't pixel-stack (hurts visual read AND pointer hit
    // detection for any click-to-inspect UI). Deterministic offset
    // based on the current alive count + max-alive keeps replays
    // bit-identical.
    const spawnStats = UNIT_STATS[beh.spawnKind];
    const spacing = fromFloat(0.25);
    const offsetSlot = aliveCount - ((maxAlive - 1) >> 1);
    const offset: Fixed = mul(fromInt(offsetSlot), spacing);
    const spawnX = add(buildingCenterX(b), offset);
    const spawnY = buildingCenterY(b);
    const newUnit: Unit & { lifespanTicks?: number } = {
      id: state.nextUnitId++,
      kind: beh.spawnKind,
      // Defender spawn inherits the nest's owner so symmetric arena
      // produces NestSpiders on the right side for an owner=1 nest
      // and on the left for an owner=0 nest. Raid mode (only owner=1
      // nests exist) preserves the original `owner: 1` behavior.
      owner: b.owner,
      layer: b.layer,
      x: spawnX,
      y: spawnY,
      hp: spawnStats.hpMax,
      hpMax: spawnStats.hpMax,
      pathId: -1,
      pathProgress: 0,
      attackCooldown: 0,
      targetBuildingId: 0,
    };
    if (beh.spawnLifetimeTicks) {
      newUnit.lifespanTicks = beh.spawnLifetimeTicks;
    }
    state.units.push(newUnit);
    // Reflect the new defender in the cached count so two nests
    // spawning in the same tick respect each other's max-alive gate.
    aliveByOwnerKind[b.owner][beh.spawnKind] = aliveCount + 1;
    b.spawnCooldown = beh.spawnIntervalTicks;
  }

  // -------------------------------------------------------------------
  // 5. Death-spawn: Scarab → MiniScarabs.
  //
  // Iterate units that died this tick (hp <= 0) and whose kind has
  // UNIT_BEHAVIOR.deathSpawnKind. Spawn offspring at the parent's
  // position. step.ts culls the parent after combat returns, so
  // we need to tag the parent so we don't double-spawn if cull is
  // skipped for some reason. A `deathSpawned` transient flag does
  // the job.
  // -------------------------------------------------------------------
  const initialUnitCount = state.units.length;
  for (let i = 0; i < initialUnitCount; i++) {
    const u = state.units[i] as Unit & { deathSpawned?: boolean };
    if (u.hp > 0) continue;
    if (u.deathSpawned) continue;
    const beh = UNIT_BEHAVIOR[u.kind];
    if (!beh?.deathSpawnKind || !beh.deathSpawnCount) continue;
    u.deathSpawned = true;
    const childStats = UNIT_STATS[beh.deathSpawnKind];
    const spacing = fromFloat(0.25);
    for (let k = 0; k < beh.deathSpawnCount; k++) {
      // Fan out slightly on x so multiple siblings aren't stacked.
      const offset: Fixed = mul(fromInt(k - ((beh.deathSpawnCount - 1) >> 1)), spacing);
      state.units.push({
        id: state.nextUnitId++,
        kind: beh.deathSpawnKind,
        owner: u.owner,
        layer: u.layer,
        x: add(u.x, offset),
        y: u.y,
        hp: childStats.hpMax,
        hpMax: childStats.hpMax,
        pathId: -1,
        pathProgress: 0,
        attackCooldown: 0,
        // Offspring auto-acquire via pheromoneFollow's end-of-path
        // branch (pathId === -1) on the next tick.
        targetBuildingId: 0,
      });
    }
  }
}
