-- Sprite generation history. Keeps the last few bytes of each
-- generated art piece so an admin can A/B recent outputs and
-- revert to an earlier generation if the latest Gemini run made
-- things worse. Cap of 3 rows per key is enforced application-
-- side on write (trim-after-insert) — the index supports the
-- "most recent N" lookup that powers both that trim and the
-- admin's "show last 3" UI.
--
-- sprites (singular-current) stays as the authoritative "what's
-- currently live" row. sprite_history is parallel storage: every
-- save inserts into both, restores copy a history row back into
-- sprites with the bytes intact. Splitting them this way means
-- the serve path (sprites + fastify-static) is unchanged and DB
-- migration risk is zero for the existing game.

CREATE TABLE IF NOT EXISTS sprite_history (
  id          BIGSERIAL PRIMARY KEY,
  key         TEXT NOT NULL,
  format      TEXT NOT NULL CHECK (format IN ('png', 'webp')),
  data        BYTEA NOT NULL,
  size        INTEGER NOT NULL,
  frames      INTEGER NOT NULL DEFAULT 1,
  -- Short free-text note the admin can enter on save. Stored alongside
  -- the bytes so history rows show "walk-cycle A first pass" etc. in
  -- the UI instead of timestamps only. NULL = unlabeled.
  label       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Supports both the trim (DELETE ... NOT IN most-recent-3) and the
-- list-history read in the admin UI, both of which are always keyed
-- by (key) and sorted by (id) / (created_at) DESC.
CREATE INDEX IF NOT EXISTS sprite_history_key_id_idx
  ON sprite_history (key, id DESC);
