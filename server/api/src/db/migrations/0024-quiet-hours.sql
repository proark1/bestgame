-- Quiet hours — top-10 audit #10. A daily 3-hour window the player
-- can pick (e.g. midnight to 3 am their local time) during which
-- matchmaking skips their base. Different from a raid shield: the
-- shield is reactive (granted on a 2-star defeat) and bounded in
-- length; quiet hours are proactive and recur every UTC day.
--
-- Stored as two integers in [0, 24) representing the start hour and
-- duration in hours, both UTC. start_hour=NULL means "off"; the
-- matchmaking filter only applies when start_hour IS NOT NULL.
-- Capped to 3-hour windows so it can't be abused as a permanent
-- shield. Honest scope: anti-griefing, not anti-PvP.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS quiet_hour_start  INT,
  ADD COLUMN IF NOT EXISTS quiet_hour_length INT NOT NULL DEFAULT 3
    CHECK (quiet_hour_length BETWEEN 1 AND 3);
