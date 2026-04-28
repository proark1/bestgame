-- Allow NULL player_id on clan_messages for system messages — used
-- by the live war ticker (and future system pings like "your unit
-- request was filled"). Routes flag system rows by leaving
-- player_id NULL; the client renders them italicised with a 🛡 /
-- ⚙ prefix rather than as a player avatar + name.

ALTER TABLE clan_messages
  ALTER COLUMN player_id DROP NOT NULL;
