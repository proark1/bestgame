-- Core Hive Wars persistence schema.
-- Safe to re-run only via the migration runner; each statement is
-- idempotent-friendly (IF NOT EXISTS / CREATE OR REPLACE) but the
-- runner also tracks applied IDs in _migrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ======== players ========================================================
-- A player is identified by one of:
--  - device_id (guest login via localStorage UUID)
--  - facebook_id (FB Instant context, future upgrade path)
-- Both columns are UNIQUE so we can upsert on whichever auth method is used.
CREATE TABLE IF NOT EXISTS players (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id      TEXT UNIQUE,
  facebook_id    TEXT UNIQUE,
  display_name   TEXT NOT NULL DEFAULT 'Guest',
  faction        TEXT NOT NULL DEFAULT 'Ants',
  trophies       INTEGER NOT NULL DEFAULT 100,
  sugar          BIGINT NOT NULL DEFAULT 1200,
  leaf_bits      BIGINT NOT NULL DEFAULT 300,
  aphid_milk     BIGINT NOT NULL DEFAULT 0,
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS players_trophies_idx ON players(trophies);
CREATE INDEX IF NOT EXISTS players_last_seen_idx ON players(last_seen_at DESC);

-- ======== bases ==========================================================
-- One base per player. The snapshot column stores the full Base JSON from
-- @hive/shared — simpler than relational modeling for a pre-1.0 game, and
-- the schema is owned by the sim anyway.
CREATE TABLE IF NOT EXISTS bases (
  player_id    UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  faction      TEXT NOT NULL DEFAULT 'Ants',
  snapshot     JSONB NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ======== raids ==========================================================
-- Every submitted raid, whether real-player or bot. Input timeline is
-- replayable via @hive/shared runReplay. Keep the base snapshot inline
-- so that later base edits don't invalidate the replay.
CREATE TABLE IF NOT EXISTS raids (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attacker_id         UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  defender_id         UUID,
  seed                BIGINT NOT NULL,
  base_snapshot       JSONB NOT NULL,
  inputs              JSONB NOT NULL,
  result              JSONB NOT NULL,
  stars               SMALLINT NOT NULL,
  sugar_looted        BIGINT NOT NULL DEFAULT 0,
  leaf_looted         BIGINT NOT NULL DEFAULT 0,
  attacker_trophies_delta  INTEGER NOT NULL DEFAULT 0,
  defender_trophies_delta  INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS raids_attacker_idx
  ON raids(attacker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS raids_defender_idx
  ON raids(defender_id, created_at DESC);
