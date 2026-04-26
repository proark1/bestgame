-- Giant-map hive wars — foundation slice.
--
-- Step 8 of the audit asked for "weekly hive wars on a giant shared
-- map". The full mechanic (multi-clan attack windows, neighbour
-- targeting, base-anchoring, etc.) is genuinely multi-week. This
-- migration ships the FOUNDATION — seasons, enrollment, slot
-- assignment, score roll-up — so the attack endpoints can land on
-- top of it later without re-doing the schema.
--
-- A "season" is a time-bounded competition with a fixed board (e.g.
-- 8×8 grid of clan slots). Clan leaders enroll their clan during
-- the open window; once active, the slot grid is immutable. Score
-- accumulates from per-attack writes (deferred to a future
-- migration). When ends_at passes, a finalize job moves state to
-- 'finished' and pays out rewards.

CREATE TABLE IF NOT EXISTS hive_war_seasons (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  board_w     INT  NOT NULL DEFAULT 8,
  board_h     INT  NOT NULL DEFAULT 8,
  -- 'open'     — accepting enrollments, no attacks yet
  -- 'active'   — board locked, attack window live
  -- 'finished' — finalized, rewards paid
  state       TEXT NOT NULL DEFAULT 'open'
              CHECK (state IN ('open', 'active', 'finished')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hive_war_seasons_state_idx
  ON hive_war_seasons (state, ends_at DESC);

CREATE TABLE IF NOT EXISTS hive_war_enrollments (
  id                BIGSERIAL PRIMARY KEY,
  season_id         BIGINT NOT NULL REFERENCES hive_war_seasons(id) ON DELETE CASCADE,
  clan_id           UUID   NOT NULL REFERENCES clans(id)            ON DELETE CASCADE,
  slot_x            INT    NOT NULL,
  slot_y            INT    NOT NULL,
  score             INT    NOT NULL DEFAULT 0,
  attacks_made      INT    NOT NULL DEFAULT 0,
  attacks_received  INT    NOT NULL DEFAULT 0,
  enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A clan can only sit at one slot per season; a slot can only
  -- host one clan. The slot uniqueness lets the enrollment route
  -- pick the next-available slot via a left-to-right walk.
  UNIQUE (season_id, clan_id),
  UNIQUE (season_id, slot_x, slot_y)
);
CREATE INDEX IF NOT EXISTS hive_war_enrollments_season_score_idx
  ON hive_war_enrollments (season_id, score DESC);

-- Seed an initial season so the feature has something to render on
-- day-1 deploy. Length: 7 days from now. 8x8 = 64 slots, plenty for
-- v1. Idempotent insert so re-running this migration in a non-
-- destructive backfill (e.g., schema-only restore) doesn't blow up.
INSERT INTO hive_war_seasons (name, starts_at, ends_at, board_w, board_h, state)
SELECT 'Inaugural Hive', NOW(), NOW() + INTERVAL '7 days', 8, 8, 'open'
WHERE NOT EXISTS (SELECT 1 FROM hive_war_seasons WHERE state IN ('open', 'active'));
