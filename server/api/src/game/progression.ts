// Progression math — sigmoid-shaped player power curve that delivers
// fast hook-phase progress and diminishing late-game returns. See
// docs/GAME_DESIGN.md §6 for the full design rationale.
//
// This module owns:
//   - LEVEL_COST_MULT    (Golden-ratio Fibonacci cost curve)
//   - K_FACTOR_BRACKETS  (ELO K-factor by trophy tier)
//   - upgradeCostMult(), trophyDelta(), expectedWinRate()
//
// The *stat* half of the curve (LEVEL_STAT_PERCENT) lives in
// shared/src/sim/progression.ts so the deterministic sim can import it
// without crossing the shared→server boundary. We re-export it here
// under LEVEL_STAT_PERCENT for convenience on the API side.

export {
  LEVEL_STAT_PERCENT,
  levelStatPercent,
  MAX_UNIT_LEVEL,
} from '@hive/shared/sim';

// ---------------------------------------------------------------------------
// Cost curve: Golden-ratio Fibonacci.
// ---------------------------------------------------------------------------
// Each entry is the multiplier applied to a unit's baseCost when
// upgrading FROM that index+1 TO index+2. So LEVEL_COST_MULT[0] = cost
// to go from L1 → L2; LEVEL_COST_MULT[8] = cost to go from L9 → L10.
//
// Derived from 0.5 × φ^L (φ ≈ 1.618) then smoothed to "round" numbers
// that land on human-readable price points. Each step is ~1.6× the
// previous — the empirically-found sweet spot for perceived
// progression pacing in Clash-likes.
//
// The leading 0.5× is a deliberate HOOK DISCOUNT: the very first
// upgrade is half-price. That one discount is what makes the first
// 10 minutes of play feel rewarding — the cheapest, biggest-impact
// dopamine hit we can offer without actually giving away free power.
export const LEVEL_COST_MULT: readonly number[] = [
  0.5,  // L1 → L2  (hook: first upgrade is half-price)
  1.0,  // L2 → L3
  1.6,  // L3 → L4
  2.6,  // L4 → L5
  4.2,  // L5 → L6
  6.8,  // L6 → L7
  11.0, // L7 → L8
  17.8, // L8 → L9
  28.8, // L9 → L10
];

// Returns the multiplier to apply to baseCost when upgrading FROM
// currentLevel TO currentLevel + 1. Returns null if the unit is
// already at (or past) the cap — callers should short-circuit with
// "max level" UX instead of trying to debit.
export function upgradeCostMult(currentLevel: number): number | null {
  if (currentLevel < 1) return LEVEL_COST_MULT[0]!;
  if (currentLevel >= LEVEL_COST_MULT.length + 1) return null;
  return LEVEL_COST_MULT[currentLevel - 1]!;
}

// ---------------------------------------------------------------------------
// Trophy ladder: ELO with tiered K-factor.
// ---------------------------------------------------------------------------
// Standard chess ELO with K varying by the attacker's current trophy
// bracket. Low trophies → high K (fast ramp, hook phase); high trophies
// → low K (plateau, mastery phase).
//
// Replaces the old flat table (+10/+20/+30 per star) which was
// inflationary at the bottom and signal-less at the top.

export interface KBracket {
  readonly upperBound: number; // exclusive; Infinity for the top tier
  readonly k: number;
}

export const K_FACTOR_BRACKETS: readonly KBracket[] = [
  { upperBound: 400,       k: 48 }, // hook: new players climb fast
  { upperBound: 1500,      k: 32 }, // standard chess K
  { upperBound: 3000,      k: 20 }, // reduced: settled ladder
  { upperBound: Infinity,  k: 12 }, // plateau: prestige grind
];

export function kFactor(attackerTrophies: number): number {
  for (const bracket of K_FACTOR_BRACKETS) {
    if (attackerTrophies < bracket.upperBound) return bracket.k;
  }
  // Unreachable (Infinity catches everything) — defensive default.
  return K_FACTOR_BRACKETS[K_FACTOR_BRACKETS.length - 1]!.k;
}

// ELO expected-win-rate. Returns a value in [0, 1] — the probability
// that `attackerTrophies` beats `defenderTrophies` in a theoretical
// even-odds match. Used to scale trophy deltas so beating a weaker
// opponent gains less than beating a stronger one.
export function expectedWinRate(attackerTrophies: number, defenderTrophies: number): number {
  const diff = defenderTrophies - attackerTrophies;
  return 1 / (1 + Math.pow(10, diff / 400));
}

// Dampen defender trophy loss relative to attacker gain to slightly
// inflate the ladder — casual players feel like they're progressing
// even across average-outcome sessions. If the median trophy count
// drifts up more than ~5%/month, lower this toward 1.0.
const DEFENDER_LOSS_RATIO = 0.8;

export interface TrophyDelta {
  att: number; // attacker trophy change (≥ 0 on any win)
  def: number; // defender trophy change (≤ 0)
}

// Compute trophy deltas for a raid outcome. `stars` is 0/1/2/3.
// On a 0-star raid neither side moves (matches existing behavior — a
// 0-star raid is a failed attempt, not a "defender win").
export function trophyDelta(params: {
  stars: 0 | 1 | 2 | 3;
  attackerTrophies: number;
  defenderTrophies: number;
}): TrophyDelta {
  const { stars, attackerTrophies, defenderTrophies } = params;

  if (stars === 0) return { att: 0, def: 0 };

  const k = kFactor(attackerTrophies);
  const actual = stars / 3; // 1/3, 2/3, 1.0
  const expected = expectedWinRate(attackerTrophies, defenderTrophies);
  const rawGain = k * (actual - expected);

  // Minimum of +1 for any successful raid — prevents "I 3-starred a
  // much weaker opponent and gained zero" no-op UX. Also guards
  // against floating-point rounding to 0.
  const gain = Math.max(1, Math.round(rawGain));
  const loss = -Math.max(1, Math.round(Math.abs(rawGain) * DEFENDER_LOSS_RATIO));

  return { att: gain, def: loss };
}
