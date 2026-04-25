// Builder time gates. When a player queues a building upgrade, the
// cost is debited immediately, but the level bump is delayed by a
// timer that scales with the upgrade's cost-curve multiplier. Players
// can spend AphidMilk to skip the timer — the planned monetization
// hook (GDD §6.6 / §9). All math lives here as pure functions so the
// server (authoritative timer) and the client (countdown UI + skip
// price preview) compute identical numbers.
//
// Used by:
//   - server/api/src/routes/player.ts upgrade-building endpoint to
//     compute completesAt
//   - server/api/src/routes/player.ts /me to lazily finalize expired
//     pendings
//   - server/api/src/routes/player.ts builder/skip endpoint to charge
//     the right milk amount
//   - client/src/ui/buildingInfoModal.ts to render the countdown +
//     skip CTA on a pending building

// Base build time (ms) for an L1→L2 upgrade before the cost-curve
// multiplier applies. Tuned so the very first upgrade of the player's
// life clamps to BUILD_TIME_FLOOR_MS (10s) — short enough to feel like
// a tutorial, long enough to teach the gate exists.
const BASE_BUILD_TIME_MS = 30 * 1000;

// Aggressive curve multiplier so the late-game tier feels like a real
// investment rather than another instant flip. With LEVEL_COST_MULT
// L9→L10 = 28.8, this puts the final tier upgrade at ~3 hours — a
// natural "log off and come back" beat that pulls the player into a
// second session of the day.
const BUILD_CURVE_FACTOR = 12;

const BUILD_TIME_FLOOR_MS = 10 * 1000; // 10s floor
const BUILD_TIME_CEIL_MS = 48 * 60 * 60 * 1000; // 48h ceiling

// Cost-curve multipliers, keyed by FROM-level. Mirrors the server's
// LEVEL_COST_MULT so a balance change to one (without the other)
// surfaces as a consistency test failure rather than a silent skew.
const LEVEL_COST_MULT: readonly number[] = [
  0.5, 1.0, 1.6, 2.6, 4.2, 6.8, 11.0, 17.8, 28.8,
];

// Total wall-clock time (ms) that an upgrade from `currentLevel`
// → `currentLevel + 1` should take. Returns 0 for upgrades past the
// curve (the caller should reject these as "max level" first; the 0
// is a safety value, not a green light).
export function buildTimeMs(currentLevel: number): number {
  if (currentLevel < 1 || currentLevel > LEVEL_COST_MULT.length) return 0;
  const mult = LEVEL_COST_MULT[currentLevel - 1]!;
  const raw = BASE_BUILD_TIME_MS * mult * BUILD_CURVE_FACTOR;
  return Math.max(BUILD_TIME_FLOOR_MS, Math.min(BUILD_TIME_CEIL_MS, raw));
}

// AphidMilk price to skip the remaining time on a pending upgrade.
// Linear in remaining time so a player who waits half the build time
// pays half the skip cost (encourages "skip the last few minutes"
// rather than "skip the whole thing as soon as you queue it").
//
// 36 ms-per-milk = 100 milk per hour skipped. Designed so a single
// AphidFarm L1 (0.2 milk/sec → 720 milk/hr) covers ~7 hours of skips
// per online hour — generous but not unlimited. Real IAP will want
// to dwarf this rate.
const MS_PER_MILK = 36 * 1000;

export function skipCostMilk(remainingMs: number): number {
  if (remainingMs <= 0) return 0;
  return Math.max(1, Math.ceil(remainingMs / MS_PER_MILK));
}

// Convenience wrapper for the route layer — given a pendingCompletesAt
// ISO string and a now() ms timestamp, returns the remaining time in
// ms (clamped at 0).
export function remainingMsAt(completesAtIso: string, nowMs: number): number {
  const t = Date.parse(completesAtIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, t - nowMs);
}
