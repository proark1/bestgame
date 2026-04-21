import type { Base } from './base.js';
import type { SimInput } from './pheromone.js';

export interface RaidResult {
  stars: 0 | 1 | 2 | 3;
  sugarLooted: number;
  leafBitsLooted: number;
  attackerSurvivorCount: number;
  defenderBuildingsDestroyed: number;
  tickEnded: number;
}

export interface Replay {
  replayId: string;
  attackerId: string;
  defenderId: string;
  baseSnapshot: Base;
  seed: number;
  // Sorted ascending by tick.
  inputs: SimInput[];
  result: RaidResult;
  // Hash of final SimState after running the replay. Server recomputes and
  // rejects the submission if it doesn't match.
  resultHash: string;
  createdAt: string;
}
