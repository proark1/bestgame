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
): Promise<SpriteRow> {
  const res = await pool.query<{ updated_at: Date }>(
    `INSERT INTO sprites (key, format, data, size, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (key) DO UPDATE
        SET format = EXCLUDED.format,
            data = EXCLUDED.data,
            size = EXCLUDED.size,
            updated_at = NOW()
     RETURNING updated_at`,
    [key, format, data, data.length],
  );
  return {
    key,
    format,
    size: data.length,
    updatedAt: res.rows[0]!.updated_at,
  };
}

export async function listSprites(pool: pg.Pool): Promise<SpriteRow[]> {
  const res = await pool.query<{
    key: string;
    format: SpriteFormat;
    size: number;
    updated_at: Date;
  }>('SELECT key, format, size, updated_at FROM sprites ORDER BY key');
  return res.rows.map((r) => ({
    key: r.key,
    format: r.format,
    size: r.size,
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
    updated_at: Date;
  }>('SELECT key, format, data, size, updated_at FROM sprites WHERE key = $1', [
    key,
  ]);
  if (res.rows.length === 0) return null;
  const r = res.rows[0]!;
  return {
    key: r.key,
    format: r.format,
    data: r.data,
    size: r.size,
    updatedAt: r.updated_at,
  };
}

export async function deleteSprite(pool: pg.Pool, key: string): Promise<number> {
  const res = await pool.query('DELETE FROM sprites WHERE key = $1', [key]);
  return res.rowCount ?? 0;
}

// On-boot hydration: write every row in `sprites` out to distDir.
// Skips files that already exist with a matching size + mtime ≥ updated_at,
// so re-runs are cheap. Callers pass both DIST and PUBLIC so dev workflows
// get the committable mirror too.
export async function hydrateSpritesToDisk(
  pool: pg.Pool,
  targetDirs: string[],
  log: (msg: string) => void,
): Promise<{ written: number; skipped: number }> {
  const rows = await listSprites(pool);
  if (rows.length === 0) {
    return { written: 0, skipped: 0 };
  }

  let written = 0;
  let skipped = 0;
  for (const dir of targetDirs) {
    if (!existsSync(dir)) {
      // `public/` under a deployed bundle may genuinely not exist — skip
      // silently; dist is the authoritative target.
      continue;
    }
    await mkdir(dir, { recursive: true });
    const existingNames = new Set<string>();
    try {
      const names = await readdir(dir);
      for (const n of names) existingNames.add(n);
    } catch {
      // fine
    }

    for (const row of rows) {
      const filename = `${row.key}.${row.format}`;
      const path = join(dir, filename);
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
        await unlink(join(dir, siblingName)).catch(() => undefined);
      }
    }
  }
  log(`[db] sprites hydrated: ${written} written, ${skipped} up-to-date`);
  return { written, skipped };
}
