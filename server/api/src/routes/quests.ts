import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';
import {
  QUEST_POOL,
  questDef,
  refreshIfStale,
  type DailyQuests,
  type QuestId,
} from '../game/quests.js';
import {
  CURRENT_SEASON_ID,
  SEASON_MILESTONES,
  milestoneById,
} from '../game/season.js';

// Daily quests + season XP endpoints. Daily quest state lives on the
// player row (see migrations/0011); these routes own the claim path
// so the payout is transactional with the state flip.

export function registerQuests(app: FastifyInstance): void {
  // GET /api/player/quests — today's 3 quests + season progress.
  // Re-rolls the daily set if the stored date is stale. Also resets
  // season state if the stored season id has been bumped since the
  // last read.
  app.get('/player/quests', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const res = await pool.query<{
      daily_quests: unknown;
      season_id: string;
      season_xp: number;
      season_milestones_claimed: number[];
    }>(
      `SELECT daily_quests, season_id, season_xp, season_milestones_claimed
         FROM players WHERE id = $1`,
      [playerId],
    );
    if (res.rows.length === 0) {
      reply.code(404);
      return { error: 'player not found' };
    }
    const row = res.rows[0]!;
    const fresh = refreshIfStale(row.daily_quests, playerId);
    // Persist the refresh if we had to roll today's quests — otherwise
    // a player that never submits a raid would read new quests each
    // request.
    if (fresh !== row.daily_quests) {
      await pool.query(
        `UPDATE players SET daily_quests = $2::jsonb WHERE id = $1`,
        [playerId, JSON.stringify(fresh)],
      );
    }
    const onCurrentSeason = row.season_id === CURRENT_SEASON_ID;
    return {
      dailyQuests: fresh,
      questDefs: QUEST_POOL,
      season: {
        id: CURRENT_SEASON_ID,
        xp: onCurrentSeason ? row.season_xp : 0,
        milestonesClaimed: onCurrentSeason ? row.season_milestones_claimed : [],
        milestones: SEASON_MILESTONES,
      },
    };
  });

  interface ClaimBody { questId: QuestId }
  app.post<{ Body: ClaimBody }>('/player/quests/claim', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const body = req.body;
    if (!body || typeof body.questId !== 'string') {
      reply.code(400);
      return { error: 'questId required' };
    }
    const def = questDef(body.questId);
    if (!def) {
      reply.code(400);
      return { error: 'unknown questId' };
    }
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query<{
        daily_quests: unknown;
        season_id: string;
      }>(
        'SELECT daily_quests, season_id FROM players WHERE id = $1 FOR UPDATE',
        [playerId],
      );
      if (lock.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'player not found' };
      }
      const fresh = refreshIfStale(lock.rows[0]!.daily_quests, playerId);
      const q = fresh.quests.find((x) => x.id === body.questId);
      if (!q) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'quest not in today\'s roster' };
      }
      if (q.claimed) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: 'already claimed' };
      }
      if (q.progress < def.goal) {
        await client.query('ROLLBACK');
        reply.code(409);
        return {
          error: 'quest not complete',
          progress: q.progress,
          goal: def.goal,
        };
      }
      q.claimed = true;

      // Payout + season XP bump. Season CASE handles a just-rolled
      // season by resetting counters and then applying the new xp on
      // top of zero. Same idiom as raid.ts.
      const payout = await client.query<{
        sugar: string;
        leaf_bits: string;
        season_xp: number;
      }>(
        `UPDATE players
            SET sugar          = sugar + $2,
                leaf_bits      = leaf_bits + $3,
                daily_quests   = $4::jsonb,
                season_id      = $5,
                season_xp      = CASE
                                   WHEN season_id = $5 THEN season_xp + $6
                                   ELSE $6
                                 END,
                season_milestones_claimed = CASE
                                   WHEN season_id = $5 THEN season_milestones_claimed
                                   ELSE '{}'::int[]
                                 END
          WHERE id = $1
      RETURNING sugar, leaf_bits, season_xp`,
        [
          playerId,
          def.rewardSugar,
          def.rewardLeaf,
          JSON.stringify(fresh),
          CURRENT_SEASON_ID,
          def.rewardXp,
        ],
      );
      await client.query('COMMIT');
      const r = payout.rows[0]!;
      return {
        ok: true,
        questId: body.questId,
        reward: {
          sugar: def.rewardSugar,
          leafBits: def.rewardLeaf,
          xp: def.rewardXp,
        },
        dailyQuests: fresh,
        resources: {
          sugar: Number(r.sugar),
          leafBits: Number(r.leaf_bits),
        },
        seasonXp: r.season_xp,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'quest claim failed');
      reply.code(500);
      return { error: 'claim failed' };
    } finally {
      client.release();
    }
  });

  interface SeasonClaimBody { milestoneId: number }
  app.post<{ Body: SeasonClaimBody }>(
    '/player/season/claim',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const body = req.body;
      if (!body || !Number.isInteger(body.milestoneId)) {
        reply.code(400);
        return { error: 'milestoneId required' };
      }
      const milestone = milestoneById(body.milestoneId);
      if (!milestone) {
        reply.code(400);
        return { error: 'unknown milestoneId' };
      }
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const lock = await client.query<{
          season_id: string;
          season_xp: number;
          season_milestones_claimed: number[];
        }>(
          `SELECT season_id, season_xp, season_milestones_claimed
             FROM players WHERE id = $1 FOR UPDATE`,
          [playerId],
        );
        if (lock.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'player not found' };
        }
        const row = lock.rows[0]!;
        const onCurrentSeason = row.season_id === CURRENT_SEASON_ID;
        const xp = onCurrentSeason ? row.season_xp : 0;
        const claimed = onCurrentSeason ? row.season_milestones_claimed : [];

        if (xp < milestone.xpRequired) {
          await client.query('ROLLBACK');
          reply.code(409);
          return {
            error: 'insufficient XP',
            have: xp,
            need: milestone.xpRequired,
          };
        }
        if (claimed.includes(milestone.id)) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: 'milestone already claimed' };
        }

        // Pay out + append the milestone id. When the stored season
        // doesn't match current, we reset-then-append atomically via
        // CASE — same pattern as the quest claim flow.
        const payout = await client.query<{
          sugar: string;
          leaf_bits: string;
          season_milestones_claimed: number[];
        }>(
          `UPDATE players
              SET sugar     = sugar + $2,
                  leaf_bits = leaf_bits + $3,
                  season_id = $4,
                  season_xp = CASE WHEN season_id = $4 THEN season_xp ELSE 0 END,
                  season_milestones_claimed = CASE
                                   WHEN season_id = $4
                                     THEN array_append(season_milestones_claimed, $5)
                                   ELSE ARRAY[$5]::int[]
                                 END
            WHERE id = $1
        RETURNING sugar, leaf_bits, season_milestones_claimed`,
          [
            playerId,
            milestone.rewardSugar,
            milestone.rewardLeaf,
            CURRENT_SEASON_ID,
            milestone.id,
          ],
        );
        await client.query('COMMIT');
        const r = payout.rows[0]!;
        return {
          ok: true,
          milestoneId: milestone.id,
          reward: {
            sugar: milestone.rewardSugar,
            leafBits: milestone.rewardLeaf,
          },
          resources: {
            sugar: Number(r.sugar),
            leafBits: Number(r.leaf_bits),
          },
          milestonesClaimed: r.season_milestones_claimed,
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'milestone claim failed');
        reply.code(500);
        return { error: 'claim failed' };
      } finally {
        client.release();
      }
    },
  );
}
