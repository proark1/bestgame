-- Server-authoritative match tuples.
--
-- Before this table existed, /api/match returned { defenderId, seed,
-- baseSnapshot } and /api/raid/submit trusted those three back from the
-- client. A malicious caller could submit a spoofed base snapshot
-- (e.g. zero defenders, huge vaults) and win an "honest" replay against
-- it, scoring trophies + loot for a fight that never happened.
--
-- The fix: /api/match persists the tuple here keyed by a random token
-- and only returns the token + a UI-only view of the base. /api/raid/
-- submit looks the row up and runs the sim against the authoritative
-- snapshot. Rows expire in 15 minutes.

CREATE TABLE IF NOT EXISTS pending_matches (
  token          TEXT PRIMARY KEY,
  attacker_id    UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  defender_id    UUID REFERENCES players(id) ON DELETE CASCADE,
  seed           BIGINT NOT NULL,
  base_snapshot  JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS pending_matches_attacker_idx
  ON pending_matches(attacker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pending_matches_expires_idx
  ON pending_matches(expires_at);
