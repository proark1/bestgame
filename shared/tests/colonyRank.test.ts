import { describe, expect, it } from 'vitest';
import {
  MAX_COLONY_RANK,
  clampLootByRank,
  colonyRankFromInvested,
  lootCapForRank,
} from '../src/sim/colonyRank.js';

describe('colonyRankFromInvested', () => {
  it('rank 0 below 1000', () => {
    expect(colonyRankFromInvested(0)).toBe(0);
    expect(colonyRankFromInvested(500)).toBe(0);
    expect(colonyRankFromInvested(999)).toBe(0);
  });

  it('rank advances 1 per ~doubling of total', () => {
    expect(colonyRankFromInvested(1000)).toBe(1);
    expect(colonyRankFromInvested(3000)).toBe(2);
    expect(colonyRankFromInvested(7000)).toBe(3);
    expect(colonyRankFromInvested(31000)).toBe(5);
  });

  it('caps at MAX_COLONY_RANK', () => {
    // A rank that would otherwise exceed MAX_COLONY_RANK clamps down.
    // 2^16 × 1000 = 65,536,000 → log2 hits 16, but we cap at 15.
    expect(colonyRankFromInvested(65_536_000)).toBe(MAX_COLONY_RANK);
    expect(colonyRankFromInvested(1e15)).toBe(MAX_COLONY_RANK);
  });

  it('accepts bigint and string inputs', () => {
    expect(colonyRankFromInvested(BigInt(1500))).toBe(1);
    expect(colonyRankFromInvested('1500')).toBe(1);
    expect(colonyRankFromInvested('0')).toBe(0);
    expect(colonyRankFromInvested('not-a-number')).toBe(0);
  });

  it('floors negative / NaN to 0', () => {
    expect(colonyRankFromInvested(-1)).toBe(0);
    expect(colonyRankFromInvested(NaN)).toBe(0);
  });
});

describe('lootCapForRank', () => {
  it('rank 0 returns base cap', () => {
    expect(lootCapForRank(0)).toEqual({ sugar: 600, leafBits: 200 });
  });

  it('cap grows linearly per rank', () => {
    expect(lootCapForRank(1)).toEqual({ sugar: 900, leafBits: 300 });
    expect(lootCapForRank(5)).toEqual({ sugar: 2100, leafBits: 700 });
    expect(lootCapForRank(10)).toEqual({ sugar: 3600, leafBits: 1200 });
  });

  it('out-of-range rank clamps to bounds', () => {
    expect(lootCapForRank(-1)).toEqual({ sugar: 600, leafBits: 200 });
    expect(lootCapForRank(99)).toEqual(lootCapForRank(MAX_COLONY_RANK));
  });
});

describe('clampLootByRank', () => {
  it('returns loot unchanged when below cap', () => {
    expect(
      clampLootByRank(2, { sugar: 200, leafBits: 50 }),
    ).toEqual({ sugar: 200, leafBits: 50, capped: false });
  });

  it('clamps and flags when above cap', () => {
    // Rank 0 cap: 600 sugar / 200 leaf
    const res = clampLootByRank(0, { sugar: 1000, leafBits: 250 });
    expect(res.sugar).toBe(600);
    expect(res.leafBits).toBe(200);
    expect(res.capped).toBe(true);
  });

  it('partial clamp still flags', () => {
    // Sugar over, leaf under
    const res = clampLootByRank(0, { sugar: 999, leafBits: 50 });
    expect(res.sugar).toBe(600);
    expect(res.leafBits).toBe(50);
    expect(res.capped).toBe(true);
  });
});
