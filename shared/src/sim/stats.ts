import { fromFloat, fromInt } from './fixed.js';
import type { UnitKind } from '../types/units.js';
import type { UnitStats } from '../types/units.js';
import type { BuildingKind } from '../types/base.js';

// All stats as Fixed (Q16.16). Balance numbers; tune freely.
//
// Speed is in Fixed tiles / tick (sim runs at 30 Hz; 0.08 tiles/tick ≈ 2.4
// tiles/sec, takes ~6 seconds to cross the 16-tile map).

export const UNIT_STATS: Record<UnitKind, UnitStats> = {
  WorkerAnt: {
    hpMax: fromInt(20),
    speed: fromFloat(0.08),
    attackRange: fromFloat(0.6),
    attackDamage: fromInt(2),
    attackCooldownTicks: 18,
    canFly: false,
    canDig: false,
  },
  SoldierAnt: {
    hpMax: fromInt(40),
    speed: fromFloat(0.07),
    attackRange: fromFloat(0.8),
    attackDamage: fromInt(6),
    attackCooldownTicks: 24,
    canFly: false,
    canDig: false,
  },
  DirtDigger: {
    hpMax: fromInt(30),
    speed: fromFloat(0.05),
    attackRange: fromFloat(0.5),
    attackDamage: fromInt(4),
    attackCooldownTicks: 30,
    canFly: false,
    canDig: true,
  },
  Forager: {
    hpMax: fromInt(15),
    speed: fromFloat(0.12),
    attackRange: fromFloat(0.5),
    attackDamage: fromInt(2),
    attackCooldownTicks: 20,
    canFly: true,
    canDig: false,
  },
  Wasp: {
    hpMax: fromInt(25),
    speed: fromFloat(0.10),
    attackRange: fromFloat(2.5),
    attackDamage: fromInt(5),
    attackCooldownTicks: 30,
    canFly: true,
    canDig: false,
  },
  HoneyTank: {
    hpMax: fromInt(80),
    speed: fromFloat(0.04),
    attackRange: fromFloat(0.8),
    attackDamage: fromInt(8),
    attackCooldownTicks: 36,
    canFly: false,
    canDig: false,
  },
  ShieldBeetle: {
    hpMax: fromInt(120),
    speed: fromFloat(0.05),
    attackRange: fromFloat(0.6),
    attackDamage: fromInt(4),
    attackCooldownTicks: 30,
    canFly: false,
    canDig: false,
  },
  BombBeetle: {
    hpMax: fromInt(30),
    speed: fromFloat(0.09),
    attackRange: fromFloat(0.4),
    attackDamage: fromInt(25),
    attackCooldownTicks: 1,
    canFly: false,
    canDig: false,
  },
  Roller: {
    hpMax: fromInt(50),
    speed: fromFloat(0.11),
    attackRange: fromFloat(0.7),
    attackDamage: fromInt(10),
    attackCooldownTicks: 45,
    canFly: false,
    canDig: false,
  },
  Jumper: {
    hpMax: fromInt(35),
    speed: fromFloat(0.10),
    attackRange: fromFloat(0.6),
    attackDamage: fromInt(7),
    attackCooldownTicks: 22,
    canFly: false,
    canDig: false,
  },
  WebSetter: {
    hpMax: fromInt(25),
    speed: fromFloat(0.07),
    attackRange: fromFloat(2.0),
    attackDamage: fromInt(1),
    attackCooldownTicks: 40,
    canFly: false,
    canDig: false,
  },
  Ambusher: {
    hpMax: fromInt(30),
    speed: fromFloat(0.09),
    attackRange: fromFloat(0.7),
    attackDamage: fromInt(12),
    attackCooldownTicks: 30,
    canFly: false,
    canDig: false,
  },
};

export interface BuildingStats {
  hpMax: number;
  canAttack: boolean;
  attackRange: number; // Fixed tiles
  attackDamage: number; // Fixed hp per hit
  attackCooldownTicks: number;
  dropsSugarOnDestroy: number;
  dropsLeafBitsOnDestroy: number;
}

export const BUILDING_STATS: Record<BuildingKind, BuildingStats> = {
  QueenChamber: {
    hpMax: 800,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 0,
  },
  DewCollector: {
    hpMax: 200,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 100,
    dropsLeafBitsOnDestroy: 0,
  },
  MushroomTurret: {
    hpMax: 400,
    canAttack: true,
    attackRange: fromFloat(3.0),
    attackDamage: fromInt(5),
    attackCooldownTicks: 30,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 20,
  },
  LeafWall: {
    hpMax: 600,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 5,
  },
  PebbleBunker: {
    hpMax: 900,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 10,
  },
  LarvaNursery: {
    hpMax: 300,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 60,
    dropsLeafBitsOnDestroy: 0,
  },
  SugarVault: {
    hpMax: 350,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 500,
    dropsLeafBitsOnDestroy: 0,
  },
  TunnelJunction: {
    hpMax: 250,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 0,
  },
  DungeonTrap: {
    hpMax: 100,
    canAttack: true,
    attackRange: fromFloat(1.0),
    attackDamage: fromInt(20),
    attackCooldownTicks: 120,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 5,
  },
};
