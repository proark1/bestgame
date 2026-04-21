// Per-level stat multipliers, expressed as integer percentages so sim
// math stays determinism-safe (no float rounding, no Math.log at call
// sites). See docs/GAME_DESIGN.md §6.3 for the design rationale.
//
// Shape: logarithmic diminishing returns approximating
//   1 + 0.25 × ln(L)
// with each entry rounded to a clean integer percentage. First upgrade
// (L1 → L2) is the biggest relative jump (+17%); later upgrades taper
// to +2–3%. Combined with the Fibonacci cost curve
// (server/api/src/game/progression.ts::LEVEL_COST_MULT) this produces
// the sigmoid-shaped power curve documented in the GDD.
//
// This array is the SINGLE source of truth for sim stat scaling.
// deploy.ts and combat.ts import from here instead of hand-coding the
// formula; server/api/src/game/progression.ts re-exports the same table
// so the UI renders identical numbers.

export const MAX_UNIT_LEVEL = 10;

// Index 0 = level 1 (baseline 100%), index 9 = level 10.
export const LEVEL_STAT_PERCENT: readonly number[] = [
  100, // L1
  117, // L2  (+17%)
  127, // L3  (+10%)
  135, // L4  (+8%)
  140, // L5  (+5%)
  145, // L6  (+5%)
  150, // L7  (+5%)
  155, // L8  (+5%)
  157, // L9  (+2%)
  160, // L10 (+3%)
];

export function levelStatPercent(level: number | undefined): number {
  if (!level || level <= 1) return LEVEL_STAT_PERCENT[0]!;
  const clamped = Math.min(MAX_UNIT_LEVEL, Math.floor(level));
  return LEVEL_STAT_PERCENT[clamped - 1]!;
}
