// Web Push subscription registry. Stores PushSubscription JSON
// blobs keyed by player so a future delivery worker can ping
// them on builder-done / raid-incoming / clan-war events.
//
// This is the *registration* surface only — a separate sender
// module (game/pushSender.ts) consumes these rows when it has
// VAPID keys configured. That module ships in a follow-up so this
// PR stays scoped to scaffolding the storage + opt-in surface.

import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';
import { pushPublicKey } from '../game/pushSender.js';

interface SubscribeBody {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
  expirationTime?: number | null;
}

interface UnsubscribeBody {
  endpoint?: string;
}

export function registerPush(app: FastifyInstance): void {
  // GET /api/push/public-key — VAPID public key the client needs
  // to call PushManager.subscribe(). Returns 503 when not configured
  // so the client can suppress the opt-in toggle gracefully.
  app.get('/push/public-key', async (_req, reply) => {
    const key = pushPublicKey();
    if (!key) {
      reply.code(503);
      return { error: 'push not configured' };
    }
    return { publicKey: key };
  });

  // POST /api/push/subscribe — upsert subscription for caller. Body
  // is the JSON shape PushSubscription.toJSON() returns.
  app.post<{ Body: SubscribeBody }>('/push/subscribe', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const body = (req.body ?? {}) as SubscribeBody;
    const endpoint = body.endpoint;
    const p256dh = body.keys?.p256dh;
    const auth = body.keys?.auth;
    if (!endpoint || !p256dh || !auth) {
      reply.code(400);
      return { error: 'missing endpoint or keys' };
    }
    const ua = (req.headers['user-agent'] as string | undefined) ?? null;
    await pool.query(
      `INSERT INTO push_subscriptions (player_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint)
       DO UPDATE SET player_id  = EXCLUDED.player_id,
                     p256dh     = EXCLUDED.p256dh,
                     auth       = EXCLUDED.auth,
                     user_agent = EXCLUDED.user_agent`,
      [playerId, endpoint, p256dh, auth, ua],
    );
    return { ok: true };
  });

  // POST /api/push/unsubscribe — drop the subscription row. Best-effort
  // cleanup paired with the client's PushSubscription.unsubscribe().
  app.post<{ Body: UnsubscribeBody }>('/push/unsubscribe', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const endpoint = req.body?.endpoint;
    if (!endpoint) {
      reply.code(400);
      return { error: 'missing endpoint' };
    }
    await pool.query(
      'DELETE FROM push_subscriptions WHERE player_id = $1 AND endpoint = $2',
      [playerId, endpoint],
    );
    return { ok: true };
  });
}
