-- Aphid milk residual tracker. AphidFarm produces milk at 0.2/sec ×
-- level — a fractional rate. Without a residual the offline trickle
-- floors `gainedMilk = floor(0.2 × elapsedSec)`, which means a frequent
-- /player/me poll (e.g. every 4 sec → 0.8 → floors to 0) silently
-- discards every produced unit. For a premium currency that's an
-- economy leak.
--
-- Fix: track the unbanked fractional remainder in a real-typed column.
-- Each /player/me reads the residual, adds the new fractional gain,
-- floors to bank an integer, and writes the new residual back. So
-- nothing is ever lost, regardless of polling cadence.
--
-- Default 0 backfills cleanly for existing players.
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS aphid_milk_residual REAL NOT NULL DEFAULT 0;
