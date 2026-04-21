-- Username/password accounts layered on top of the existing guest
-- device_id flow. A user row is independent from a player row so an
-- account can outlive device identity — log in on a new phone and
-- get back the same base + trophies.
--
-- players.user_id is nullable: guests stay unlinked (user_id = NULL)
-- until they register via /auth/register, at which point the new
-- user row is created and the current player is attached.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Case-insensitive unique so "Alice" and "alice" are the same login
  -- but the user's typed casing is preserved on display.
  username        CITEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  password_salt   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS users_last_login_idx ON users(last_login_at DESC);

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- One active player per user. A NULL user_id (guest) doesn't count —
-- the partial-index WHERE makes that a no-op for unlinked rows.
CREATE UNIQUE INDEX IF NOT EXISTS players_user_id_unique
  ON players(user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS players_user_id_idx ON players(user_id);
