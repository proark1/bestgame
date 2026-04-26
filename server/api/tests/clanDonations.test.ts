import { describe, expect, it } from 'vitest';
import { clampRequestCount, isAllowedRequestKind } from '../src/routes/clan.js';

// Pure-logic guards for the new clan donation endpoints. The full
// route exercises the DB; here we pin the small input-validation
// rules so a regression can't slip through silently.

describe('clampRequestCount', () => {
  it('returns null for non-numeric input', () => {
    expect(clampRequestCount(undefined)).toBeNull();
    expect(clampRequestCount(null)).toBeNull();
    expect(clampRequestCount('5')).toBeNull();
    expect(clampRequestCount(NaN)).toBeNull();
  });

  it('returns null for zero / negative counts', () => {
    expect(clampRequestCount(0)).toBeNull();
    expect(clampRequestCount(-3)).toBeNull();
  });

  it('passes through valid mid-range counts', () => {
    expect(clampRequestCount(1)).toBe(1);
    expect(clampRequestCount(5)).toBe(5);
    expect(clampRequestCount(10)).toBe(10);
  });

  it('clamps oversized counts to the max', () => {
    expect(clampRequestCount(11)).toBe(10);
    expect(clampRequestCount(99)).toBe(10);
  });

  it('floors fractional counts before clamping', () => {
    expect(clampRequestCount(3.7)).toBe(3);
    expect(clampRequestCount(0.4)).toBeNull();
  });
});

describe('isAllowedRequestKind', () => {
  it('accepts the common attacker kinds', () => {
    expect(isAllowedRequestKind('SoldierAnt')).toBe(true);
    expect(isAllowedRequestKind('FireAnt')).toBe(true);
    expect(isAllowedRequestKind('Mantis')).toBe(true);
  });

  it('rejects defender / system-only kinds', () => {
    expect(isAllowedRequestKind('NestSpider')).toBe(false);
    expect(isAllowedRequestKind('MiniScarab')).toBe(false);
  });

  it('rejects garbage', () => {
    expect(isAllowedRequestKind('')).toBe(false);
    expect(isAllowedRequestKind(undefined)).toBe(false);
    expect(isAllowedRequestKind(42)).toBe(false);
    expect(isAllowedRequestKind('not-a-real-kind')).toBe(false);
  });
});
