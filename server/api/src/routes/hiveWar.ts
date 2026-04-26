import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';

// Giant-map hive wars — foundation routes.
//
// Step 8 of the audit asked for "weekly hive wars on a giant shared
// map". The full mechanic (attack windows, neighbour targeting,
// base anchoring) is multi-week; this ships the foundation:
// seasons + enrollment + map state + scoreboard. Attack mechanics
// land on a future PR using the same season + enrollment tables.

// Helper: find next available slot in (board_w × board_h), left-to-
// right top-to-bottom. Returns null if the season is full. Pure
// computation — exported so unit tests can pin the scan order
// without spinning up a DB.
export function nextAvailableSlot(
  occupied: ReadonlyArray<{ x: number; y: number }>,
  boardW: number,
  boardH: number,
): { x: number; y: number } | null {
  const taken = new Set<string>();
  for (const o of occupied) taken.add(`${o.x},${o.y}`);
  for (let y = 0; y < boardH; y++) {
    for (let x = 0; x < boardW; x++) {
      if (!taken.has(`${x},${y}`)) return { x, y };
    }
  }
  return null;
}

export function registerHiveWar(app: FastifyInstance): void {
  // GET /api/hivewar/season/current — current open or active season,
  // with every enrolled clan's slot + score so the client can render
  // a single map view in one round-trip.
  app.get('/hivewar/season/current', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    // Latest open or active season — the seed migration always
    // leaves at least one of these in the table.
    const seasonRes = await pool.query<{
      id: string;
      name: string;
      starts_at: Date;
      ends_at: Date;
      board_w: number;
      board_h: number;
      state: string;
    }>(
      `SELECT id, name, starts_at, ends_at, board_w, board_h, state
         FROM hive_war_seasons
        WHERE state IN ('open', 'active')
        ORDER BY starts_at DESC
        LIMIT 1`,
    );
    if (seasonRes.rows.length === 0) {
      return { season: null };
    }
    const s = seasonRes.rows[0]!;
    const enrollments = await pool.query<{
      clan_id: string;
      clan_name: string | null;
      clan_tag: string | null;
      slot_x: number;
      slot_y: number;
      score: number;
      attacks_made: number;
      attacks_received: number;
    }>(
      `SELECT e.clan_id, c.name AS clan_name, c.tag AS clan_tag,
              e.slot_x, e.slot_y, e.score,
              e.attacks_made, e.attacks_received
         FROM hive_war_enrollments e
         LEFT JOIN clans c ON c.id = e.clan_id
        WHERE e.season_id = $1
        ORDER BY e.score DESC, e.enrolled_at ASC`,
      [s.id],
    );
    // The viewer's own enrollment, if any, surfaced as a separate
    // field so the client can render "your clan is here →" without
    // scanning the list.
    const my = await pool.query<{ clan_id: string }>(
      `SELECT cm.clan_id FROM clan_members cm WHERE cm.player_id = $1::uuid`,
      [playerId],
    );
    const myClanId = my.rows[0]?.clan_id ?? null;
    const myEntry = enrollments.rows.find((r) => r.clan_id === myClanId) ?? null;
    return {
      season: {
        id: Number(s.id),
        name: s.name,
        startsAt: s.starts_at.toISOString(),
        endsAt: s.ends_at.toISOString(),
        boardW: s.board_w,
        boardH: s.board_h,
        state: s.state as 'open' | 'active' | 'finished',
      },
      enrollments: enrollments.rows.map((r) => ({
        clanId: r.clan_id,
        clanName: r.clan_name ?? 'Unknown Clan',
        clanTag: r.clan_tag ?? '',
        slotX: r.slot_x,
        slotY: r.slot_y,
        score: r.score,
        attacksMade: r.attacks_made,
        attacksReceived: r.attacks_received,
      })),
      myClanId,
      myEnrollment: myEntry
        ? {
            slotX: myEntry.slot_x,
            slotY: myEntry.slot_y,
            score: myEntry.score,
            attacksMade: myEntry.attacks_made,
            attacksReceived: myEntry.attacks_received,
          }
        : null,
    };
  });

  // POST /api/hivewar/season/:id/enroll — clan leader enrolls their
  // clan in the season. Slot is assigned by the server (next
  // available); player can't pick. Idempotent on re-call: if the
  // clan is already enrolled, returns the existing slot rather
  // than re-allocating.
  app.post<{ Params: { id: string } }>(
    '/hivewar/season/:id/enroll',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const seasonId = Number(req.params.id);
      if (!Number.isFinite(seasonId) || seasonId <= 0) {
        reply.code(400);
        return { error: 'invalid season id' };
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Lock the season row so two concurrent leaders enrolling
        // simultaneously don't race on slot allocation.
        const seasonRes = await client.query<{
          id: string;
          board_w: number;
          board_h: number;
          state: string;
        }>(
          `SELECT id, board_w, board_h, state
             FROM hive_war_seasons
            WHERE id = $1
            FOR UPDATE`,
          [seasonId],
        );
        if (seasonRes.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'season not found' };
        }
        const season = seasonRes.rows[0]!;
        if (season.state !== 'open') {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: 'season is not accepting enrollments' };
        }
        // Caller must be a clan leader — only leaders enroll their
        // clan in a war.
        const role = await client.query<{ clan_id: string; role: string }>(
          `SELECT clan_id, role FROM clan_members WHERE player_id = $1::uuid`,
          [playerId],
        );
        if (role.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(403);
          return { error: 'not in a clan' };
        }
        const { clan_id: clanId, role: memberRole } = role.rows[0]!;
        if (memberRole !== 'leader') {
          await client.query('ROLLBACK');
          reply.code(403);
          return { error: 'only the clan leader can enroll' };
        }
        // Already enrolled? Surface the existing slot rather than
        // 409-ing — the leader probably tapped twice.
        const existing = await client.query<{ slot_x: number; slot_y: number }>(
          `SELECT slot_x, slot_y FROM hive_war_enrollments
            WHERE season_id = $1 AND clan_id = $2::uuid`,
          [seasonId, clanId],
        );
        if (existing.rows.length > 0) {
          await client.query('COMMIT');
          return {
            ok: true,
            alreadyEnrolled: true,
            slotX: existing.rows[0]!.slot_x,
            slotY: existing.rows[0]!.slot_y,
          };
        }
        // Pick next available slot.
        const occ = await client.query<{ slot_x: number; slot_y: number }>(
          `SELECT slot_x, slot_y FROM hive_war_enrollments
            WHERE season_id = $1`,
          [seasonId],
        );
        const slot = nextAvailableSlot(
          occ.rows.map((r) => ({ x: r.slot_x, y: r.slot_y })),
          season.board_w,
          season.board_h,
        );
        if (!slot) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: 'season is full' };
        }
        await client.query(
          `INSERT INTO hive_war_enrollments
             (season_id, clan_id, slot_x, slot_y)
           VALUES ($1, $2::uuid, $3, $4)`,
          [seasonId, clanId, slot.x, slot.y],
        );
        await client.query('COMMIT');
        return { ok: true, alreadyEnrolled: false, slotX: slot.x, slotY: slot.y };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'hivewar/enroll failed');
        reply.code(500);
        return { error: 'enrollment failed' };
      } finally {
        client.release();
      }
    },
  );
}
