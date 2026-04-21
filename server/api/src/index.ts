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
import { registerAdminHook } from './auth/adminAuth.js';

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

  // Admin routes (with bearer auth). Hook intercepts /admin/api/* requests
  // before they resolve; the routes themselves live at /admin/api/*.
  registerAdminHook(app);
  registerAdmin(app);

  // Game JSON API lives under /api/*.
  await app.register(
    async (scope) => {
      registerRaid(scope);
      registerMatchmaking(scope);
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
