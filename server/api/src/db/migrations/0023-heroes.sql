-- Heroes — special, persistent units the player owns and equips
-- per raid. Distinct from regular UnitKinds because they're owned
-- across raids, capped at MAX_EQUIPPED_HEROES (2) per match, and
-- emit auras that buff allied units in a radius.
--
-- See shared/src/types/heroes.ts for the full HeroKind catalog,
-- price ladder, and aura definitions. PR D wires the in-raid
-- buff into the sim; this migration just adds the persistence
-- columns so PR C can ship the ownership / shop / equip flows.
--
-- - hero_ownership : presence map { 'Mantis': true, ... }
-- - hero_equipped  : ordered array of HeroKind strings, length ≤ 2
-- - hero_chest_claimed : whether the free chest gift has been opened

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS hero_ownership JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS hero_equipped JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS hero_chest_claimed BOOLEAN NOT NULL DEFAULT FALSE;
