import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Types } from '@hive/shared';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';
import { parseBase } from '../game/parseBase.js';

// /api/arena/reserve — the live-PvP pairing entrypoint.
//
// Mirrors the async-raid matchmaking shape so the Colyseus arena never
// has to trust a client-supplied base. The flow:
//
//   1. Client POSTs /api/arena/reserve (optionally with a trophy band).
//   2. We find a second player in-band OR return 409 "no opponent" so
//      the client can offer a bot-arena fallback.
//   3. We snapshot both bases, pick a seed, mint a token, and persist
//      into arena_matches with a 15-minute TTL.
//   4. Both players connect to the Colyseus `picnic` room with
//      ?token=<token>; the arena server looks the row up and seeds the
//      sim with the persisted host_snapshot.
//
// The "host" is the player whose base becomes the map. We pick it
// deterministically (the player with the lower UUID lexicographically)
// so reservation is reproducible across retries.

const ARENA_TROPHY_BAND = 120;
const ARENA_ACTIVE_WINDOW_MINUTES = 10; // live PvP needs a fresher pool than raids
const ARENA_MATCH_TTL_MINUTES = 15;

// Postgres BIGINT comes back as string. Coerce + reject NaN/Infinity
// so a malformed seed surfaces as a clear 500 instead of silently
// corrupting the deterministic sim's RNG. Mirrors the same guard on
// /raid/submit.
function parseSeed(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

interface ReserveResponse {
  arenaToken: string;
  role: 'host' | 'challenger';
  seed: number;
  opponent: {
    playerId: string;
    displayName: string;
    trophies: number;
  };
  hostSnapshot: Types.Base;
  challengerSnapshot: Types.Base;
}

function randomToken(): string {
  return randomBytes(24).toString('base64url');
}

function arenaSeed(salt: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < salt.length; i++) {
    h = Math.imul(h ^ salt.charCodeAt(i), 16777619) >>> 0;
  }
  return h >>> 0;
}

