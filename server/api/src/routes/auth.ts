import type { FastifyInstance } from 'fastify';
import { Sim } from '@hive/shared';
import type { Types } from '@hive/shared';
import { getPool } from '../db/pool.js';
import { mintSessionToken, requirePlayer } from '../auth/playerAuth.js';
import { hashPassword, verifyPassword } from '../auth/password.js';

// Guest authentication: the client sends a stable deviceId (persisted
// in localStorage) and we upsert a players row on it. Returns an HMAC
// bearer token that identifies the player on every subsequent request.

interface GuestLoginBody {
  deviceId: string;
  displayName?: string;
  faction?: Types.Faction;
}

// Every new player starts with a sensible 6-building base so HomeScene
// has something to show before they upgrade/place. Built from the Sim
// defaults so the schema stays owned by @hive/shared.
function startingBase(playerId: string, faction: Types.Faction): Types.Base {
  return {
    baseId: playerId,
    ownerId: playerId,
    faction,
    gridSize: { w: 16, h: 12 },
    resources: { sugar: 1200, leafBits: 300, aphidMilk: 0 },
    trophies: 100,
    version: 1,
    tunnels: [],
    buildings: [
      {
        id: 'b-queen',
        kind: 'QueenChamber',
        anchor: { x: 7, y: 5, layer: 0 },
        footprint: { w: 2, h: 2 },
        spans: [0, 1],
        level: 1,
        hp: 800,
        hpMax: 800,
      },
      {
        id: 'b-turret-1',
        kind: 'MushroomTurret',
        anchor: { x: 3, y: 3, layer: 0 },
        footprint: { w: 1, h: 1 },
        level: 1,
        hp: 400,
        hpMax: 400,
      },
      {
        id: 'b-turret-2',
        kind: 'MushroomTurret',
        anchor: { x: 11, y: 3, layer: 0 },
        footprint: { w: 1, h: 1 },
        level: 1,
        hp: 400,
        hpMax: 400,
      },
      {
        id: 'b-dew-1',
        kind: 'DewCollector',
        anchor: { x: 2, y: 8, layer: 0 },
        footprint: { w: 1, h: 1 },
        level: 1,
        hp: 200,
        hpMax: 200,
      },
      {
        id: 'b-vault-1',
        kind: 'SugarVault',
        anchor: { x: 10, y: 8, layer: 1 },
        footprint: { w: 1, h: 1 },
        level: 1,
        hp: 350,
        hpMax: 350,
      },
      {
        id: 'b-nursery-1',
        kind: 'LarvaNursery',
        anchor: { x: 4, y: 7, layer: 1 },
        footprint: { w: 1, h: 1 },
        level: 1,
        hp: 300,
        hpMax: 300,
      },
    ],
  };
}

const ALLOWED_FACTIONS: ReadonlyArray<Types.Faction> = [
  'Ants',
  'Bees',
  'Beetles',
  'Spiders',
];
const DEVICE_ID_RE = /^[A-Za-z0-9-_]{4,64}$/;

// Per-route rate limit config applied to auth endpoints. Tighter than
// the global limit because signup/login are the classic brute-force
// targets: one IP attempting thousands of guesses should be shut down
// long before it finishes.
const AUTH_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: 30,
      timeWindow: '1 minute',
    },
  },
};

