-- Walk-cycle animations + game-wide settings.
--
-- sprites.frames: number of horizontal frames when the stored image
-- is a spritesheet (e.g. a 512×128 strip of four 128×128 walk-cycle
-- frames stores frames=4). frames=1 = single static image (default,
-- backwards-compatible with every existing row).
--
-- game_settings: generic single-row-per-key store for feature flags
-- and runtime config. Value is a free-shape JSONB so we don't need a
-- migration every time we add a new flag. First consumer:
-- 'unit_animation' → { "WorkerAnt": true, ... }.

ALTER TABLE sprites
  ADD COLUMN IF NOT EXISTS frames INTEGER NOT NULL DEFAULT 1
    CHECK (frames >= 1 AND frames <= 16);

CREATE TABLE IF NOT EXISTS game_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the animation toggle with the three units that will ship walk
-- cycles first. Admin can flip these off later; the client falls back
-- to the static image whichever way the toggle is set.
INSERT INTO game_settings (key, value)
VALUES (
  'unit_animation',
  '{"WorkerAnt": true, "SoldierAnt": true, "Wasp": true}'::jsonb
)
ON CONFLICT (key) DO NOTHING;
