import type { FastifyInstance } from 'fastify';
import type { Types } from '@hive/shared';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';

// /api/match — find an opponent for a raid.
//
// 1. If DB is configured + the attacker is authenticated, query `bases`
//    for a player in a ±TROPHY_BAND window, excluding the attacker, and
//    prefer recently-active ones.
// 2. Otherwise (unauthenticated, or empty pool, or DB down), fall back
//    to the hard-coded bot base so the client flow still works.

const TROPHY_BAND = 75;
// Returned directly from DB — matching the attacker's own layout in the
// pool is fine (the raid still resolves deterministically against the
// snapshot) but we deprioritize it so the attacker fights someone else
// when possible.

interface MatchResponse {
  defenderId: string | null;
  trophiesSought: number;
  seed: number;
  baseSnapshot: Types.Base;
  opponent: { isBot: boolean; displayName: string; trophies: number };
}

function deterministicSeed(salt: string): number {
  // Hash-like derivation that includes the current hour — stable enough
  // for anti-replay but rotates over time so a player seeing the same
  // opponent hits a different seed.
  let h = 2166136261 >>> 0;
  const src = `${salt}:${Math.floor(Date.now() / 3600000)}`;
  for (let i = 0; i < src.length; i++) {
    h = Math.imul(h ^ src.charCodeAt(i), 16777619) >>> 0;
  }
  return h >>> 0;
}

function botBase(seed: number): { id: null; base: Types.Base; opponent: MatchResponse['opponent'] } {
  return {
    id: null,
    base: {
      baseId: 'bot-0',
      ownerId: 'bot-0',
      faction: 'Beetles',
      gridSize: { w: 16, h: 12 },
      resources: { sugar: 1600, leafBits: 420, aphidMilk: 0 },
      trophies: 80,
      version: 1,
      tunnels: [],
      buildings: [
        {
          id: 'b-queen', kind: 'QueenChamber',
          anchor: { x: 8, y: 6, layer: 0 },
          footprint: { w: 2, h: 2 }, spans: [0, 1],
          level: 1, hp: 800, hpMax: 800,
        },
        {
          id: 'b-turret-1', kind: 'MushroomTurret',
          anchor: { x: 5, y: 4, layer: 0 },
          footprint: { w: 1, h: 1 },
          level: 1, hp: 400, hpMax: 400,
        },
        {
          id: 'b-turret-2', kind: 'MushroomTurret',
          anchor: { x: 12, y: 4, layer: 0 },
          footprint: { w: 1, h: 1 },
          level: 1, hp: 400, hpMax: 400,
        },
        {
          id: 'b-wall-1', kind: 'LeafWall',
          anchor: { x: 6, y: 6, layer: 0 },
          footprint: { w: 1, h: 1 },
          level: 1, hp: 600, hpMax: 600,
        },
        {
          id: 'b-bunker', kind: 'PebbleBunker',
          anchor: { x: 3, y: 9, layer: 0 },
          footprint: { w: 1, h: 1 },
          level: 1, hp: 900, hpMax: 900,
        },
        {
          id: 'b-vault-1', kind: 'SugarVault',
          anchor: { x: 10, y: 9, layer: 1 },
          footprint: { w: 1, h: 1 },
          level: 1, hp: 350, hpMax: 350,
        },
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
    const attackerId = req.playerId ?? null;
    const trophies = Math.max(
      0,
      Number.isFinite(req.body?.trophies) ? Math.floor(req.body!.trophies!) : 100,
    );
    const pool = await getPool();

    // Fallback: no auth or no DB → send the bot.
    if (!pool || !attackerId) {
      const seed = deterministicSeed(`bot:${req.body?.playerId ?? 'anon'}`);
      const { base, opponent } = botBase(seed);
      const response: MatchResponse = {
        defenderId: null,
        trophiesSought: trophies,
        seed,
        baseSnapshot: base,
        opponent,
      };
      return response;
    }

    // Try to find a real opponent within trophy band. Prefer recently
    // active players (last_seen_at DESC). Tie-break with a small random
    // so we don't always pick the exact same defender.
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
        ORDER BY p.last_seen_at DESC, random()
        LIMIT 1`,
      [attackerId, trophies - TROPHY_BAND, trophies + TROPHY_BAND],
    );

    if (match.rows.length === 0) {
      // No real opponent in band — bot.
      const seed = deterministicSeed(`bot:${attackerId}`);
      const { base, opponent } = botBase(seed);
      const response: MatchResponse = {
        defenderId: null,
        trophiesSought: trophies,
        seed,
        baseSnapshot: base,
        opponent,
      };
      return response;
    }

    const row = match.rows[0]!;
    // Attach the trophy/displayname to the snapshot so the client's
    // opponent card can render without a second round-trip.
    const snapshot: Types.Base = {
      ...row.snapshot,
      ownerId: row.id,
      baseId: row.id,
      trophies: row.trophies,
    };
    const response: MatchResponse = {
      defenderId: row.id,
      trophiesSought: trophies,
      seed: deterministicSeed(`${attackerId}:${row.id}`),
      baseSnapshot: snapshot,
      opponent: {
        isBot: false,
        displayName: row.display_name,
        trophies: row.trophies,
      },
    };
    // requirePlayer isn't called because unauth'd callers already took the
    // bot branch above — we only reach here when attackerId is set.
    void reply;
    return response;
  });

  // Not exported — kept so the requirePlayer import stays used if future
  // matchmaking features (friends, revenge, ranked) need auth.
  void requirePlayer;
}
