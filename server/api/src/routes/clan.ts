import type { FastifyInstance } from 'fastify';
import type { Types } from '@hive/shared';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';
import { sanitizeSafeText } from '../util/safeText.js';

// Clans + chat routes.
//
// Guard rails:
//   - A player can only be in one clan; every mutation runs in a
//     transaction that SELECTs FOR UPDATE on the membership row.
//   - Clan names are unique. Tag is 2-5 upper-case chars for display.
//   - Messages are rate-limited per-player (1/sec). Content is
//     validated length + stripped of raw control characters.

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}\s'\-_.]{1,31}$/u;
const TAG_RE = /^[A-Z0-9]{2,5}$/;
const MAX_CHAT_LEN = 400;
const MAX_MESSAGES_PER_FETCH = 100;
const MIN_MS_BETWEEN_MESSAGES = 1000;

// Donation request shape — capped tight so a request can't spam the
// clan. Adjustable later if balance demands.
const REQUEST_MIN_COUNT = 1;
const REQUEST_MAX_COUNT = 10;
const ALLOWED_REQUEST_KINDS: ReadonlyArray<string> = [
  'WorkerAnt', 'SoldierAnt', 'DirtDigger', 'Wasp', 'FireAnt',
  'Termite', 'Dragonfly', 'Mantis', 'Scarab',
];
// Donor sugar reward per donated unit. Small enough that donation
// hoarding doesn't become a farm; big enough to be felt.
const DONOR_SUGAR_PER_UNIT = 10;
const DONOR_LEAF_PER_UNIT = 4;

