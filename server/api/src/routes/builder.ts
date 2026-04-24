import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';
import {
  buildDurationSeconds,
  aphidMilkSkipCost,
  type BuilderQueueEntry,
} from '../game/builderQueue.js';
import { utcDateKey } from '../game/quests.js';

// Builder queue routes. The queue turns instant upgrades into time-gated
// ones — the daily check-in lever.
//
// Endpoints:
//   GET  /api/player/builder        — current queue + free-skip status
//   POST /api/player/builder/enqueue  — (used internally by upgrade
//                                        endpoints; also exposed so the
//                                        client can queue from the UI)
//   POST /api/player/builder/:id/skip — consume the free daily skip
//                                        OR AphidMilk to finish early
//   POST /api/player/builder/:id/finish — apply a completed upgrade
//                                        (client calls this when the
//                                         countdown hits 0; the server
//                                         rejects if ends_at > NOW())
//
// Applying the upgrade bumps the actual stat (unit_levels jsonb, queen
// level in base snapshot). The upgrade routes (/upgrade-unit, etc) now
// ENQUEUE instead of applying immediately — see player.ts for the
// integration.

interface EnqueueBody {
  targetKind: 'unit' | 'building' | 'queen';
  targetId: string;
  levelTo: number;
}

export function registerBuilder(app: FastifyInstance): void {
  app.get('/player/builder', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const [qRes, pRes] = await Promise.all([
      pool.query<{
        id: string;
        target_kind: string;
        target_id: string;
        level_to: number;
        started_at: Date;
        ends_at: Date;
      }>(
        `SELECT id, target_kind, target_id, level_to, started_at, ends_at
           FROM builder_queue
          WHERE player_id = $1
            AND finished = FALSE
          ORDER BY ends_at ASC`,
        [playerId],
      ),
      pool.query<{
        builder_slots: number;
        free_skip_day: string;
        aphid_milk: string;
      }>(
        `SELECT builder_slots, free_skip_day, aphid_milk
           FROM players WHERE id = $1`,
        [playerId],
      ),
    ]);
    const player = pRes.rows[0];
    const entries: BuilderQueueEntry[] = qRes.rows.map((r) => {
      const now = Date.now();
      const remaining = Math.max(
        0,
        Math.round((r.ends_at.getTime() - now) / 1000),
      );
      return {
        id: r.id,
        targetKind: r.target_kind as BuilderQueueEntry['targetKind'],
        targetId: r.target_id,
        levelTo: r.level_to,
        startedAt: r.started_at.toISOString(),
        endsAt: r.ends_at.toISOString(),
        secondsRemaining: remaining,
        skipCostAphidMilk: aphidMilkSkipCost(remaining),
      };
    });
    const today = utcDateKey();
    const freeSkipAvailable = player ? player.free_skip_day !== today : false;
    return {
      entries,
      slots: player?.builder_slots ?? 2,
      freeSkipAvailable,
      aphidMilk: player ? Number(player.aphid_milk) : 0,
    };
  });

  app.post<{ Body: EnqueueBody }>(
    '/player/builder/enqueue',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const body = req.body;
      if (
        !body ||
        !['unit', 'building', 'queen'].includes(body.targetKind) ||
        typeof body.targetId !== 'string' ||
        !Number.isInteger(body.levelTo) ||
        body.levelTo < 2
      ) {
        reply.code(400);
        return { error: 'bad enqueue body' };
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const pRes = await client.query<{ builder_slots: number }>(
          'SELECT builder_slots FROM players WHERE id = $1 FOR UPDATE',
          [playerId],
        );
        if (pRes.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'player not found' };
        }
        const slots = pRes.rows[0]!.builder_slots;
        const active = await client.query<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM builder_queue
            WHERE player_id = $1 AND finished = FALSE`,
          [playerId],
        );
        const activeCount = Number(active.rows[0]?.c ?? 0);
        if (activeCount >= slots) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: 'all builder slots in use', slots, activeCount };
        }
        const duration = buildDurationSeconds(body.levelTo, body.targetKind);
        const ins = await client.query<{
          id: string;
          started_at: Date;
          ends_at: Date;
        }>(
          `INSERT INTO builder_queue
             (player_id, target_kind, target_id, level_to, ends_at)
           VALUES ($1, $2, $3, $4, NOW() + ($5 || ' seconds')::INTERVAL)
           RETURNING id, started_at, ends_at`,
          [playerId, body.targetKind, body.targetId, body.levelTo, String(duration)],
        );
        await client.query('COMMIT');
        const r = ins.rows[0]!;
        return {
          ok: true,
          entry: {
            id: r.id,
            targetKind: body.targetKind,
            targetId: body.targetId,
            levelTo: body.levelTo,
            startedAt: r.started_at.toISOString(),
            endsAt: r.ends_at.toISOString(),
            secondsRemaining: duration,
            skipCostAphidMilk: aphidMilkSkipCost(duration),
          } satisfies BuilderQueueEntry,
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'builder/enqueue failed');
        reply.code(500);
        return { error: 'enqueue failed' };
      } finally {
        client.release();
      }
    },
  );

  interface SkipBody { useAphidMilk?: boolean }
  app.post<{ Params: { id: string }; Body: SkipBody }>(
    '/player/builder/:id/skip',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const useMilk = !!req.body?.useAphidMilk;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const entry = await client.query<{
          id: string;
          player_id: string;
          ends_at: Date;
          finished: boolean;
        }>(
          `SELECT id, player_id, ends_at, finished
             FROM builder_queue WHERE id = $1 FOR UPDATE`,
          [req.params.id],
        );
        if (entry.rows.length === 0 || entry.rows[0]!.player_id !== playerId) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'entry not found' };
        }
        const e = entry.rows[0]!;
        if (e.finished) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: 'already finished' };
        }
        const secondsRemaining = Math.max(
          0,
          Math.round((e.ends_at.getTime() - Date.now()) / 1000),
        );
        if (useMilk) {
          const cost = aphidMilkSkipCost(secondsRemaining);
          const debit = await client.query<{ aphid_milk: string }>(
            `UPDATE players SET aphid_milk = aphid_milk - $2
              WHERE id = $1 AND aphid_milk >= $2
          RETURNING aphid_milk`,
            [playerId, cost],
          );
          if (debit.rows.length === 0) {
            await client.query('ROLLBACK');
            reply.code(402);
            return { error: 'insufficient aphid milk', cost };
          }
        } else {
          const today = utcDateKey();
          const pRow = await client.query<{ free_skip_day: string }>(
            'SELECT free_skip_day FROM players WHERE id = $1 FOR UPDATE',
            [playerId],
          );
          if (pRow.rows[0]?.free_skip_day === today) {
            await client.query('ROLLBACK');
            reply.code(409);
            return { error: 'free skip already used today' };
          }
          await client.query(
            'UPDATE players SET free_skip_day = $2 WHERE id = $1',
            [playerId, today],
          );
        }
        await client.query(
          'UPDATE builder_queue SET ends_at = NOW() WHERE id = $1',
          [e.id],
        );
        await client.query('COMMIT');
        return { ok: true, id: e.id, usedAphidMilk: useMilk };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'builder/skip failed');
        reply.code(500);
        return { error: 'skip failed' };
      } finally {
        client.release();
      }
    },
  );

  // Finish the upgrade. For this PR we commit the actual level bump in
  // this route rather than background tick — simpler to reason about,
  // and the timer is short enough that the client will poll anyway.
  app.post<{ Params: { id: string } }>(
    '/player/builder/:id/finish',
    async (req, reply) => {
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
        const entry = await client.query<{
          id: string;
          player_id: string;
          target_kind: string;
          target_id: string;
          level_to: number;
          ends_at: Date;
          finished: boolean;
        }>(
          `SELECT * FROM builder_queue WHERE id = $1 FOR UPDATE`,
          [req.params.id],
        );
        if (entry.rows.length === 0 || entry.rows[0]!.player_id !== playerId) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'entry not found' };
        }
        const e = entry.rows[0]!;
        if (e.finished) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: 'already finished' };
        }
        if (e.ends_at.getTime() > Date.now()) {
          await client.query('ROLLBACK');
          reply.code(409);
          return {
            error: 'not yet finished',
            endsAt: e.ends_at.toISOString(),
          };
        }

        // Apply the stat change. Each target_kind resolves differently;
        // building/queen edit the base snapshot, unit edits the jsonb
        // unit_levels on the player row.
        if (e.target_kind === 'unit') {
          await client.query(
            `UPDATE players
                SET unit_levels = jsonb_set(
                  COALESCE(unit_levels, '{}'::jsonb),
                  ARRAY[$2::text],
                  to_jsonb($3::int),
                  true
                )
              WHERE id = $1`,
            [playerId, e.target_id, e.level_to],
          );
        } else if (e.target_kind === 'queen') {
          await client.query(
            `UPDATE bases
                SET snapshot = jsonb_set(
                  snapshot,
                  '{buildings}',
                  (
                    SELECT jsonb_agg(
                      CASE
                        WHEN b->>'kind' = 'QueenChamber'
                          THEN jsonb_set(b, '{level}', to_jsonb($2::int))
                        ELSE b
                      END
                    )
                    FROM jsonb_array_elements(snapshot->'buildings') AS b
                  )
                ),
                version = version + 1,
                updated_at = NOW()
              WHERE player_id = $1`,
            [playerId, e.level_to],
          );
        } else if (e.target_kind === 'building') {
          await client.query(
            `UPDATE bases
                SET snapshot = jsonb_set(
                  snapshot,
                  '{buildings}',
                  (
                    SELECT jsonb_agg(
                      CASE
                        WHEN b->>'id' = $2
                          THEN jsonb_set(b, '{level}', to_jsonb($3::int))
                        ELSE b
                      END
                    )
                    FROM jsonb_array_elements(snapshot->'buildings') AS b
                  )
                ),
                version = version + 1,
                updated_at = NOW()
              WHERE player_id = $1`,
            [playerId, e.target_id, e.level_to],
          );
        }

        await client.query(
          'UPDATE builder_queue SET finished = TRUE WHERE id = $1',
          [e.id],
        );
        await client.query('COMMIT');
        return {
          ok: true,
          id: e.id,
          appliedKind: e.target_kind,
          appliedId: e.target_id,
          appliedLevel: e.level_to,
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'builder/finish failed');
        reply.code(500);
        return { error: 'finish failed' };
      } finally {
        client.release();
      }
    },
  );
}
