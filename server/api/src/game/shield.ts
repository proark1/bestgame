// Raid shield — the classic CoC-style attack cooldown.
//
// A defender who loses 2+ stars on a raid gets a 4-hour protection
// window during which matchmaking refuses to send them as a target.
// Shorter wins (1 star or less) don't trigger a shield — the attacker
// didn't really hurt you, so you stay in the queue.
//
// Duration is intentionally modest: enough to protect a player from
// a bad-luck chain of attacks while they rebuild, but short enough
// that the pool of active targets stays liquid. If median queue times
// for raids stretch, lower SHIELD_HOURS or raise the star threshold.

export const SHIELD_HOURS_ON_2_STAR = 3;
export const SHIELD_HOURS_ON_3_STAR = 5;

// Returns the Postgres interval string (or null if no shield earned)
// for a given star count against the defender. Caller applies this
// as `NOW() + ($x || ' hours')::INTERVAL` to avoid clock drift
// between node and the DB.
export function shieldHoursForStars(stars: 0 | 1 | 2 | 3): number | null {
  if (stars >= 3) return SHIELD_HOURS_ON_3_STAR;
  if (stars >= 2) return SHIELD_HOURS_ON_2_STAR;
  return null;
}
