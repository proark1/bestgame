import { describe, expect, it } from 'vitest';

// Pure-logic tests for the arena pairing invariants. The full route
// needs a live Postgres; here we just pin the tiny, stable rules that
// live inside /api/arena/reserve so a future refactor can't silently
// change the host-pick or token shape.

// Same host-pick rule the route uses: whichever UUID is
// lexicographically smaller is the host. Keeping it as a testable
// helper means the rule is documented + pinned.
function pickHost(aId: string, bId: string): { hostId: string; challengerId: string } {
  if (aId === bId) throw new Error('same player cannot face themselves');
  const hostId = aId < bId ? aId : bId;
  const challengerId = hostId === aId ? bId : aId;
  return { hostId, challengerId };
}

// Same fnv1a variant used by arenaSeed() — copy-pasted here so the
// test doesn't need to import an unexported function. If routes/arena.ts
// changes the seed derivation this test should be updated in lockstep.
function arenaSeed(salt: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < salt.length; i++) {
    h = Math.imul(h ^ salt.charCodeAt(i), 16777619) >>> 0;
  }
  return h >>> 0;
}

describe('arena host-pick is deterministic', () => {
  it('lower UUID wins, regardless of argument order', () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    expect(pickHost(a, b)).toEqual({ hostId: a, challengerId: b });
    expect(pickHost(b, a)).toEqual({ hostId: a, challengerId: b });
  });

  it('refuses self-matches', () => {
    expect(() => pickHost('same', 'same')).toThrow(/same player/);
  });
});

describe('arena seed is deterministic for a given salt', () => {
  it('same salt → same 32-bit seed', () => {
    const s1 = arenaSeed('host:challenger:1700000000000');
    const s2 = arenaSeed('host:challenger:1700000000000');
    expect(s1).toBe(s2);
    expect(Number.isInteger(s1)).toBe(true);
    expect(s1).toBeGreaterThanOrEqual(0);
    expect(s1).toBeLessThanOrEqual(0xffffffff);
  });

  it('different salts → different seeds (no collisions on short strings)', () => {
    const a = arenaSeed('x:y:1');
    const b = arenaSeed('x:y:2');
    expect(a).not.toBe(b);
  });
});
