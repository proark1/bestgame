import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';

// /api/leaderboard — top N players by trophies, paginated by rank.
//
// Public to any authenticated player. Returns the caller's own rank
// alongside the top list so we can show "You're #N" without a second
// round-trip.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface LeaderboardEntry {
  rank: number;
  playerId: string;
  displayName: string;
  faction: string;
  trophies: number;
}

export function registerLeaderboard(app: FastifyInstance): void {
  app.get('/leaderboard', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }

    const qLimit = Number((req.query as { limit?: string } | null)?.limit);
    const limit = Number.isFinite(qLimit) && qLimit > 0
      ? Math.min(MAX_LIMIT, Math.floor(qLimit))
      : DEFAULT_LIMIT;

    // Top N + caller's row. RANK() handles ties (two players at 100
    // trophies share rank 1). We query both in a single round-trip.
    const res = await pool.query<{
      id: string;
      display_name: string;
      faction: string;
      trophies: number;
      rank: string; // bigint
    }>(
      `WITH ranked AS (
         SELECT p.id, p.display_name, p.faction, p.trophies,
                RANK() OVER (ORDER BY p.trophies DESC, p.last_seen_at DESC) AS rank
           FROM players p
       )
       SELECT id, display_name, faction, trophies, rank
         FROM ranked
        WHERE rank <= $1 OR id = $2
        ORDER BY rank ASC`,
      [limit, playerId],
    );

    const top: LeaderboardEntry[] = [];
    let me: LeaderboardEntry | null = null;
    for (const r of res.rows) {
      const entry: LeaderboardEntry = {
        rank: Number(r.rank),
        playerId: r.id,
        displayName: r.display_name,
        faction: r.faction,
        trophies: r.trophies,
      };
      if (entry.rank <= limit) top.push(entry);
      if (entry.playerId === playerId) me = entry;
    }

    return {
      top,
      me,
      limit,
    };
  });
}
