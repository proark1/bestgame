import type { Fixed } from '../sim/fixed.js';
import type { Layer } from './base.js';
import type { UnitKind } from './units.js';

// A pheromone path is what the player actually draws on screen. It's a
// polyline of tile-coordinate waypoints, tagged with which deck slot to
// spawn from and how many units to send.
//
// We store tile coordinates as Fixed (Q16.16) so snap-to-grid waypoints
// and smooth hand-drawn paths share the same representation.

export interface PheromonePoint {
  x: Fixed;
  y: Fixed;
}

export interface PheromonePath {
  pathId: number;
  spawnLayer: Layer; // which layer the unit group enters on
  unitKind: UnitKind;
  count: number;
  points: PheromonePoint[]; // >= 2 points; first is spawn, last is target area
}

// Input: a player command issued at a specific sim tick. The sim consumes
// these from a queue sorted by tick. In async raid: the full timeline is
// known up front. In live arena: it arrives over the network.
export type SimInput =
  | { type: 'deployPath'; tick: number; ownerSlot: 0 | 1; path: PheromonePath }
  | { type: 'surrender'; tick: number; ownerSlot: 0 | 1 };
