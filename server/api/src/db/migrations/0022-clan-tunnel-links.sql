-- Clanmate tunnel links — foundation for "shared underground tunnels
-- between clanmates' bases" (audit step 8). Full cross-base sim
-- transit (a unit walks from your underground into a clanmate's
-- underground mid-raid) is a multi-week sim change; this ships the
-- pairing + opt-in flow so the social side of the feature is live
-- and so the sim hook has a stable data model to read.
--
-- A link is BIDIRECTIONAL but stored once with a canonical ordering
-- (player_a < player_b lexicographically) so:
--   * we can rely on a UNIQUE on (player_a, player_b) without
--     worrying about insertion order;
--   * neither player can have two link rows for the same partner.
--
-- A link starts in 'pending' (one player requested) and flips to
-- 'active' the moment the other player accepts. Either side can
-- break it; that deletes the row outright (history isn't worth
-- keeping for v1, and a future re-request runs the flow fresh).

CREATE TABLE IF NOT EXISTS clan_tunnel_links (
  id            BIGSERIAL PRIMARY KEY,
  -- Lexicographic-low player id of the pair (id::text comparison).
  player_a      UUID   NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  -- Lexicographic-high player id of the pair.
  player_b      UUID   NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  -- Whoever requested the link first. Used for "Alice → Bob: pending"
  -- UI rendering on the clan-member list.
  requester_id  UUID   NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  -- 'pending' | 'active'. No 'rejected' state — a reject just deletes
  -- the row so the requester can retry later.
  state         TEXT   NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'active')),
  -- Same clan check is enforced at the route layer at request /
  -- accept time; we don't add a foreign key on (clan_id) here
  -- because a clan-leave should NOT auto-break the link (the sim
  -- hook may want to keep it alive for the rest of the day).
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at   TIMESTAMPTZ,
  CHECK (player_a <> player_b),
  CHECK (player_a < player_b),
  UNIQUE (player_a, player_b)
);
CREATE INDEX IF NOT EXISTS clan_tunnel_links_player_a_idx
  ON clan_tunnel_links (player_a, state);
CREATE INDEX IF NOT EXISTS clan_tunnel_links_player_b_idx
  ON clan_tunnel_links (player_b, state);
