import type { FastifyInstance } from 'fastify';
import archiver from 'archiver';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geminiGenerateImages } from '../admin/gemini.js';
import { adminAuthConfigured } from '../auth/adminAuth.js';

// Admin API — authenticated via the registerAdminHook in auth/adminAuth.ts.
// Routes are mounted at /admin/api/* so the auth prefix match is exact.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const SPRITES_DIR = join(REPO_ROOT, 'client', 'public', 'assets', 'sprites');
const PROMPTS_PATH = join(REPO_ROOT, 'tools', 'gemini-art', 'prompts.json');

interface GenerateBody {
  prompt: string;
  variants?: number;
  model?: string;
  temperature?: number;
}

interface SaveBody {
  key: string;
  data: string; // base64 (no data: prefix)
  format: 'png' | 'webp';
}

interface UpdatePromptBody {
  category: 'units' | 'buildings' | 'factions' | 'styleLock';
  key?: string;
  value: string;
}

const MAX_SAVE_BYTES = 2_000_000; // 2 MB — well above any reasonable 128-256 px sprite.
const ALLOWED_KEY_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/i;
// Closed set. New buckets require a deliberate code change — prevents
// prototype-pollution via surprise categories like __proto__/constructor
// and also stops ad-hoc keys from growing prompts.json unbounded.
const ALLOWED_BUCKET_CATEGORIES = new Set<'units' | 'buildings' | 'factions'>([
  'units',
  'buildings',
  'factions',
]);
// JavaScript's special inherited-property names. Even with a bucket
// allowlist we reject these as sub-keys — the prompts.json bucket object
// is iterated elsewhere, so polluting it is still a bad idea.
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function sanitizeKey(key: string): string | null {
  if (DANGEROUS_KEYS.has(key)) return null;
  return ALLOWED_KEY_RE.test(key) ? key : null;
}

