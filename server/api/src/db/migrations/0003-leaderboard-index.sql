-- Composite index for /api/leaderboard.
--
-- The route uses:
--   RANK() OVER (ORDER BY trophies DESC, last_seen_at DESC)
--
-- Before this index, Postgres had to seq-scan `players` and sort in
-- memory for every request. As the user base grows that becomes the
-- dominant cost of the endpoint. With this covering index the
-- window function can walk rows in index order and pick the top-N
-- without sorting.
--
-- A Redis-backed sorted set is still the right long-term move for
-- hot traffic, but this carries us several orders of magnitude of
-- growth essentially for free.

CREATE INDEX IF NOT EXISTS players_leaderboard_idx
  ON players (trophies DESC, last_seen_at DESC);
