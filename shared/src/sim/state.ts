import type { Fixed } from './fixed.js';
import type { Base, BuildingKind, Layer } from '../types/base.js';
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
