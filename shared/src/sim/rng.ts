// PCG32 — a small, fast, high-quality PRNG with well-defined bitwise
// behavior across engines. We use it instead of Math.random() because:
//   1. Math.random() is not seeded and not reproducible.
//   2. Some engines implement it with subtly different algorithms.
// PCG32 uses only integer ops that JavaScript's int32 semantics define
// identically everywhere: BigInt for the 64-bit state, then truncation.
//
// Reference: https://www.pcg-random.org/
//
// Use one RNG per sim instance. Never call Math.random() inside the sim.

const MUL = 6364136223846793005n;
const INC_DEFAULT = 1442695040888963407n;
const MASK_64 = (1n << 64n) - 1n;
const MASK_32 = (1n << 32n) - 1n;

export class Rng {
  private state: bigint;
  private readonly inc: bigint;

  constructor(seed: number, streamId = 0) {
    // Seed into state using the reference init algorithm.
    this.inc = ((BigInt(streamId) << 1n) | 1n) & MASK_64;
    this.state = 0n;
    this.nextU32();
    this.state = (this.state + BigInt.asUintN(64, BigInt(seed))) & MASK_64;
    this.nextU32();
  }

  // Core 32-bit draw — all other helpers derive from this.
  nextU32(): number {
    const oldstate = this.state;
    this.state = (oldstate * MUL + (this.inc || INC_DEFAULT)) & MASK_64;
    const xorshifted = (((oldstate >> 18n) ^ oldstate) >> 27n) & MASK_32;
    const rot = Number((oldstate >> 59n) & 31n);
    const rotated = ((xorshifted >> BigInt(rot)) | (xorshifted << BigInt(-rot & 31))) & MASK_32;
    return Number(rotated);
  }

  // Uniform integer in [0, boundExclusive). Uses rejection to avoid bias.
  nextIntBelow(boundExclusive: number): number {
    if (boundExclusive <= 0) return 0;
    const threshold = (2 ** 32 - boundExclusive) % boundExclusive;
    // Reject values that would skew the distribution; in practice loops < 2x.
    while (true) {
      const r = this.nextU32();
      if (r >= threshold) return r % boundExclusive;
    }
  }

  // Inclusive/exclusive integer in [lo, hi).
  nextIntRange(lo: number, hi: number): number {
    return lo + this.nextIntBelow(hi - lo);
  }

  // Fractional draw in [0, 1) as a float — AVOID inside the sim; exposed
  // only for tests/UI. Uses 24 bits to stay exactly representable as float.
  nextUnitFloat(): number {
    return (this.nextU32() >>> 8) / (1 << 24);
  }

  // Snapshot/restore state — used for determinism tests and replay validation.
  snapshot(): { state: string; inc: string } {
    return { state: this.state.toString(), inc: this.inc.toString() };
  }

  static restore(snap: { state: string; inc: string }): Rng {
    const r = new Rng(0, 0);
    (r as unknown as { state: bigint }).state = BigInt(snap.state);
    (r as unknown as { inc: bigint }).inc = BigInt(snap.inc);
    return r;
  }
}
