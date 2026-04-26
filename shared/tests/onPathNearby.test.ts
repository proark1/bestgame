import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  fromFloat,
  fromInt,
  hashSimState,
  hashToHex,
  step,
} from '../src/sim/index.js';
import type { SimConfig } from '../src/sim/index.js';
import type { Base, BuildingAIRule, SimInput } from '../src/types/index.js';

// onPathNearby — step-7 audit gap. Defender AI rule that fires when
// any active pheromone path passes within radius of the rule host.
// We test the geometry, the same-layer gate, and that the rule
// stays inert before any path is committed.

function baseWithReactiveTurret(rule: BuildingAIRule, turretAt: { x: number; y: number; layer: 0 | 1 }): Base {
  return {
    baseId: 'fx', ownerId: 'fx', faction: 'Ants',
    gridSize: { w: 16, h: 12 },
    resources: { sugar: 0, leafBits: 0, aphidMilk: 0 },
    trophies: 0, version: 1, tunnels: [],
    buildings: [
      { id: 'queen', kind: 'QueenChamber',
        anchor: { x: 14, y: 5, layer: 0 }, footprint: { w: 2, h: 2 },
        spans: [0, 1], level: 1, hp: 800, hpMax: 800 },
      { id: 'turret', kind: 'MushroomTurret',
        anchor: turretAt, footprint: { w: 1, h: 1 },
        level: 1, hp: 400, hpMax: 400, aiRules: [rule] },
    ],
  };
}

const cfgWith = (b: Base): SimConfig => ({
  tickRate: 30, maxTicks: 90, initialSnapshot: b, seed: 0xc0ffee,
});

function pathInput(args: {
  spawnLayer: 0 | 1;
  via: Array<{ x: number; y: number }>;
}): SimInput {
  return {
    type: 'deployPath', tick: 1, ownerSlot: 0,
    path: {
      pathId: 0, spawnLayer: args.spawnLayer,
      unitKind: 'SoldierAnt', count: 1,
      points: args.via.map((p) => ({ x: fromFloat(p.x), y: fromFloat(p.y) })),
    },
  };
}

const BUFF_RULE: BuildingAIRule = {
  id: 'r-bait',
  trigger: 'onPathNearby',
  effect: 'boostAttackDamage',
  params: { radius: 2, percent: 200, durationTicks: 60 },
  cooldownTicks: 60,
};

describe('onPathNearby', () => {
  it('fires when a path passes within radius of the building', () => {
    // Turret at (5, 5). Path goes from (0, 5) → (10, 5), which
    // walks straight through the turret's tile — well within
    // radius 2.
    const base = baseWithReactiveTurret(BUFF_RULE, { x: 5, y: 5, layer: 0 });
    const cfg = cfgWith(base);
    const state = createInitialState(cfg);
    const input = pathInput({ spawnLayer: 0, via: [{ x: 0, y: 5 }, { x: 10, y: 5 }] });
    // First tick: rule pre-deploy is inert (no path yet). After
    // the deploy + one more step, the rule should have fired —
    // boostDamageTicks reflects that.
    step(state, cfg, [input]);
    step(state, cfg, []);
    const turret = state.buildings.find((b) => b.kind === 'MushroomTurret')!;
    expect((turret.boostDamageTicks ?? 0)).toBeGreaterThan(0);
  });

  it('does NOT fire when the path is far from the building', () => {
    // Turret at (1, 1). Path stays along y=10 — well outside r=2.
    const base = baseWithReactiveTurret(BUFF_RULE, { x: 1, y: 1, layer: 0 });
    const cfg = cfgWith(base);
    const state = createInitialState(cfg);
    const input = pathInput({ spawnLayer: 0, via: [{ x: 0, y: 10 }, { x: 14, y: 10 }] });
    step(state, cfg, [input]);
    step(state, cfg, []);
    const turret = state.buildings.find((b) => b.kind === 'MushroomTurret')!;
    expect((turret.boostDamageTicks ?? 0)).toBe(0);
  });

  it('does NOT fire for a different-layer path on a non-spanning building', () => {
    // Turret on the surface (layer 0); path's spawnLayer=1
    // (underground). MushroomTurret is single-layer, so the
    // same-layer gate skips it.
    const base = baseWithReactiveTurret(BUFF_RULE, { x: 5, y: 5, layer: 0 });
    const cfg = cfgWith(base);
    const state = createInitialState(cfg);
    const input = pathInput({ spawnLayer: 1, via: [{ x: 0, y: 5 }, { x: 10, y: 5 }] });
    step(state, cfg, [input]);
    step(state, cfg, []);
    const turret = state.buildings.find((b) => b.kind === 'MushroomTurret')!;
    expect((turret.boostDamageTicks ?? 0)).toBe(0);
  });

  it('stays inert when no paths exist yet', () => {
    // Empty paths list. The trigger evaluator should short-circuit
    // before any geometry runs and prevConditionTrue stays false.
    const base = baseWithReactiveTurret(BUFF_RULE, { x: 5, y: 5, layer: 0 });
    const cfg = cfgWith(base);
    const state = createInitialState(cfg);
    for (let i = 0; i < 30; i++) step(state, cfg, []);
    const turret = state.buildings.find((b) => b.kind === 'MushroomTurret')!;
    expect((turret.boostDamageTicks ?? 0)).toBe(0);
    expect(turret.rules?.[0]?.prevConditionTrue).toBe(false);
  });

  it('produces deterministic hashes across two runs', () => {
    const base = baseWithReactiveTurret(BUFF_RULE, { x: 5, y: 5, layer: 0 });
    const cfg = cfgWith(base);
    const inp = pathInput({ spawnLayer: 0, via: [{ x: 0, y: 5 }, { x: 10, y: 5 }] });
    const a = createInitialState(cfg);
    const b = createInitialState(cfg);
    for (let i = 0; i < 30; i++) {
      step(a, cfg, i === 0 ? [inp] : []);
      step(b, cfg, i === 0 ? [inp] : []);
    }
    expect(hashToHex(hashSimState(a))).toBe(hashToHex(hashSimState(b)));
  });
});
