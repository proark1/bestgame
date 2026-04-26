-- Replay comments — closes the step-3 audit gap.
--
-- Step 3 of the original game-improvement series shipped the
-- async-PvP loop (matchmaking, replay viewer with pause/2x/4x,
-- featured feed, view tracking, upvotes) — but comments were
-- promised and never landed. Replays are noteworthy because they
-- carry the feature-card moment: "this 3-star Pincer-Dig was the
-- play of the week." Without comments, the social loop is read-only
-- and rotates faster than it sticks.
--
-- One row per comment. Mirrors the replay_upvotes shape: composite
-- (raid_id, author_id) is NOT the PK because the same viewer can post
-- multiple comments. Rate limit lives at the route layer, same as
-- /clan/message.
CREATE TABLE IF NOT EXISTS replay_comments (
  id          BIGSERIAL PRIMARY KEY,
  raid_id     UUID NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
  author_id   UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS replay_comments_raid_idx
  ON replay_comments (raid_id, created_at DESC);
CREATE INDEX IF NOT EXISTS replay_comments_author_idx
  ON replay_comments (author_id, created_at DESC);

-- Roll-up so the feed list endpoint can render "💬 7" without joining
-- in-flight. Maintained by trigger so the count stays correct even if
-- a comment row is deleted (e.g., player account purge cascades).
ALTER TABLE raids
  ADD COLUMN IF NOT EXISTS comment_count INT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION replay_comments_count_bump() RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE raids SET comment_count = comment_count + 1 WHERE id = NEW.raid_id;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE raids SET comment_count = GREATEST(0, comment_count - 1) WHERE id = OLD.raid_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS replay_comments_count_trigger ON replay_comments;
CREATE TRIGGER replay_comments_count_trigger
AFTER INSERT OR DELETE ON replay_comments
FOR EACH ROW EXECUTE FUNCTION replay_comments_count_bump();
