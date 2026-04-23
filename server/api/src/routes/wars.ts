import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';

// Clan wars — 24-hour paired battles between two clans. Each clan
// member gets one attack per war; stars are aggregated by clan side;
// winning clan collects a bonus trophy payout when the war ends.
//
// Endpoints:
//   POST /api/clan/war/start        → leader starts a war vs another clan
//   GET  /api/clan/war/current      → state of my clan's active war
//   POST /api/clan/war/attack       → submit an attack (called after a
//                                     successful raid on an opponent
//                                     clan member)
//   POST /api/clan/war/end          → finalize an expired war (idempotent)
//
// Starting a war requires both clans to NOT have an active war. For
// v1 the "start" is one-sided — the starting leader effectively
// declares war and the opponent is informed via their clan panel.
// A full "both sides must opt in" flow can layer on later.

const WAR_DURATION_HOURS = 24;

interface StartWarBody { opponentClanId: string }
interface AttackBody   { defenderPlayerId: string; stars: 0 | 1 | 2 | 3 }
interface EndWarBody   { warId: string }

// Bonus trophies awarded to the winning clan's members per-member.
// Modest — the ladder is ELO-based, clan wars are a side objective.
const WAR_WIN_TROPHY_BONUS = 25;
const WAR_DRAW_TROPHY_BONUS = 5;

