import type { Fixed } from '../sim/fixed.js';
import type { Layer } from './base.js';

export type UnitKind =
  | 'WorkerAnt'
  | 'SoldierAnt'
  | 'DirtDigger'
  | 'Forager'
  | 'Wasp'
  | 'HoneyTank'
  | 'ShieldBeetle'
  | 'BombBeetle'
  | 'Roller'
  | 'Jumper'
  | 'WebSetter'
  | 'Ambusher';

// A live unit inside a running sim. Positions are Fixed (Q16.16) in world
// sub-tile coordinates; the grid is 16x12 tiles so values stay small.
export interface Unit {
  id: number;
  kind: UnitKind;
  owner: 0 | 1; // 0 = attacker, 1 = defender
  layer: Layer;
  x: Fixed;
  y: Fixed;
  hp: Fixed;
  hpMax: Fixed;
  // Index of the pheromone path this unit is following, -1 if none.
  pathId: number;
  // How far along the current path (in Fixed "arclength units") — used by
  // the pheromoneFollow system to advance through waypoints in order.
  pathProgress: Fixed;
  // Cooldown ticks until the unit can attack again.
  attackCooldown: number;
  // Target building id, 0 if none. Units prefer buildings but auto-switch
  // to nearby enemy units via the combat system.
  targetBuildingId: number;
}

export interface UnitStats {
  hpMax: Fixed;
  speed: Fixed; // Fixed tiles per tick
  attackRange: Fixed; // Fixed tiles
  attackDamage: Fixed; // Fixed HP per hit
  attackCooldownTicks: number;
  canFly: boolean;
  canDig: boolean;
}
