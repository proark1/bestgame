import type { FastifyInstance } from 'fastify';
import { getPool, isConfigured } from '../db/pool.js';

// /health is Railway's readiness probe — stays up even when the DB is
// down so the service doesn't get killed. /health/db is the richer
// variant a human (or the admin panel) can call to see exactly why
// persistence routes are returning 503.

type DbStatus =
  | 'connected'
  | 'not-configured'
  | 'connect-failed'
  | 'query-failed';

async function probeDb(): Promise<{ status: DbStatus; detail?: string }> {
  if (!isConfigured()) return { status: 'not-configured' };
  const pool = await getPool();
  if (!pool) return { status: 'connect-failed' };
  try {
    await pool.query('SELECT 1');
    return { status: 'connected' };
  } catch (err) {
    return { status: 'query-failed', detail: (err as Error).message };
  }
}

export function registerHealth(app: FastifyInstance): void {
  const bootedAtMs = Date.now();
  app.get('/health', async () => ({
    ok: true,
    uptimeMs: Date.now() - bootedAtMs,
    tick: Math.floor((Date.now() - bootedAtMs) / 33),
  }));
  app.get('/health/db', async () => {
    const probed = await probeDb();
    const hint =
      probed.status === 'not-configured'
        ? 'Set DATABASE_URL. On Railway: Add Plugin → Postgres, then on the API service Variables tab bind DATABASE_URL = ${{Postgres.DATABASE_URL}}.'
        : probed.status === 'connect-failed'
          ? 'DATABASE_URL is set but the pool could not connect. Check TLS (PGSSLMODE / sslmode), hostname, and credentials.'
          : probed.status === 'query-failed'
            ? 'Connection is open but SELECT 1 failed. Likely the role lacks privileges or the schema drifted.'
            : undefined;
    return {
      status: probed.status,
      ...(probed.detail ? { detail: probed.detail } : {}),
      ...(hint ? { hint } : {}),
    };
  });
}