export function registerArena(app: FastifyInstance): void {
  // Arbitrary 32-bit namespace for the reserve-flow advisory lock. Any
  // constant works; we only need all reserve callers to agree on the
  // same value so pg_advisory_xact_lock serializes them. "ARENARSV" in
  // ASCII-ish hex keeps it self-documenting in pg_locks output.
  const RESERVE_LOCK_KEY = 0x4152454e; // 'AREN'

  app.post('/arena/reserve', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }

    // Serialize the whole existing-lookup + opponent-match + insert
    // sequence behind an advisory transaction lock. Without this, two
    // simultaneous callers can both observe "no active row" and both
    // INSERT, producing two tokens for the same pair and silently
    // breaking rendezvous. Throughput cost is trivial (reserve is ~ms
    // work, called a handful of times per arena session).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [RESERVE_LOCK_KEY]);

      // Rendezvous rule: if any unexpired, unfinished reservation already
      // names THIS player as host or challenger, return it verbatim so
      // both callers end up with the same arenaToken and meet in the
      // same Colyseus room.
      const existing = await client.query<{
        token: string;
        seed: string;
        host_player_id: string;
        challenger_player_id: string;
        host_snapshot: Types.Base;
        challenger_snapshot: Types.Base;
      }>(
        `SELECT token, seed, host_player_id, challenger_player_id,
                host_snapshot, challenger_snapshot
           FROM arena_matches
          WHERE (host_player_id = $1 OR challenger_player_id = $1)
            AND expires_at > NOW()
            AND finished_at IS NULL
          ORDER BY created_at ASC
          LIMIT 1`,
        [playerId],
      );
      if (existing.rows.length > 0) {
        const r = existing.rows[0]!;
        const seed = parseSeed(r.seed);
        if (seed === null) {
          await client.query('ROLLBACK');
          reply.code(500);
          return { error: 'arena reservation has invalid seed' };
        }
        const hostSnapshot = parseBase(r.host_snapshot);
        const challengerSnapshot = parseBase(r.challenger_snapshot);
        if (!hostSnapshot || !challengerSnapshot) {
          await client.query('ROLLBACK');
          reply.code(500);
          return { error: 'arena reservation has malformed snapshot' };
        }
        const oppId =
          r.host_player_id === playerId ? r.challenger_player_id : r.host_player_id;
        const oppRow = await client.query<{
          display_name: string;
          trophies: number;
        }>('SELECT display_name, trophies FROM players WHERE id = $1', [oppId]);
        const opp = oppRow.rows[0];
        await client.query('COMMIT');
        const rendezvous: ReserveResponse = {
          arenaToken: r.token,
          role: r.host_player_id === playerId ? 'host' : 'challenger',
          seed,
          opponent: {
            playerId: oppId,
            displayName: opp?.display_name ?? 'Unknown',
            trophies: opp?.trophies ?? 0,
          },
          hostSnapshot,
          challengerSnapshot,
        };
        return rendezvous;
      }

      // No rendezvous yet — try to create a fresh reservation.
      const self = await client.query<{
        trophies: number;
        display_name: string;
        snapshot: Types.Base;
      }>(
        `SELECT p.trophies, p.display_name, b.snapshot
           FROM players p
           JOIN bases b ON b.player_id = p.id
          WHERE p.id = $1`,
        [playerId],
      );
      if (self.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'player or base missing' };
      }
      const me = self.rows[0]!;

      // Opponent query: trophy-banded, freshly-active, excludes self
      // AND excludes anyone already in an active reservation (they'll
      // hit the rendezvous branch above on their next call).
      const opp = await client.query<{
        id: string;
        display_name: string;
        trophies: number;
        snapshot: Types.Base;
      }>(
        `SELECT p.id, p.display_name, p.trophies, b.snapshot
           FROM players p
           JOIN bases b ON b.player_id = p.id
          WHERE p.id <> $1
            AND p.trophies BETWEEN $2 AND $3
            AND p.last_seen_at > NOW() - ($4 || ' minutes')::INTERVAL
            AND NOT EXISTS (
              SELECT 1 FROM arena_matches m
               WHERE (m.host_player_id = p.id OR m.challenger_player_id = p.id)
                 AND m.expires_at > NOW()
                 AND m.finished_at IS NULL
            )
          ORDER BY p.last_seen_at DESC
          LIMIT 1`,
        [
          playerId,
          me.trophies - ARENA_TROPHY_BAND,
          me.trophies + ARENA_TROPHY_BAND,
          String(ARENA_ACTIVE_WINDOW_MINUTES),
        ],
      );
      if (opp.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(409);
        return {
          error: 'no arena opponent online — try again soon or use a bot arena',
        };
      }
      const other = opp.rows[0]!;

      // Deterministic host pick so both players agree without a
      // second-phase handshake. Lower UUID wins (hosts).
      const hostId = playerId < other.id ? playerId : other.id;
      const challengerId = hostId === playerId ? other.id : playerId;
      const hostSnapshot = hostId === playerId ? me.snapshot : other.snapshot;
      const challengerSnapshot =
        challengerId === playerId ? me.snapshot : other.snapshot;

      const token = randomToken();
      const seed = arenaSeed(`${hostId}:${challengerId}:${Date.now()}`);

      await client.query(
        `INSERT INTO arena_matches
           (token, host_player_id, challenger_player_id, seed,
            host_snapshot, challenger_snapshot, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb,
                 NOW() + ($7 || ' minutes')::INTERVAL)`,
        [
          token,
          hostId,
          challengerId,
          seed,
          JSON.stringify(hostSnapshot),
          JSON.stringify(challengerSnapshot),
          String(ARENA_MATCH_TTL_MINUTES),
        ],
      );

      await client.query('COMMIT');

      // Best-effort prune of stale rows (outside the xact lock).
      pool
        .query('DELETE FROM arena_matches WHERE expires_at < NOW()')
        .catch(() => undefined);

      const response: ReserveResponse = {
        arenaToken: token,
        role: hostId === playerId ? 'host' : 'challenger',
        seed,
        opponent: {
          playerId: other.id,
          displayName: other.display_name,
          trophies: other.trophies,
        },
        hostSnapshot,
        challengerSnapshot,
      };
      return response;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'arena reserve failed');
      reply.code(500);
      return { error: 'arena reserve failed' };
    } finally {
      client.release();
    }
  });

  // The arena server calls this to redeem a token and get the
  // authoritative snapshot+seed tuple. Authenticated via a shared
  // secret so it's not browser-reachable. If ARENA_SHARED_SECRET is
  // unset we fall back to localhost-only (convenient for dev); in
  // production you SHOULD set it and pass it as a header.
  app.post<{ Body: { arenaToken: string } }>(
    '/arena/_lookup',
    async (req, reply) => {
      const expected = process.env.ARENA_SHARED_SECRET;
      const provided = req.headers['x-arena-secret'];
      if (expected) {
        if (typeof provided !== 'string' || provided !== expected) {
          reply.code(401);
          return { error: 'arena secret required' };
        }
      } else {
        const remote = req.ip;
        if (remote !== '127.0.0.1' && remote !== '::1') {
          reply.code(401);
          return {
            error: 'ARENA_SHARED_SECRET unset; _lookup accepts loopback only',
          };
        }
      }
      const body = req.body;
      if (!body || typeof body.arenaToken !== 'string') {
        reply.code(400);
        return { error: 'arenaToken required' };
      }
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
      }
      const row = await pool.query<{
        host_player_id: string;
        challenger_player_id: string;
        seed: string;
        host_snapshot: Types.Base;
        challenger_snapshot: Types.Base;
      }>(
        `SELECT host_player_id, challenger_player_id, seed,
                host_snapshot, challenger_snapshot
           FROM arena_matches
          WHERE token = $1 AND expires_at > NOW()`,
        [body.arenaToken],
      );
      if (row.rows.length === 0) {
        reply.code(404);
        return { error: 'unknown, expired, or already-used arena token' };
      }
      const r = row.rows[0]!;
      const seed = parseSeed(r.seed);
      if (seed === null) {
        reply.code(500);
        return { error: 'arena reservation has invalid seed' };
      }
      const hostSnapshot = parseBase(r.host_snapshot);
      const challengerSnapshot = parseBase(r.challenger_snapshot);
      if (!hostSnapshot || !challengerSnapshot) {
        reply.code(500);
        return { error: 'arena reservation has malformed snapshot' };
      }
      return {
        hostPlayerId: r.host_player_id,
        challengerPlayerId: r.challenger_player_id,
        seed,
        hostSnapshot,
        challengerSnapshot,
      };
    },
  );

  // Arena → API result callback. The Colyseus server POSTs this when a
  // match finishes so we can record the outcome alongside the
  // reservation row. Same auth shape as _lookup.
  app.post<{
    Body: {
      arenaToken: string;
      outcome: string;
      winnerSlot: number | null;
      ticks: number;
      finalStateHash: string;
    };
  }>('/arena/_result', async (req, reply) => {
    const expected = process.env.ARENA_SHARED_SECRET;
    const provided = req.headers['x-arena-secret'];
    if (expected) {
      if (typeof provided !== 'string' || provided !== expected) {
        reply.code(401);
        return { error: 'arena secret required' };
      }
    } else if (req.ip !== '127.0.0.1' && req.ip !== '::1') {
      reply.code(401);
      return { error: 'ARENA_SHARED_SECRET unset; _result accepts loopback only' };
    }
    const body = req.body;
    if (
      !body ||
      typeof body.arenaToken !== 'string' ||
      typeof body.outcome !== 'string' ||
      typeof body.ticks !== 'number' ||
      typeof body.finalStateHash !== 'string'
    ) {
      reply.code(400);
      return { error: 'bad request' };
    }
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const upd = await pool.query(
      `UPDATE arena_matches
          SET outcome = $2,
              winner_slot = $3,
              ticks = $4,
              final_state_hash = $5,
              finished_at = NOW()
        WHERE token = $1`,
      [
        body.arenaToken,
        body.outcome,
        body.winnerSlot,
        body.ticks,
        body.finalStateHash,
      ],
    );
    if ((upd.rowCount ?? 0) === 0) {
      reply.code(404);
      return { error: 'unknown arena token' };
    }
    return { ok: true };
  });
}
