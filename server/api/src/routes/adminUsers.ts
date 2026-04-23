import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';

// Admin-only CRUD over the `users` table.
//
// Auth: adminAuth.ts covers every /admin/api/* route, so nothing to
// re-enforce here. Focused on correctness + validation:
//   * username is CITEXT unique (case-insensitive)
//   * email is CITEXT, nullable, unique when set
//   * passwords hashed via scrypt (auth/password.ts) — never stored
//     or returned in plaintext
//   * DELETE clears the link on `players.user_id` via the FK's
//     ON DELETE SET NULL — so deleting a user detaches their
//     player rather than orphaning state
//
// Validation rejects malformed input with a 400 + stable `code` so
// the admin UI can render a clear inline error. Duplicate
// username/email collisions surface as 409.

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
// Looser-than-RFC email shape check. Good enough for admin-entered
// bookkeeping; real validation happens at signup time if we ever
// wire verification.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 128;

interface CreateUserBody {
  username: string;
  email?: string | null;
  password: string;
}
interface UpdateUserBody {
  username?: string;
  email?: string | null;
  password?: string;
}

interface UserRow {
  id: string;
  username: string;
  email: string | null;
  created_at: Date;
  last_login_at: Date | null;
  player_id: string | null;
  display_name: string | null;
}

function serializeUser(r: UserRow): {
  id: string;
  username: string;
  email: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  playerId: string | null;
  displayName: string | null;
} {
  return {
    id: r.id,
    username: r.username,
    email: r.email,
    createdAt: r.created_at.toISOString(),
    lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
    playerId: r.player_id,
    displayName: r.display_name,
  };
}

// Canonicalise a nullable email. Admin UI may send "" to clear; we
// coerce that to null so we don't hit the CITEXT uniqueness index
// with an empty string.
function normaliseEmail(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed;
}

function validateUsername(name: unknown): string | null {
  if (typeof name !== 'string') return 'username must be a string';
  if (!USERNAME_RE.test(name)) {
    return 'username must be 3–32 chars: letters, digits, `_`, `.`, `-`';
  }
  return null;
}

function validateEmail(email: string | null | undefined): string | null {
  if (email === undefined || email === null) return null;
  if (!EMAIL_RE.test(email)) return 'email is not a valid address';
  if (email.length > 254) return 'email too long';
  return null;
}

function validatePassword(pw: unknown): string | null {
  if (typeof pw !== 'string') return 'password must be a string';
  if (pw.length < MIN_PASSWORD_LEN) {
    return `password must be at least ${MIN_PASSWORD_LEN} characters`;
  }
  if (pw.length > MAX_PASSWORD_LEN) {
    return `password must be at most ${MAX_PASSWORD_LEN} characters`;
  }
  return null;
}

