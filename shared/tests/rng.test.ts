import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/rng.js';

describe('PCG32 RNG', () => {
  it('produces identical sequences for identical seeds', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) {
      expect(a.nextU32()).toBe(b.nextU32());
    }
  });

  it('differs with different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    let diffs = 0;
    for (let i = 0; i < 100; i++) {
      if (a.nextU32() !== b.nextU32()) diffs++;
    }
    expect(diffs).toBeGreaterThan(90);
  });

  it('snapshot/restore preserves sequence', () => {
    const a = new Rng(99);
    a.nextU32();
    a.nextU32();
    const snap = a.snapshot();
    const next = a.nextU32();
    const restored = Rng.restore(snap);
    expect(restored.nextU32()).toBe(next);
  });

  it('nextIntBelow(n) stays in range', () => {
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.nextIntBelow(13);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(13);
    }
  });
});
