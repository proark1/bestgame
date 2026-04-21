import type { FastifyInstance } from 'fastify';
import archiver from 'archiver';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile, unlink } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geminiGenerateImages } from '../admin/gemini.js';
import { adminAuthConfigured } from '../auth/adminAuth.js';

// Admin API — authenticated via the registerAdminHook in auth/adminAuth.ts.
// Routes are mounted at /admin/api/* so the auth prefix match is exact.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

// Two possible sprite locations, each with a specific purpose:
//
// DIST_SPRITES_DIR — under client/dist, the directory fastify-static
// actually serves at /assets/sprites/*. This MUST be the primary write
// target or the running game will 404 on the image the admin just saved
// (classic "save succeeded, preview is broken" symptom).
//
// PUBLIC_SPRITES_DIR — under client/public, the committable source of
// truth that Vite copies into dist at build time and that the CLI
// (tools/gemini-art) writes to. We best-effort mirror admin saves here
// when it exists so that local-dev workflows (admin running against a
// checked-out repo) get files that can be `git add`-ed directly.
const DIST_SPRITES_DIR = join(
  REPO_ROOT,
  'client',
  'dist',
  'assets',
  'sprites',
);
const PUBLIC_SPRITES_DIR = join(
  REPO_ROOT,
  'client',
  'public',
  'assets',
  'sprites',
);
const PROMPTS_PATH = join(REPO_ROOT, 'tools', 'gemini-art', 'prompts.json');

function publicDirExists(): boolean {
  return existsSync(join(REPO_ROOT, 'client', 'public'));
}

interface SpriteFileMeta {
  name: string;
  size: number;
  mtime: number;
  source: 'dist' | 'public';
}

// Merged listing of sprite files from both directories. Dist wins on
// name collisions because it's the live served state; public fills in
// the long tail (e.g. sprites committed to the repo but not yet
// re-saved since the last deploy). Consumers include /admin/api/status
// (what the UI sees) and /admin/api/download-all (what the zip ships).
async function listAllSprites(): Promise<SpriteFileMeta[]> {
  const merged = new Map<string, SpriteFileMeta>();
  // Iterate public first so dist entries overwrite when both exist.
  const sources: Array<[string, 'public' | 'dist']> = [
    [PUBLIC_SPRITES_DIR, 'public'],
    [DIST_SPRITES_DIR, 'dist'],
  ];
  for (const [dir, source] of sources) {
    try {
      const names = await readdir(dir);
      const metas = await Promise.all(
        names
          .filter((n) => n.endsWith('.png') || n.endsWith('.webp'))
          .map(async (n): Promise<SpriteFileMeta> => {
            const s = await stat(join(dir, n));
            return { name: n, size: s.size, mtime: s.mtimeMs, source };
          }),
      );
      for (const m of metas) merged.set(m.name, m);
    } catch {
      // directory may not exist — fine, it'll be created on first save
    }
  }
  return Array.from(merged.values());
}

function resolveSpritePath(meta: SpriteFileMeta): string {
  return join(
    meta.source === 'dist' ? DIST_SPRITES_DIR : PUBLIC_SPRITES_DIR,
    meta.name,
  );
}

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
    // Merged view across dist + public so the admin always sees the full
    // repository state. Dist wins on name collisions (it's the live
    // served state).
    const files = await listAllSprites();
    return {
      authMode: adminAuthConfigured() ? 'token' : 'loopback-only',
      spritesDir: DIST_SPRITES_DIR,
      mirrorsPublic: publicDirExists(),
      files: files.map(({ name, size, mtime }) => ({ name, size, mtime })),
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

    // Write order matters: dist is what fastify-static serves, so write
    // there first. If public exists (local-dev workflow), mirror so a
    // `git add client/public/assets/sprites` captures the same bytes.
    const siblingExt = body.format === 'webp' ? 'png' : 'webp';
    await mkdir(DIST_SPRITES_DIR, { recursive: true });
    await writeFile(join(DIST_SPRITES_DIR, `${safeKey}.${body.format}`), buf);
    try {
      await unlink(join(DIST_SPRITES_DIR, `${safeKey}.${siblingExt}`));
    } catch {
      // not there — fine
    }

    let mirrored = false;
    if (publicDirExists()) {
      try {
        await mkdir(PUBLIC_SPRITES_DIR, { recursive: true });
        await writeFile(
          join(PUBLIC_SPRITES_DIR, `${safeKey}.${body.format}`),
          buf,
        );
        try {
          await unlink(join(PUBLIC_SPRITES_DIR, `${safeKey}.${siblingExt}`));
        } catch {
          // not there
        }
        mirrored = true;
      } catch (err) {
        // public mirror is best-effort — the game still works from dist
        app.log.warn({ err }, 'public mirror write failed');
      }
    }

    return {
      ok: true,
      path: `/assets/sprites/${safeKey}.${body.format}`,
      size: buf.length,
      mirroredToPublic: mirrored,
    };
  });

  app.get('/admin/api/download-all', async (_req, reply) => {
    // Uses the same merged listing as /status so the zip always ships
    // exactly what the admin UI displays. STORE-only entries since
    // WebP/PNG are already compressed.
    const files = await listAllSprites();
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
    for (const f of files) {
      zip.file(resolveSpritePath(f), { name: f.name });
    }
    zip.append(
      `# Hive Wars sprite bundle\n\nExtract these ${files.length} file(s) ` +
        `to\n  client/public/assets/sprites/\nthen \`git add\` and commit ` +
        `so the art survives the next Railway redeploy.\n`,
      { name: 'README.txt' },
    );
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
    // Remove from both dist and public so admin-delete doesn't leave
    // a ghost copy that would re-appear after the next build.
    let removed = 0;
    for (const dir of [DIST_SPRITES_DIR, PUBLIC_SPRITES_DIR]) {
      for (const ext of ['png', 'webp']) {
        try {
          await unlink(join(dir, `${safeKey}.${ext}`));
          removed++;
        } catch {
          // not there
        }
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
