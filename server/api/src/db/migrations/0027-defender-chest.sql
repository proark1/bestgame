-- Defender daily chest. Builds a retention loop that rewards
-- holding the line: every successful defense (attacker scored
-- <3 stars) fills 10% of the chest. At 100% the player taps to
-- claim 500 sugar + 200 leafBits. Resets at UTC midnight whether
-- or not the chest was claimed — the daily cadence is the hook.
--
-- chest_progress is the 0..100 fill percentage. Stored as an INT
-- in steps of 10 so the wire/UI never has to deal with rounding.
-- chest_day is the UTC date of the last fill or claim; both the
-- /raid/submit fill path and the /player/me read path bump
-- chest_progress to 0 when chest_day != today.
--
-- Both routes hold the player row FOR UPDATE during the read,
-- so the reset is race-free even if a player defends and reads
-- /me at the same instant from two devices.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS chest_progress INT NOT NULL DEFAULT 0
    CHECK (chest_progress BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS chest_day DATE NOT NULL
    DEFAULT (NOW() AT TIME ZONE 'UTC')::DATE;
