import type { Fixed } from './fixed.js';
import type { Base, BuildingAIRule, BuildingKind, Layer } from '../types/base.js';
import type { Unit } from '../types/units.js';
import type { PheromonePath } from '../types/pheromone.js';

// A building instance inside a running sim — copied from Base.buildings
// and mutated freely (hp drops, destroyed). Never writes back to the
// source Base (which is a frozen snapshot for replay fidelity).
export interface SimBuilding {
  id: number;
  kind: BuildingKind;
  layer: Layer;
  anchorX: number;
  anchorY: number;
  w: number;
  h: number;
  spans: Layer[] | null;
  hp: Fixed;
  hpMax: Fixed;
  level: number;
  attackCooldown: number;
  // HiddenStinger stealth state — set true the first tick an attacker
  // enters range. Once revealed, a stinger attacks at its fast cadence
  // until destroyed. Unused for other kinds.
  revealed?: boolean;
  // RootSnare single-shot latch — true once the trap has fired. The
  // building hp is zeroed at trigger time too; the flag is redundant
  // but makes intent obvious when reading combat code.
  triggered?: boolean;
  // SpiderNest spawn cadence — counts down each tick, spawns a
  // NestSpider defender when it hits 0, then resets.
  spawnCooldown?: number;
  // FireAnt burn — DoT remaining on this building. Damage-per-tick is
  // Fixed HP; ticks count down in combat.ts.
  burnTicks?: number;
  burnDamagePerTick?: Fixed;
  // Player-authored defender AI: rules and per-rule runtime state.
  // `rules` is a frozen copy of Building.aiRules (transformed to
  // SimRuleState by init.ts). Evaluated by ai_rules.ts each tick;
  // boost* fields feed the combat system when computing damage /
  // range / cooldown. Kept here (not in a side-table) so the sim
  // stays a single mutable structure for hashing.
  rules?: SimRuleState[];
  // Active effect buffers — all counted in sim ticks. Decremented in
  // the ai_rules pre-pass; consumed in combat.ts.
  boostDamagePercent?: number;   // e.g. 150 = +50% damage
  boostDamageTicks?: number;
  boostRateDivisor?: number;     // attackCooldown /= divisor while > 0
  boostRateTicks?: number;
  boostRangeAmount?: Fixed;      // added to attackRange while > 0
  boostRangeTicks?: number;
  // extraSpawn effect: remaining bonus spawns this rule can grant
  // (decremented per fire, not per tick). Pooled across all rules
  // on this building.
  bonusSpawnsRemaining?: number;
  // aoeRoot effect: buffered root-radius / root-ticks request. Read
  // by combat.ts the same tick it's set, then cleared.
  aoeRootRadius?: Fixed;
  aoeRootTicks?: number;
}

// Runtime mirror of a BuildingAIRule. Keeps the original params by
// reference (read-only); mutable state (`remaining`, `rearmCooldown`)
// lives here so replays can be re-hydrated from the canonical Base
// snapshot + tick stream without stale state leaking across raids.
export interface SimRuleState {
  rule: BuildingAIRule;
  // How many fires remain this raid. null = unlimited.
  remaining: number | null;
  // Ticks of trigger-internal cooldown still active. 0 = armed.
  rearmCooldown: number;
  // Was the trigger condition true on the previous tick? Edge-
  // triggered rules (onEnemyInRange) fire on the false→true edge
  // rather than every tick the condition holds.
  prevConditionTrue: boolean;
  // For onTick: ticks since last fire.
  tickAccumulator: number;
  // Cumulative number of extraSpawn grants this rule has produced
  // this raid. Compared against params.maxExtra so a rule can't
  // indefinitely top up the nest's spawn bank — once the cap is
  // reached, the effect stops granting even if combat consumes
  // the banked spawn between fires.
  extraSpawnsGranted: number;
}

export interface SimState {
  tick: number;
  // Owner 0 = attacker, owner 1 = defender. Symmetric in arena.
  units: Unit[];
  // Buildings all belong to defender in raid mode; symmetric in arena.
  buildings: SimBuilding[];
  // Active pheromone paths referenced by pathId in units.
  paths: PheromonePath[];
  // Monotonic id allocators.
  nextUnitId: number;
  nextPathId: number;
  // RNG state snapshot — re-hydrated into Rng at step boundary.
  rngState: { state: string; inc: string };
  // Loot accumulators for the attacker. In arena, these are star counters.
  attackerSugarLooted: number;
  attackerLeafBitsLooted: number;
  // Per-owner deploy capacity. Players can't dump infinite units; paths
  // that exceed capacity are rejected at input-ingest.
  deployCapRemaining: [number, number];
  // Match outcome is latched the tick it occurs.
  outcome: 'ongoing' | 'attackerWin' | 'defenderWin' | 'draw';
  // Rolling counter of ally buildings that transitioned to hp <= 0 on
  // the current tick. Cleared at the start of each step, written by
  // combat.ts the moment a building dies, read by the `onAllyDestroyed`
  // AI trigger. Kept on state (not side-table) so the hash includes it.
  buildingsDestroyedThisTick?: number;
}

export interface SimConfig {
  // Ticks per simulated second. The sim is frame-rate-independent.
  tickRate: 30;
  // Hard cap on sim length — async raid is 90 s = 2700 ticks.
  maxTicks: number;
  // Base at which this sim started; kept for loot math.
  initialSnapshot: Base;
  // Seed for the PCG32 — part of the replay contract.
  seed: number;
  // Per-kind level multipliers applied at unit spawn time. Absent keys
  // default to level 1 (baseline stats). Must be identical on client
  // and server to keep the sim deterministic across environments.
  attackerUnitLevels?: Partial<Record<import('../types/units.js').UnitKind, number>>;
}
