import { describe, expect, it } from 'vitest';
import { deriveQueenTiers, MAX_QUEEN_LEVEL } from '../src/codex/queenTiers.js';

const COSTS = [
  { sugar: 500,   leafBits: 200,  aphidMilk: 0 },
  { sugar: 1500,  leafBits: 600,  aphidMilk: 0 },
  { sugar: 4000,  leafBits: 1500, aphidMilk: 0 },
  { sugar: 10000, leafBits: 3500, aphidMilk: 0 },
];

const RICH = { sugar: 99999, leafBits: 99999, aphidMilk: 999 };
const POOR = { sugar: 0, leafBits: 0, aphidMilk: 0 };

describe('deriveQueenTiers', () => {
  it('always returns one row per tier', () => {
    const rows = deriveQueenTiers({ currentQueenLevel: 1, resources: RICH, costs: COSTS });
    expect(rows).toHaveLength(MAX_QUEEN_LEVEL);
    expect(rows.map((r) => r.level)).toEqual([1, 2, 3, 4, 5]);
  });

  it('marks current / completed / locked correctly', () => {
    const rows = deriveQueenTiers({ currentQueenLevel: 3, resources: RICH, costs: COSTS });
    expect(rows[0]!.status).toBe('completed');
    expect(rows[1]!.status).toBe('completed');
    expect(rows[2]!.status).toBe('current');
    expect(rows[3]!.status).toBe('locked');
    expect(rows[4]!.status).toBe('locked');
  });

  it('returns null cost for tier 1', () => {
    const rows = deriveQueenTiers({ currentQueenLevel: 1, resources: RICH, costs: COSTS });
    expect(rows[0]!.costToReach).toBeNull();
  });

  it('returns the right cost for tiers 2–5', () => {
    const rows = deriveQueenTiers({ currentQueenLevel: 1, resources: RICH, costs: COSTS });
    expect(rows[1]!.costToReach).toEqual(COSTS[0]);
    expect(rows[4]!.costToReach).toEqual(COSTS[3]);
  });

  it('only flags affordability on the immediate next tier', () => {
    const rows = deriveQueenTiers({ currentQueenLevel: 1, resources: RICH, costs: COSTS });
    expect(rows[1]!.affordable).toBe(true);   // next, can afford
    expect(rows[2]!.affordable).toBe(false);  // skip-ahead → false even when rich
    expect(rows[3]!.affordable).toBe(false);
  });

  it('flags unaffordable when the wallet is short', () => {
    const rows = deriveQueenTiers({ currentQueenLevel: 1, resources: POOR, costs: COSTS });
    expect(rows[1]!.affordable).toBe(false);
  });

  it('handles missing/empty cost arrays', () => {
    const rows = deriveQueenTiers({ currentQueenLevel: 1, resources: RICH, costs: undefined });
    expect(rows[1]!.costToReach).toBeNull();
    expect(rows[1]!.affordable).toBe(false);
  });

  it('clamps out-of-range current levels', () => {
    const tooLow = deriveQueenTiers({ currentQueenLevel: 0, resources: RICH, costs: COSTS });
    expect(tooLow[0]!.status).toBe('current');
    const tooHigh = deriveQueenTiers({ currentQueenLevel: 99, resources: RICH, costs: COSTS });
    expect(tooHigh[4]!.status).toBe('current');
  });

  it('exposes the unlock lists per tier', () => {
    const rows = deriveQueenTiers({ currentQueenLevel: 1, resources: RICH, costs: COSTS });
    expect(rows[1]!.unitsUnlocked).toContain('FireAnt');
    expect(rows[2]!.unitsUnlocked).toContain('Termite');
    expect(rows[3]!.buildingsUnlocked).toContain('AphidFarm');
    expect(rows[4]!.unitsUnlocked).toContain('Scarab');
  });
});