export function registerWars(app: FastifyInstance): void {
  // -- Start -----------------------------------------------------------------
  app.post<{ Body: StartWarBody }>('/clan/war/start', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const body = req.body;
    if (!body || typeof body.opponentClanId !== 'string') {
      reply.code(400);
      return { error: 'opponentClanId required' };
    }
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Caller must be the leader of their own clan.
      const me = await client.query<{ clan_id: string; role: string }>(
        'SELECT clan_id, role FROM clan_members WHERE player_id = $1',
        [playerId],
      );
      if (me.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'not in a clan' };
      }
      const myClan = me.rows[0]!;
      if (myClan.role !== 'leader') {
        await client.query('ROLLBACK');
        reply.code(403);
        return { error: 'only the clan leader can start a war' };
      }
      if (myClan.clan_id === body.opponentClanId) {
        await client.query('ROLLBACK');
        reply.code(400);
        return { error: 'cannot war against your own clan' };
      }

      // Opponent clan must exist.
      const oppRes = await client.query<{ id: string }>(
        'SELECT id FROM clans WHERE id = $1',
        [body.opponentClanId],
      );
      if (oppRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'opponent clan not found' };
      }

      // Neither clan may already be in an active war. Condition mirrors
      // the partial index in migrations/0011 so Postgres picks it up.
      const busy = await client.query<{ id: string }>(
        `SELECT id FROM clan_wars
          WHERE status = 'active'
            AND (clan_a_id = $1 OR clan_b_id = $1
                 OR clan_a_id = $2 OR clan_b_id = $2)
          LIMIT 1`,
        [myClan.clan_id, body.opponentClanId],
      );
      if (busy.rows.length > 0) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: 'one of the clans is already in a war' };
      }

      const insert = await client.query<{ id: string; ends_at: Date }>(
        `INSERT INTO clan_wars (clan_a_id, clan_b_id, ends_at)
         VALUES ($1, $2, NOW() + ($3 || ' hours')::INTERVAL)
         RETURNING id, ends_at`,
        [myClan.clan_id, body.opponentClanId, String(WAR_DURATION_HOURS)],
      );
      await client.query('COMMIT');
      const row = insert.rows[0]!;
      return {
        ok: true,
        warId: row.id,
        endsAt: row.ends_at.toISOString(),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'clan/war/start failed');
      reply.code(500);
      return { error: 'start failed' };
    } finally {
      client.release();
    }
  });

  // -- Current state ---------------------------------------------------------
  app.get('/clan/war/current', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const me = await pool.query<{ clan_id: string }>(
      'SELECT clan_id FROM clan_members WHERE player_id = $1',
      [playerId],
    );
    if (me.rows.length === 0) {
      return { inClan: false, war: null };
    }
    const clanId = me.rows[0]!.clan_id;
    const war = await pool.query<{
      id: string;
      clan_a_id: string;
      clan_b_id: string;
      status: string;
      started_at: Date;
      ends_at: Date;
      stars_a: number;
      stars_b: number;
    }>(
      `SELECT id, clan_a_id, clan_b_id, status, started_at, ends_at,
              stars_a, stars_b
         FROM clan_wars
        WHERE status = 'active'
          AND (clan_a_id = $1 OR clan_b_id = $1)
        ORDER BY started_at DESC
        LIMIT 1`,
      [clanId],
    );
    if (war.rows.length === 0) {
      return { inClan: true, clanId, war: null };
    }
    const w = war.rows[0]!;
    const attacks = await pool.query<{
      attacker_player_id: string;
      attacker_clan_id: string;
      stars: number;
    }>(
      `SELECT attacker_player_id, attacker_clan_id, stars
         FROM clan_war_attacks
        WHERE war_id = $1`,
      [w.id],
    );
    return {
      inClan: true,
      clanId,
      war: {
        id: w.id,
        clanAId: w.clan_a_id,
        clanBId: w.clan_b_id,
        myClanSide: w.clan_a_id === clanId ? 'A' : 'B',
        status: w.status,
        startedAt: w.started_at.toISOString(),
        endsAt: w.ends_at.toISOString(),
        starsA: w.stars_a,
        starsB: w.stars_b,
        attacks: attacks.rows.map((r) => ({
          attackerPlayerId: r.attacker_player_id,
          attackerClanId: r.attacker_clan_id,
          stars: r.stars,
        })),
      },
    };
  });

  // -- Submit an attack ------------------------------------------------------
  //
  // Designed to be called client-side right after /api/raid/submit
  // succeeds against a clan-war opponent. The route does its own
  // validation (both players in matched clans, one attack per player
  // per war). It doesn't re-run the raid — raid.ts already did that.
  app.post<{ Body: AttackBody }>('/clan/war/attack', async (req, reply) => {
    const attackerId = requirePlayer(req, reply);
    if (!attackerId) return;
    const body = req.body;
    if (
      !body ||
      typeof body.defenderPlayerId !== 'string' ||
      ![0, 1, 2, 3].includes(body.stars)
    ) {
      reply.code(400);
      return { error: 'defenderPlayerId + stars in 0..3 required' };
    }
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lookup attacker + defender clans.
      const clans = await client.query<{ player_id: string; clan_id: string }>(
        `SELECT player_id, clan_id FROM clan_members
          WHERE player_id = ANY($1::uuid[])`,
        [[attackerId, body.defenderPlayerId]],
      );
      const attackerClan = clans.rows.find((r) => r.player_id === attackerId)?.clan_id;
      const defenderClan = clans.rows.find((r) => r.player_id === body.defenderPlayerId)?.clan_id;
      if (!attackerClan || !defenderClan) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'both players must be in clans' };
      }
      if (attackerClan === defenderClan) {
        await client.query('ROLLBACK');
        reply.code(400);
        return { error: 'attacker and defender are in the same clan' };
      }

      // Find the active war matching these two clans.
      const war = await client.query<{
        id: string;
        clan_a_id: string;
        clan_b_id: string;
      }>(
        `SELECT id, clan_a_id, clan_b_id
           FROM clan_wars
          WHERE status = 'active'
            AND ((clan_a_id = $1 AND clan_b_id = $2)
              OR (clan_a_id = $2 AND clan_b_id = $1))
          LIMIT 1`,
        [attackerClan, defenderClan],
      );
      if (war.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'no active war between these clans' };
      }
      const w = war.rows[0]!;

      // Insert or reject on duplicate (war_id, attacker) UNIQUE.
      const ins = await client.query<{ id: string }>(
        `INSERT INTO clan_war_attacks
           (war_id, attacker_clan_id, attacker_player_id,
            defender_player_id, stars)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (war_id, attacker_player_id) DO NOTHING
         RETURNING id`,
        [w.id, attackerClan, attackerId, body.defenderPlayerId, body.stars],
      );
      if (ins.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: 'you already used your war attack' };
      }

      // Aggregate onto the war side score.
      const isA = attackerClan === w.clan_a_id;
      await client.query(
        `UPDATE clan_wars
            SET stars_a = stars_a + CASE WHEN $2 THEN $3 ELSE 0 END,
                stars_b = stars_b + CASE WHEN $2 THEN 0 ELSE $3 END
          WHERE id = $1`,
        [w.id, isA, body.stars],
      );
      await client.query('COMMIT');
      return { ok: true, warId: w.id };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'clan/war/attack failed');
      reply.code(500);
      return { error: 'attack failed' };
    } finally {
      client.release();
    }
  });

  // -- Finalize -------------------------------------------------------------
  //
  // Idempotent: if the war is already 'ended' the route returns the
  // existing summary. Can be called by either clan after `ends_at`
  // has passed. In production a worker would sweep this; the endpoint
  // gives us a manual / on-demand path until that's written.
  app.post<{ Body: EndWarBody }>('/clan/war/end', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const body = req.body;
    if (!body || typeof body.warId !== 'string') {
      reply.code(400);
      return { error: 'warId required' };
    }
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const war = await client.query<{
        id: string;
        clan_a_id: string;
        clan_b_id: string;
        status: string;
        ends_at: Date;
        stars_a: number;
        stars_b: number;
        winning_clan_id: string | null;
      }>(
        `SELECT id, clan_a_id, clan_b_id, status, ends_at,
                stars_a, stars_b, winning_clan_id
           FROM clan_wars
          WHERE id = $1
          FOR UPDATE`,
        [body.warId],
      );
      if (war.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'war not found' };
      }
      const w = war.rows[0]!;
      if (w.status === 'ended') {
        await client.query('ROLLBACK');
        return {
          ok: true,
          alreadyEnded: true,
          winningClanId: w.winning_clan_id,
          starsA: w.stars_a,
          starsB: w.stars_b,
        };
      }
      if (w.ends_at.getTime() > Date.now()) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: 'war has not ended yet', endsAt: w.ends_at.toISOString() };
      }

      // Winner: higher star total. Tie → both get a small bonus.
      let winningClanId: string | null = null;
      let bonus = WAR_DRAW_TROPHY_BONUS;
      if (w.stars_a > w.stars_b) {
        winningClanId = w.clan_a_id;
        bonus = WAR_WIN_TROPHY_BONUS;
      } else if (w.stars_b > w.stars_a) {
        winningClanId = w.clan_b_id;
        bonus = WAR_WIN_TROPHY_BONUS;
      }

      // Pay out trophy bonus to every member of the winning clan
      // (or both clans on a tie).
      const recipientClans = winningClanId
        ? [winningClanId]
        : [w.clan_a_id, w.clan_b_id];
      for (const cid of recipientClans) {
        await client.query(
          `UPDATE players
              SET trophies = trophies + $2
            WHERE id IN (SELECT player_id FROM clan_members WHERE clan_id = $1)`,
          [cid, bonus],
        );
      }

      await client.query(
        `UPDATE clan_wars
            SET status = 'ended',
                ended_at = NOW(),
                winning_clan_id = $2
          WHERE id = $1`,
        [w.id, winningClanId],
      );
      await client.query('COMMIT');
      return {
        ok: true,
        winningClanId,
        starsA: w.stars_a,
        starsB: w.stars_b,
        bonusPerMember: bonus,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'clan/war/end failed');
      reply.code(500);
      return { error: 'end failed' };
    } finally {
      client.release();
    }
  });
}
