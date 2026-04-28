// Web Push sender — fans out a notification payload to every
// registered subscription for a given player. Pruning belongs here
// so an expired endpoint (410 Gone) doesn't keep retrying on every
// future trigger.
//
// VAPID configuration via env:
//   VAPID_PUBLIC_KEY   — base64url public key (also surfaced to the
//                        client at /api/push/public-key)
//   VAPID_PRIVATE_KEY  — base64url private key
//   VAPID_SUBJECT      — mailto: or https: contact URL (web-push
//                        requirement; many providers reject without it)
//
// When any of those are missing, sendPushToPlayer is a silent no-op:
// the registration storage still works (so the client can opt in
// before VAPID lands), pushes simply don't go out yet. Lets us ship
// the receiver + sender separately without a coupled deploy.
//
// `web-push` is loaded via dynamic import so the package is optional
// at typecheck time. On Railway / production, run pnpm install with
// the lockfile to pull it in; in environments where it's missing,
// the catch path keeps the rest of the API healthy.

import { getPool } from '../db/pool.js';

interface PushPayload {
  title: string;
  body: string;
  // Optional collapse key — repeated notifications with the same tag
  // overwrite each other instead of stacking. Use for "you were
  // attacked" so a burst of attacks shows one badge, not five.
  tag?: string;
  // Deep-link URL the SW navigates to on click. Defaults to '/' if
  // unset; useful for routing to /play vs the landing page.
  url?: string;
}

interface CompiledModule {
  setVapidDetails: (subject: string, pub: string, priv: string) => void;
  sendNotification: (
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
  ) => Promise<{ statusCode: number }>;
}

let cachedModule: CompiledModule | null = null;
let configuredOnce = false;

async function loadWebPush(): Promise<CompiledModule | null> {
  if (cachedModule) return cachedModule;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!pub || !priv || !subject) return null;
  try {
    // Dynamic import — keeps the module optional at build time. The
    // `as` cast narrows the runtime shape to the subset we use.
    const mod = (await import('web-push')) as unknown as {
      default?: CompiledModule;
      setVapidDetails: CompiledModule['setVapidDetails'];
      sendNotification: CompiledModule['sendNotification'];
    };
    const compiled: CompiledModule = mod.default ?? {
      setVapidDetails: mod.setVapidDetails,
      sendNotification: mod.sendNotification,
    };
    if (!configuredOnce) {
      compiled.setVapidDetails(subject, pub, priv);
      configuredOnce = true;
    }
    cachedModule = compiled;
    return compiled;
  } catch {
    // web-push package not installed (or import failed). The caller
    // treats this as "push not configured" and silently drops sends.
    return null;
  }
}

export function pushPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

// Look up every subscription for a player, attempt delivery on each,
// and remove rows that the push service rejects with 404/410. Returns
// the count of successful deliveries.
export async function sendPushToPlayer(
  playerId: string,
  payload: PushPayload,
  log?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void },
): Promise<number> {
  const pool = await getPool();
  if (!pool) return 0;
  const wp = await loadWebPush();
  if (!wp) return 0;
  const res = await pool.query<{
    id: number;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE player_id = $1',
    [playerId],
  );
  if (res.rows.length === 0) return 0;
  const body = JSON.stringify(payload);
  let delivered = 0;
  const expiredIds: number[] = [];
  for (const row of res.rows) {
    try {
      const r = await wp.sendNotification(
        {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        },
        body,
      );
      if (r.statusCode >= 200 && r.statusCode < 300) delivered++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // Subscription is dead. Clean it up so subsequent sends don't
        // keep retrying — and, more importantly, so a player who
        // re-subscribes from the same browser doesn't accumulate stale
        // rows.
        expiredIds.push(row.id);
      } else {
        log?.warn?.({ err, endpoint: row.endpoint }, 'push send failed');
      }
    }
  }
  if (expiredIds.length > 0) {
    await pool.query('DELETE FROM push_subscriptions WHERE id = ANY($1::bigint[])', [
      expiredIds,
    ]);
  }
  // Bump last_used_at on any row that delivered, so a future cleanup
  // job can prune stale-but-not-failed rows by age.
  if (delivered > 0) {
    await pool.query(
      `UPDATE push_subscriptions SET last_used_at = NOW()
        WHERE player_id = $1 AND id NOT IN (
          SELECT unnest($2::bigint[])
        )`,
      [playerId, expiredIds],
    );
  }
  return delivered;
}
