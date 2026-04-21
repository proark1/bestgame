import pg from 'pg';

// Singleton Postgres pool. Connects lazily on first use so the API
// starts even when DATABASE_URL isn't set — /health keeps responding,
// routes that need persistence return 503.
//
// On Railway / Supabase / generic hosted Postgres, DATABASE_URL looks
// like `postgres://user:pass@host:port/db?sslmode=require`. The pg
// driver handles sslmode from the URL; we also force TLS in production
// via ssl: { rejectUnauthorized: false } — Railway's internal cert
// chain isn't in node's store.

let pool: pg.Pool | null = null;
let initPromise: Promise<pg.Pool | null> | null = null;

async function init(): Promise<pg.Pool | null> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return null;
  }
  const p = new pg.Pool({
    connectionString: url,
    // rejectUnauthorized:false is conventional for managed Postgres
    // providers whose CA isn't in the default node trust store; the
    // TLS tunnel itself is still encrypted.
    ssl:
      process.env.PGSSLMODE === 'disable' || /(^|[?&])sslmode=disable(&|$)/.test(url)
        ? false
        : { rejectUnauthorized: false },
    // Conservative pool size — Fastify tasks are short.
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // Fail fast on first connect so boot logs make the misconfiguration
  // obvious. We don't throw from init() because the server should still
  // start (for /health); but we do log.
  try {
    const client = await p.connect();
    client.release();
  } catch (err) {
    console.warn(
      '[db] initial connect failed; persistence routes will return 503:',
      (err as Error).message,
    );
    await p.end().catch(() => undefined);
    return null;
  }
  return p;
}

export async function getPool(): Promise<pg.Pool | null> {
  if (pool) return pool;
  if (!initPromise) initPromise = init();
  pool = await initPromise;
  return pool;
}

export function poolSync(): pg.Pool | null {
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    initPromise = null;
  }
}

export function isConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
