import type pg from 'pg';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Sprite persistence in Postgres + on-disk mirror.
//
// Why both: DB is the source of truth (survives Railway redeploys);
// disk is the hot-serve path (fastify-static). On boot we rehydrate
// disk from DB so the runtime serves the same bytes without a
// per-request DB round-trip.

export type SpriteFormat = 'png' | 'webp';

export interface SpriteRow {
  key: string;
  format: SpriteFormat;
  size: number;
  frames: number;
  updatedAt: Date;
}

export interface SpriteRowWithData extends SpriteRow {
  data: Buffer;
}

export async function upsertSprite(
  pool: pg.Pool,
  key: string,
  format: SpriteFormat,
  data: Buffer,
  frames: number = 1,
): Promise<SpriteRow> {
  const safeFrames = Math.max(1, Math.min(16, Math.floor(frames)));
  const res = await pool.query<{ updated_at: Date }>(
    `INSERT INTO sprites (key, format, data, size, frames, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (key) DO UPDATE
        SET format = EXCLUDED.format,
            data = EXCLUDED.data,
            size = EXCLUDED.size,
            frames = EXCLUDED.frames,
            updated_at = NOW()
     RETURNING updated_at`,
    [key, format, data, data.length, safeFrames],
  );
  return {
    key,
    format,
    size: data.length,
    frames: safeFrames,
    updatedAt: res.rows[0]!.updated_at,
  };
}

export async function listSprites(pool: pg.Pool): Promise<SpriteRow[]> {
  const res = await pool.query<{
    key: string;
    format: SpriteFormat;
    size: number;
    frames: number;
    updated_at: Date;
  }>(
    'SELECT key, format, size, frames, updated_at FROM sprites ORDER BY key',
  );
  return res.rows.map((r) => ({
    key: r.key,
    format: r.format,
    size: r.size,
    frames: r.frames,
    updatedAt: r.updated_at,
  }));
}

export async function getSprite(
  pool: pg.Pool,
  key: string,
): Promise<SpriteRowWithData | null> {
  const res = await pool.query<{
    key: string;
    format: SpriteFormat;
    data: Buffer;
    size: number;
    frames: number;
    updated_at: Date;
  }>(
    'SELECT key, format, data, size, frames, updated_at FROM sprites WHERE key = $1',
    [key],
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0]!;
  return {
    key: r.key,
    format: r.format,
    data: r.data,
    size: r.size,
    frames: r.frames,
    updatedAt: r.updated_at,
  };
}

export async function deleteSprite(pool: pg.Pool, key: string): Promise<number> {
  const res = await pool.query('DELETE FROM sprites WHERE key = $1', [key]);
  return res.rowCount ?? 0;
}

// On-boot hydration target. 'create' targets are mkdir'd if missing
// so a fresh deploy (where nothing has written to client/dist/assets/
// sprites/ yet) still gets its bytes; 'mirror' targets only hydrate
// if the parent already exists, so a production bundle without a
// client/public/ checkout isn't polluted with a surprise directory.
export interface HydrateTarget {
  dir: string;
  mode: 'create' | 'mirror';
}

// On-boot hydration: write every row in `sprites` out to each target
// directory. Skips files already on disk with a matching size + mtime
// ≥ updated_at so re-runs are cheap.
//
// Accepts the legacy `string[]` shape for back-compat with older
// callers (each entry defaults to 'mirror' to preserve old behavior).
export async function hydrateSpritesToDisk(
  pool: pg.Pool,
  targets: Array<HydrateTarget | string>,
  log: (msg: string) => void,
): Promise<{ written: number; skipped: number }> {
  const rows = await listSprites(pool);
  if (rows.length === 0) {
    return { written: 0, skipped: 0 };
  }

  const normalized: HydrateTarget[] = targets.map((t) =>
    typeof t === 'string' ? { dir: t, mode: 'mirror' } : t,
  );

  let written = 0;
  let skipped = 0;
  for (const target of normalized) {
    if (target.mode === 'mirror' && !existsSync(target.dir)) {
      // Optional mirror directory doesn't exist — skip silently. The
      // 'create' mode below is used for the authoritative dist target.
      continue;
    }
    // Always mkdir recursively (idempotent when the dir is present).
    // This is the fix that lets a fresh Railway deploy — which starts
    // with no client/dist/assets/sprites/ directory at all — still
    // rehydrate DB-backed admin sprites onto the served path.
    await mkdir(target.dir, { recursive: true });
    const existingNames = new Set<string>();
    try {
      const names = await readdir(target.dir);
      for (const n of names) existingNames.add(n);
    } catch {
      // fine — we just created it and nothing's inside
    }

    for (const row of rows) {
      const filename = `${row.key}.${row.format}`;
      const path = join(target.dir, filename);
      if (existingNames.has(filename)) {
        try {
          const s = await stat(path);
          if (s.size === row.size && s.mtimeMs >= row.updatedAt.getTime()) {
            skipped++;
            continue;
          }
        } catch {
          // fall through to rewrite
        }
      }
      const row2 = await getSprite(pool, row.key);
      if (!row2) continue;
      await writeFile(path, row2.data);
      written++;
      // Clean up a sibling in the other format so a format change
      // doesn't leave a stale twin on disk.
      const siblingExt = row.format === 'webp' ? 'png' : 'webp';
      const siblingName = `${row.key}.${siblingExt}`;
      if (existingNames.has(siblingName)) {
        await unlink(join(target.dir, siblingName)).catch(() => undefined);
      }
    }
  }
  log(`[db] sprites hydrated: ${written} written, ${skipped} up-to-date`);
  return { written, skipped };
}