export function clampRequestCount(raw: unknown): number | null {
  const n = typeof raw === 'number' ? Math.floor(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  if (n < REQUEST_MIN_COUNT) return null;
  if (n > REQUEST_MAX_COUNT) return REQUEST_MAX_COUNT;
  return n;
}

export function isAllowedRequestKind(raw: unknown): raw is string {
  return typeof raw === 'string' && ALLOWED_REQUEST_KINDS.includes(raw);
}

interface CreateClanBody {
  name: string;
  tag: string;
  description?: string;
  isOpen?: boolean;
}

interface JoinClanBody {
  clanId: string;
}

interface MessageBody {
  content: string;
}

interface RequestUnitsBody {
  unitKind: string;
  count: number;
}

interface DonateUnitsBody {
  requestId: number;
  count: number;
}

// Clan chat is text-only by design — no images, no links, no
// embedded HTML / Markdown. The shared sanitiser in util/safeText.ts
// owns the rules so /clan/message and /replay/:id/comments stay in
// lockstep. Returns the cleaned content or an error reason; the
// route surfaces the latter as 400.
function sanitizeChat(raw: unknown): { ok: true; content: string } | { ok: false; error: string } {
  return sanitizeSafeText(raw, { maxLength: MAX_CHAT_LEN });
}

export function registerClan(app: FastifyInstance): void {
  // -- Create ----------------------------------------------------------------
  app.post<{ Body: CreateClanBody }>('/clan/create', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const body = req.body ?? { name: '', tag: '' };
    const name = (body.name ?? '').trim();
    const tag = (body.tag ?? '').trim().toUpperCase();
    const description = (body.description ?? '').slice(0, 200);
    const isOpen = body.isOpen !== false;
    if (!NAME_RE.test(name)) {
      reply.code(400);
      return { error: 'name must be 2-32 chars, letters/digits/spaces/-_.\'' };
    }
    if (!TAG_RE.test(tag)) {
      reply.code(400);
      return { error: 'tag must be 2-5 uppercase letters or digits' };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ clan_id: string }>(
        'SELECT clan_id FROM clan_members WHERE player_id = $1',
        [playerId],
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: 'already in a clan — leave first' };
      }
      let clanId: string;
      try {
        const created = await client.query<{ id: string }>(
          `INSERT INTO clans (name, tag, description, is_open, leader_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [name, tag, description, isOpen, playerId],
        );
        clanId = created.rows[0]!.id;
      } catch (err) {
        await client.query('ROLLBACK');
        if ((err as { code?: string }).code === '23505') {
          reply.code(409);
          return { error: 'name already taken' };
        }
        throw err;
      }
      await client.query(
        `INSERT INTO clan_members (player_id, clan_id, role)
         VALUES ($1, $2, 'leader')`,
        [playerId, clanId],
      );
      await client.query('COMMIT');
      return { ok: true, clanId };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'clan/create failed');
      reply.code(500);
      return { error: 'create failed' };
    } finally {
      client.release();
    }
  });

  // -- Browse ----------------------------------------------------------------
  app.get('/clan/browse', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const rows = await pool.query<{
      id: string;
      name: string;
      tag: string;
      description: string;
      member_count: string;
      created_at: Date;
    }>(
      `SELECT c.id, c.name, c.tag, c.description, c.created_at,
              COUNT(m.player_id) AS member_count
         FROM clans c
         LEFT JOIN clan_members m ON m.clan_id = c.id
        WHERE c.is_open = TRUE
        GROUP BY c.id
        ORDER BY c.created_at DESC
        LIMIT 50`,
    );
    return {
      clans: rows.rows.map((r) => ({
        id: r.id,
        name: r.name,
        tag: r.tag,
        description: r.description,
        memberCount: Number(r.member_count),
        createdAt: r.created_at.toISOString(),
      })),
    };
  });

  // -- Join ------------------------------------------------------------------
  app.post<{ Body: JoinClanBody }>('/clan/join', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const clanId = req.body?.clanId;
    if (!clanId || typeof clanId !== 'string') {
      reply.code(400);
      return { error: 'clanId required' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ clan_id: string }>(
        'SELECT clan_id FROM clan_members WHERE player_id = $1 FOR UPDATE',
        [playerId],
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: 'already in a clan' };
      }
      const clan = await client.query<{ is_open: boolean }>(
        'SELECT is_open FROM clans WHERE id = $1',
        [clanId],
      );
      if (clan.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'clan not found' };
      }
      if (!clan.rows[0]!.is_open) {
        await client.query('ROLLBACK');
        reply.code(403);
        return { error: 'clan is closed' };
      }
      await client.query(
        `INSERT INTO clan_members (player_id, clan_id, role)
         VALUES ($1, $2, 'member')`,
        [playerId, clanId],
      );
      await client.query('COMMIT');
      return { ok: true, clanId };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'clan/join failed');
      reply.code(500);
      return { error: 'join failed' };
    } finally {
      client.release();
    }
  });

  // -- Leave -----------------------------------------------------------------
  app.post('/clan/leave', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query<{ clan_id: string; role: string }>(
        'SELECT clan_id, role FROM clan_members WHERE player_id = $1 FOR UPDATE',
        [playerId],
      );
      if (row.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'not in a clan' };
      }
      const { clan_id, role } = row.rows[0]!;
      await client.query('DELETE FROM clan_members WHERE player_id = $1', [playerId]);

      // If the leader left, promote the earliest-joined remaining member.
      if (role === 'leader') {
        const next = await client.query<{ player_id: string }>(
          `SELECT player_id FROM clan_members
            WHERE clan_id = $1
            ORDER BY joined_at ASC
            LIMIT 1`,
          [clan_id],
        );
        if (next.rows.length > 0) {
          const newLeaderId = next.rows[0]!.player_id;
          await client.query(
            `UPDATE clan_members SET role = 'leader' WHERE player_id = $1`,
            [newLeaderId],
          );
          await client.query('UPDATE clans SET leader_id = $2 WHERE id = $1', [
            clan_id,
            newLeaderId,
          ]);
        } else {
          // Empty clan — delete it to keep the browse list clean.
          await client.query('DELETE FROM clans WHERE id = $1', [clan_id]);
        }
      }
      await client.query('COMMIT');
      return { ok: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'clan/leave failed');
      reply.code(500);
      return { error: 'leave failed' };
    } finally {
      client.release();
    }
  });

  // -- My clan + members + recent messages ----------------------------------
  app.get('/clan/my', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const myRow = await pool.query<{ clan_id: string; role: string }>(
      'SELECT clan_id, role FROM clan_members WHERE player_id = $1',
      [playerId],
    );
    if (myRow.rows.length === 0) return { clan: null };
    const clanId = myRow.rows[0]!.clan_id;

    const [clanRes, membersRes, messagesRes] = await Promise.all([
      pool.query<{
        id: string;
        name: string;
        tag: string;
        description: string;
        is_open: boolean;
        leader_id: string | null;
        created_at: Date;
      }>('SELECT * FROM clans WHERE id = $1', [clanId]),
      pool.query<{
        player_id: string;
        display_name: string;
        trophies: number;
        role: string;
        joined_at: Date;
      }>(
        `SELECT m.player_id, p.display_name, p.trophies, m.role, m.joined_at
           FROM clan_members m
           JOIN players p ON p.id = m.player_id
          WHERE m.clan_id = $1
          ORDER BY m.role = 'leader' DESC, p.trophies DESC`,
        [clanId],
      ),
      pool.query<{
        id: string;
        player_id: string;
        display_name: string | null;
        content: string;
        created_at: Date;
      }>(
        `SELECT m.id, m.player_id, p.display_name, m.content, m.created_at
           FROM clan_messages m
           LEFT JOIN players p ON p.id = m.player_id
          WHERE m.clan_id = $1
          ORDER BY m.id DESC
          LIMIT 50`,
        [clanId],
      ),
    ]);
    const clan = clanRes.rows[0]!;
    return {
      clan: {
        id: clan.id,
        name: clan.name,
        tag: clan.tag,
        description: clan.description,
        isOpen: clan.is_open,
        leaderId: clan.leader_id,
        createdAt: clan.created_at.toISOString(),
      },
      myRole: myRow.rows[0]!.role,
      members: membersRes.rows.map((m) => ({
        playerId: m.player_id,
        displayName: m.display_name,
        trophies: m.trophies,
        role: m.role,
        joinedAt: m.joined_at.toISOString(),
      })),
      messages: messagesRes.rows
        .map((m) => ({
          id: m.id,
          playerId: m.player_id,
          displayName: m.display_name ?? 'deleted',
          content: m.content,
          createdAt: m.created_at.toISOString(),
        }))
        // Server returns newest first for LIMIT efficiency; client
        // wants oldest first so the scroll sits at the newest message.
        .reverse(),
    };
  });

  // -- Send message ----------------------------------------------------------
  app.post<{ Body: MessageBody }>('/clan/message', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const sanitised = sanitizeChat(req.body?.content);
    if (!sanitised.ok) {
      reply.code(400);
      return { error: sanitised.error };
    }
    const content = sanitised.content;
    const clanRow = await pool.query<{ clan_id: string }>(
      'SELECT clan_id FROM clan_members WHERE player_id = $1',
      [playerId],
    );
    if (clanRow.rows.length === 0) {
      reply.code(403);
      return { error: 'not in a clan' };
    }
    // Rate limit: 1 msg/sec. One SQL round-trip using the latest
    // timestamp from this player in this clan.
    const recent = await pool.query<{ created_at: Date }>(
      `SELECT created_at FROM clan_messages
        WHERE player_id = $1
        ORDER BY id DESC LIMIT 1`,
      [playerId],
    );
    if (recent.rows.length > 0) {
      const age = Date.now() - recent.rows[0]!.created_at.getTime();
      if (age < MIN_MS_BETWEEN_MESSAGES) {
        reply.code(429);
        return { error: 'too fast', retryInMs: MIN_MS_BETWEEN_MESSAGES - age };
      }
    }
    const inserted = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO clan_messages (clan_id, player_id, content)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [clanRow.rows[0]!.clan_id, playerId, content],
    );
    return {
      ok: true,
      id: inserted.rows[0]!.id,
      createdAt: inserted.rows[0]!.created_at.toISOString(),
    };
  });

  // -- Poll for new messages since a given id --------------------------------
  app.get<{ Querystring: { sinceId?: string } }>(
    '/clan/messages',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
      }
      const clanRow = await pool.query<{ clan_id: string }>(
        'SELECT clan_id FROM clan_members WHERE player_id = $1',
        [playerId],
      );
      if (clanRow.rows.length === 0) return { messages: [] };
      const sinceRaw = Number(req.query?.sinceId ?? 0);
      const since = Number.isFinite(sinceRaw) ? Math.max(0, Math.floor(sinceRaw)) : 0;
      const res = await pool.query<{
        id: string;
        player_id: string;
        display_name: string | null;
        content: string;
        created_at: Date;
      }>(
        `SELECT m.id, m.player_id, p.display_name, m.content, m.created_at
           FROM clan_messages m
           LEFT JOIN players p ON p.id = m.player_id
          WHERE m.clan_id = $1 AND m.id > $2
          ORDER BY m.id ASC
          LIMIT $3`,
        [clanRow.rows[0]!.clan_id, since, MAX_MESSAGES_PER_FETCH],
      );
      return {
        messages: res.rows.map((m) => ({
          id: m.id,
          playerId: m.player_id,
          displayName: m.display_name ?? 'deleted',
          content: m.content,
          createdAt: m.created_at.toISOString(),
        })),
      };
    },
  );

  // -- Open a unit-donation request -----------------------------------------
  // The requester must be in a clan; only one open request per player at
  // a time (DB partial-unique index enforces it). Posts a flavor message
  // into clan chat so the request surfaces in the existing pollers.
  app.post<{ Body: RequestUnitsBody }>('/clan/request', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const count = clampRequestCount(req.body?.count);
    if (count === null) {
      reply.code(400);
      return { error: `count must be ${REQUEST_MIN_COUNT}..${REQUEST_MAX_COUNT}` };
    }
    if (!isAllowedRequestKind(req.body?.unitKind)) {
      reply.code(400);
      return { error: 'unitKind not in allowed list' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const mem = await client.query<{ clan_id: string; display_name: string }>(
        `SELECT cm.clan_id, p.display_name
           FROM clan_members cm
           JOIN players p ON p.id = cm.player_id
          WHERE cm.player_id = $1::uuid`,
        [playerId],
      );
      if (mem.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: 'not in a clan' };
      }
      const { clan_id, display_name } = mem.rows[0]!;
      const ins = await client.query<{ id: string }>(
        `INSERT INTO clan_unit_requests
           (clan_id, requester_id, unit_kind, requested_count)
         VALUES ($1::uuid, $2::uuid, $3, $4)
         RETURNING id`,
        [clan_id, playerId, req.body.unitKind, count],
      );
      // Side-effect chat message so existing pollers see the request
      // in the clan feed.
      await client.query(
        `INSERT INTO clan_messages (clan_id, player_id, content)
         VALUES ($1::uuid, $2::uuid, $3)`,
        [clan_id, playerId, `🤝 ${display_name} requests ${req.body.unitKind} ×${count}`],
      );
      await client.query('COMMIT');
      return { ok: true, requestId: Number(ins.rows[0]!.id) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      // Partial-unique index throws on duplicate open request.
      if ((err as { code?: string }).code === '23505') {
        reply.code(409);
        return { error: 'you already have an open request' };
      }
      app.log.error({ err }, 'clan/request failed');
      reply.code(500);
      return { error: 'request failed' };
    } finally {
      client.release();
    }
  });

  // -- Donate units toward an open request ----------------------------------
  // Any clanmate (not the requester themselves) can fulfill any portion
  // up to the remaining count. Donor receives a small sugar+leaf
  // reward proportional to their contribution. Auto-closes the request
  // when fulfilled.
  app.post<{ Body: DonateUnitsBody }>('/clan/donate', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const requestId = Number(req.body?.requestId);
    if (!Number.isFinite(requestId) || requestId <= 0) {
      reply.code(400);
      return { error: 'requestId required' };
    }
    const wantCount = Math.floor(req.body?.count);
    if (!Number.isFinite(wantCount) || wantCount <= 0) {
      reply.code(400);
      return { error: 'count must be positive' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Gate: donor must be in the same clan as the request, and not be
      // the requester themselves.
      const reqRow = await client.query<{
        clan_id: string;
        requester_id: string;
        unit_kind: string;
        requested_count: number;
        fulfilled_count: number;
        closed_at: Date | null;
      }>(
        `SELECT clan_id, requester_id, unit_kind, requested_count,
                fulfilled_count, closed_at
           FROM clan_unit_requests
          WHERE id = $1
          FOR UPDATE`,
        [requestId],
      );
      if (reqRow.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'request not found' };
      }
      const r = reqRow.rows[0]!;
      if (r.closed_at !== null) {
        await client.query('ROLLBACK');
        reply.code(410);
        return { error: 'request already closed' };
      }
      if (r.requester_id === playerId) {
        await client.query('ROLLBACK');
        reply.code(403);
        return { error: "can't fulfill your own request" };
      }
      const donorMem = await client.query<{ clan_id: string; display_name: string }>(
        `SELECT cm.clan_id, p.display_name
           FROM clan_members cm JOIN players p ON p.id = cm.player_id
          WHERE cm.player_id = $1::uuid`,
        [playerId],
      );
      if (donorMem.rows.length === 0 || donorMem.rows[0]!.clan_id !== r.clan_id) {
        await client.query('ROLLBACK');
        reply.code(403);
        return { error: 'not in the request\'s clan' };
      }
      const remaining = Math.max(0, r.requested_count - r.fulfilled_count);
      const give = Math.min(remaining, wantCount);
      if (give <= 0) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: 'request is fully filled' };
      }
      const newFilled = r.fulfilled_count + give;
      const closed = newFilled >= r.requested_count;
      await client.query(
        `UPDATE clan_unit_requests
            SET fulfilled_count = $2,
                closed_at = CASE WHEN $3::boolean THEN NOW() ELSE closed_at END
          WHERE id = $1`,
        [requestId, newFilled, closed],
      );
      await client.query(
        `INSERT INTO clan_donation_log (request_id, donor_id, count)
         VALUES ($1, $2::uuid, $3)`,
        [requestId, playerId, give],
      );
      // Donor reward — tiny sugar+leaf bump per unit donated.
      const sugarReward = give * DONOR_SUGAR_PER_UNIT;
      const leafReward = give * DONOR_LEAF_PER_UNIT;
      await client.query(
        `UPDATE players
            SET sugar = sugar + $2,
                leaf_bits = leaf_bits + $3
          WHERE id = $1::uuid`,
        [playerId, sugarReward, leafReward],
      );
      // Credit the REQUESTER's donation inventory so the donated
      // units actually reach their next raid deck. The jsonb_set
      // path increments an existing kind count or initialises it to
      // `give` if the key wasn't there before. RaidScene merges this
      // map into the deck on raid start; /raid/submit clears it on
      // a successful submit so donations are war-army-style (refill
      // per raid, expire whether-or-not used).
      await client.query(
        `UPDATE players
            SET donation_inventory = jsonb_set(
              COALESCE(donation_inventory, '{}'::jsonb),
              ARRAY[$2::text],
              to_jsonb(
                COALESCE((donation_inventory->>$2)::int, 0) + $3::int
              ),
              true
            )
          WHERE id = $1::uuid`,
        [r.requester_id, r.unit_kind, give],
      );
      // System chat message visible to the whole clan.
      const donorName = donorMem.rows[0]!.display_name;
      const note = closed
        ? `🤝 ${donorName} fulfilled ${r.unit_kind} ×${give} (request complete)`
        : `🤝 ${donorName} donated ${r.unit_kind} ×${give}`;
      await client.query(
        `INSERT INTO clan_messages (clan_id, player_id, content)
         VALUES ($1::uuid, $2::uuid, $3)`,
        [r.clan_id, playerId, note],
      );
      await client.query('COMMIT');
      return {
        ok: true,
        donated: give,
        fulfilled: newFilled,
        closed,
        reward: { sugar: sugarReward, leafBits: leafReward },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'clan/donate failed');
      reply.code(500);
      return { error: 'donate failed' };
    } finally {
      client.release();
    }
  });

  // -- List open requests in my clan ----------------------------------------
  // Returns the active request set so the client can render donate
  // buttons inline with chat. Closed requests are filtered out.
  app.get('/clan/requests', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const mem = await pool.query<{ clan_id: string }>(
      `SELECT clan_id FROM clan_members WHERE player_id = $1::uuid`,
      [playerId],
    );
    if (mem.rows.length === 0) return { requests: [] };
    const clanId = mem.rows[0]!.clan_id;
    const res = await pool.query<{
      id: string;
      requester_id: string;
      requester_name: string | null;
      unit_kind: string;
      requested_count: number;
      fulfilled_count: number;
      created_at: Date;
    }>(
      `SELECT r.id, r.requester_id, p.display_name AS requester_name,
              r.unit_kind, r.requested_count, r.fulfilled_count, r.created_at
         FROM clan_unit_requests r
         LEFT JOIN players p ON p.id = r.requester_id
        WHERE r.clan_id = $1::uuid AND r.closed_at IS NULL
        ORDER BY r.created_at DESC
        LIMIT 50`,
      [clanId],
    );
    return {
      requests: res.rows.map((r) => ({
        id: Number(r.id),
        requesterId: r.requester_id,
        requesterName: r.requester_name ?? 'Unknown',
        unitKind: r.unit_kind,
        requestedCount: r.requested_count,
        fulfilledCount: r.fulfilled_count,
        remaining: Math.max(0, r.requested_count - r.fulfilled_count),
        createdAt: r.created_at.toISOString(),
        canDonate: r.requester_id !== playerId,
      })),
    };
  });

  // -- Visit a clanmate's base (read-only base tour) ------------------------
  // Returns the requested clanmate's base snapshot so the client can
  // render a tour of their underground/surface layout. Auth gate: the
  // viewer and target must be in the same clan. Returns 403 if not in
  // a clan, 404 if the target isn't a clanmate. Foundation for the
  // step-8 "shared underground tunnels" feature — tour first, then
  // (eventually) cross-base unit transit on top.
  app.get<{ Params: { playerId: string } }>(
    '/clan/base/:playerId',
    async (req, reply) => {
      const viewerId = requirePlayer(req, reply);
      if (!viewerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const targetId = String(req.params.playerId).trim();
      if (!targetId) {
        reply.code(400);
        return { error: 'playerId required' };
      }
      // One round-trip: confirm both viewer + target sit in the
      // same clan, then return the target's base snapshot. The
      // SELF-clan check prevents an out-of-clan player from tour-
      // viewing strangers — we want the base browser to feel like
      // a clan privilege, not a public dossier.
      const res = await pool.query<{
        target_name: string | null;
        target_trophies: number | null;
        snapshot: Types.Base | null;
        same_clan: boolean;
      }>(
        `WITH viewer AS (
           SELECT clan_id FROM clan_members WHERE player_id = $1::uuid
         ), target AS (
           SELECT clan_id FROM clan_members WHERE player_id = $2::uuid
         )
         SELECT p.display_name AS target_name,
                p.trophies AS target_trophies,
                b.snapshot AS snapshot,
                (
                  EXISTS(SELECT 1 FROM viewer)
                    AND EXISTS(SELECT 1 FROM target)
                    AND (SELECT clan_id FROM viewer) = (SELECT clan_id FROM target)
                ) AS same_clan
           FROM players p
           LEFT JOIN bases b ON b.player_id = p.id
          WHERE p.id = $2::uuid`,
        [viewerId, targetId],
      );
      if (res.rows.length === 0 || !res.rows[0]!.snapshot) {
        reply.code(404);
        return { error: 'player or base not found' };
      }
      const row = res.rows[0]!;
      if (!row.same_clan) {
        reply.code(403);
        return { error: 'not in the same clan' };
      }
      return {
        playerId: targetId,
        displayName: row.target_name ?? 'Unknown',
        trophies: row.target_trophies ?? 0,
        base: row.snapshot,
      };
    },
  );
}
