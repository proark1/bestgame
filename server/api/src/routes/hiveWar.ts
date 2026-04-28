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

// Reward sweep — top-3 clans by score get a sugar/leaf bonus paid
// to every member. Tier scale is intentionally mild for v1: we want
// the reward to feel real without making hive war the dominant
// econ source. Tweakable.
const REWARDS: ReadonlyArray<{ sugar: number; leafBits: number }> = [
  { sugar: 5000, leafBits: 1500 }, // 1st
  { sugar: 2500, leafBits: 750 },  // 2nd
  { sugar: 1000, leafBits: 300 },  // 3rd
];

interface PoolLike {
  query<T extends import('pg').QueryResultRow = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  connect(): Promise<{
    query<T extends import('pg').QueryResultRow = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }>;
    release(): void;
  }>;
}

interface LoggerLike {
  error(payload: unknown, msg?: string): void;
  warn?(payload: unknown, msg?: string): void;
}

// Lazy auto-flip: any 'open' season whose starts_at has passed →
// 'active'; any 'active' season whose ends_at has passed →
// 'finished' (with reward sweep). Idempotent under concurrent
// callers because each UPDATE is gated on the current state, so a
// second caller seeing the new state simply does nothing.
export async function maybeFinalizeSeasons(
  pool: PoolLike,
  log: LoggerLike,
): Promise<void> {
  try {
    // open → active. Bulk update; no per-season transaction needed.
    await pool.query(
      `UPDATE hive_war_seasons
          SET state = 'active'
        WHERE state = 'open' AND starts_at <= NOW()`,
    );
    // active → finished. Per-season because we also have to pay
    // out rewards atomically with the state flip — a partially-
    // paid finalize on retry would double-credit winners.
    const finishing = await pool.query<{ id: string }>(
      `SELECT id FROM hive_war_seasons
        WHERE state = 'active' AND ends_at <= NOW()
        ORDER BY id`,
    );
    for (const row of finishing.rows) {
      await finalizeSeason(pool, log, Number(row.id));
    }
  } catch (err) {
    // Failure here mustn't break /season/current — the worst case
    // is a delayed finalize that runs on the next request.
    log.error({ err }, 'maybeFinalizeSeasons failed');
  }
}

