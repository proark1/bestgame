-- Stickiness features. Bundled into one migration because each
-- subsystem is small on its own and they share a deploy rollout. Each
-- section is independent and additive — existing rows backfill via
-- column defaults.
--
-- Subsystems:
--   1. Login streaks + comeback bonus (#6)
--   2. Nemesis pointer cache (#4) — computed live, just stamped
--   3. Builder queue + daily free skip (#2)
--   4. Queen skins + equipped skin id (#5)
--   5. Prologue / tutorial flag (#8)
--   6. Campaign chapter progress (#9)
--   7. Replay feed (#7)
--   8. Replay names cache for share (#1) on raids
--
-- All columns are NOT NULL with server-friendly defaults so the first
-- /player/me after deploy hydrates them without a backfill job.

-- 1. Login streak / comeback.
--   streak_count     — days in a row with a /player/me hit.
--   streak_last_day  — UTC date key of the most recent credited login.
--   streak_last_claim — most recent streak_count that was claimed (free
--                       rewards give one claim per streak day; re-claims
--                       are idempotent).
--   comeback_pending — 1 if the player is currently in a "welcome back"
--                       window (missed 3+ days; resets when they claim).
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS streak_count       INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS streak_last_day    TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS streak_last_claim  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comeback_pending   BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Nemesis — the opponent who most recently hurt us. Cached on the
-- player row so HomeScene doesn't re-scan raids on every open. Nullable
-- until the first defeat.
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS nemesis_player_id UUID,
  ADD COLUMN IF NOT EXISTS nemesis_stars     INT,
  ADD COLUMN IF NOT EXISTS nemesis_set_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS nemesis_avenged   BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Builder queue. One row per in-progress upgrade. Free daily skip
-- is consumed by a flag on the player row so the cool-down is easy
-- to inspect + reset.
--
-- target_kind: 'unit' | 'building' | 'queen'
-- target_id:   unit kind string, building id, or 'queen'
-- level_to:    level the upgrade will finish at
-- ends_at:     when the upgrade unlocks
CREATE TABLE IF NOT EXISTS builder_queue (
  id             BIGSERIAL PRIMARY KEY,
  player_id      UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  target_kind    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  level_to       INT  NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at        TIMESTAMPTZ NOT NULL,
  finished       BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (player_id, target_kind, target_id, finished)
);
CREATE INDEX IF NOT EXISTS builder_queue_player_idx
  ON builder_queue(player_id, finished);

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS builder_slots INT NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS free_skip_day TEXT NOT NULL DEFAULT '';

-- 4. Queen skins. Owned skins stored as text[] so new skin ids can ship
-- without a schema change. `queen_skin_id` is the currently equipped one
-- (an empty string means the default portrait).
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS queen_skins     TEXT[] NOT NULL DEFAULT ARRAY['default']::text[],
  ADD COLUMN IF NOT EXISTS queen_skin_id   TEXT   NOT NULL DEFAULT 'default';

-- 5. Prologue / tutorial flag. `tutorial_stage` is a small integer
-- that tracks where the onboarding got to; 0 means untouched, 100
-- means finished.
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS tutorial_stage INT NOT NULL DEFAULT 0;

-- 6. Seasonal campaign chapter progress. `campaign_chapter` is the
-- highest chapter number the player has unlocked; `campaign_progress`
-- counts scripted raids cleared in the current chapter.
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS campaign_chapter  INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS campaign_progress INT NOT NULL DEFAULT 0;

-- 7. Replay feed + replay sharing name.
--
-- Replay name is computed at raid-save time from the path shape and
-- star result (see computeReplayName()); cached on the raid row so
-- the share endpoint doesn't recompute.
--
-- featured + view_count + upvote_count support the "watch top raids"
-- list. Any raid with stars >= 3 is eligible for featuring; a nightly
-- job (or the route itself, on access) bumps `featured = TRUE` when
-- it meets criteria.
ALTER TABLE raids
  ADD COLUMN IF NOT EXISTS replay_name    TEXT,
  ADD COLUMN IF NOT EXISTS featured       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS view_count     INT     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS upvote_count   INT     NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS raids_featured_idx
  ON raids(featured, created_at DESC)
  WHERE featured = TRUE;
CREATE INDEX IF NOT EXISTS raids_stars_recent_idx
  ON raids(stars, created_at DESC)
  WHERE stars >= 3;

-- Replay upvote ledger — one row per (viewer, raid). Enforces one vote
-- per viewer via the composite primary key.
CREATE TABLE IF NOT EXISTS replay_upvotes (
  raid_id   UUID NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
  viewer_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (raid_id, viewer_id)
);
CREATE INDEX IF NOT EXISTS replay_upvotes_viewer_idx
  ON replay_upvotes(viewer_id);
