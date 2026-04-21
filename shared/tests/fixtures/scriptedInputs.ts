import { fromInt, fromFloat } from '../../src/sim/fixed.js';
import type { SimInput } from '../../src/types/index.js';

// A fixed input script used by determinism tests: one deploy at tick 10,
// another at tick 50, another at tick 120. These are chosen to stress the
// pheromoneFollow and combat systems — paths go across multiple tiles and
// at least one targets the underground layer.

export const SCRIPTED_INPUTS: SimInput[] = [
  {
    type: 'deployPath',
    tick: 10,
    ownerSlot: 0,
    path: {
      pathId: 0,
      spawnLayer: 0,
      unitKind: 'SoldierAnt',
      count: 6,
      points: [
        { x: fromInt(0), y: fromInt(1) },
        { x: fromFloat(3.5), y: fromInt(3) },
        { x: fromInt(7), y: fromInt(5) }, // queen chamber center
      ],
    },
  },
  {
    type: 'deployPath',
    tick: 50,
    ownerSlot: 0,
    path: {
      pathId: 0,
      spawnLayer: 0,
      unitKind: 'WorkerAnt',
      count: 4,
      points: [
        { x: fromInt(0), y: fromInt(10) },
        { x: fromInt(5), y: fromInt(4) }, // target leaf wall
      ],
    },
  },
  {
    type: 'deployPath',
    tick: 120,
    ownerSlot: 0,
    path: {
      pathId: 0,
      spawnLayer: 1,
      unitKind: 'DirtDigger',
      count: 3,
      points: [
        { x: fromInt(0), y: fromInt(8) },
        { x: fromInt(10), y: fromInt(8) }, // sugar vault on layer 1
      ],
    },
  },
];
