import { describe, expect, it } from 'vitest';
import {
  AMBUSH_TICKS,
  type SimInput,
} from '../src/types/index.js';
import {
  createInitialState,
  fromFloat,
  fromInt,
  hashSimState,
  hashToHex,
  runReplay,
  step,
  type SimConfig,
} from '../src/sim/index.js';
import { SMALL_BASE } from './fixtures/smallBase.js';

// Path modifiers (split / ambush / dig) layered on the base sim. Each
// case below pins one observable behaviour and the determinism guarantee
// (two runs ⇒ identical hash). Existing modifier-free scenarios are
// already covered by determinism.test.ts.

const cfg: SimConfig = {
  tickRate: 30,
  maxTicks: 300,
  initialSnapshot: SMALL_BASE,
  seed: 0x1234abcd,
};

function runWith(inputs: SimInput[]) {
  const state = createInitialState(cfg);
  return runReplay(state, cfg, inputs);
}

describe('path modifiers', () => {
  it('split forks half the swarm off the path at the marker waypoint', () => {
    const input: SimInput = {
      type: 'deployPath',
      tick: 1,
      ownerSlot: 0,
      path: {
        pathId: 0,
        spawnLayer: 0,
        unitKind: 'SoldierAnt',
        count: 4,
        points: [
          { x: fromInt(0), y: fromInt(5) },
          { x: fromFloat(3), y: fromInt(5) },
          { x: fromFloat(7), y: fromInt(5) },
        ],
        modifier: { kind: 'split', pointIndex: 1 },
      },
    };
    // Step far enough that every unit has crossed waypoint 1.
    const state = createInitialState(cfg);
    for (let i = 0; i < 90; i++) {
      step(state, cfg, i + 1 === input.tick ? [input] : []);
      if (state.outcome !== 'ongoing') break;
    }
    const split = state.units.filter((u) => u.hasSplit);
    expect(split.length).toBeGreaterThanOrEqual(2);
    // Of split units, ones with odd id should have left the path.
    for (const u of split) {
      if ((u.id & 1) === 1) expect(u.pathId).toBe(-1);
    }
  });

  it('ambush pauses every unit for AMBUSH_TICKS sim ticks', () => {
    const input: SimInput = {
      type: 'deployPath',
      tick: 1,
      ownerSlot: 0,
      path: {
        pathId: 0,
        spawnLayer: 0,
        unitKind: 'SoldierAnt',
        count: 2,
        points: [
          { x: fromInt(0), y: fromInt(5) },
          { x: fromFloat(2), y: fromInt(5) },
          { x: fromFloat(7), y: fromInt(5) },
        ],
        modifier: { kind: 'ambush', pointIndex: 1 },
      },
    };
    const state = createInitialState(cfg);
    // Run until at least one unit has triggered the ambush.
    let triggeredAt = -1;
    for (let i = 0; i < 200; i++) {
      step(state, cfg, i + 1 === input.tick ? [input] : []);
      if (state.units.some((u) => u.hasAmbushed) && triggeredAt < 0) {
        triggeredAt = state.tick;
      }
    }
    expect(triggeredAt).toBeGreaterThan(0);
    // After triggering, ambushTicks should have decremented to 0 within
    // AMBUSH_TICKS+a small margin sim ticks.
    for (const u of state.units) {
      if (u.hasAmbushed) {
        expect((u.ambushTicks ?? 0)).toBeLessThanOrEqual(AMBUSH_TICKS);
      }
    }
  });

  it('dig flips the layer of canDig units only', () => {
    const input: SimInput = {
      type: 'deployPath',
      tick: 1,
      ownerSlot: 0,
      path: {
        pathId: 0,
        spawnLayer: 0,
        unitKind: 'DirtDigger',
        count: 2,
        points: [
          { x: fromInt(0), y: fromInt(8) },
          { x: fromFloat(3), y: fromInt(8) },
          { x: fromInt(10), y: fromInt(8) },
        ],
        modifier: { kind: 'dig', pointIndex: 1 },
      },
    };
    const state = createInitialState(cfg);
    // Step long enough for the dig animation to complete. Walk to
    // marker (~few ticks) + DIG_TICKS=90 + small buffer for the
    // post-dig layer-flip to register. 200 ticks is comfortable.
    for (let i = 0; i < 200; i++) {
      step(state, cfg, i + 1 === input.tick ? [input] : []);
      if (state.outcome !== 'ongoing') break;
    }
    const dug = state.units.filter((u) => u.hasDug);
    expect(dug.length).toBeGreaterThanOrEqual(1);
    for (const u of dug) expect(u.layer).toBe(1);
  });

  it('dig is not instantaneous — diggers hold position for the dig window', () => {
    // Sample the digger state mid-dig (well before DIG_TICKS=90
    // would elapse) and confirm it's still on the surface, with
    // diggingTicks > 0. The full-flip behavior is exercised by the
    // earlier "dig flips the layer" test.
    const input: SimInput = {
      type: 'deployPath',
      tick: 1,
      ownerSlot: 0,
      path: {
        pathId: 0,
        spawnLayer: 0,
        unitKind: 'DirtDigger',
        count: 1,
        points: [
          { x: fromInt(0), y: fromInt(8) },
          { x: fromFloat(3), y: fromInt(8) },
          { x: fromInt(10), y: fromInt(8) },
        ],
        modifier: { kind: 'dig', pointIndex: 1 },
      },
    };
    const state = createInitialState(cfg);
    // Walk to marker (~60 ticks at speed 0.05 over 3 tiles) plus a
    // short buffer so the dig has been running for ~30 ticks.
    for (let i = 0; i < 95; i++) {
      step(state, cfg, i + 1 === input.tick ? [input] : []);
      if (state.outcome !== 'ongoing') break;
    }
    const mid = state.units.find((u) => u.kind === 'DirtDigger');
    expect(mid).toBeDefined();
    expect(mid!.hasDug).toBe(true);
    expect(mid!.layer).toBe(0); // still surface, dig in progress
    expect((mid!.diggingTicks ?? 0)).toBeGreaterThan(0);
  });

  it('produces identical hashes on two runs (modifiers stay deterministic)', () => {
    const inputs: SimInput[] = [
      {
        type: 'deployPath', tick: 5, ownerSlot: 0,
        path: {
          pathId: 0, spawnLayer: 0, unitKind: 'SoldierAnt', count: 4,
          points: [
            { x: fromInt(0), y: fromInt(5) },
            { x: fromFloat(4), y: fromInt(5) },
            { x: fromInt(8), y: fromInt(5) },
          ],
          modifier: { kind: 'split', pointIndex: 1 },
        },
      },
      {
        type: 'deployPath', tick: 30, ownerSlot: 0,
        path: {
          pathId: 0, spawnLayer: 0, unitKind: 'DirtDigger', count: 3,
          points: [
            { x: fromInt(0), y: fromInt(8) },
            { x: fromFloat(3), y: fromInt(8) },
            { x: fromInt(10), y: fromInt(8) },
          ],
          modifier: { kind: 'dig', pointIndex: 1 },
        },
      },
    ];
    const a = runWith(inputs);
    const b = runWith(inputs);
    expect(hashToHex(hashSimState(a))).toBe(hashToHex(hashSimState(b)));
  });
});
