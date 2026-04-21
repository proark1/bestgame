import type { FastifyInstance } from 'fastify';

export function registerHealth(app: FastifyInstance): void {
  const bootedAtMs = Date.now();
  app.get('/health', async () => ({
    ok: true,
    uptimeMs: Date.now() - bootedAtMs,
    tick: Math.floor((Date.now() - bootedAtMs) / 33),
  }));
}
