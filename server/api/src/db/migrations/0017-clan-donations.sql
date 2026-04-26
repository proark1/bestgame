-- Clan donations / "request units" mechanic.
--
-- A clan member opens a request for N units of one kind; clanmates
-- donate toward it until the request is closed (fulfilled, manually
-- closed by requester, or expired). Mirrors the CoC clan-castle loop:
-- daily ritual where you ask, teammates respond, you owe them back.
--
-- One open request per player at a time (partial-unique index).
-- Closed requests stick around for the activity feed.

CREATE TABLE IF NOT EXISTS clan_unit_requests (
  id               BIGSERIAL PRIMARY KEY,
  clan_id          UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  requester_id     UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  unit_kind        TEXT NOT NULL,
  requested_count  INT  NOT NULL,
  fulfilled_count  INT  NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS clan_unit_requests_clan_idx
  ON clan_unit_requests (clan_id, closed_at, created_at DESC);

-- One open request per player. Closing the request (closed_at IS NOT
-- NULL) frees the player to make another. The DB-level guarantee
-- avoids a TOCTOU race between two POST /clan/request calls.
CREATE UNIQUE INDEX IF NOT EXISTS clan_unit_requests_one_open_per_player
  ON clan_unit_requests (requester_id)
  WHERE closed_at IS NULL;

-- Per-donation ledger so we can show "Bob donated 3" in the activity
-- feed and (later) hand out donor-side rewards on a cooldown.
CREATE TABLE IF NOT EXISTS clan_donation_log (
  id            BIGSERIAL PRIMARY KEY,
  request_id    BIGINT NOT NULL REFERENCES clan_unit_requests(id) ON DELETE CASCADE,
  donor_id      UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  count         INT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS clan_donation_log_request_idx
  ON clan_donation_log (request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS clan_donation_log_donor_idx
  ON clan_donation_log (donor_id, created_at DESC);
