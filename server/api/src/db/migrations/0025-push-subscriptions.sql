-- Web Push subscriptions. Each player can have multiple endpoints
-- (phone + desktop, or replaced after browser reset). Server picks
-- the freshest one when sending; expired endpoints are pruned when
-- a delivery returns 404/410.
--
-- The PushSubscription JSON shape is stored verbatim so we can hand
-- it to web-push without reshaping. p256dh + auth go in their own
-- columns for indexing/diagnostics.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           BIGSERIAL PRIMARY KEY,
  player_id    UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_player
  ON push_subscriptions(player_id);
