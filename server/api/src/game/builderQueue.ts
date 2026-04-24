// Builder queue — the daily-check-in lever. Upgrades (unit levels,
// queen levels, building levels) no longer resolve instantly. They
// enter a queue with a real-time duration, filling one of the player's
// builder slots until they finish. The free daily skip converts one
// pending upgrade into instant-done, once per UTC day.
//
// Design goals:
//   1. Generous free-to-play flow. Tier 1–3 upgrades are near-instant
//      (5 minutes or less) so new players don't feel time-walled in
//      the first session. Late-tier upgrades stretch to 24–48 hours.
//   2. Predictable math. The timer comes from a pure function of
//      (kind, level-to); no RNG, no server-side knobs. Balance is
//      visible in one table.
//   3. Free-to-play kindness. Every UTC day, every player gets one
//      instant-skip — not just paying ones. AphidMilk skips layer on
//      top of that.

export type BuilderTargetKind = 'unit' | 'building' | 'queen';

// Duration in seconds per "level to" — indexed by the level the
// upgrade will arrive at (so L2 == index 2). Entries up to 10 cover
// the max level cap; past that we clamp to the last bucket.
//
// Curve: 10s → 30s → 2m → 5m → 15m → 1h → 4h → 12h → 24h → 48h.
// The first three tiers intentionally feel instant so the first
// session still has the "snap" that keeps new players playing.
export const BUILD_DURATION_SECONDS: ReadonlyArray<number> = [
  0,      // L1 (default, never built)
  10,     // L2
  30,     // L3
  120,    // L4 = 2m
  300,    // L5 = 5m
  900,    // L6 = 15m
  3600,   // L7 = 1h
  14400,  // L8 = 4h
  43200,  // L9 = 12h
  86400,  // L10 = 24h
  172800, // L11+ clamped = 48h
];

export function buildDurationSeconds(levelTo: number, kind: BuilderTargetKind): number {
  const idx = Math.max(1, Math.min(BUILD_DURATION_SECONDS.length - 1, levelTo));
  const base = BUILD_DURATION_SECONDS[idx]!;
  // Queen upgrades are larger, more structural — add 50% to their
  // timer so the queen feels like a real milestone. Building
  // upgrades are the same as unit upgrades for now.
  if (kind === 'queen') return Math.round(base * 1.5);
  return base;
}

// AphidMilk cost to skip a pending upgrade. Scales with remaining time.
// Cheap early (nudge purchases for a new player willing to pay a little
// to test it) and capped so long upgrades don't become oppressive.
export function aphidMilkSkipCost(secondsRemaining: number): number {
  if (secondsRemaining <= 0) return 0;
  // 1 AM per minute remaining, rounded up, clamped 1..60.
  const cost = Math.ceil(secondsRemaining / 60);
  return Math.max(1, Math.min(60, cost));
}

export const DEFAULT_BUILDER_SLOTS = 2;
export const MAX_BUILDER_SLOTS = 5;

export interface BuilderQueueEntry {
  id: string;            // bigserial stringified
  targetKind: BuilderTargetKind;
  targetId: string;
  levelTo: number;
  startedAt: string;
  endsAt: string;
  secondsRemaining: number;
  skipCostAphidMilk: number;
}
