-- Retention loop + clan wars.
--
-- Three independent subsystems bundled into one migration so the
-- `_migrations` row count stays readable:
--
--   1. Raid shield — a per-player cooldown that blocks being raided
--      for a few hours after losing 2+ stars on defense. Modeled as
--      a nullable timestamp column: NULL = no shield, future time =
--      shield active. Matchmaking filters defenders with
--      `shield_expires_at > NOW()`.
--
--   2. Daily quests + season XP — JSONB snapshot of today's quest
--      state on the player row (3 quests/day, rotated deterministically
--      by UTC date + player id), plus integer counters for season
--      progress. Keeping daily quests on the player avoids a per-day
--      table of millions of rows; we read+write the full JSON each
--      time, which is fine at 3-quest-a-day granularity.
--
--   3. Clan wars — paired clan vs clan battles with stars aggregated
--      over a 24-hour window. Two tables: one war header, one row
--      per attack a member submits.

-- Subsystem 1: Raid shield.
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS shield_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS players_shield_idx
  ON players(shield_expires_at)
  WHERE shield_expires_at IS NOT NULL;

-- Subsystem 2: Daily quests + season XP.
--
-- daily_quests JSON shape:
--   { "date": "2026-04-23",
--     "quests": [
--       { "id": "win_3", "progress": 0, "goal": 3, "claimed": false },
--       ...
--     ] }
-- "date" keys the server-side rotation; if the stored date is stale
-- the routes re-roll for today. Claimed flags stick until the next
-- roll so repeat claims within the day error cleanly.
--
-- season_id lets us reset the ladder without wiping tables — bumping
-- the id zeroes the effective progress for a new season. claimed
-- milestones live on the same row as an int array so the payout
-- endpoint can atomically check + append.
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS daily_quests     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS season_id        TEXT  NOT NULL DEFAULT 'S1',
  ADD COLUMN IF NOT EXISTS season_xp        INT   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS season_milestones_claimed INT[] NOT NULL DEFAULT '{}';

-- Subsystem 3: Clan wars.
--
-- Status lifecycle:
--   'searching'  (not used in v1 — we require both clans to opt-in)
--   'active'     (created; members may submit attacks until ends_at)
--   'ended'      (ends_at reached; winner stamped, bonus paid out)
--
-- Each war has a fixed duration (24h). Winning clan is the one with
-- higher total stars when the war ends; tie goes to whichever clan
-- used fewer attacks (efficiency tiebreaker), then to clan_a if still
-- tied. winning_clan_id is NULL while active and for no-contest ties.
CREATE TABLE IF NOT EXISTS clan_wars (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clan_a_id          UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  clan_b_id          UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'active',
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at            TIMESTAMPTZ NOT NULL,
  ended_at           TIMESTAMPTZ,
  winning_clan_id    UUID REFERENCES clans(id) ON DELETE SET NULL,
  stars_a            INT NOT NULL DEFAULT 0,
  stars_b            INT NOT NULL DEFAULT 0,
  CHECK (clan_a_id <> clan_b_id)
);
CREATE INDEX IF NOT EXISTS clan_wars_active_idx
  ON clan_wars(status, ends_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS clan_wars_clan_a_idx ON clan_wars(clan_a_id);
CREATE INDEX IF NOT EXISTS clan_wars_clan_b_idx ON clan_wars(clan_b_id);

-- One row per attack. (war_id, attacker_player_id) is unique so the
-- same player can't stack 3 attacks in one war — each member has one
-- shot per war, matching CoC's structure.
CREATE TABLE IF NOT EXISTS clan_war_attacks (
  id                    BIGSERIAL PRIMARY KEY,
  war_id                UUID NOT NULL REFERENCES clan_wars(id) ON DELETE CASCADE,
  attacker_clan_id      UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  attacker_player_id    UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  defender_player_id    UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  stars                 INT  NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (war_id, attacker_player_id)
);
CREATE INDEX IF NOT EXISTS clan_war_attacks_war_idx ON clan_war_attacks(war_id);
