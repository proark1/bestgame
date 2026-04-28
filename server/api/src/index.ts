import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { initServerSentry } from './obs/sentry.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHealth } from './routes/health.js';
import { registerRaid } from './routes/raid.js';
import { registerMatchmaking } from './routes/matchmaking.js';
import { registerAdmin } from './routes/admin.js';
import { registerAdminUsers } from './routes/adminUsers.js';
import { registerAdminAudio } from './routes/audio.js';
import { registerAdminHook } from './auth/adminAuth.js';
import { registerAuth } from './routes/auth.js';
import { registerPlayer } from './routes/player.js';
import { registerLeaderboard } from './routes/leaderboard.js';
import { registerClan } from './routes/clan.js';
import { registerWars } from './routes/wars.js';
import { registerArena } from './routes/arena.js';
import { registerSettings } from './routes/settings.js';
import { registerSpritesManifest } from './routes/sprites.js';
import { registerStories } from './routes/stories.js';
import { registerQuests } from './routes/quests.js';
import { registerCampaign } from './routes/campaign.js';
import { registerBuilder } from './routes/builder.js';
import { registerReplayFeed } from './routes/replayFeed.js';
import { registerHiveWar } from './routes/hiveWar.js';
import { registerPush } from './routes/push.js';
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
  // Wire Sentry up before Fastify so its request hooks can wrap every
  // handler. No-op unless SENTRY_DSN_SERVER is set.
  initServerSentry();

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // 3.5 MB — comfortably fits a 256 px WebP sprite (base64-encoded) plus
    // envelope. /admin/api/save is the only route that needs this much.
    // /admin/api/audio/save sets a higher route-level bodyLimit (22 MB)
    // for music mp3s; we keep the global low to limit DoS surface area
    // on every other endpoint.
    bodyLimit: 3_500_000,
    // Trust the platform's proxy so rate-limit + logs see the real
    // client IP (Railway, Fly, Render all set X-Forwarded-For).
    trustProxy: true,
    // Treat /play and /play/ (and every other clean URL) as the same
    // route so we don't have to register a pair of handlers each time.
    ignoreTrailingSlash: true,
  });

  await app.register(cors, {
    // In dev (NODE_ENV !== 'production') we stay permissive so
    // local IPs and tunneling services "just work". In prod we
    // require ALLOWED_ORIGINS — if it's missing we fail closed
    // (origin: false) so a misconfigured deploy can't silently
    // expose the API to every origin on the internet.
    // CORS_ALLOW_ALL=1 forces permissive mode for QA tunneling.
    origin:
      process.env.NODE_ENV !== 'production' || process.env.CORS_ALLOW_ALL === '1'
        ? true
        : process.env.ALLOWED_ORIGINS
          ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
          : false,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  // Global rate limit. Most routes are generous (cheap) but auth +
  // raid submission get tighter caps applied at the route level.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // When the platform proxy populates X-Forwarded-For, fastify's
    // req.ip already resolves to the real client IP thanks to
    // trustProxy above. Key by that so one cloud NAT doesn't share
    // a bucket across thousands of distinct players.
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit hit. Try again in ${Math.ceil(ctx.ttl / 1000)}s.`,
    }),
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
  registerAdminAudio(app);

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
      registerStories(scope);
      registerQuests(scope);
      registerCampaign(scope);
      registerBuilder(scope);
      registerReplayFeed(scope);
      registerHiveWar(scope);
      registerPush(scope);
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

    // Clean URLs for game, legal, and admin pages. Landing (index.html)
    // is served by the static fallback at '/'; these aliases map the
    // no-extension paths to the right static file. `ignoreTrailingSlash`
    // on the Fastify instance means each of these also matches /path/.
    app.get('/admin', (_req, reply) => {
      reply.sendFile('admin.html');
    });
    app.get('/play', (_req, reply) => {
      reply.sendFile('play.html');
    });
    app.get('/privacy', (_req, reply) => {
      reply.sendFile('privacy.html');
    });
    app.get('/terms', (_req, reply) => {
      reply.sendFile('terms.html');
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
