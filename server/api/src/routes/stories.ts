import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Public story-metadata endpoint. Returns the structural JSON the
// landing-page comic-strip rail needs: which stories exist, what
// captions go on each panel, and which sprite key holds the
// generated image. Prompts themselves live in prompts.json under
// the `stories` bucket and are edited via /admin/api/prompts; this
// endpoint is read-only and unauthenticated so the landing page can
// fetch it without a bearer token.

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORIES_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'tools',
  'gemini-art',
  'stories.json',
);

export function registerStories(app: FastifyInstance): void {
  app.get('/stories', async (_req, reply) => {
    try {
      const raw = await readFile(STORIES_PATH, 'utf8');
      reply.header('content-type', 'application/json');
      reply.header('cache-control', 'public, max-age=60');
      return raw;
    } catch (err) {
      reply.code(500);
      return { error: `could not read stories.json: ${(err as Error).message}` };
    }
  });
}
