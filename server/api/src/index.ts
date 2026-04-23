import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHealth } from './routes/health.js';
import { registerRaid } from './routes/raid.js';
import { registerMatchmaking } from './routes/matchmaking.js';
import { registerAdmin } from './routes/admin.js';
import { registerAdminUsers } from './routes/adminUsers.js';
import { registerAdminHook } from './auth/adminAuth.js';
import { registerAuth } from './routes/auth.js';
import { registerPlayer } from './routes/player.js';
import { registerLeaderboard } from './routes/leaderboard.js';
import { registerClan } from './routes/clan.js';
import { registerWars } from './routes/wars.js';
import { registerArena } from './routes/arena.js';
import { registerSettings } from './routes/settings.js';
import { registerSpritesManifest } from './routes/sprites.js';
import { registerQuests } from './routes/quests.js';
import { registerPlayerAuthHook } from './auth/playerAuth.js';
import { getPool, isConfigured } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { hydrateSpritesToDisk } from './db/sprites.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';

// In the Railway deploy, the API process serves both the game (static
// client bundle at /) and the JSON API (routes under /api/*). This keeps
// everything on a single URL + single Railway service for the MVP.
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = join(__dirname, '..', '..', '..', 'client', 'dist');

async function start(): Promise<void> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // 3.5 MB — comfortably fits a 256 px WebP sprite (base64-encoded) plus
    // envelope. /admin/api/save is the only route that needs this much.
    bodyLimit: 3_500_000,
  });

  await app.register(cors, {
    // Dev origins + FB Instant wrapper. Tighten in production.
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  // Healthcheck stays at /health (Railway's ready probe points here).
  registerHealth(app);

  // Run database migrations up-front so routes can count on the schema
  // being present. If DATABASE_URL isn't configured we log and keep
  // going — persistence routes will 503 but the rest of the API still
  // serves. /health stays up regardless so the Railway probe is happy.
  if (isConfigured()) {
    const pool = await getPool();
    if (pool) {
      try {
        await runMigrations(pool, (msg) => app.log.info(msg));
        app.log.info('[db] migrations up to date');
        // Pull every admin-uploaded sprite out of the DB and onto the
        // served disk directory so fastify-static returns them right
        // away — no per-request DB read in the hot path.
        //
        // Dist is 'create' because a fresh Railway deploy starts with
        // NO client/dist/assets/sprites/ directory — hydration has to
        // make it. Public is 'mirror': only populated when the repo
        // checkout exists (local dev), never auto-created in a
        // production bundle.
        try {
          const clientDist = join(__dirname, '..', '..', '..', 'client');
          await hydrateSpritesToDisk(
            pool,
            [
              { dir: join(clientDist, 'dist', 'assets', 'sprites'), mode: 'create' },
              { dir: join(clientDist, 'public', 'assets', 'sprites'), mode: 'mirror' },
            ],
            (msg) => app.log.info(msg),
          );
        } catch (err) {
          app.log.warn({ err }, '[db] sprite hydration failed (non-fatal)');
        }
      } catch (err) {
        app.log.error({ err }, '[db] migrations failed');
        process.exit(1);
      }
    } else {
      app.log.warn(
        '[db] DATABASE_URL set but pool init failed — check TLS and credentials. Persistence routes will return 503.',
      );
    }
  } else {
    app.log.warn(
      '[db] DATABASE_URL not set. On Railway: Add Plugin → Postgres, ' +
        'then under the API service Variables tab add DATABASE_URL ' +
        'referencing ${{Postgres.DATABASE_URL}}. Persistence routes will ' +
        'return 503 until this is set.',
    );
  }

  // Player bearer auth hook: populate req.playerId from Authorization.
  // Routes that need it call requirePlayer() which 401s when absent.
  registerPlayerAuthHook(app);

  // Admin routes (with bearer auth). Hook intercepts /admin/api/* requests
  // before they resolve; the routes themselves live at /admin/api/*.
  registerAdminHook(app);
  registerAdmin(app);
  registerAdminUsers(app);

  // Game JSON API lives under /api/*.
  await app.register(
    async (scope) => {
      registerAuth(scope);
      registerPlayer(scope);
      registerRaid(scope);
      registerMatchmaking(scope);
      registerLeaderboard(scope);
      registerClan(scope);
      registerWars(scope);
      registerArena(scope);
      registerSettings(scope);
      registerSpritesManifest(scope);
      registerQuests(scope);
    },
    { prefix: '/api' },
  );


  // Serve the built client (Phaser SPA) from the root. If the build hasn't
  // run yet we skip registration so local API-only dev still boots.
  if (existsSync(CLIENT_DIST)) {
    // wildcard:true registers a GET /* catchall that serves any matching
    // file under CLIENT_DIST. Explicit routes registered earlier
    // (/health, /api/*, /admin/api/*) still win — Fastify's router gives
    // more-specific paths priority. Without the wildcard, /assets/
    // sprites written by the admin at runtime would 404 even though the
    // file is on disk.
    await app.register(fastifyStatic, {
      root: CLIENT_DIST,
      prefix: '/',
    });
    app.log.info(`serving client from ${CLIENT_DIST}`);

    // Clean /admin URL -> admin.html. Must be registered after static so
    // that /admin.html itself still resolves to the static file.
    app.get('/admin', (_req, reply) => {
      reply.sendFile('admin.html');
    });
    app.get('/admin/', (_req, reply) => {
      reply.sendFile('admin.html');
    });
  } else {
    app.log.warn(
      `client build not found at ${CLIENT_DIST}; run \`pnpm -r build\` first`,
    );
  }

  try {
    await app.listen({ host: HOST, port: PORT });
    app.log.info(`@hive/api listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void start();
