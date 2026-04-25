-- Colony Rank — meta progression. `total_invested` is the running sum
-- of every sugar+leaf the player has spent on upgrades / placements /
-- queen tiers. Colony Rank is computed from it (floor log2 curve) and
-- gates the per-raid loot ceiling so a maxed late-game player can't
-- farm beginner bases for runaway loot.
--
-- See docs/GAME_DESIGN.md §6.7 for the formula and design rationale.
-- Rank is *not* persisted — it's a pure function of total_invested,
-- so re-tuning the formula needs no data migration.
--
-- Default 0 backfills cleanly for existing players (they start at
-- rank 0 and climb naturally as they spend going forward).
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS total_invested BIGINT NOT NULL DEFAULT 0;
