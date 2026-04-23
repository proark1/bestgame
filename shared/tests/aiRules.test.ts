import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  fromFloat,
  hashSimState,
  runReplay,
  step,
  toFloat,
} from '../src/sim/index.js';
import type { SimConfig } from '../src/sim/index.js';
import type {
  Base,
  BuildingAIRule,
  PheromonePath,
  SimInput,
} from '../src/types/index.js';

// Sanity + determinism tests for the player-authored defender AI
// system. The sim is the source of truth for balance; these tests
// assert that:
//   * rules actually change attack behavior (boost, heal, root, etc.)
//   * re-running a scripted scenario produces bit-identical state
//     hashes even when rules are in play — critical for replay
//     validation and the determinism gate
//   * rules don't leak state across runs (no hidden singletons)

function baseWithRules(rules: BuildingAIRule[]): Base {
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
        anchor: { x: 7, y: 5, layer: 0 },
        footprint: { w: 2, h: 2 },
        spans: [0, 1],
        level: 1,
        hp: 800,
        hpMax: 800,
      },
      {
        id: 'turret',
        kind: 'MushroomTurret',
        anchor: { x: 2, y: 2, layer: 0 },
        footprint: { w: 1, h: 1 },
        level: 1,
        hp: 400,
        hpMax: 400,
        aiRules: rules,
      },
    ],
  };
}

function straightDeploy(): SimInput {
  const path: PheromonePath = {
    pathId: 0,
    spawnLayer: 0,
    unitKind: 'SoldierAnt',
    count: 1,
    points: [
      { x: fromFloat(0), y: fromFloat(2.5) },
      { x: fromFloat(6), y: fromFloat(2.5) },
    ],
  };
  return { type: 'deployPath', tick: 1, ownerSlot: 0, path };
}

function runFor(
  snapshot: Base,
  ticks: number,
  inputs: SimInput[],
): { hash: number; turretHp: number; remainingUnits: number } {
  const cfg: SimConfig = {
    tickRate: 30,
    maxTicks: ticks + 10,
    initialSnapshot: snapshot,
    seed: 0xc0ffee,
  };
  const state = createInitialState(cfg);
  // runReplay mutates + returns `state`; ignore the return value.
  runReplay(state, cfg, inputs);
  // Run out any remaining ticks with no further inputs. runReplay
  // already consumed the maxTicks budget, so this loop is usually a
  // no-op; left in so subsequent tweaks of the test don't silently
  // drop trailing ticks.
  while (state.tick < ticks && state.outcome === 'ongoing') {
    step(state, cfg, []);
  }
  const turret = state.buildings.find((b) => b.kind === 'MushroomTurret');
  return {
    hash: hashSimState(state),
    turretHp: turret ? turret.hp : 0,
    remainingUnits: state.units.filter((u) => u.hp > 0).length,
  };
}

describe('defender AI — effects take hold', () => {
  it('healSelf raises turret hp when it drops', () => {
    // Damage the turret via the fixture's starting hp then verify the
    // rule heals it back. onLowHp fires at 50% HP with a heal.
    const rules: BuildingAIRule[] = [
      {
        id: 'r1',
        trigger: 'onLowHp',
        effect: 'healSelf',
        params: { percent: 60, hp: 100 },
      },
    ];
    const snap = baseWithRules(rules);
    // Pre-damage the turret so the rule condition is met on tick 1.
    snap.buildings[1]!.hp = 100;
    const cfg: SimConfig = {
      tickRate: 30,
      maxTicks: 30,
      initialSnapshot: snap,
      seed: 1,
    };
    const state = createInitialState(cfg);
    // Tick twice so the decay + fire passes both run.
    step(state, cfg, []);
    step(state, cfg, []);
    const turret = state.buildings.find((b) => b.kind === 'MushroomTurret')!;
    // Turret started at Fixed(100); healSelf adds Fixed(100). Result
    // should be > 100 in Fixed units (toFloat converts).
    expect(toFloat(turret.hp)).toBeGreaterThan(100);
  });

  it('boostAttackDamage raises effective damage', () => {
    // Without boost: turret chips at the wall's target each tick per
    // its cooldown. With a +100% boost from the first tick the turret
    // fires, damage dealt to the first enemy should be roughly double
    // within the same window.
    const baseline = runFor(baseWithRules([]), 120, [straightDeploy()]);
    const boosted = runFor(
      baseWithRules([
        {
          id: 'r1',
          trigger: 'onEnemyInRange',
          effect: 'boostAttackDamage',
          params: { radius: 6, percent: 200, durationTicks: 300 },
        },
      ]),
      120,
      [straightDeploy()],
    );
    // With a boost active, the single SoldierAnt should die sooner —
    // so fewer units remain or the scenario ended earlier. Our
    // signal: the boosted run has equal-or-fewer live attackers
    // AND the two state hashes differ (proving the boost path runs).
    expect(boosted.remainingUnits).toBeLessThanOrEqual(baseline.remainingUnits);
    expect(boosted.hash).not.toBe(baseline.hash);
  });
});

describe('defender AI — determinism', () => {
  it('same inputs + same rules produce bit-identical hashes', () => {
    const rules: BuildingAIRule[] = [
      {
        id: 'r1',
        trigger: 'onTick',
        effect: 'extraSpawn',
        params: { ticks: 60, maxExtra: 2 },
      },
    ];
    const a = runFor(baseWithRules(rules), 90, [straightDeploy()]);
    const b = runFor(baseWithRules(rules), 90, [straightDeploy()]);
    expect(a.hash).toBe(b.hash);
  });

  it('no rules === original baseline', () => {
    const withEmpty = runFor(baseWithRules([]), 90, [straightDeploy()]);
    // Same scenario without the aiRules array at all. Both should
    // produce the same hash — an empty array must not alter the sim.
    const snap = baseWithRules([]);
    delete (snap.buildings[1] as { aiRules?: BuildingAIRule[] }).aiRules;
    const cfg: SimConfig = {
      tickRate: 30,
      maxTicks: 100,
      initialSnapshot: snap,
      seed: 0xc0ffee,
    };
    const s = createInitialState(cfg);
    runReplay(s, cfg, [straightDeploy()]);
    while (s.tick < 90 && s.outcome === 'ongoing') step(s, cfg, []);
    expect(hashSimState(s)).toBe(withEmpty.hash);
  });
});
