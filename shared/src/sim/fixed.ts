// Q16.16 fixed-point arithmetic.
//
// The shared sim runs on fixed-point integers instead of floats so that every
// tick produces bit-identical output across V8 (Node), JavaScriptCore (iOS
// Safari / FB Instant WebView), and Gecko. Float ops differ in the last bit
// across engines; those bits diverge over thousands of ticks and break both
// async-raid replay validation and live-arena reconciliation.
//
// Format: signed 32-bit integer where the upper 16 bits are the integer part
// and the lower 16 bits are the fractional part. Range: [-32768, 32767.999…].
// That's plenty for a 16x12 base grid scaled to sub-pixel precision.

export const FIXED_SHIFT = 16;
export const FIXED_ONE = 1 << FIXED_SHIFT; // 65536
export const FIXED_HALF = FIXED_ONE >> 1;
export const FIXED_MASK = FIXED_ONE - 1;

export type Fixed = number; // branded semantically; still an int32 under the hood

export const fromInt = (n: number): Fixed => (n << FIXED_SHIFT) | 0;
export const fromFloat = (f: number): Fixed => Math.round(f * FIXED_ONE) | 0;
export const toFloat = (x: Fixed): number => x / FIXED_ONE;
export const toInt = (x: Fixed): number => x >> FIXED_SHIFT;

export const add = (a: Fixed, b: Fixed): Fixed => (a + b) | 0;
export const sub = (a: Fixed, b: Fixed): Fixed => (a - b) | 0;

// Multiply uses BigInt to avoid the >32-bit intermediate overflow that
// would otherwise silently truncate. BigInt is deterministic across engines.
export const mul = (a: Fixed, b: Fixed): Fixed =>
  Number((BigInt(a) * BigInt(b)) >> BigInt(FIXED_SHIFT)) | 0;

export const div = (a: Fixed, b: Fixed): Fixed =>
  Number((BigInt(a) << BigInt(FIXED_SHIFT)) / BigInt(b)) | 0;

export const neg = (a: Fixed): Fixed => (-a) | 0;
export const abs = (a: Fixed): Fixed => (a < 0 ? -a : a) | 0;
export const min = (a: Fixed, b: Fixed): Fixed => (a < b ? a : b);
export const max = (a: Fixed, b: Fixed): Fixed => (a > b ? a : b);
export const clamp = (x: Fixed, lo: Fixed, hi: Fixed): Fixed =>
  x < lo ? lo : x > hi ? hi : x;

// Integer square root on the fixed-point value.
// We compute sqrt(x * FIXED_ONE) so that the Q16.16 meaning is preserved:
// sqrt(Fixed(n)) should equal Fixed(sqrt(n)).
export function sqrt(x: Fixed): Fixed {
  if (x <= 0) return 0;
  const scaled = BigInt(x) << BigInt(FIXED_SHIFT);
  // Newton iteration on BigInt — deterministic.
  let lo = 0n;
  let hi = scaled;
  while (lo < hi) {
    const mid = (lo + hi + 1n) >> 1n;
    if (mid * mid <= scaled) lo = mid;
    else hi = mid - 1n;
  }
  return Number(lo) | 0;
}

// 8192-entry sine table covering [0, 2π). Entries are Q16.16.
// Precomputed with Math.sin at MODULE LOAD time and then FROZEN — at runtime
// the sim never calls Math.sin, so engine-specific trig drift is eliminated.
// The table itself is generated the same way on every engine because it uses
// the same input integers and Math.round to a Fixed — any last-bit Math.sin
// difference rounds to the same 16-bit fraction.
const SINE_RESOLUTION = 8192;
const SINE_TABLE: Int32Array = (() => {
  const t = new Int32Array(SINE_RESOLUTION);
  for (let i = 0; i < SINE_RESOLUTION; i++) {
    const angle = (i / SINE_RESOLUTION) * Math.PI * 2;
    t[i] = Math.round(Math.sin(angle) * FIXED_ONE) | 0;
  }
  return t;
})();

// Angle input is a Fixed in units of "turns" (one full turn = FIXED_ONE).
// This keeps angles in range and avoids any dependency on Math.PI at runtime.
export function sinTurns(turns: Fixed): Fixed {
  // Modulo into [0, FIXED_ONE). Bitmask works because FIXED_ONE is a power of 2.
  const t = turns & FIXED_MASK;
  const idx = (t * SINE_RESOLUTION) >>> FIXED_SHIFT;
  return SINE_TABLE[idx & (SINE_RESOLUTION - 1)]!;
}

export function cosTurns(turns: Fixed): Fixed {
  // cos(x) = sin(x + 0.25 turn)
  return sinTurns((turns + (FIXED_ONE >> 2)) | 0);
}

// atan2 in turns, implemented via binary search over the sine table.
// Used for unit facing and projectile aim. Deterministic because it never
// calls Math.atan.
export function atan2Turns(dy: Fixed, dx: Fixed): Fixed {
  if (dx === 0 && dy === 0) return 0;
  // Full-turn angle with 8192 resolution — coarse but fine for gameplay.
  // We use cross/dot signs to pick the quadrant.
  //
  // FIXED_ONE (65536) / SINE_RESOLUTION (8192) = 8 exactly, so converting
  // a table index to a Fixed "turn" is a `<< 3` — integer-only, keeps the
  // FPU out of the sim.
  let lo = 0;
  let hi = SINE_RESOLUTION;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    const a = mid << 3;
    const sx = cosTurns(a);
    const sy = sinTurns(a);
    // Compare cross product sign to determine side.
    const cross = mul(sx, dy) - mul(sy, dx);
    if (cross >= 0) hi = mid;
    else lo = mid;
  }
  return (lo << 3) | 0;
}

// Manhattan and Chebyshev distance — pathfinding helpers.
export const manhattan = (ax: Fixed, ay: Fixed, bx: Fixed, by: Fixed): Fixed =>
  (abs(ax - bx) + abs(ay - by)) | 0;

export const chebyshev = (ax: Fixed, ay: Fixed, bx: Fixed, by: Fixed): Fixed =>
  max(abs(ax - bx), abs(ay - by));

// Euclidean distance squared (cheap; use for range checks where comparing
// squared thresholds is fine).
export const dist2 = (ax: Fixed, ay: Fixed, bx: Fixed, by: Fixed): Fixed => {
  const dx = sub(ax, bx);
  const dy = sub(ay, by);
  return add(mul(dx, dx), mul(dy, dy));
};