export function registerAuth(app: FastifyInstance): void {
  app.post<{ Body: GuestLoginBody }>('/auth/guest', AUTH_RATE_LIMIT, async (req, reply) => {
    const { deviceId, displayName, faction } = req.body ?? { deviceId: '' };
    if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
      reply.code(400);
      return { error: 'deviceId required (4-64 chars, [A-Za-z0-9-_])' };
    }
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }

    const safeName = (displayName ?? '').slice(0, 40) || 'Hive Wanderer';
    const safeFaction: Types.Faction = ALLOWED_FACTIONS.includes(
      faction as Types.Faction,
    )
      ? (faction as Types.Faction)
      : 'Ants';

    // Idempotent upsert: returns the existing row if deviceId is known,
    // otherwise creates a new row and its starting base.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM players WHERE device_id = $1',
        [deviceId],
      );
      let playerId: string;
      let isNew = false;
      if (existing.rows.length > 0) {
        playerId = existing.rows[0]!.id;
        await client.query(
          'UPDATE players SET last_seen_at = NOW() WHERE id = $1',
          [playerId],
        );
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO players (device_id, display_name, faction)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [deviceId, safeName, safeFaction],
        );
        playerId = inserted.rows[0]!.id;
        isNew = true;
      }
      if (isNew) {
        const base = startingBase(playerId, safeFaction);
        await client.query(
          `INSERT INTO bases (player_id, faction, snapshot)
           VALUES ($1, $2, $3)`,
          [playerId, safeFaction, base],
        );
      }
      await client.query('COMMIT');
      const token = mintSessionToken(playerId);
      return { playerId, token, isNew };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'auth/guest failed');
      reply.code(500);
      return { error: 'auth failed' };
    } finally {
      client.release();
    }
  });

  // Username/password registration. If the caller is already
  // authenticated as a guest (playerAuth hook populated req.playerId),
  // we CLAIM that guest's player for the new user — their existing
  // base, trophies, resources, and unit levels all carry over. If no
  // session is attached, we create a brand-new player + starting base.
  app.post<{ Body: RegisterBody }>('/auth/register', AUTH_RATE_LIMIT, async (req, reply) => {
    const body = req.body ?? { username: '', password: '' };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!USERNAME_RE.test(username)) {
      reply.code(400);
      return { error: 'username must be 3-20 chars, [A-Za-z0-9_-]' };
    }
    if (password.length < 8 || password.length > 128) {
      reply.code(400);
      return { error: 'password must be 8-128 chars' };
    }
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }

    const { hash, salt } = await hashPassword(password);
    const existingPlayerId = req.playerId ?? null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Reject the registration early if the username is taken — this
      // also protects against the race where two calls try to insert
      // the same username concurrently (the UNIQUE index rejects the
      // second anyway, but early 409 is a better UX than a 500).
      const dup = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE username = $1',
        [username],
      );
      if (dup.rows.length > 0) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: 'username taken' };
      }
      const uRow = await client.query<{ id: string }>(
        `INSERT INTO users (username, password_hash, password_salt, last_login_at)
         VALUES ($1, $2, $3, NOW())
         RETURNING id`,
        [username, hash, salt],
      );
      const userId = uRow.rows[0]!.id;

      let playerId: string;
      if (existingPlayerId) {
        // Claim the caller's guest player — but only if it isn't
        // already attached to some OTHER user. (Playing on a claimed
        // account while re-registering is a nonsense state.)
        const check = await client.query<{ user_id: string | null }>(
          'SELECT user_id FROM players WHERE id = $1 FOR UPDATE',
          [existingPlayerId],
        );
        if (check.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'session points at a missing player' };
        }
        if (check.rows[0]!.user_id && check.rows[0]!.user_id !== userId) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: 'this player is already claimed by another account' };
        }
        playerId = existingPlayerId;
        await client.query(
          'UPDATE players SET user_id = $1, last_seen_at = NOW() WHERE id = $2',
          [userId, playerId],
        );
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO players (display_name, faction, user_id)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [username.slice(0, 40), 'Ants', userId],
        );
        playerId = inserted.rows[0]!.id;
        const base = startingBase(playerId, 'Ants');
        await client.query(
          `INSERT INTO bases (player_id, faction, snapshot)
           VALUES ($1, $2, $3)`,
          [playerId, 'Ants', base],
        );
      }
      await client.query('COMMIT');
      const token = mintSessionToken(playerId);
      return { ok: true, playerId, userId, username, token };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'auth/register failed');
      reply.code(500);
      return { error: 'register failed' };
    } finally {
      client.release();
    }
  });

  // Username/password login. Looks up the user, verifies the password,
  // then returns a session token bound to that user's linked player.
  // Works from any device — the whole point of the register/login
  // flow is that your progress lives on the server, not the device.
  app.post<{ Body: LoginBody }>('/auth/login', AUTH_RATE_LIMIT, async (req, reply) => {
    const body = req.body ?? { username: '', password: '' };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
      reply.code(400);
      return { error: 'username and password required' };
    }
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }

    const row = await pool.query<{
      id: string;
      username: string;
      password_hash: string;
      password_salt: string;
    }>(
      'SELECT id, username, password_hash, password_salt FROM users WHERE username = $1',
      [username],
    );
    if (row.rows.length === 0) {
      reply.code(401);
      return { error: 'invalid credentials' };
    }
    const u = row.rows[0]!;
    const ok = await verifyPassword(password, u.password_hash, u.password_salt);
    if (!ok) {
      reply.code(401);
      return { error: 'invalid credentials' };
    }

    // Find the player attached to this user. A user without a player
    // shouldn't happen (register always links one), but guard against
    // database corruption by creating one on the fly — better UX than
    // locking a legitimate login out.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const linked = await client.query<{ id: string }>(
        'SELECT id FROM players WHERE user_id = $1 LIMIT 1',
        [u.id],
      );
      let playerId: string;
      if (linked.rows.length > 0) {
        playerId = linked.rows[0]!.id;
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO players (display_name, faction, user_id)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [u.username.slice(0, 40), 'Ants', u.id],
        );
        playerId = inserted.rows[0]!.id;
        const base = startingBase(playerId, 'Ants');
        await client.query(
          `INSERT INTO bases (player_id, faction, snapshot)
           VALUES ($1, $2, $3)`,
          [playerId, 'Ants', base],
        );
      }
      await client.query(
        'UPDATE users SET last_login_at = NOW() WHERE id = $1',
        [u.id],
      );
      await client.query(
        'UPDATE players SET last_seen_at = NOW() WHERE id = $1',
        [playerId],
      );
      await client.query('COMMIT');
      const token = mintSessionToken(playerId);
      return { ok: true, playerId, userId: u.id, username: u.username, token };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'auth/login failed');
      reply.code(500);
      return { error: 'login failed' };
    } finally {
      client.release();
    }
  });

  // Current session info: tells the client whether the active token
  // is for a claimed user account or a still-anonymous guest. Used by
  // HomeScene's account menu to show "Register" vs "Logged in as X".
  app.get('/auth/me', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const r = await pool.query<{
      user_id: string | null;
      username: string | null;
    }>(
      `SELECT p.user_id, u.username
         FROM players p
         LEFT JOIN users u ON u.id = p.user_id
        WHERE p.id = $1`,
      [playerId],
    );
    if (r.rows.length === 0) {
      reply.code(404);
      return { error: 'player not found' };
    }
    const row = r.rows[0]!;
    return {
      playerId,
      userId: row.user_id,
      username: row.username,
      isGuest: !row.user_id,
    };
  });

  void Sim; // keep named import stable for future starting-base overrides
}

interface RegisterBody {
  username: string;
  password: string;
}
interface LoginBody {
  username: string;
  password: string;
}
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
