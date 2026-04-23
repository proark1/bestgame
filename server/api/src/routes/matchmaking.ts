import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Types } from '@hive/shared';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';

// /api/match — pairs the authenticated attacker with a defender, stores
// the authoritative (defenderId, seed, baseSnapshot) tuple in
// pending_matches keyed by a random token, and returns that token to
// the client. /api/raid/submit later looks up the row and runs the sim
// against the server-owned snapshot so a malicious client can't spoof
// the defender's base to farm loot.
//
// The base snapshot *is* returned to the client here, but purely for
// rendering — it is never read back on submit.

const TROPHY_BAND = 75;
const ACTIVE_WINDOW_DAYS = 3;
const MATCH_TTL_MINUTES = 15;

interface MatchResponse {
  matchToken: string;
  defenderId: string | null;
  trophiesSought: number;
  seed: number;
  baseSnapshot: Types.Base;
  opponent: { isBot: boolean; displayName: string; trophies: number };
}

function deterministicSeed(salt: string): number {
  let h = 2166136261 >>> 0;
  const src = `${salt}:${Math.floor(Date.now() / 3600000)}`;
  for (let i = 0; i < src.length; i++) {
    h = Math.imul(h ^ src.charCodeAt(i), 16777619) >>> 0;
  }
  return h >>> 0;
}

function randomToken(): string {
  return randomBytes(24).toString('base64url');
}

function botBase(): { base: Types.Base; opponent: MatchResponse['opponent'] } {
  return {
    base: {
      baseId: 'bot-0', ownerId: 'bot-0', faction: 'Beetles',
      gridSize: { w: 16, h: 12 },
      resources: { sugar: 1600, leafBits: 420, aphidMilk: 0 },
      trophies: 80, version: 1, tunnels: [],
      buildings: [
        { id: 'b-queen', kind: 'QueenChamber',
          anchor: { x: 8, y: 6, layer: 0 }, footprint: { w: 2, h: 2 },
          spans: [0, 1], level: 1, hp: 800, hpMax: 800 },
        { id: 'b-turret-1', kind: 'MushroomTurret',
          anchor: { x: 5, y: 4, layer: 0 }, footprint: { w: 1, h: 1 },
          level: 1, hp: 400, hpMax: 400 },
        { id: 'b-turret-2', kind: 'MushroomTurret',
          anchor: { x: 12, y: 4, layer: 0 }, footprint: { w: 1, h: 1 },
          level: 1, hp: 400, hpMax: 400 },
        { id: 'b-wall-1', kind: 'LeafWall',
          anchor: { x: 6, y: 6, layer: 0 }, footprint: { w: 1, h: 1 },
          level: 1, hp: 600, hpMax: 600 },
        { id: 'b-bunker', kind: 'PebbleBunker',
          anchor: { x: 3, y: 9, layer: 0 }, footprint: { w: 1, h: 1 },
          level: 1, hp: 900, hpMax: 900 },
        { id: 'b-vault-1', kind: 'SugarVault',
          anchor: { x: 10, y: 9, layer: 1 }, footprint: { w: 1, h: 1 },
          level: 1, hp: 350, hpMax: 350 },
      ],
    },
    opponent: { isBot: true, displayName: 'Beetle Outpost', trophies: 80 },
  };
}

interface MatchBody {
  playerId?: string;
  trophies?: number;
}

export function registerMatchmaking(app: FastifyInstance): void {
  app.post<{ Body: MatchBody }>('/match', async (req, reply) => {
    const attackerId = requirePlayer(req, reply);
    if (!attackerId) return;
    const trophies = Math.max(
      0,
      Number.isFinite(req.body?.trophies) ? Math.floor(req.body!.trophies!) : 100,
    );
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }

    // Real-player query: 3-day active window + fully random pick so we
    // don't dogpile onto the most-recent last_seen_at. Excludes self.
    // Also excludes defenders under an active raid shield — shields
    // are granted on losing 2+ stars defensively, see
    // server/api/src/routes/raid.ts / game/shield.ts.
    const match = await pool.query<{
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
          AND p.last_seen_at > NOW() - ($4 || ' days')::INTERVAL
          AND (p.shield_expires_at IS NULL OR p.shield_expires_at <= NOW())
        ORDER BY random()
        LIMIT 1`,
      [
        attackerId,
        trophies - TROPHY_BAND,
        trophies + TROPHY_BAND,
        String(ACTIVE_WINDOW_DAYS),
      ],
    );

    // Build the tuple.
    let defenderId: string | null;
    let snapshot: Types.Base;
    let opponent: MatchResponse['opponent'];
    let seed: number;

    if (match.rows.length > 0) {
      const row = match.rows[0]!;
      defenderId = row.id;
      snapshot = {
        ...row.snapshot,
        ownerId: row.id,
        baseId: row.id,
        trophies: row.trophies,
      };
      opponent = { isBot: false, displayName: row.display_name, trophies: row.trophies };
      seed = deterministicSeed(`${attackerId}:${row.id}:${Date.now()}`);
    } else {
      const bot = botBase();
      defenderId = null;
      snapshot = bot.base;
      opponent = bot.opponent;
      seed = deterministicSeed(`bot:${attackerId}:${Date.now()}`);
    }

    const token = randomToken();
    await pool.query(
      `INSERT INTO pending_matches
         (token, attacker_id, defender_id, seed, base_snapshot, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + ($6 || ' minutes')::INTERVAL)`,
      [token, attackerId, defenderId, seed, JSON.stringify(snapshot), String(MATCH_TTL_MINUTES)],
    );

    // Best-effort: prune expired tuples so the table stays small. Swallow
    // errors — the INSERT already succeeded and this is maintenance.
    pool
      .query('DELETE FROM pending_matches WHERE expires_at < NOW()')
      .catch(() => undefined);

    const response: MatchResponse = {
      matchToken: token,
      defenderId,
      trophiesSought: trophies,
      seed,
      baseSnapshot: snapshot,
      opponent,
    };
    return response;
  });
}
