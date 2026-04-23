-- Add optional email to users for admin-managed accounts.
--
-- Nullable so the column backfills cleanly over existing rows that
-- never captured an email. CITEXT matches `username`'s convention so
-- "Alice@Example.com" and "alice@example.com" are treated as the
-- same address. Partial unique index keeps the uniqueness constraint
-- from catching NULL rows (Postgres treats NULLs as distinct in a
-- naive UNIQUE, but the partial index makes the intent explicit and
-- keeps existing guest-upgraded rows legal).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email CITEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
  ON users(email)
  WHERE email IS NOT NULL;
