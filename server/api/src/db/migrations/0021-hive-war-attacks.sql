-- Hive war attack mechanics — closes step-8 follow-on after #100.
--
-- #100 shipped seasons + enrollment + the map view. Attack mechanics
-- were explicitly deferred. This adds the per-attack ledger plus a
-- daily-cap counter so a clan can't snipe the same target dozens of
-- times in a row.
--
-- Score model (v1):
--   - Each attack scores 1..3 points based on stars (same scale as
--     raids). The attacker's enrollment.score grows by that amount;
--     the defender's enrollment.attacks_received counter ticks.
--   - 3 attacks per attacker per UTC day per season.
--   - An attack reuses the standard /raid/submit path under the hood;
--     /hivewar/season/:id/attack just records the result against the
--     hive-war ledger. Anti-cheat (replay validation) stays in raid.ts.
--
-- Future PR can layer in:
--   - Neighbour-only targeting (right now any enrolled clan is fair game)
--   - State auto-transitions (open → active on N enrollments / starts_at;
--     active → finished on ends_at)
--   - Reward sweep on finalisation (top-3 clans get bonus sugar / leaf)

CREATE TABLE IF NOT EXISTS hive_war_attacks (
  id                 BIGSERIAL PRIMARY KEY,
  season_id          BIGINT NOT NULL REFERENCES hive_war_seasons(id) ON DELETE CASCADE,
  attacker_clan_id   UUID   NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  defender_clan_id   UUID   NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  attacker_player_id UUID   NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  stars              INT    NOT NULL CHECK (stars BETWEEN 0 AND 3),
  score_delta        INT    NOT NULL,
  -- Optional link back to the raid row that produced this attack —
  -- when /raid/submit becomes hive-war-aware in a future PR. NULL
  -- for v1 self-reported attacks.
  raid_id            UUID   REFERENCES raids(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hive_war_attacks_season_idx
  ON hive_war_attacks (season_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hive_war_attacks_attacker_player_idx
  ON hive_war_attacks (attacker_player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hive_war_attacks_defender_clan_idx
  ON hive_war_attacks (defender_clan_id, created_at DESC);
