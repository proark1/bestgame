import type { FastifyInstance } from 'fastify';
import archiver from 'archiver';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile, unlink } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geminiGenerateImages } from '../admin/gemini.js';
import { adminAuthConfigured } from '../auth/adminAuth.js';
import { getPool } from '../db/pool.js';
import {
  deleteSprite,
  getSprite,
  listSprites,
  upsertSprite,
} from '../db/sprites.js';
import {
  ANIMATED_UNIT_KINDS,
  DEFAULT_UNIT_ANIMATION,
  DEFAULT_UI_OVERRIDES,
  SETTING_UI_OVERRIDES,
  SETTING_UNIT_ANIMATION,
  UI_OVERRIDE_KEYS,
  getSetting,
  putSetting,
  type AnimatedUnitKind,
  type UiOverrideKey,
  type UiOverrideSettings,
  type UnitAnimationSettings,
} from '../db/settings.js';

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
  source: 'dist' | 'public' | 'db';
  // Set only for DB-sourced sprites. Disk entries default to undefined
  // (= 1 frame) because we don't store frame metadata on-disk; the DB
  // is authoritative for anything that needs the spritesheet flag.
  frames?: number;
}

// Merged listing across three sources: the DB (source of truth, survives
// redeploys), the dist directory (what fastify-static actually serves),
// and the public directory (the committable repo mirror for local dev).
// Priority on name collisions: db > dist > public — we always trust the
// DB's bytes since they'll rehydrate disk on the next boot anyway.
//
// Consumers: /admin/api/status (what the UI sees) and
// /admin/api/download-all (what the zip ships).
async function listAllSprites(): Promise<SpriteFileMeta[]> {
  const merged = new Map<string, SpriteFileMeta>();
  // Iterate lowest-priority sources first; later writes overwrite.
  const diskSources: Array<[string, 'public' | 'dist']> = [
    [PUBLIC_SPRITES_DIR, 'public'],
    [DIST_SPRITES_DIR, 'dist'],
  ];
  for (const [dir, source] of diskSources) {
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
  // DB wins last so its bytes are authoritative when present.
  const pool = await getPool();
  if (pool) {
    try {
      const rows = await listSprites(pool);
      for (const r of rows) {
        const name = `${r.key}.${r.format}`;
        merged.set(name, {
          name,
          size: r.size,
          mtime: r.updatedAt.getTime(),
          source: 'db',
          frames: r.frames,
        });
      }
    } catch {
      // DB unavailable — disk listing is the best we can do
    }
  }
  return Array.from(merged.values());
}

// Resolve where the bytes live so download-all knows whether to stream
// from disk or fetch from DB.
async function loadSpriteBytes(meta: SpriteFileMeta): Promise<Buffer | null> {
  if (meta.source === 'db') {
    const pool = await getPool();
    if (!pool) return null;
    const parsed = parseSpriteFileName(meta.name);
    if (!parsed) return null;
    const row = await getSprite(pool, parsed.key);
    return row?.data ?? null;
  }
  const dir = meta.source === 'dist' ? DIST_SPRITES_DIR : PUBLIC_SPRITES_DIR;
  try {
    return await readFile(join(dir, meta.name));
  } catch {
    return null;
  }
}

function parseSpriteFileName(name: string): { key: string; format: 'png' | 'webp' } | null {
  const m = /^(.+)\.(png|webp)$/.exec(name);
  if (!m) return null;
  return { key: m[1]!, format: m[2] as 'png' | 'webp' };
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
  // Horizontal spritesheet frame count. Default 1 = single static
  // image (backwards compatible with the existing admin UI); >1 means
  // the image is a horizontal strip of N equal-width frames that the
  // client loads as a Phaser spritesheet.
  frames?: number;
}

interface UpdatePromptBody {
  category: 'units' | 'buildings' | 'factions' | 'walkCycles' | 'menuUi' | 'styleLock';
  key?: string;
  value: string;
}

const MAX_SAVE_BYTES = 2_000_000; // 2 MB — well above any reasonable 128-256 px sprite.
const ALLOWED_KEY_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/i;
// Closed set. New buckets require a deliberate code change — prevents
// prototype-pollution via surprise categories like __proto__/constructor
// and also stops ad-hoc keys from growing prompts.json unbounded.
const ALLOWED_BUCKET_CATEGORIES = new Set<
  'units' | 'buildings' | 'factions' | 'walkCycles' | 'menuUi'
>(['units', 'buildings', 'factions', 'walkCycles', 'menuUi']);
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
    // Merged view across DB + dist + public so the admin always sees the
    // authoritative state. DB wins on collisions — it's what survives
    // redeploys and what the next boot will rehydrate disk from.
    const files = await listAllSprites();
    const pool = await getPool();
    return {
      authMode: adminAuthConfigured() ? 'token' : 'loopback-only',
      spritesDir: DIST_SPRITES_DIR,
      mirrorsPublic: publicDirExists(),
      dbPersistence: pool ? 'connected' : 'not-configured',
      files: files.map(({ name, size, mtime, source, frames }) => ({
        name,
        size,
        mtime,
        source,
        ...(typeof frames === 'number' ? { frames } : {}),
      })),
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
        body.category as 'units' | 'buildings' | 'factions' | 'walkCycles' | 'menuUi',
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

    // Write order matters:
    //  1. DB — source of truth that survives Railway redeploys.
    //  2. Dist — what fastify-static serves to the running game.
    //  3. Public — committable mirror for local dev (best-effort).
    //
    // If the DB write fails we still try disk, but return an error so
    // the admin UI can surface that persistence is degraded. Without
    // DB the save is ephemeral and will vanish on next redeploy.
    // Clamp the frame count. Anything outside [1, 16] is treated as a
    // typo from the admin UI rather than honored; >16 frames isn't
    // something Gemini can consistently produce and blows the sprite
    // size budget anyway.
    const frameCount =
      typeof body.frames === 'number' && Number.isFinite(body.frames)
        ? Math.max(1, Math.min(16, Math.floor(body.frames)))
        : 1;

    let persistedToDb = false;
    const pool = await getPool();
    if (pool) {
      try {
        await upsertSprite(pool, safeKey, body.format, buf, frameCount);
        persistedToDb = true;
      } catch (err) {
        app.log.error({ err, key: safeKey }, 'sprite DB upsert failed');
      }
    }

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
      persistedToDb,
      mirroredToPublic: mirrored,
    };
  });

  app.get('/admin/api/download-all', async (_req, reply) => {
    // Uses the same merged listing as /status so the zip always ships
    // exactly what the admin UI displays. STORE-only entries since
    // WebP/PNG are already compressed.
    //
    // For DB-sourced files we append a Buffer directly; disk-sourced
    // files stream from the filesystem. Both paths share the same
    // archiver instance.
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
      if (f.source === 'db') {
        const bytes = await loadSpriteBytes(f);
        if (bytes) zip.append(bytes, { name: f.name });
      } else {
        const dir = f.source === 'dist' ? DIST_SPRITES_DIR : PUBLIC_SPRITES_DIR;
        zip.file(join(dir, f.name), { name: f.name });
      }
    }
    zip.append(
      `# Hive Wars sprite bundle\n\nExtract these ${files.length} file(s) ` +
        `to\n  client/public/assets/sprites/\nthen \`git add\` and commit ` +
        `so the art survives the next Railway redeploy.\n\n` +
        `(Railway deploys with Postgres attached now auto-persist sprites ` +
        `in the \`sprites\` table — this zip is a belt-and-braces backup.)\n`,
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
    // Remove from DB + both on-disk locations so admin-delete doesn't
    // leave a ghost copy that would re-appear on the next hydration or
    // rebuild.
    let dbRemoved = 0;
    const pool = await getPool();
    if (pool) {
      try {
        dbRemoved = await deleteSprite(pool, safeKey);
      } catch (err) {
        app.log.error({ err, key: safeKey }, 'sprite DB delete failed');
      }
    }
    let diskRemoved = 0;
    for (const dir of [DIST_SPRITES_DIR, PUBLIC_SPRITES_DIR]) {
      for (const ext of ['png', 'webp']) {
        try {
          await unlink(join(dir, `${safeKey}.${ext}`));
          diskRemoved++;
        } catch {
          // not there
        }
      }
    }
    return { ok: true, dbRemoved, diskRemoved };
  });

  // Animation toggle read/write. The public GET /api/settings/animation
  // serves the same JSON to the client; this admin version is the only
  // path that can mutate it. If DB is offline we return defaults so
  // the admin UI is still usable for at-rest inspection.
  app.get('/admin/api/settings/animation', async () => {
    const pool = await getPool();
    if (!pool) {
      return {
        kinds: ANIMATED_UNIT_KINDS,
        values: DEFAULT_UNIT_ANIMATION,
        dbPersistence: 'not-configured' as const,
      };
    }
    const row = await getSetting<UnitAnimationSettings>(
      pool,
      SETTING_UNIT_ANIMATION,
    );
    return {
      kinds: ANIMATED_UNIT_KINDS,
      values: row ?? DEFAULT_UNIT_ANIMATION,
      dbPersistence: 'connected' as const,
    };
  });

  interface UpdateAnimationBody {
    values: UnitAnimationSettings;
  }
  app.put<{ Body: UpdateAnimationBody }>(
    '/admin/api/settings/animation',
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof body.values !== 'object' || body.values === null) {
        reply.code(400);
        return { error: 'values object required' };
      }
      // Server owns the shape: ignore unknown keys and coerce values
      // to booleans. Anything else would let the admin UI pollute the
      // JSONB blob with arbitrary nested objects.
      const sanitized: UnitAnimationSettings = {};
      for (const kind of ANIMATED_UNIT_KINDS) {
        const v = body.values[kind as AnimatedUnitKind];
        if (typeof v === 'boolean') sanitized[kind as AnimatedUnitKind] = v;
      }
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
      }
      await putSetting(pool, SETTING_UNIT_ANIMATION, sanitized);
      return { ok: true, values: sanitized };
    },
  );

  // Menu UI image-override settings. Same shape as the animation
  // settings, but for the in-game UI chrome. Admin flips a flag ON
  // for a key, and if the corresponding image is also on disk, the
  // game renders that image instead of the shared button/panel
  // Graphics fallback. Flags OFF → fallback everywhere.
  app.get('/admin/api/settings/ui-overrides', async () => {
    const pool = await getPool();
    if (!pool) {
      return {
        keys: UI_OVERRIDE_KEYS,
        values: DEFAULT_UI_OVERRIDES,
        dbPersistence: 'not-configured' as const,
      };
    }
    const row = await getSetting<UiOverrideSettings>(pool, SETTING_UI_OVERRIDES);
    return {
      keys: UI_OVERRIDE_KEYS,
      values: row ?? DEFAULT_UI_OVERRIDES,
      dbPersistence: 'connected' as const,
    };
  });

  interface UpdateUiOverridesBody {
    values: UiOverrideSettings;
  }
  app.put<{ Body: UpdateUiOverridesBody }>(
    '/admin/api/settings/ui-overrides',
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof body.values !== 'object' || body.values === null) {
        reply.code(400);
        return { error: 'values object required' };
      }
      const sanitized: UiOverrideSettings = {};
      for (const key of UI_OVERRIDE_KEYS) {
        const v = body.values[key as UiOverrideKey];
        if (typeof v === 'boolean') sanitized[key as UiOverrideKey] = v;
      }
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
      }
      await putSetting(pool, SETTING_UI_OVERRIDES, sanitized);
      return { ok: true, values: sanitized };
    },
  );

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
