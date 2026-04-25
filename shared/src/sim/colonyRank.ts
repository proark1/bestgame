// Colony Rank — meta progression curve. A pure function of the player's
// running `total_invested` (sum of all sugar + leaf they've ever spent).
// See docs/GAME_DESIGN.md §6.7.
//
// Used by:
//   - server/api/src/routes/raid.ts to clamp per-raid loot (a maxed
//     player raiding a starter base shouldn't cash a giant payout)
//   - server/api/src/routes/player.ts to surface the rank on /me so
//     the client can render it in the HUD / profile
//
// The curve is `floor(log2(1 + x / 1000))`, calibrated against the
// cost-curve totals from §6.2 so:
//   - rank 0 = first raid (player has spent < 1000)
//   - rank 5 = mid-game (~31k invested ≈ Q3 + a few unit upgrades)
//   - rank 10 = late game (~1M invested ≈ Q5 + most units mid-tier)
// Rank 15 corresponds to ~32M invested — well past any practical
// account, so we treat it as the de-facto cap.

export const MAX_COLONY_RANK = 15;

// Floor base loot ceiling at rank 0. Roughly the destruction-drop sum
// of a starter Q1 base (660 sugar / 40 leaf with floor-of-200), so a
// fresh attacker against a fresh defender takes home almost all of it.
const BASE_LOOT_CAP_SUGAR = 600;
const BASE_LOOT_CAP_LEAF = 200;

// Each rank adds another 50% of the base cap. Linear (not exponential)
// so a rank-10 attacker can carry away ~6× a rank-0 attacker — enough
// to make raiding harder targets pay, not enough to invalidate weaker
// bases as a farm forever.
const PER_RANK_CAP_GROWTH = 0.5;

export function colonyRankFromInvested(
  totalInvested: number | bigint | string,
): number {
  // Coerce BigInt / numeric string safely. Postgres BIGINT comes back
  // through node-pg as a string, so we accept that flavor too. A
  // precision wobble at 2^53+ is fine since rank caps at MAX_COLONY_RANK
  // long before then.
  let tot: number;
  if (typeof totalInvested === 'bigint') tot = Number(totalInvested);
  else if (typeof totalInvested === 'string') tot = Number(totalInvested);
  else tot = totalInvested;
  if (!Number.isFinite(tot) || tot <= 0) return 0;
  const raw = Math.floor(Math.log2(1 + tot / 1000));
  return Math.max(0, Math.min(MAX_COLONY_RANK, raw));
}

export interface LootCap {
  sugar: number;
  leafBits: number;
}

export function lootCapForRank(rank: number): LootCap {
  const r = Math.max(0, Math.min(MAX_COLONY_RANK, Math.floor(rank)));
  const factor = 1 + r * PER_RANK_CAP_GROWTH;
  return {
    sugar: Math.round(BASE_LOOT_CAP_SUGAR * factor),
    leafBits: Math.round(BASE_LOOT_CAP_LEAF * factor),
  };
}

// Convenience wrapper — pure function, used by both the server (to
// debit before /raid/submit credits) and the client (to render the
// "loot cap: X" hint in the raid HUD before the player commits).
export function clampLootByRank(
  rank: number,
  loot: { sugar: number; leafBits: number },
): { sugar: number; leafBits: number; capped: boolean } {
  const cap = lootCapForRank(rank);
  const sugarCapped = Math.min(loot.sugar, cap.sugar);
  const leafCapped = Math.min(loot.leafBits, cap.leafBits);
  return {
    sugar: sugarCapped,
    leafBits: leafCapped,
    capped: sugarCapped < loot.sugar || leafCapped < loot.leafBits,
  };
}
