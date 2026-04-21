-- Live PvP (arena) reservations + results.
--
-- Flow: /api/arena/reserve pops or pairs two players, picks which side
-- is the "host" (their base snapshot is the map), stores the tuple
-- keyed by a random token, and returns the token to both clients. The
-- Colyseus arena server looks up the row on ws connect and uses the
-- persisted snapshot — no trust in client-supplied bases, same pattern
-- as pending_matches for async raids.
--
-- We store both players' snapshots so a future symmetric-PvP sim can
-- consume them without another migration.

CREATE TABLE IF NOT EXISTS arena_matches (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token              TEXT UNIQUE NOT NULL,
  host_player_id     UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  challenger_player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  seed               BIGINT NOT NULL,
  host_snapshot      JSONB NOT NULL,
  challenger_snapshot JSONB NOT NULL,
  outcome            TEXT,
  winner_slot        SMALLINT,
  ticks              INTEGER,
  final_state_hash   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes')
);

CREATE INDEX IF NOT EXISTS arena_matches_token_idx ON arena_matches(token);
CREATE INDEX IF NOT EXISTS arena_matches_host_idx
  ON arena_matches(host_player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS arena_matches_challenger_idx
  ON arena_matches(challenger_player_id, created_at DESC);
