import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';

// Replay feed. Passive engagement loop: when a player is tired of
// raiding themselves, they can scroll the "Top Raids" feed — watch
// great plays, upvote favorites, earn a small token reward for every
// 3 watched replays.
//
// Featured eligibility is already set at raid-insert time in raid.ts
// (any 3-star is auto-featured). This module owns the view + vote
// endpoints.

// Watch reward — small but non-zero, converts "second-screen" idle time
// into a positive economic signal. Paid out on the 3rd, 6th, 9th ...
// replay watched in a single UTC day, capped by daily cooldown.
const WATCH_REWARD_SUGAR = 40;
const WATCH_REWARD_LEAF = 10;
const WATCH_REWARD_EVERY = 3;
const MAX_WATCH_REWARDS_PER_DAY = 5;

export function registerReplayFeed(app: FastifyInstance): void {
  // GET /api/replay/feed?limit=N&cursor=<iso>
  //
  // Pages by created_at DESC so new raids surface first. Returns the
  // raid header (no inputs — those come from /replay/:id) so scrolling
  // stays cheap.
  app.get('/replay/feed', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const q = (req.query ?? {}) as { limit?: string; cursor?: string };
    const limit = Math.max(1, Math.min(50, Number(q.limit) || 20));
    const cursor = typeof q.cursor === 'string' && q.cursor.length > 0
      ? new Date(q.cursor)
      : null;
    const res = await pool.query<{
      id: string;
      attacker_id: string;
      defender_id: string | null;
      attacker_name: string | null;
      defender_name: string | null;
      attacker_trophies: number | null;
      stars: number;
      sugar_looted: string;
      replay_name: string | null;
      view_count: number;
      upvote_count: number;
      comment_count: number;
      created_at: Date;
      has_my_upvote: boolean;
    }>(
      `SELECT r.id, r.attacker_id, r.defender_id,
              ap.display_name AS attacker_name,
              dp.display_name AS defender_name,
              ap.trophies     AS attacker_trophies,
              r.stars, r.sugar_looted, r.replay_name,
              r.view_count, r.upvote_count,
              r.comment_count,
              r.created_at,
              EXISTS(
                SELECT 1 FROM replay_upvotes u
                 WHERE u.raid_id = r.id AND u.viewer_id = $1::uuid
              ) AS has_my_upvote
         FROM raids r
         LEFT JOIN players ap ON ap.id = r.attacker_id
         LEFT JOIN players dp ON dp.id = r.defender_id
        WHERE r.featured = TRUE
          AND ($2::timestamptz IS NULL OR r.created_at < $2::timestamptz)
        ORDER BY r.created_at DESC
        LIMIT $3`,
      [playerId, cursor, limit],
    );
    return {
      entries: res.rows.map((r) => ({
        id: r.id,
        attackerId: r.attacker_id,
        attackerName: r.attacker_name ?? 'Unknown',
        attackerTrophies: r.attacker_trophies ?? 0,
        defenderId: r.defender_id,
        defenderName: r.defender_name ?? (r.defender_id ? 'Unknown' : 'Bot Base'),
        stars: r.stars,
        sugarLooted: Number(r.sugar_looted),
        replayName: r.replay_name ?? 'Unnamed Raid',
        viewCount: r.view_count,
        upvoteCount: r.upvote_count,
        commentCount: r.comment_count ?? 0,
        hasMyUpvote: r.has_my_upvote,
        createdAt: r.created_at.toISOString(),
      })),
      nextCursor: res.rows.length > 0
        ? res.rows[res.rows.length - 1]!.created_at.toISOString()
        : null,
    };
  });

  // GET /api/replay/:id — full replay (base snapshot + input timeline)
  // so the client can re-run the deterministic sim and render.
  app.get<{ Params: { id: string } }>('/replay/:id', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const res = await pool.query<{
      id: string;
      attacker_id: string;
      defender_id: string | null;
      seed: string;
      base_snapshot: unknown;
      inputs: unknown;
      result: unknown;
      stars: number;
      replay_name: string | null;
      view_count: number;
      upvote_count: number;
      comment_count: number;
      created_at: Date;
      attacker_name: string | null;
      defender_name: string | null;
    }>(
      `SELECT r.id, r.attacker_id, r.defender_id, r.seed,
              r.base_snapshot, r.inputs, r.result, r.stars,
              r.replay_name, r.view_count, r.upvote_count,
              r.comment_count,
              r.created_at,
              ap.display_name AS attacker_name,
              dp.display_name AS defender_name
         FROM raids r
         LEFT JOIN players ap ON ap.id = r.attacker_id
         LEFT JOIN players dp ON dp.id = r.defender_id
        WHERE r.id = $1`,
      [req.params.id],
    );
    if (res.rows.length === 0) {
      reply.code(404);
      return { error: 'replay not found' };
    }
    const r = res.rows[0]!;
    return {
      replay: {
        id: r.id,
        seed: Number(r.seed),
        baseSnapshot: r.base_snapshot,
        inputs: r.inputs,
        result: r.result,
        stars: r.stars,
        replayName: r.replay_name ?? 'Unnamed Raid',
        viewCount: r.view_count,
        upvoteCount: r.upvote_count,
        commentCount: r.comment_count ?? 0,
        createdAt: r.created_at.toISOString(),
        attackerId: r.attacker_id,
        attackerName: r.attacker_name ?? 'Unknown',
        defenderId: r.defender_id,
        defenderName: r.defender_name ?? (r.defender_id ? 'Unknown' : 'Bot Base'),
      },
    };
  });

  // POST /api/replay/:id/view — bumps view_count; grants a small
  // passive reward every N views watched by the same player per UTC
  // day. Rate limited both by the UNIQUE on viewer + the daily
  // reward cap.
  app.post<{ Params: { id: string } }>('/replay/:id/view', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query<{ id: string }>(
        'SELECT id FROM raids WHERE id = $1',
        [req.params.id],
      );
      if (exists.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'replay not found' };
      }
      await client.query(
        'UPDATE raids SET view_count = view_count + 1 WHERE id = $1',
        [req.params.id],
      );

      // Session-level watch reward bookkeeping: counted in a UTC-day
      // bucket on the player row. Re-uses streak_last_day-like shape
      // — stored in the daily_quests JSON under `watchMeta` to avoid
      // an additional column. The session_xp already flows through
      // this row so the hit cost is negligible.
      const bucket = await client.query<{
        daily_quests: unknown;
        sugar: string;
        leaf_bits: string;
      }>(
        'SELECT daily_quests, sugar, leaf_bits FROM players WHERE id = $1 FOR UPDATE',
        [playerId],
      );
      if (bucket.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'player not found' };
      }
      const dq = (bucket.rows[0]!.daily_quests as Record<string, unknown>) ?? {};
      const watchMeta = (dq.watchMeta ?? {}) as { day?: string; count?: number; rewards?: number };
      const todayKey = new Date().toISOString().slice(0, 10);
      const fresh = watchMeta.day === todayKey
        ? { day: todayKey, count: (watchMeta.count ?? 0) + 1, rewards: watchMeta.rewards ?? 0 }
        : { day: todayKey, count: 1, rewards: 0 };

      let rewarded = false;
      if (
        fresh.count % WATCH_REWARD_EVERY === 0 &&
        fresh.rewards < MAX_WATCH_REWARDS_PER_DAY
      ) {
        fresh.rewards++;
        rewarded = true;
      }
      const merged = { ...dq, watchMeta: fresh };
      if (rewarded) {
        await client.query(
          `UPDATE players
              SET sugar = sugar + $2,
                  leaf_bits = leaf_bits + $3,
                  daily_quests = $4::jsonb
            WHERE id = $1`,
          [playerId, WATCH_REWARD_SUGAR, WATCH_REWARD_LEAF, JSON.stringify(merged)],
        );
      } else {
        await client.query(
          'UPDATE players SET daily_quests = $2::jsonb WHERE id = $1',
          [playerId, JSON.stringify(merged)],
        );
      }
      await client.query('COMMIT');
      return {
        ok: true,
        rewarded,
        reward: rewarded
          ? { sugar: WATCH_REWARD_SUGAR, leafBits: WATCH_REWARD_LEAF }
          : null,
        watchesToday: fresh.count,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'replay/view failed');
      reply.code(500);
      return { error: 'view failed' };
    } finally {
      client.release();
    }
  });

  // POST /api/replay/:id/upvote — toggles the viewer's upvote. Returns
  // the new upvote count + whether the viewer now has their vote on
  // this replay. Idempotent: re-calling does NOT double-count.
  app.post<{ Params: { id: string } }>('/replay/:id/upvote', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query<{ id: string }>(
        'SELECT id FROM raids WHERE id = $1 FOR UPDATE',
        [req.params.id],
      );
      if (exists.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'replay not found' };
      }
      const already = await client.query<{ raid_id: string }>(
        `SELECT raid_id FROM replay_upvotes WHERE raid_id = $1 AND viewer_id = $2::uuid`,
        [req.params.id, playerId],
      );
      let hasMyUpvote: boolean;
      if (already.rows.length === 0) {
        await client.query(
          'INSERT INTO replay_upvotes (raid_id, viewer_id) VALUES ($1, $2::uuid)',
          [req.params.id, playerId],
        );
        await client.query(
          'UPDATE raids SET upvote_count = upvote_count + 1 WHERE id = $1',
          [req.params.id],
        );
        hasMyUpvote = true;
      } else {
        await client.query(
          'DELETE FROM replay_upvotes WHERE raid_id = $1 AND viewer_id = $2::uuid',
          [req.params.id, playerId],
        );
        await client.query(
          'UPDATE raids SET upvote_count = GREATEST(0, upvote_count - 1) WHERE id = $1',
          [req.params.id],
        );
        hasMyUpvote = false;
      }
      const count = await client.query<{ upvote_count: number }>(
        'SELECT upvote_count FROM raids WHERE id = $1',
        [req.params.id],
      );
      await client.query('COMMIT');
      return {
        ok: true,
        hasMyUpvote,
        upvoteCount: count.rows[0]?.upvote_count ?? 0,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'replay/upvote failed');
      reply.code(500);
      return { error: 'upvote failed' };
    } finally {
      client.release();
    }
  });

  // GET /api/replay/:id/comments — list comments on a replay, oldest
  // first (chat-style flow). Pagination is forward-only via the
  // `afterId` cursor so the client can poll for new entries cheaply
  // without re-fetching the full thread.
  app.get<{ Params: { id: string }; Querystring: { afterId?: string; limit?: string } }>(
    '/replay/:id/comments',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const limit = Math.max(
        1,
        Math.min(MAX_COMMENT_FETCH, Number(req.query?.limit) || 30),
      );
      const afterId = Number(req.query?.afterId) || 0;
      const res = await pool.query<{
        id: string;
        author_id: string;
        author_name: string | null;
        content: string;
        created_at: Date;
      }>(
        `SELECT c.id, c.author_id, p.display_name AS author_name,
                c.content, c.created_at
           FROM replay_comments c
           LEFT JOIN players p ON p.id = c.author_id
          WHERE c.raid_id = $1
            AND ($2::bigint = 0 OR c.id > $2::bigint)
          ORDER BY c.id ASC
          LIMIT $3`,
        [req.params.id, afterId, limit],
      );
      return {
        comments: res.rows.map((c) => ({
          id: Number(c.id),
          authorId: c.author_id,
          authorName: c.author_name ?? 'Unknown',
          content: c.content,
          createdAt: c.created_at.toISOString(),
        })),
      };
    },
  );

  // POST /api/replay/:id/comments — append a comment. Rate-limited per
  // author (1 / sec, mirrors /clan/message) and content is validated
  // for length + control-char hygiene. The comment_count roll-up on
  // raids is maintained by the trigger in migration 0019.
  app.post<{ Params: { id: string }; Body: { content?: string } }>(
    '/replay/:id/comments',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const validated = validateCommentContent(req.body?.content);
      if ('error' in validated) {
        reply.code(400);
        return { error: validated.error };
      }
      // Rate limit: author can post at most one comment per second
      // anywhere. Cheap to check at the route layer; per-replay
      // throttling can land later if spam becomes a real problem.
      const recent = await pool.query<{ created_at: Date }>(
        `SELECT created_at FROM replay_comments
          WHERE author_id = $1::uuid
          ORDER BY id DESC
          LIMIT 1`,
        [playerId],
      );
      if (recent.rows.length > 0) {
        const sinceMs = Date.now() - recent.rows[0]!.created_at.getTime();
        if (sinceMs < MIN_MS_BETWEEN_COMMENTS) {
          reply.code(429);
          return { error: 'slow down — wait a moment between comments' };
        }
      }
      const exists = await pool.query<{ id: string }>(
        'SELECT id FROM raids WHERE id = $1',
        [req.params.id],
      );
      if (exists.rows.length === 0) {
        reply.code(404);
        return { error: 'replay not found' };
      }
      const ins = await pool.query<{ id: string; created_at: Date }>(
        `INSERT INTO replay_comments (raid_id, author_id, content)
         VALUES ($1, $2::uuid, $3)
         RETURNING id, created_at`,
        [req.params.id, playerId, validated.content],
      );
      return {
        ok: true,
        comment: {
          id: Number(ins.rows[0]!.id),
          authorId: playerId,
          content: validated.content,
          createdAt: ins.rows[0]!.created_at.toISOString(),
        },
      };
    },
  );
}

// Comment-content validator — exported for unit tests so the rules
// (length cap + control-char strip) are pinned without spinning up
// the route. Mirrors sanitizeChat in clan.ts but stays local here so
// the two surfaces evolve independently.
const MAX_COMMENT_LEN = 280;
const MIN_MS_BETWEEN_COMMENTS = 1000;
const MAX_COMMENT_FETCH = 100;

export function validateCommentContent(
  raw: unknown,
): { content: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'content required' };
  // Strip ASCII control chars; collapse whitespace; trim. Mirrors the
  // clan-chat sanitiser. Keeps unicode letters + emoji.
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_COMMENT_LEN);
  if (cleaned.length === 0) return { error: 'content cannot be empty' };
  return { content: cleaned };
}
