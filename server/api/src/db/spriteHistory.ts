import type pg from 'pg';
import type { SpriteFormat } from './sprites.js';

// Sprite generation history DAO. Every successful admin save lands
// here in addition to `sprites`, so the admin UI can show the last
// few generations and restore one without a re-run of Gemini (free).
// Cap of 3 entries per key is enforced by trimSpriteHistory —
// migration intentionally does NOT enforce it at the DB level so
// we can raise the cap (or add a temporary grace window during a
// batch regen) without a schema change.

export const SPRITE_HISTORY_CAP = 3;

export interface SpriteHistoryRow {
  id: number;
  key: string;
  format: SpriteFormat;
  size: number;
  frames: number;
  label: string | null;
  createdAt: Date;
}

export interface SpriteHistoryRowWithData extends SpriteHistoryRow {
  data: Buffer;
}

// Insert a new history row for `key`. Caller is responsible for
// trimming to SPRITE_HISTORY_CAP afterwards (we return early so
// the caller can batch the trim under the same transaction).
export async function insertSpriteHistory(
  pool: pg.Pool,
  key: string,
  format: SpriteFormat,
  data: Buffer,
  frames: number,
  label: string | null,
): Promise<SpriteHistoryRow> {
  const safeFrames = Math.max(1, Math.min(16, Math.floor(frames)));
  const res = await pool.query<{ id: number; created_at: Date }>(
    `INSERT INTO sprite_history (key, format, data, size, frames, label)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [key, format, data, data.length, safeFrames, label],
  );
  const row = res.rows[0]!;
  return {
    id: row.id,
    key,
    format,
    size: data.length,
    frames: safeFrames,
    label,
    createdAt: row.created_at,
  };
}

// Keep only the N most-recent history rows for `key`. Run after
// insertSpriteHistory or after a restore that promotes an old row
// to the top of the list.
export async function trimSpriteHistory(
  pool: pg.Pool,
  key: string,
  cap: number = SPRITE_HISTORY_CAP,
): Promise<number> {
  const res = await pool.query(
    `DELETE FROM sprite_history
     WHERE key = $1
       AND id NOT IN (
         SELECT id FROM sprite_history
         WHERE key = $1
         ORDER BY id DESC
         LIMIT $2
       )`,
    [key, cap],
  );
  return res.rowCount ?? 0;
}

// List the most-recent N history rows for a key, metadata only
// (no bytes — the admin UI previews via a separate bytes endpoint
// so the list response stays small).
export async function listSpriteHistory(
  pool: pg.Pool,
  key: string,
  cap: number = SPRITE_HISTORY_CAP,
): Promise<SpriteHistoryRow[]> {
  const res = await pool.query<{
    id: number;
    format: SpriteFormat;
    size: number;
    frames: number;
    label: string | null;
    created_at: Date;
  }>(
    `SELECT id, format, size, frames, label, created_at
     FROM sprite_history
     WHERE key = $1
     ORDER BY id DESC
     LIMIT $2`,
    [key, cap],
  );
  return res.rows.map((r) => ({
    id: r.id,
    key,
    format: r.format,
    size: r.size,
    frames: r.frames,
    label: r.label,
    createdAt: r.created_at,
  }));
}

// Fetch a single history row including its bytes. Used both for the
// preview endpoint (admin UI renders from a data URL) and to copy
// bytes back into `sprites` on restore.
export async function getSpriteHistoryById(
  pool: pg.Pool,
  key: string,
  id: number,
): Promise<SpriteHistoryRowWithData | null> {
  const res = await pool.query<{
    id: number;
    key: string;
    format: SpriteFormat;
    data: Buffer;
    size: number;
    frames: number;
    label: string | null;
    created_at: Date;
  }>(
    `SELECT id, key, format, data, size, frames, label, created_at
     FROM sprite_history
     WHERE key = $1 AND id = $2`,
    [key, id],
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0]!;
  return {
    id: r.id,
    key: r.key,
    format: r.format,
    data: r.data,
    size: r.size,
    frames: r.frames,
    label: r.label,
    createdAt: r.created_at,
  };
}

// Delete all history for a key. Used from the existing sprite-delete
// path so a full delete nukes both the live sprite AND its history.
// Returns the number of rows removed for logging / response.
export async function deleteSpriteHistory(
  pool: pg.Pool,
  key: string,
): Promise<number> {
  const res = await pool.query(
    'DELETE FROM sprite_history WHERE key = $1',
    [key],
  );
  return res.rowCount ?? 0;
}
