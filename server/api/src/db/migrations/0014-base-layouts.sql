-- Save/load base layouts.
--
-- A player can save up to a handful of named base layouts and
-- hot-swap the whole building set to one of them. Different layouts
-- optimize for different goals — an offensive trophy push, a
-- defensive chest farm, a resource-income specialist. Storing the
-- full snapshot per layout is simpler than diff-encoding; a layout
-- is just the same shape the live `bases.snapshot` column uses.
--
-- Kept lean on purpose: one row per (player_id, name) with a JSONB
-- snapshot. Unique(player_id, name) stops accidental duplicates.
CREATE TABLE IF NOT EXISTS base_layouts (
  id          BIGSERIAL PRIMARY KEY,
  player_id   UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  snapshot    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (player_id, name)
);
CREATE INDEX IF NOT EXISTS base_layouts_player_idx
  ON base_layouts(player_id, updated_at DESC);
