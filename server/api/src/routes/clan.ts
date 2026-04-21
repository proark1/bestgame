import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';

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

function sanitizeChat(s: string): string {
  // Strip control chars and collapse runs of whitespace. Keeps emoji
  // and unicode letters.
  return s
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHAT_LEN);
}

export function registerClan(app: FastifyInstance): void {
  // -- Create ----------------------------------------------------------------
  app.post<{ Body: CreateClanBody }>('/clan/create', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
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
      return { error: 'database not configured' };
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
      return { error: 'database not configured' };
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
      return { error: 'database not configured' };
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
      return { error: 'database not configured' };
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
      return { error: 'database not configured' };
    }
    const content = sanitizeChat(req.body?.content ?? '');
    if (content.length === 0) {
      reply.code(400);
      return { error: 'content required' };
    }
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
        return { error: 'database not configured' };
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
}
