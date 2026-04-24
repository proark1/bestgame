import { randomBytes } from 'node:crypto';
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

      // Lock both clan rows before checking existing wars — without
      // this, two leaders racing each other could each see "no active
      // war" and both succeed at the INSERT, leaving a clan in two
      // wars at once. ORDER BY id keeps lock acquisition deterministic
      // across concurrent starters so we don't deadlock on reverse
      // pairs. The SELECT also validates opponent clan existence;
      // missing id → 404 in the same hop.
      const lockIds = [myClan.clan_id, body.opponentClanId].sort();
      const lockRes = await client.query<{ id: string }>(
        'SELECT id FROM clans WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [lockIds],
      );
      if (lockRes.rows.length !== 2) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'opponent clan not found' };
      }

      // Neither clan may already be in an active war. Safe now that
      // we hold row locks on both clans — any concurrent start will
      // block here until our transaction commits.
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

  // -- War opponent picker --------------------------------------------------
  //
  // Returns a random unattacked member of the opposing clan for the
  // caller's active war. Used by the client when the player taps
  // "Attack War Target" on the ClanWarsScene — it hands back a match
  // token the same shape as /match so the existing RaidScene flow
  // works unchanged. The token ties the pending match to a specific
  // war so /raid/submit can auto-submit to /clan/war/attack.
  app.post('/clan/war/find-target', async (req, reply) => {
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
      const me = await client.query<{ clan_id: string }>(
        'SELECT clan_id FROM clan_members WHERE player_id = $1',
        [playerId],
      );
      if (me.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'not in a clan' };
      }
      const myClanId = me.rows[0]!.clan_id;
      const war = await client.query<{
        id: string;
        clan_a_id: string;
        clan_b_id: string;
      }>(
        `SELECT id, clan_a_id, clan_b_id
           FROM clan_wars
          WHERE status = 'active'
            AND (clan_a_id = $1 OR clan_b_id = $1)
          ORDER BY started_at DESC
          LIMIT 1`,
        [myClanId],
      );
      if (war.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'no active war' };
      }
      const w = war.rows[0]!;
      // Did the caller already use their war attack?
      const alreadyAttacked = await client.query<{ id: string }>(
        `SELECT id FROM clan_war_attacks
          WHERE war_id = $1 AND attacker_player_id = $2`,
        [w.id, playerId],
      );
      if (alreadyAttacked.rows.length > 0) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: 'you already used your war attack' };
      }
      const opponentClanId = w.clan_a_id === myClanId ? w.clan_b_id : w.clan_a_id;
      // Pick a member of the opposing clan the caller hasn't attacked
      // yet in this war. We pick one at random from the unattacked set.
      const target = await client.query<{
        player_id: string;
        display_name: string;
        trophies: number;
        snapshot: unknown;
        seed: string | null;
      }>(
        `SELECT cm.player_id, p.display_name, p.trophies,
                b.snapshot,
                NULL::text AS seed
           FROM clan_members cm
           JOIN players p ON p.id = cm.player_id
           LEFT JOIN bases b ON b.player_id = p.id
          WHERE cm.clan_id = $1
            AND cm.player_id <> $2
          ORDER BY RANDOM()
          LIMIT 1`,
        [opponentClanId, playerId],
      );
      if (target.rows.length === 0 || !target.rows[0]!.snapshot) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'no war target available' };
      }
      const t = target.rows[0]!;
      // Create a pending_match the same way /api/match does. The
      // resulting matchToken + defenderId feeds the existing RaidScene
      // flow; once the client completes the raid + /raid/submit, the
      // scene calls /clan/war/attack with the result to record the war
      // hit. Matchmaking's own token shape is a 32-char hex string so
      // we mint one of the same shape here.
      const token = randomBytes(16).toString('hex');
      const seed = Math.floor(Math.random() * 2 ** 31);
      const insert = await client.query<{ expires_at: Date }>(
        `INSERT INTO pending_matches
           (token, attacker_id, defender_id, seed, base_snapshot, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb,
                 NOW() + INTERVAL '15 minutes')
         RETURNING expires_at`,
        [
          token,
          playerId,
          t.player_id,
          seed,
          JSON.stringify(t.snapshot),
        ],
      );
      await client.query('COMMIT');
      const row = insert.rows[0]!;
      return {
        ok: true,
        matchToken: token,
        warId: w.id,
        defenderId: t.player_id,
        seed,
        expiresAt: row.expires_at.toISOString(),
        opponent: {
          isBot: false,
          displayName: t.display_name,
          trophies: t.trophies,
        },
        baseSnapshot: t.snapshot,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'clan/war/find-target failed');
      reply.code(500);
      return { error: 'target pick failed' };
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
      // Pull `has_ended` from Postgres itself rather than comparing
      // `ends_at` against the API node's `Date.now()` — the app and
      // DB clocks can drift, especially across deploys, and the
      // shield + matchmaking code already uses DB-side NOW() for the
      // same reason. One extra boolean column on the result keeps
      // the expiration decision consistent with the source of truth.
      const war = await client.query<{
        id: string;
        clan_a_id: string;
        clan_b_id: string;
        status: string;
        ends_at: Date;
        stars_a: number;
        stars_b: number;
        winning_clan_id: string | null;
        has_ended: boolean;
      }>(
        `SELECT id, clan_a_id, clan_b_id, status, ends_at,
                stars_a, stars_b, winning_clan_id,
                ends_at <= NOW() AS has_ended
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
      if (!w.has_ended) {
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
