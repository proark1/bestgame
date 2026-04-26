-- Donation inventory — closes the clan-donations loop end-to-end.
--
-- Step 8 of the original game-improvement series shipped the
-- request/donate/list endpoints (server/api/src/routes/clan.ts), but
-- the donated units never reached the requester's deck — donor got a
-- sugar tip, requester got a chat ack, the inventory itself wasn't
-- modeled. This adds the bank.
--
-- /clan/donate now also credits players.donation_inventory[unitKind].
-- RaidScene reads the bank on raid start and merges it into the deck.
-- /raid/submit clears the bank on success — donations are war-army-
-- style, refilled per raid, expire whether-or-not used.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS donation_inventory JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Cheap predicate index for the few callers that ever need to ask
-- "does this player have any donated units waiting?" (e.g., the
-- Home-screen "ready for raid" badge if we add one later). NOT
-- partial — JSONB '{}' is small enough that the saving from a
-- partial index is rounding-error.
CREATE INDEX IF NOT EXISTS players_donation_inventory_nonempty
  ON players ((donation_inventory <> '{}'::jsonb));
