import { describe, expect, it } from 'vitest';
import { isQuietHourActive } from '../src/routes/matchmaking.js';

// Pure-logic check on the wrap-around "is the player in their
// quiet window?" math. The DB-side fragment in matchmaking.ts
// uses the same modulo formula, so pinning the helper here
// guards both surfaces.

describe('isQuietHourActive', () => {
  it('returns false when start is null (feature disabled)', () => {
    expect(isQuietHourActive(null, 3, 0)).toBe(false);
    expect(isQuietHourActive(null, 3, 12)).toBe(false);
  });

  it('returns false when length is 0', () => {
    expect(isQuietHourActive(0, 0, 0)).toBe(false);
  });

  it('returns true when current hour is exactly the start', () => {
    expect(isQuietHourActive(22, 3, 22)).toBe(true);
  });

  it('returns true throughout the inclusive-start window', () => {
    expect(isQuietHourActive(22, 3, 22)).toBe(true);
    expect(isQuietHourActive(22, 3, 23)).toBe(true);
    expect(isQuietHourActive(22, 3, 0)).toBe(true); // wrap
  });

  it('returns false at start + length (exclusive end)', () => {
    expect(isQuietHourActive(22, 3, 1)).toBe(false);
  });

  it('returns false outside the window', () => {
    expect(isQuietHourActive(22, 3, 12)).toBe(false);
    expect(isQuietHourActive(22, 3, 21)).toBe(false);
  });

  it('handles a non-wrapping window', () => {
    expect(isQuietHourActive(2, 3, 1)).toBe(false);
    expect(isQuietHourActive(2, 3, 2)).toBe(true);
    expect(isQuietHourActive(2, 3, 4)).toBe(true);
    expect(isQuietHourActive(2, 3, 5)).toBe(false);
  });

  it('handles maximum length (3 h)', () => {
    expect(isQuietHourActive(0, 3, 0)).toBe(true);
    expect(isQuietHourActive(0, 3, 2)).toBe(true);
    expect(isQuietHourActive(0, 3, 3)).toBe(false);
  });
});
