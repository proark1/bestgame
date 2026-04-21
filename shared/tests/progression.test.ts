import { describe, expect, it } from 'vitest';
import {
  LEVEL_STAT_PERCENT,
  MAX_UNIT_LEVEL,
  levelStatPercent,
} from '../src/sim/progression.js';

// The sim's stat-scaling table is the determinism-safe half of the
// progression curve. If these assertions ever break, the shape of the
// curve changed — cross-reference with docs/GAME_DESIGN.md §6.3 and
// server/api/src/game/progression.ts before retuning.

describe('sim progression table', () => {
  it('has exactly MAX_UNIT_LEVEL entries', () => {
    expect(LEVEL_STAT_PERCENT.length).toBe(MAX_UNIT_LEVEL);
  });

  it('L1 is baseline 100%', () => {
    expect(LEVEL_STAT_PERCENT[0]).toBe(100);
  });

  it('every entry is an integer percent (no float-rounding bugs in the sim)', () => {
    for (const pct of LEVEL_STAT_PERCENT) {
      expect(Number.isInteger(pct)).toBe(true);
      expect(pct).toBeGreaterThanOrEqual(100);
    }
  });

  it('is monotonically non-decreasing', () => {
    for (let i = 1; i < LEVEL_STAT_PERCENT.length; i++) {
      expect(LEVEL_STAT_PERCENT[i]!).toBeGreaterThanOrEqual(
        LEVEL_STAT_PERCENT[i - 1]!,
      );
    }
  });

  it('gains diminish: L1→L2 jump exceeds L9→L10 jump', () => {
    const early = LEVEL_STAT_PERCENT[1]! - LEVEL_STAT_PERCENT[0]!;
    const late = LEVEL_STAT_PERCENT[9]! - LEVEL_STAT_PERCENT[8]!;
    expect(early).toBeGreaterThan(late);
  });

  it('levelStatPercent clamps undefined / ≤1 / past-cap values', () => {
    expect(levelStatPercent(undefined)).toBe(100);
    expect(levelStatPercent(0)).toBe(100);
    expect(levelStatPercent(1)).toBe(100);
    expect(levelStatPercent(999)).toBe(LEVEL_STAT_PERCENT[MAX_UNIT_LEVEL - 1]);
  });
});
