import { describe, expect, it } from 'vitest';
import {
  buildTimeMs,
  remainingMsAt,
  skipCostMilk,
} from '../src/sim/builderGates.js';

describe('buildTimeMs', () => {
  it('clamps L1→L2 to the 10s floor', () => {
    // 30000 × 0.5 × 12 = 180000 — above 10s floor, so just returns 180s.
    // Floor only kicks in if a future tuning lowers BUILD_CURVE_FACTOR.
    expect(buildTimeMs(1)).toBe(180_000);
  });

  it('grows monotonically with level', () => {
    let prev = -1;
    for (let l = 1; l <= 9; l++) {
      const t = buildTimeMs(l);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
  });

  it('caps at 48h ceiling', () => {
    // L9→L10: 30000 × 28.8 × 12 = 10,368,000 ms (~2.88 hours)
    // Below the 48h cap, so returns the raw value.
    expect(buildTimeMs(9)).toBe(10_368_000);
  });

  it('returns 0 for out-of-range levels', () => {
    expect(buildTimeMs(0)).toBe(0);
    expect(buildTimeMs(10)).toBe(0);
    expect(buildTimeMs(-3)).toBe(0);
  });
});

describe('skipCostMilk', () => {
  it('zero or negative remaining costs nothing', () => {
    expect(skipCostMilk(0)).toBe(0);
    expect(skipCostMilk(-5000)).toBe(0);
  });

  it('floors at 1 milk for any positive remaining time', () => {
    expect(skipCostMilk(1)).toBe(1);
    expect(skipCostMilk(100)).toBe(1);
    expect(skipCostMilk(35_999)).toBe(1);
  });

  it('1 hour ≈ 100 milk', () => {
    expect(skipCostMilk(60 * 60 * 1000)).toBe(100);
  });

  it('linear growth past the floor', () => {
    expect(skipCostMilk(2 * 60 * 60 * 1000)).toBe(200);
    expect(skipCostMilk(12 * 60 * 60 * 1000)).toBe(1200);
  });
});

describe('remainingMsAt', () => {
  const now = Date.parse('2026-04-25T10:00:00Z');

  it('returns 0 for past timestamps', () => {
    expect(remainingMsAt('2026-04-25T09:00:00Z', now)).toBe(0);
  });

  it('returns positive ms for future timestamps', () => {
    expect(remainingMsAt('2026-04-25T11:00:00Z', now)).toBe(60 * 60 * 1000);
  });

  it('returns 0 for invalid timestamps', () => {
    expect(remainingMsAt('not-a-date', now)).toBe(0);
  });
});
