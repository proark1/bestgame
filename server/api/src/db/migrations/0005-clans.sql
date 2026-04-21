-- Clans + chat.
--
-- One player is in at most one clan at a time. Messages are plain-text
-- (no formatting for now) with a rate-limit enforced at the route.
-- Leader death (account delete) demotes the clan; the clans row is
-- orphaned with leader_id = NULL, and the route can promote the
-- oldest remaining member if needed.

CREATE TABLE IF NOT EXISTS clans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  tag           TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  is_open       BOOLEAN NOT NULL DEFAULT TRUE,
  leader_id     UUID REFERENCES players(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS clans_open_idx ON clans(is_open, created_at DESC);

-- Membership is 1:1 because player_id is the PK.
CREATE TABLE IF NOT EXISTS clan_members (
  player_id     UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  clan_id       UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member',
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS clan_members_clan_idx ON clan_members(clan_id);

CREATE TABLE IF NOT EXISTS clan_messages (
  id            BIGSERIAL PRIMARY KEY,
  clan_id       UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  player_id     UUID NOT NULL REFERENCES players(id) ON DELETE SET NULL,
  content       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS clan_messages_clan_idx
  ON clan_messages(clan_id, id DESC);
