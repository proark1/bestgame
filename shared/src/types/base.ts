// Base and building data models. Kept plain-data (no methods) so they
// serialize cleanly into replay blobs and Colyseus payloads.

export type Layer = 0 | 1; // 0 = surface, 1 = underground

export interface Cell {
  x: number;
  y: number;
  layer: Layer;
}

export type Faction = 'Ants' | 'Bees' | 'Beetles' | 'Spiders';

export type BuildingKind =
  | 'QueenChamber'
  | 'DewCollector'
  | 'MushroomTurret'
  | 'LeafWall'
  | 'PebbleBunker'
  | 'LarvaNursery'
  | 'SugarVault'
  | 'TunnelJunction'
  | 'DungeonTrap'
  // Expanded defensive roster (Clash-style). Each kind has a distinct
  // combat role — see shared/src/sim/stats.ts BUILDING_STATS for
  // concrete numbers and shared/src/sim/systems/combat.ts for the
  // splash / anti-air / stealth / trap / nest-spawn semantics.
  | 'AcidSpitter'    // long-range splash (mortar analog)
  | 'SporeTower'     // anti-air only (cannot hit ground)
  | 'RootSnare'      // one-shot trap, roots/slows on trigger
  | 'HiddenStinger'  // cloaked until a unit enters range, then reveals
  | 'SpiderNest'     // periodically spawns defender units during a raid
  | 'ThornHedge';    // tier-2 wall: higher hp + chip-damage reflect

export interface Building {
  id: string;
  kind: BuildingKind;
  anchor: Cell;
  footprint: { w: number; h: number };
  // If set, this building occupies multiple layers. QueenChamber spans [0,1]
  // — a surface turret wired to an underground throne room.
  spans?: Layer[];
  level: number;
  hp: number;
  hpMax: number;
}

export interface Base {
  baseId: string;
  ownerId: string;
  faction: Faction;
  gridSize: { w: number; h: number };
  buildings: Building[];
  tunnels: { from: Cell; to: Cell }[];
  resources: {
    sugar: number;
    leafBits: number;
    aphidMilk: number;
  };
  trophies: number;
  version: number;
}

export const DEFAULT_GRID_SIZE = { w: 16, h: 12 } as const;
