-- Per-player unit upgrades.
--
-- unit_levels is a JSONB map of unit kind → level. Absent keys mean
-- level 1 (baseline stats). Keeping this as a JSON map instead of a
-- joined upgrades table keeps reads to one row per player and matches
-- the shape the sim wants at deploy time.
--
-- Default '{}' so existing rows upgrade cleanly.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS unit_levels JSONB NOT NULL DEFAULT '{}'::jsonb;
