import { abs, add, sub, mul, div, dist2, fromInt, fromFloat } from '../fixed.js';
import type { Fixed } from '../fixed.js';
import { BUILDING_STATS, BUILDING_BEHAVIOR, UNIT_STATS, UNIT_BEHAVIOR } from '../stats.js';
import { levelStatPercent } from '../progression.js';
import type { SimState, SimBuilding } from '../state.js';
import type { Unit, UnitKind } from '../../types/units.js';

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
    if (!attackerCanSee(b)) {
      // Target gone or still hidden — drop it, pheromoneFollow will
      // reacquire next tick.
      u.targetBuildingId = 0;
      continue;
    }
    const stats = UNIT_STATS[u.kind];
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
      b.hp = sub(b.hp, dmg);
      u.attackCooldown = stats.attackCooldownTicks;

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
      }
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
    const rangeSq = mul(bstats.attackRange, bstats.attackRange);

    // Acquire nearest living attacker within range. Respect antiAirOnly
    // and layer reachability. For stealth buildings we use the same
    // acquisition (they see attackers just fine; it's attackers that
    // can't see them).
    let bestIdx = -1;
    let bestD2: Fixed = rangeSq + 1;
    for (let i = 0; i < state.units.length; i++) {
      const u = state.units[i]!;
      if (u.hp <= 0) continue;
      if (u.owner !== 0) continue;
      if (beh?.antiAirOnly && !UNIT_STATS[u.kind].canFly) continue;
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

    // Single-target damage (or splash center).
    primary.hp = sub(primary.hp, bstats.attackDamage);
    if (primary.hp < 0) primary.hp = 0;

    // Splash: additional units inside splashRadius of the primary.
    if (beh?.splashRadius && beh.splashRadius > 0) {
      const splashSq = mul(beh.splashRadius, beh.splashRadius);
      for (let i = 0; i < state.units.length; i++) {
        if (i === bestIdx) continue;
        const u = state.units[i]!;
        if (u.hp <= 0 || u.owner !== 0) continue;
        // Splash still respects antiAir (spit only catches flyers
        // for SporeTower + splash variant; AcidSpitter has no
        // antiAirOnly, so this just stays permissive).
        if (beh.antiAirOnly && !UNIT_STATS[u.kind].canFly) continue;
        const d2 = dist2(u.x, u.y, primary.x, primary.y);
        if (d2 <= splashSq) {
          u.hp = sub(u.hp, bstats.attackDamage);
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

    b.attackCooldown = bstats.attackCooldownTicks;
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

    const stats = UNIT_STATS[u.kind];
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
  // -------------------------------------------------------------------
  let anyLiveAttacker = false;
  for (let i = 0; i < state.units.length; i++) {
    const u = state.units[i]!;
    if (u.hp > 0 && u.owner === 0) {
      anyLiveAttacker = true;
      break;
    }
  }
  // Only spawn while attackers are in play — avoids the nest quietly
  // producing free defenders during the lull between deploy waves when
  // no attackers exist yet. (Attacker-count is 0 until the first
  // deploy, so without this the nest would preload defenders.)
  if (anyLiveAttacker) {
    for (let j = 0; j < state.buildings.length; j++) {
      const b = state.buildings[j]!;
      if (b.hp <= 0) continue;
      const beh = BUILDING_BEHAVIOR[b.kind];
      if (!beh?.spawnIntervalTicks || !beh.spawnKind) continue;

      if (b.spawnCooldown === undefined) b.spawnCooldown = 0;
      if (b.spawnCooldown > 0) {
        b.spawnCooldown--;
        continue;
      }

      // Count alive defender units of this kind.
      const maxAlive = beh.spawnMaxAlive ?? 999;
      let aliveCount = 0;
      for (let i = 0; i < state.units.length; i++) {
        const u = state.units[i]!;
        if (u.hp > 0 && u.owner === 1 && u.kind === beh.spawnKind) {
          aliveCount++;
        }
      }
      if (aliveCount >= maxAlive) {
        // Don't reset cooldown — we'll retry every tick until a defender
        // dies, which matches CoC-style clan castle urgency.
        continue;
      }

      // Spawn at the nest's footprint center.
      const spawnX = buildingCenterX(b);
      const spawnY = buildingCenterY(b);
      const spawnStats = UNIT_STATS[beh.spawnKind];
      const newUnit: Unit & { lifespanTicks?: number } = {
        id: state.nextUnitId++,
        kind: beh.spawnKind,
        owner: 1,
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
      b.spawnCooldown = beh.spawnIntervalTicks;
    }
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
