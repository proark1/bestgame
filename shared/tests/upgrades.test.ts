import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  runReplay,
  type SimConfig,
} from '../src/sim/index.js';
import type { SimInput, Base } from '../src/types/index.js';
import { fromInt, fromFloat } from '../src/sim/fixed.js';

// Validates the two places where unit level multipliers feed the sim:
//   1. applyDeploy scales unit HP  (longer survival)
//   2. combatSystem scales unit damage (harder hits against buildings)
// Without either wiring the "upgrade" is cosmetic. These tests would
// have caught the damage-scaling gap Gemini flagged on PR #13.

const BASE: Base = {
  baseId: 'test-base',
  ownerId: 'test',
  faction: 'Beetles',
  gridSize: { w: 16, h: 12 },
  resources: { sugar: 0, leafBits: 0, aphidMilk: 0 },
  trophies: 100,
  version: 1,
  tunnels: [],
  buildings: [
    {
      id: 'b-wall',
      kind: 'LeafWall',
      anchor: { x: 7, y: 5, layer: 0 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 600,
      hpMax: 600,
    },
  ],
};

function run(
  levels: Record<string, number>,
  ticks: number,
): ReturnType<typeof runReplay> {
  const cfg: SimConfig = {
    tickRate: 30,
    maxTicks: ticks,
    initialSnapshot: BASE,
    seed: 0xabc,
    attackerUnitLevels: levels,
  };
  const inputs: SimInput[] = [
    {
      type: 'deployPath',
      tick: 2,
      ownerSlot: 0,
      path: {
        pathId: 0,
        spawnLayer: 0,
        unitKind: 'SoldierAnt',
        count: 4,
        points: [
          { x: fromInt(0), y: fromInt(5) },
          { x: fromFloat(7.5), y: fromInt(5) },
        ],
      },
    },
  ];
  return runReplay(createInitialState(cfg), cfg, inputs);
}

describe('unit upgrades — sim integration', () => {
  it('level 2 units hit harder: wall HP falls faster than at level 1', () => {
    const TICKS = 120;
    const lv1 = run({}, TICKS);
    const lv2 = run({ SoldierAnt: 2 }, TICKS);
    const wall1 = lv1.buildings.find((b) => b.kind === 'LeafWall')!;
    const wall2 = lv2.buildings.find((b) => b.kind === 'LeafWall')!;
    // Level-2 attackers should have chewed through MORE of the wall by
    // the same tick count. HP at level 2 < HP at level 1.
    expect(wall2.hp).toBeLessThan(wall1.hp);
  });

  it('level 2 units survive longer: higher hpMax at spawn', () => {
    const lv1 = run({}, 1); // spawn happens on tick 2, so after 1 tick no spawn — let's use 3
    const lv2 = run({ SoldierAnt: 2 }, 1);
    // After tick 1, no units yet. Bump ticks.
    const after1 = run({}, 5);
    const after2 = run({ SoldierAnt: 2 }, 5);
    const hp1 = after1.units.find((u) => u.kind === 'SoldierAnt')?.hpMax ?? 0;
    const hp2 = after2.units.find((u) => u.kind === 'SoldierAnt')?.hpMax ?? 0;
    expect(hp2).toBeGreaterThan(hp1);
    void lv1; void lv2;
  });

  it('missing level entry defaults to baseline', () => {
    const baseline = run({}, 120);
    const explicit1 = run({ SoldierAnt: 1 }, 120);
    // Identical hash expected: level 1 should be a no-op.
    const wallA = baseline.buildings.find((b) => b.kind === 'LeafWall')!;
    const wallB = explicit1.buildings.find((b) => b.kind === 'LeafWall')!;
    expect(wallA.hp).toBe(wallB.hp);
  });
});
