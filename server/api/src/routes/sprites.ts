import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from '../db/pool.js';
import { listSprites } from '../db/sprites.js';

// Public sprite manifest. Tells the Phaser boot loader which sprite
// keys it can fetch without triggering 404s. On first deploy (no
// Gemini art generated yet) the manifest is small and the client
// draws procedural placeholders for everything else; once art is
// generated, the manifest grows and the client picks up real sprites
// on next reload.
//
// Response shape:
//   {
//     images: [{ key: "unit-WorkerAnt", ext: "webp" }, ...],
//     sheets: [{ key: "unit-WorkerAnt-walk", frames: 4, ext: "webp" }, ...],
//     updatedAt: <epoch-ms-of-newest-asset>
//   }
//
// The per-entry `ext` lets the client request exactly the one URL
// that exists on disk instead of trying both .webp and .png per key
// (the previous shape required the client to guess, which produced
// an unavoidable 404-per-sprite in the console).
//
// Clients use `updatedAt` as a cache-bust suffix when loading sprite
// URLs so a freshly-generated sprite shows up without a hard reload.

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_SPRITES_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'client',
  'dist',
  'assets',
  'sprites',
);

type SpriteExt = 'png' | 'webp';

interface ManifestImage {
  key: string;
  ext: SpriteExt;
}

interface ManifestSheet {
  key: string;
  frames: number;
  ext: SpriteExt;
}

interface ManifestResponse {
  images: ManifestImage[];
  sheets: ManifestSheet[];
  updatedAt: number;
}

function parseName(name: string): { key: string; format: SpriteExt } | null {
  const m = /^(.+)\.(png|webp)$/.exec(name);
  if (!m) return null;
  return { key: m[1]!, format: m[2] as SpriteExt };
}

export function registerSpritesManifest(app: FastifyInstance): void {
  app.get('/sprites/manifest', async (_req, reply) => {
    // DB is the source of truth when reachable — it has per-sprite
    // frame counts + format and survives redeploys. Fall back to a
    // disk scan if DB isn't configured so the boot flow still works
    // in offline/no-DB dev setups.
    const pool = await getPool();
    const images = new Map<string, ManifestImage>();
    const sheets = new Map<string, ManifestSheet>();
    let newest = 0;

    if (pool) {
      try {
        const rows = await listSprites(pool);
        for (const r of rows) {
          const t = r.updatedAt.getTime();
          if (t > newest) newest = t;
          if (r.frames > 1) {
            sheets.set(r.key, {
              key: r.key,
              frames: r.frames,
              ext: r.format,
            });
          } else {
            images.set(r.key, { key: r.key, ext: r.format });
          }
        }
      } catch (err) {
        app.log.warn({ err }, 'sprite manifest DB lookup failed');
      }
    }

    // Disk fallback / supplement: scan client/dist/assets/sprites for
    // files the DB doesn't know about (e.g. sprites committed to the
    // repo before the DB migration). Disk has no frame metadata, so
    // these always land as single-frame images; a key that already
    // exists in sheets keeps its DB entry. Prefer webp when the disk
    // somehow has both extensions for the same key.
    if (existsSync(DIST_SPRITES_DIR)) {
      try {
        const names = await readdir(DIST_SPRITES_DIR);
        for (const n of names) {
          const parsed = parseName(n);
          if (!parsed) continue;
          if (!sheets.has(parsed.key)) {
            const prev = images.get(parsed.key);
            if (!prev || (prev.ext === 'png' && parsed.format === 'webp')) {
              images.set(parsed.key, {
                key: parsed.key,
                ext: parsed.format,
              });
            }
          }
          try {
            const s = await stat(join(DIST_SPRITES_DIR, n));
            if (s.mtimeMs > newest) newest = s.mtimeMs;
          } catch {
            // skip
          }
        }
      } catch {
        // directory may not exist — fine
      }
    }

    const body: ManifestResponse = {
      images: [...images.values()].sort((a, b) => a.key.localeCompare(b.key)),
      sheets: [...sheets.values()].sort((a, b) => a.key.localeCompare(b.key)),
      updatedAt: newest || Date.now(),
    };
    // Short cache window: the manifest is cheap to compute and refresh
    // is valuable after an admin regenerates a sprite. 30s is a
    // reasonable balance between dev feedback and hit rate.
    reply.header('cache-control', 'public, max-age=30');
    return body;
  });
}
