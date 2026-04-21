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
