import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerHealth } from './routes/health.js';
import { registerRaid } from './routes/raid.js';
import { registerMatchmaking } from './routes/matchmaking.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';

async function start(): Promise<void> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(cors, {
    // Dev origins + FB Instant wrapper. Tighten in production.
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  registerHealth(app);
  registerRaid(app);
  registerMatchmaking(app);

  try {
    await app.listen({ host: HOST, port: PORT });
    app.log.info(`@hive/api listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void start();
