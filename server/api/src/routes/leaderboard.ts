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
  // GET /api/online — rough "players online right now" counter
  // computed from players.last_seen_at within the last 5 minutes.
  // Used by HomeScene to render a "327 online" chip next to the
  // raid CTA — turns matchmaking latency into a social signal.
  // Cached for 30s in-process so a poll storm can't hammer the DB.
  let onlineCache: { value: number; fetchedAt: number } | null = null;
  app.get('/online', async () => {
    const pool = await getPool();
    if (!pool) return { online: 0 };
    const now = Date.now();
    if (onlineCache && now - onlineCache.fetchedAt < 30_000) {
      return { online: onlineCache.value };
    }
    try {
      const res = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c
           FROM players
          WHERE last_seen_at > NOW() - INTERVAL '5 minutes'`,
      );
      const value = Number(res.rows[0]?.c ?? 0) || 0;
      onlineCache = { value, fetchedAt: now };
      return { online: value };
    } catch {
      return { online: onlineCache?.value ?? 0 };
    }
  });

  app.get('/leaderboard', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
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
