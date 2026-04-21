import type { Base } from '../../src/types/index.js';

// A tiny 4-building base used by determinism tests and the bot tester.
// Kept inline as TypeScript (not JSON) so the test suite stays self-contained
// and typechecked.

export const SMALL_BASE: Base = {
  baseId: 'fixture-small-base',
  ownerId: 'bot-0',
  faction: 'Ants',
  gridSize: { w: 16, h: 12 },
  resources: { sugar: 1200, leafBits: 300, aphidMilk: 0 },
  trophies: 100,
  version: 1,
  buildings: [
    {
      id: 'b-queen',
      kind: 'QueenChamber',
      anchor: { x: 7, y: 5, layer: 0 },
      footprint: { w: 2, h: 2 },
      spans: [0, 1],
      level: 1,
      hp: 800,
      hpMax: 800,
    },
    {
      id: 'b-turret-1',
      kind: 'MushroomTurret',
      anchor: { x: 3, y: 3, layer: 0 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 400,
      hpMax: 400,
    },
    {
      id: 'b-wall-1',
      kind: 'LeafWall',
      anchor: { x: 5, y: 4, layer: 0 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 600,
      hpMax: 600,
    },
    {
      id: 'b-vault-1',
      kind: 'SugarVault',
      anchor: { x: 10, y: 8, layer: 1 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 350,
      hpMax: 350,
    },
  ],
  tunnels: [],
};