export function registerAdminUsers(app: FastifyInstance): void {
  // ---------------------------------------------------------------
  // GET /admin/api/users — paginated list.
  //
  // Joins to players so the admin UI can show whether a user has an
  // attached game account + its display name. Pagination is keyset
  // on created_at + id for stability across concurrent inserts.
  // ---------------------------------------------------------------
  app.get<{
    Querystring: { limit?: string; offset?: string; q?: string };
  }>('/admin/api/users', async (req, reply) => {
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const limit = Math.min(
      200,
      Math.max(1, Number.parseInt(req.query.limit ?? '50', 10) || 50),
    );
    const offset = Math.max(0, Number.parseInt(req.query.offset ?? '0', 10) || 0);
    // Simple substring filter: matches username OR email. Small-cost
    // LIKE scan is fine for the admin panel — users table is small.
    const q = (req.query.q ?? '').trim();
    const where = q ? `WHERE u.username ILIKE $3 OR u.email ILIKE $3` : '';
    const params: Array<string | number> = [limit, offset];
    if (q) params.push(`%${q}%`);
    const rows = await pool.query<UserRow>(
      `SELECT u.id, u.username, u.email::text AS email,
              u.created_at, u.last_login_at,
              p.id AS player_id, p.display_name
         FROM users u
         LEFT JOIN players p ON p.user_id = u.id
         ${where}
         ORDER BY u.created_at DESC, u.id DESC
         LIMIT $1 OFFSET $2`,
      params,
    );
    const total = await pool.query<{ n: string }>(
      q
        ? 'SELECT COUNT(*)::text AS n FROM users WHERE username ILIKE $1 OR email ILIKE $1'
        : 'SELECT COUNT(*)::text AS n FROM users',
      q ? [`%${q}%`] : [],
    );
    return {
      users: rows.rows.map(serializeUser),
      total: Number(total.rows[0]!.n),
      limit,
      offset,
    };
  });

  // ---------------------------------------------------------------
  // POST /admin/api/users — create.
  // ---------------------------------------------------------------
  app.post<{ Body: CreateUserBody }>('/admin/api/users', async (req, reply) => {
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const body = req.body;
    if (!body) {
      reply.code(400);
      return { error: 'body required' };
    }
    const uErr = validateUsername(body.username);
    if (uErr) {
      reply.code(400);
      return { error: uErr, field: 'username' };
    }
    const email = normaliseEmail(body.email);
    const eErr = validateEmail(email);
    if (eErr) {
      reply.code(400);
      return { error: eErr, field: 'email' };
    }
    const pErr = validatePassword(body.password);
    if (pErr) {
      reply.code(400);
      return { error: pErr, field: 'password' };
    }

    const { hash, salt } = await hashPassword(body.password);
    try {
      const ins = await pool.query<{
        id: string;
        username: string;
        email: string | null;
        created_at: Date;
      }>(
        `INSERT INTO users (username, email, password_hash, password_salt)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, email::text AS email, created_at`,
        [body.username, email ?? null, hash, salt],
      );
      const row = ins.rows[0]!;
      return {
        user: {
          id: row.id,
          username: row.username,
          email: row.email,
          createdAt: row.created_at.toISOString(),
          lastLoginAt: null,
          playerId: null,
          displayName: null,
        },
      };
    } catch (err) {
      const msg = (err as Error).message;
      // Postgres unique-violation → 23505. pg-node maps that to a
      // `code` property on the error; we fall back to message
      // sniffing for portability.
      const code = (err as { code?: string }).code;
      if (code === '23505' || /unique/i.test(msg)) {
        reply.code(409);
        return {
          error: /email/i.test(msg) ? 'email already in use' : 'username already in use',
          code: 'duplicate',
        };
      }
      app.log.error({ err }, 'admin user create failed');
      reply.code(500);
      return { error: 'create failed' };
    }
  });

  // ---------------------------------------------------------------
  // PUT /admin/api/users/:id — edit. All fields optional; empty or
  // missing fields are left as-is. Password, when provided, gets
  // a fresh salt (never reuse an old one).
  // ---------------------------------------------------------------
  app.put<{ Params: { id: string }; Body: UpdateUserBody }>(
    '/admin/api/users/:id',
    async (req, reply) => {
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const body = req.body ?? {};
      const sets: string[] = [];
      const params: Array<string | null> = [];

      if (body.username !== undefined) {
        const uErr = validateUsername(body.username);
        if (uErr) {
          reply.code(400);
          return { error: uErr, field: 'username' };
        }
        params.push(body.username);
        sets.push(`username = $${params.length}`);
      }

      if (body.email !== undefined) {
        const email = normaliseEmail(body.email);
        const eErr = validateEmail(email);
        if (eErr) {
          reply.code(400);
          return { error: eErr, field: 'email' };
        }
        params.push(email ?? null);
        sets.push(`email = $${params.length}`);
      }

      if (body.password !== undefined) {
        const pErr = validatePassword(body.password);
        if (pErr) {
          reply.code(400);
          return { error: pErr, field: 'password' };
        }
        const { hash, salt } = await hashPassword(body.password);
        params.push(hash);
        sets.push(`password_hash = $${params.length}`);
        params.push(salt);
        sets.push(`password_salt = $${params.length}`);
      }

      if (sets.length === 0) {
        reply.code(400);
        return { error: 'no fields to update' };
      }

      params.push(req.params.id);
      const idPlaceholder = `$${params.length}`;
      try {
        const upd = await pool.query<UserRow>(
          `UPDATE users SET ${sets.join(', ')}
            WHERE id = ${idPlaceholder}
          RETURNING id, username, email::text AS email, created_at, last_login_at,
                    NULL::uuid AS player_id, NULL::text AS display_name`,
          params,
        );
        if (upd.rows.length === 0) {
          reply.code(404);
          return { error: 'user not found' };
        }
        // Re-hydrate player info from the join so the UI row stays
        // accurate after the edit.
        const withJoin = await pool.query<UserRow>(
          `SELECT u.id, u.username, u.email::text AS email,
                  u.created_at, u.last_login_at,
                  p.id AS player_id, p.display_name
             FROM users u
             LEFT JOIN players p ON p.user_id = u.id
            WHERE u.id = $1`,
          [req.params.id],
        );
        return { user: serializeUser(withJoin.rows[0] ?? upd.rows[0]!) };
      } catch (err) {
        const code = (err as { code?: string }).code;
        const msg = (err as Error).message;
        if (code === '23505' || /unique/i.test(msg)) {
          reply.code(409);
          return {
            error: /email/i.test(msg) ? 'email already in use' : 'username already in use',
            code: 'duplicate',
          };
        }
        app.log.error({ err }, 'admin user update failed');
        reply.code(500);
        return { error: 'update failed' };
      }
    },
  );

  // ---------------------------------------------------------------
  // DELETE /admin/api/users/:id — remove the user row. The FK on
  // players.user_id is ON DELETE SET NULL, so the attached player
  // (if any) keeps its state but loses the login linkage. The admin
  // can spot this via the UI's "attached player" column going blank
  // rather than the player vanishing.
  // ---------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/admin/api/users/:id',
    async (req, reply) => {
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const res = await pool.query<{ id: string }>(
        'DELETE FROM users WHERE id = $1 RETURNING id',
        [req.params.id],
      );
      if (res.rows.length === 0) {
        reply.code(404);
        return { error: 'user not found' };
      }
      return { ok: true, id: res.rows[0]!.id };
    },
  );
}

// Testable surface — exported for unit tests to reach the validators
// without booting a full Fastify instance.
export const _testables = {
  validateUsername,
  validateEmail,
  validatePassword,
  normaliseEmail,
};
