-- Sprite bytes in the database.
--
-- Railway's filesystem is ephemeral per deploy, so admin-generated
-- sprites written to disk (client/dist/assets/sprites/) disappear on
-- the next redeploy. Persisting bytes here makes the admin pipeline a
-- real source of truth that survives deploys.
--
-- Serving stays cheap: on boot we hydrate the on-disk directory from
-- this table so fastify-static keeps serving sprites directly — no
-- per-request DB round-trip in the hot path.

CREATE TABLE IF NOT EXISTS sprites (
  key         TEXT PRIMARY KEY,
  format      TEXT NOT NULL CHECK (format IN ('png', 'webp')),
  data        BYTEA NOT NULL,
  size        INTEGER NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sprites_updated_idx ON sprites(updated_at DESC);
