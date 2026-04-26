import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  fromFloat,
  fromInt,
  hashSimState,
  hashToHex,
  runReplay,
  step,
} from '../src/sim/index.js';
import type { SimConfig } from '../src/sim/index.js';
import type { Base, SimInput } from '../src/types/index.js';

// Trapdoor counter-play: onCrossLayerEntry + forceLayerSwap.
// A defender plants the rule on a DungeonTrap; an attacker drags a
// path with the `dig` modifier; the moment the digger crosses, the
// trap flips it back. End-to-end test runs the full sim and reads
// the resulting unit state.

function baseWithTrapdoor(): Base {
  return {
    baseId: 'fx',
    ownerId: 'fx',
    faction: 'Ants',
    gridSize: { w: 16, h: 12 },
    resources: { sugar: 0, leafBits: 0, aphidMilk: 0 },
    trophies: 0,
    version: 1,
    tunnels: [],
    buildings: [
      {
        id: 'queen',
        kind: 'QueenChamber',
        anchor: { x: 12, y: 5, layer: 0 },
        footprint: { w: 2, h: 2 },
        spans: [0, 1],
        level: 1,
        hp: 1500,
        hpMax: 1500,
      },
      {
        id: 'trap',
        // Trap sits two tiles past the dig marker so it doesn't shoot
        // the digger DURING the 90-tick dig window — that interaction
        // is the dig vulnerability test, not the trapdoor test. With
        // the trap at (6,5) and the dig at (4,5), the trap's range=1
        // tile attack can't reach the digging unit, but its rule's
        // radius=4 still triggers when the digger crosses layers.
        kind: 'DungeonTrap',
        anchor: { x: 6, y: 5, layer: 0 },
        footprint: { w: 1, h: 1 },
        spans: [0, 1],
        level: 1,
        hp: 300,
        hpMax: 300,
        aiRules: [
          {
            id: 'r-trap',
            trigger: 'onCrossLayerEntry',
            effect: 'forceLayerSwap',
            params: { radius: 4 },
            cooldownTicks: 30,
          },
        ],
      },
    ],
  };
}

const cfg: SimConfig = {
  tickRate: 30,
  maxTicks: 300,
  initialSnapshot: baseWithTrapdoor(),
  seed: 0xc0ffee,
};

function digInput(): SimInput {
  return {
    type: 'deployPath',
    tick: 1,
    ownerSlot: 0,
    path: {
      pathId: 0,
      spawnLayer: 0,
      unitKind: 'DirtDigger',
      count: 2,
      points: [
        { x: fromInt(0), y: fromInt(5) },
        { x: fromFloat(4), y: fromInt(5) },
        { x: fromInt(10), y: fromInt(5) },
      ],
      modifier: { kind: 'dig', pointIndex: 1 },
    },
  };
}

describe('trapdoor counter-play', () => {
  it('forceLayerSwap bounces a digger that just crossed', () => {
    const state = createInitialState(cfg);
    const input = digInput();
    for (let i = 0; i < 200; i++) {
      step(state, cfg, i + 1 === input.tick ? [input] : []);
      if (state.outcome !== 'ongoing') break;
    }
    // DirtDigger crosses to layer 1 from `dig`. The trapdoor's
    // `forceLayerSwap` flips it back to layer 0 the same tick.
    // Net: the dug unit ends up back on the surface despite trying
    // to slip underground.
    const surfaceDiggers = state.units.filter(
      (u) => u.kind === 'DirtDigger' && u.hasDug && u.layer === 0 && u.hp > 0,
    );
    expect(surfaceDiggers.length).toBeGreaterThanOrEqual(1);
  });

  it('without the trap rule the digger reaches layer 1 unhindered', () => {
    const noTrapBase = baseWithTrapdoor();
    delete noTrapBase.buildings[1]!.aiRules;
    const altCfg: SimConfig = { ...cfg, initialSnapshot: noTrapBase };
    const state = createInitialState(altCfg);
    const input = digInput();
    for (let i = 0; i < 200; i++) {
      step(state, altCfg, i + 1 === input.tick ? [input] : []);
      if (state.outcome !== 'ongoing') break;
    }
    const undergroundDiggers = state.units.filter(
      (u) => u.kind === 'DirtDigger' && u.hasDug && u.layer === 1 && u.hp > 0,
    );
    expect(undergroundDiggers.length).toBeGreaterThanOrEqual(1);
  });

  it('two consecutive runs hash identically with the trapdoor armed', () => {
    const a = runReplay(createInitialState(cfg), cfg, [digInput()]);
    const b = runReplay(createInitialState(cfg), cfg, [digInput()]);
    expect(hashToHex(hashSimState(a))).toBe(hashToHex(hashSimState(b)));
  });
});