export function registerAdmin(app: FastifyInstance): void {
  app.get('/admin/api/status', async () => {
    let files: Array<{ name: string; size: number; mtime: number }> = [];
    try {
      const names = await readdir(SPRITES_DIR);
      const metas = await Promise.all(
        names
          .filter((n) => n.endsWith('.png') || n.endsWith('.webp'))
          .map(async (n) => {
            const s = await stat(join(SPRITES_DIR, n));
            return { name: n, size: s.size, mtime: s.mtimeMs };
          }),
      );
      files = metas;
    } catch {
      files = []; // directory may not exist yet
    }
    return {
      authMode: adminAuthConfigured() ? 'token' : 'loopback-only',
      spritesDir: SPRITES_DIR,
      files,
    };
  });

  app.get('/admin/api/prompts', async (_req, reply) => {
    try {
      const raw = await readFile(PROMPTS_PATH, 'utf8');
      reply.header('content-type', 'application/json');
      return raw;
    } catch (err) {
      reply.code(500);
      return { error: `could not read prompts.json: ${(err as Error).message}` };
    }
  });

  app.put<{ Body: UpdatePromptBody }>('/admin/api/prompts', async (req, reply) => {
    const body = req.body;
    if (!body || !body.category || typeof body.value !== 'string') {
      reply.code(400);
      return { error: 'bad request' };
    }
    // Bound the value size — prompts.json is committed to the repo and
    // an unbounded write would let an authenticated admin balloon it.
    if (body.value.length > 4096) {
      reply.code(413);
      return { error: 'value exceeds 4096 chars' };
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(await readFile(PROMPTS_PATH, 'utf8'));
    } catch (err) {
      reply.code(500);
      return { error: `read: ${(err as Error).message}` };
    }

    if (body.category === 'styleLock') {
      // Object.defineProperty avoids any __proto__ shenanigans even
      // though "styleLock" is a hardcoded literal here — belt-and-braces.
      Object.defineProperty(json, 'styleLock', {
        value: body.value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else if (
      ALLOWED_BUCKET_CATEGORIES.has(
        body.category as 'units' | 'buildings' | 'factions',
      )
    ) {
      const safeKey = body.key ? sanitizeKey(body.key) : null;
      if (!safeKey) {
        reply.code(400);
        return { error: 'valid key required (matches [a-z0-9][a-z0-9-_]{1,63}, not __proto__/constructor)' };
      }
      // Read the existing bucket via hasOwn so we never walk a prototype
      // chain, and start from a null-proto object if the key is new.
      const hasBucket = Object.prototype.hasOwnProperty.call(json, body.category);
      const raw = hasBucket ? (json[body.category] as unknown) : null;
      const bucket =
        raw && typeof raw === 'object'
          ? Object.assign(Object.create(null) as Record<string, string>, raw)
          : (Object.create(null) as Record<string, string>);
      Object.defineProperty(bucket, safeKey, {
        value: body.value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      Object.defineProperty(json, body.category, {
        value: bucket,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      reply.code(400);
      return { error: 'invalid category' };
    }

    await writeFile(PROMPTS_PATH, JSON.stringify(json, null, 2) + '\n', 'utf8');
    return { ok: true };
  });

  app.post<{ Body: GenerateBody }>('/admin/api/generate', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body.prompt !== 'string' || body.prompt.trim() === '') {
      reply.code(400);
      return { error: 'prompt required' };
    }
    try {
      const images = await geminiGenerateImages({
        prompt: body.prompt,
        variants: body.variants ?? 1,
        ...(body.model !== undefined && { model: body.model }),
        ...(body.temperature !== undefined && { temperature: body.temperature }),
      });
      return { images };
    } catch (err) {
      reply.code(502);
      return { error: (err as Error).message };
    }
  });

  app.post<{ Body: SaveBody }>('/admin/api/save', async (req, reply) => {
    const body = req.body;
    if (!body || !body.key || !body.data || !body.format) {
      reply.code(400);
      return { error: 'key, data, and format required' };
    }
    const safeKey = sanitizeKey(body.key);
    if (!safeKey) {
      reply.code(400);
      return { error: 'key must match [a-z0-9][a-z0-9-_]{1,63}' };
    }
    if (body.format !== 'png' && body.format !== 'webp') {
      reply.code(400);
      return { error: 'format must be png or webp' };
    }

    let buf: Buffer;
    try {
      buf = Buffer.from(body.data, 'base64');
    } catch {
      reply.code(400);
      return { error: 'data must be base64' };
    }
    if (buf.length === 0 || buf.length > MAX_SAVE_BYTES) {
      reply.code(413);
      return { error: `image size ${buf.length} exceeds ${MAX_SAVE_BYTES}` };
    }

    await mkdir(SPRITES_DIR, { recursive: true });

    // Writing both formats is wasteful — we pick the one the admin chose
    // and clear the sibling so BootScene's prefer-webp-then-png fallback
    // never ambiguates.
    const primary = join(SPRITES_DIR, `${safeKey}.${body.format}`);
    const sibling = join(
      SPRITES_DIR,
      `${safeKey}.${body.format === 'webp' ? 'png' : 'webp'}`,
    );
    await writeFile(primary, buf);
    try {
      // Remove the sibling if it exists so the loader always gets the latest.
      await (await import('node:fs/promises')).unlink(sibling);
    } catch {
      // not there — fine.
    }
    return {
      ok: true,
      path: `/assets/sprites/${safeKey}.${body.format}`,
      size: buf.length,
    };
  });

  app.get('/admin/api/download-all', async (_req, reply) => {
    // Stream a ZIP of the sprites/ directory. Admin presses this after
    // generating art on Railway's ephemeral disk, downloads the zip,
    // and extracts into client/public/assets/sprites/ locally for a
    // durable git commit. Entries are STORE-only because WebP/PNG are
    // already compressed — deflating them again would only waste CPU.
    let files: string[] = [];
    try {
      files = (await readdir(SPRITES_DIR)).filter(
        (n) => n.endsWith('.png') || n.endsWith('.webp'),
      );
    } catch {
      files = [];
    }
    reply
      .header(
        'content-disposition',
        `attachment; filename="hive-sprites-${Date.now()}.zip"`,
      )
      .header('content-type', 'application/zip');

    const zip = archiver('zip', { store: true });
    zip.on('error', (err) => {
      app.log.error({ err }, 'zip error');
      reply.raw.destroy(err);
    });
    for (const name of files) {
      zip.file(join(SPRITES_DIR, name), { name });
    }
    // Attach a short README so the zip is self-describing.
    zip.append(
      `# Hive Wars sprite bundle\n\nExtract these ${files.length} file(s) ` +
        `to\n  client/public/assets/sprites/\nthen \`git add\` and commit ` +
        `so the art survives the next Railway redeploy.\n`,
      { name: 'README.txt' },
    );
    // Trigger finalize without awaiting — Fastify pipes the stream to
    // the HTTP response and archiver drains on back-pressure. Errors are
    // surfaced by the 'error' handler above.
    void zip.finalize();
    return reply.send(zip);
  });

  app.delete('/admin/api/sprite/:key', async (req, reply) => {
    const params = req.params as { key: string };
    const safeKey = sanitizeKey(params.key);
    if (!safeKey) {
      reply.code(400);
      return { error: 'invalid key' };
    }
    const fs = await import('node:fs/promises');
    let removed = 0;
    for (const ext of ['png', 'webp']) {
      try {
        await fs.unlink(join(SPRITES_DIR, `${safeKey}.${ext}`));
        removed++;
      } catch {
        // not there
      }
    }
    return { ok: true, removed };
  });

  app.log.info(
    `admin API mounted (${
      adminAuthConfigured() ? 'bearer token required' : 'loopback only — set ADMIN_TOKEN for remote access'
    })`,
  );
}

// Utility export for index.ts.
export function adminExtname(name: string): string {
  return extname(name).toLowerCase();
}