async function finalizeSeason(
  pool: PoolLike,
  log: LoggerLike,
  seasonId: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Re-check + flip atomically so two concurrent finalizes pay
    // out the rewards exactly once.
    const flip = await client.query<{ id: string }>(
      `UPDATE hive_war_seasons
          SET state = 'finished'
        WHERE id = $1 AND state = 'active' AND ends_at <= NOW()
        RETURNING id`,
      [seasonId],
    );
    if (flip.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }
    // Top-3 clans by score for the reward sweep. Ties broken by
    // earliest enrollment (tied clans both got the slot first → both
    // worked harder; reward the one that committed earlier).
    const winners = await client.query<{
      clan_id: string;
      score: number;
      rank: number;
    }>(
      `SELECT clan_id, score,
              ROW_NUMBER() OVER (ORDER BY score DESC, enrolled_at ASC) AS rank
         FROM hive_war_enrollments
        WHERE season_id = $1
        LIMIT 3`,
      [seasonId],
    );
    for (const w of winners.rows) {
      const tier = REWARDS[Number(w.rank) - 1];
      if (!tier) continue;
      // Pay every member of the winning clan — that's how clan
      // wars in CoC distribute rewards and it's the most
      // motivating shape ("we won together").
      await client.query(
        `UPDATE players
            SET sugar = sugar + $2,
                leaf_bits = leaf_bits + $3
          WHERE id IN (
            SELECT player_id FROM clan_members WHERE clan_id = $1::uuid
          )`,
        [w.clan_id, tier.sugar, tier.leafBits],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    // A failed ROLLBACK is its own incident class — usually a dropped
    // connection or already-aborted TX — so log it separately rather
    // than swallowing silently. The original error is still the
    // primary signal.
    await client.query('ROLLBACK').catch((rollbackErr) => {
      log.error(
        { rollbackErr, seasonId },
        'finalizeSeason rollback also failed',
      );
    });
    log.error({ err, seasonId }, 'finalizeSeason failed');
  } finally {
    client.release();
  }
}

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
    // Lazy finalize: opportunistically promote any seasons whose
    // timeline has elapsed. This replaces a real cron daemon for
    // v1 — every /season/current call (cheap, single UPDATE per
    // bucket) auto-flips:
    //   * 'open' → 'active' once starts_at passes
    //   * 'active' → 'finished' once ends_at passes (+ reward sweep)
    // Both updates are idempotent so racing clients can't double-pay.
    await maybeFinalizeSeasons(pool, app.log);

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
    // Daily-attack-cap state for the viewer. Exposed alongside the
    // season so the UI can render "X attacks remaining today" without
    // a second round-trip.
    const used = await pool.query<{ used: string }>(
      `SELECT COUNT(*)::text AS used
         FROM hive_war_attacks
        WHERE season_id = $1
          AND attacker_player_id = $2::uuid
          AND created_at > NOW() - INTERVAL '24 hours'`,
      [s.id, playerId],
    );
    const attacksUsedToday = Number(used.rows[0]?.used ?? 0);
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
      attacksUsedToday,
      attackCapPerDay: ATTACKS_PER_DAY,
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

  // POST /api/hivewar/season/:id/attack — submit a hive-war attack.
  // The body identifies the defender clan + the stars earned (0..3).
  // v1 is self-reported: a future PR will make /raid/submit
  // hive-war-aware and link the raid_id automatically. Validations:
  // - Both clans enrolled in this season.
  // - Attacker is a member of an enrolled clan.
  // - Attacker can't target their own clan.
  // - Daily cap: ATTACKS_PER_DAY per attacker per season.
  // - Season state must be 'active'.
  app.post<{ Params: { id: string }; Body: { defenderClanId?: string; stars?: number } }>(
    '/hivewar/season/:id/attack',
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
      const stars = Number(req.body?.stars);
      if (!Number.isInteger(stars) || stars < 0 || stars > 3) {
        reply.code(400);
        return { error: 'stars must be an integer 0..3' };
      }
      const defenderClanId = req.body?.defenderClanId;
      if (typeof defenderClanId !== 'string' || defenderClanId.length === 0) {
        reply.code(400);
        return { error: 'defenderClanId required' };
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Read the season state without FOR UPDATE — locking the
        // season row would serialise EVERY attack across the whole
        // game on a single row, which is a massive throughput
        // ceiling. The actual concurrency safety lives on the
        // enrollment-row locks below; the state check here is
        // informational ("is this season still accepting attacks?")
        // and a stale read at most rejects a write that should have
        // succeeded — not a correctness hole.
        const seasonRes = await client.query<{ state: string }>(
          'SELECT state FROM hive_war_seasons WHERE id = $1',
          [seasonId],
        );
        if (seasonRes.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'season not found' };
        }
        if (seasonRes.rows[0]!.state !== 'active') {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: 'season is not active' };
        }
        const me = await client.query<{ clan_id: string }>(
          'SELECT clan_id FROM clan_members WHERE player_id = $1::uuid',
          [playerId],
        );
        if (me.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(403);
          return { error: 'not in a clan' };
        }
        const attackerClanId = me.rows[0]!.clan_id;
        if (attackerClanId === defenderClanId) {
          await client.query('ROLLBACK');
          reply.code(400);
          return { error: 'cannot attack your own clan' };
        }
        // Both clans must be enrolled in this season. Lock the two
        // enrollment rows in a DETERMINISTIC ORDER (by clan_id) so
        // two clans attacking each other simultaneously can't
        // deadlock — Postgres's lock-acquisition order on a join
        // depends on the planner / physical layout, which means
        // attacker→defender vs defender→attacker can race.
        // ORDER BY before FOR UPDATE makes both transactions queue
        // against the same id first.
        const enrolled = await client.query<{ clan_id: string }>(
          `SELECT clan_id
             FROM hive_war_enrollments
            WHERE season_id = $1
              AND clan_id IN ($2::uuid, $3::uuid)
            ORDER BY clan_id
            FOR UPDATE`,
          [seasonId, attackerClanId, defenderClanId],
        );
        if (enrolled.rows.length < 2) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: 'both clans must be enrolled in this season' };
        }
        // Daily cap. ATTACKS_PER_DAY per attacker per season per
        // UTC day. Counted via the ledger so a future raid-linked
        // attack stays consistent.
        const cap = await client.query<{ used: string }>(
          `SELECT COUNT(*)::text AS used
             FROM hive_war_attacks
            WHERE season_id = $1
              AND attacker_player_id = $2::uuid
              AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
          [seasonId, playerId],
        );
        const used = Number(cap.rows[0]!.used);
        if (used >= ATTACKS_PER_DAY) {
          await client.query('ROLLBACK');
          reply.code(429);
          return {
            error: `daily attack cap reached (${ATTACKS_PER_DAY}/24h)`,
            attacksUsed: used,
            cap: ATTACKS_PER_DAY,
          };
        }
        // Score delta — each star is 1 point. 0-star attack still
        // costs the attacker their daily slot but earns no score.
        const scoreDelta = stars;
        await client.query(
          `INSERT INTO hive_war_attacks
             (season_id, attacker_clan_id, defender_clan_id,
              attacker_player_id, stars, score_delta)
           VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6)`,
          [seasonId, attackerClanId, defenderClanId, playerId, stars, scoreDelta],
        );
        await client.query(
          `UPDATE hive_war_enrollments
              SET score = score + $3,
                  attacks_made = attacks_made + 1
            WHERE season_id = $1 AND clan_id = $2::uuid`,
          [seasonId, attackerClanId, scoreDelta],
        );
        await client.query(
          `UPDATE hive_war_enrollments
              SET attacks_received = attacks_received + 1
            WHERE season_id = $1 AND clan_id = $2::uuid`,
          [seasonId, defenderClanId],
        );
        await client.query('COMMIT');
        return {
          ok: true,
          stars,
          scoreDelta,
          attacksUsed: used + 1,
          cap: ATTACKS_PER_DAY,
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'hivewar/attack failed');
        reply.code(500);
        return { error: 'attack failed' };
      } finally {
        client.release();
      }
    },
  );

  // POST /api/hivewar/season/:id/start — admin-ish flip from open
  // to active. v1 lets any leader of an enrolled clan flip it; in a
  // future PR this becomes a cron once a min-enrollment threshold or
  // starts_at passes. The endpoint is idempotent — re-flipping an
  // already-active season is a no-op.
  app.post<{ Params: { id: string } }>(
    '/hivewar/season/:id/start',
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
      const r = await pool.query<{ role: string }>(
        `SELECT cm.role
           FROM clan_members cm
           JOIN hive_war_enrollments e
             ON e.clan_id = cm.clan_id
            AND e.season_id = $2
          WHERE cm.player_id = $1::uuid`,
        [playerId, seasonId],
      );
      if (r.rows.length === 0) {
        reply.code(403);
        return { error: 'must be a clan leader of an enrolled clan' };
      }
      if (r.rows[0]!.role !== 'leader') {
        reply.code(403);
        return { error: 'only clan leaders can start the season' };
      }
      await pool.query(
        `UPDATE hive_war_seasons SET state = 'active'
          WHERE id = $1 AND state = 'open'`,
        [seasonId],
      );
      return { ok: true };
    },
  );
}

// Per-attacker daily cap. 3 keeps the season meaningful (a 7-day
// season at 3/day = 21 attacks per player) without letting a single
// player snipe a 60-attack run in an afternoon.
const ATTACKS_PER_DAY = 3;
