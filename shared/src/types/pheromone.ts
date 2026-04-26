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

// Path modifiers — markers a player can attach to a single waypoint to
// change unit behaviour as they walk through it. v1 supports one
// modifier per path (placed at the polyline's midpoint by the client).
//
//   split  — at the marker, half of the units (those with odd id) break
//            off and acquire the nearest building immediately. The other
//            half keep walking the path. Lets a single drag pincer two
//            targets without consuming a second deploy.
//   ambush — at the marker, every unit pauses for AMBUSH_TICKS sim
//            ticks. Used to stagger arrivals or wait out a turret window.
//   dig    — at the marker, units with `canDig` flip to the opposite
//            layer. The game's first real cross-layer combat hook.
//
// All modifiers fire AT MOST once per unit per path: pheromone_follow
// fires the marker only on the rising edge of "just arrived at waypoint
// pointIndex". Forward-only path motion guarantees this.
export type PathModifierKind = 'split' | 'ambush' | 'dig';

export interface PathModifier {
  kind: PathModifierKind;
  // Index into PheromonePath.points (1..points.length-1). 0 (spawn)
  // never fires because it's the entry waypoint, not an arrival.
  pointIndex: number;
}

export interface PheromonePath {
  pathId: number;
  spawnLayer: Layer; // which layer the unit group enters on
  unitKind: UnitKind;
  count: number;
  points: PheromonePoint[]; // >= 2 points; first is spawn, last is target area
  // Optional modifier attached to the path. Absent on legacy/replay
  // inputs — those follow the original pure-walk behaviour exactly.
  modifier?: PathModifier;
}

// Sim ticks the unit pauses on an `ambush` marker. 30 ticks = 1 second
// at the canonical tickRate. Tuned long enough that a player can wait
// out a turret salvo, short enough that ambushed units don't fall too
// far behind the rest of the swarm.
export const AMBUSH_TICKS = 60;

// Input: a player command issued at a specific sim tick. The sim consumes
// these from a queue sorted by tick. In async raid: the full timeline is
// known up front. In live arena: it arrives over the network.
export type SimInput =
  | { type: 'deployPath'; tick: number; ownerSlot: 0 | 1; path: PheromonePath }
  | { type: 'surrender'; tick: number; ownerSlot: 0 | 1 };
