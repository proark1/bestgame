import { describe, expect, it } from 'vitest';
import {
  LEVEL_COST_MULT,
  MAX_UNIT_LEVEL,
  expectedWinRate,
  kFactor,
  trophyDelta,
  upgradeCostMult,
} from '../src/game/progression.js';
import { upgradeCost } from '../src/game/upgradeCosts.js';
import { LEVEL_STAT_PERCENT } from '@hive/shared/sim';

// Progression curve is the single most important balance knob in the
// game; assertions below pin its shape so a "quick tweak" can't silently
// flatten the sigmoid. See docs/GAME_DESIGN.md §6 for intent.

describe('cost curve — Golden-ratio Fibonacci', () => {
  it('has exactly MAX_UNIT_LEVEL - 1 entries (one per L→L+1 transition)', () => {
    expect(LEVEL_COST_MULT.length).toBe(MAX_UNIT_LEVEL - 1);
  });

  it('first upgrade is a hook discount (< 1×)', () => {
    expect(LEVEL_COST_MULT[0]).toBeLessThan(1);
  });

  it('is strictly monotonically increasing after the discount', () => {
    for (let i = 1; i < LEVEL_COST_MULT.length; i++) {
      expect(LEVEL_COST_MULT[i]!).toBeGreaterThan(LEVEL_COST_MULT[i - 1]!);
    }
  });

  it('each step is roughly the golden ratio (~1.6×)', () => {
    // Skip the first step since that's the hook-discount anomaly.
    for (let i = 2; i < LEVEL_COST_MULT.length; i++) {
      const ratio = LEVEL_COST_MULT[i]! / LEVEL_COST_MULT[i - 1]!;
      expect(ratio).toBeGreaterThan(1.4);
      expect(ratio).toBeLessThan(1.8);
    }
  });

  it('upgradeCostMult returns null past the cap', () => {
    expect(upgradeCostMult(MAX_UNIT_LEVEL)).toBeNull();
    expect(upgradeCostMult(MAX_UNIT_LEVEL + 5)).toBeNull();
  });

  it('upgradeCost returns null at cap', () => {
    expect(upgradeCost('SoldierAnt', MAX_UNIT_LEVEL)).toBeNull();
  });

  it('upgradeCost applies the curve to baseCost', () => {
    const l1 = upgradeCost('SoldierAnt', 1)!;
    const l9 = upgradeCost('SoldierAnt', 9)!;
    // L9→L10 (28.8×) should cost dramatically more than L1→L2 (0.5×).
    expect(l9.sugar / l1.sugar).toBeGreaterThan(50);
  });
});

describe('stat curve — logarithmic diminishing returns', () => {
  it('is strictly monotonically non-decreasing', () => {
    for (let i = 1; i < LEVEL_STAT_PERCENT.length; i++) {
      expect(LEVEL_STAT_PERCENT[i]!).toBeGreaterThanOrEqual(
        LEVEL_STAT_PERCENT[i - 1]!,
      );
    }
  });

  it('baseline is exactly 100% at L1', () => {
    expect(LEVEL_STAT_PERCENT[0]).toBe(100);
  });

  it('per-level stat GAIN shrinks with level (diminishing returns)', () => {
    // Early gains (L1→L2, L2→L3) should exceed late gains (L8→L9, L9→L10).
    const earlyGain = LEVEL_STAT_PERCENT[1]! - LEVEL_STAT_PERCENT[0]!;
    const lateGain = LEVEL_STAT_PERCENT[9]! - LEVEL_STAT_PERCENT[8]!;
    expect(earlyGain).toBeGreaterThan(lateGain);
  });
});

describe('progression envelope — stat-per-cost drops', () => {
  // The defining property of a "fast-early then slowing" curve: the
  // ratio of stat gained to cost paid drops monotonically. If this
  // test fails, a tweak broke the sigmoid shape — go re-read the GDD.
  it('stat-gain-per-cost is monotonically decreasing after the hook', () => {
    const ratios: number[] = [];
    for (let i = 0; i < LEVEL_COST_MULT.length; i++) {
      const statDelta = LEVEL_STAT_PERCENT[i + 1]! - LEVEL_STAT_PERCENT[i]!;
      ratios.push(statDelta / LEVEL_COST_MULT[i]!);
    }
    // Skip index 0 (hook discount inflates ratio[0] by design) — check
    // ratio[1..] strictly decreases.
    for (let i = 2; i < ratios.length; i++) {
      expect(ratios[i]!).toBeLessThan(ratios[i - 1]!);
    }
  });
});

describe('trophy ladder — ELO with tiered K-factor', () => {
  it('K drops as trophies rise (hook → plateau)', () => {
    expect(kFactor(100)).toBeGreaterThan(kFactor(1000));
    expect(kFactor(1000)).toBeGreaterThan(kFactor(2000));
    expect(kFactor(2000)).toBeGreaterThan(kFactor(5000));
  });

  it('expectedWinRate is 0.5 at equal trophies', () => {
    expect(expectedWinRate(1000, 1000)).toBeCloseTo(0.5, 5);
  });

  it('expected rises toward 1 as attacker dominates', () => {
    expect(expectedWinRate(2000, 1000)).toBeGreaterThan(0.9);
    expect(expectedWinRate(1000, 2000)).toBeLessThan(0.1);
  });

  it('0-star raid moves no trophies', () => {
    const d = trophyDelta({ stars: 0, attackerTrophies: 500, defenderTrophies: 500 });
    expect(d.att).toBe(0);
    expect(d.def).toBe(0);
  });

  it('winning grants at least +1 trophy (no no-op wins)', () => {
    // Stomping a much weaker opponent — expected ~1.0, actual 1.0,
    // raw gain near 0. Floor guarantees a visible reward.
    const d = trophyDelta({ stars: 3, attackerTrophies: 3000, defenderTrophies: 500 });
    expect(d.att).toBeGreaterThanOrEqual(1);
  });

  it('defender loss is dampened relative to attacker gain (slight inflation)', () => {
    const d = trophyDelta({ stars: 3, attackerTrophies: 1000, defenderTrophies: 1000 });
    expect(d.att).toBeGreaterThan(0);
    expect(-d.def).toBeLessThanOrEqual(d.att);
  });

  it('new player (hook bracket) climbs fast on a fair 3★ win', () => {
    // At t=100 (K=48), expected ≈ 0.5, actual = 1.0 → gain ≈ 24.
    const d = trophyDelta({ stars: 3, attackerTrophies: 100, defenderTrophies: 100 });
    expect(d.att).toBeGreaterThan(20);
    expect(d.att).toBeLessThan(30);
  });

  it('veteran (plateau bracket) climbs slowly on a fair 3★ win', () => {
    // At t=3500 (K=12), expected ≈ 0.5, actual = 1.0 → gain ≈ 6.
    const d = trophyDelta({ stars: 3, attackerTrophies: 3500, defenderTrophies: 3500 });
    expect(d.att).toBeLessThan(10);
  });
});
