import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  SPRITE_HISTORY_CAP,
  deleteSpriteHistory,
  getSpriteHistoryById,
  insertSpriteHistory,
  listSpriteHistory,
  trimSpriteHistory,
} from '../src/db/spriteHistory.js';

// History DAO tested against a fake in-memory pg Pool so the behaviour
// we care about most — "save three times, list returns three most-
// recent, fourth save trims the oldest, restore works by id" — runs
// without a live Postgres. SQL routing mirrors the actual queries in
// spriteHistory.ts; when we add a new query there, a matching branch
// lands here.

interface Row {
  id: number;
  key: string;
  format: 'png' | 'webp';
  data: Buffer;
  size: number;
  frames: number;
  label: string | null;
  created_at: Date;
}

function makeFakePool(): pg.Pool {
  const rows: Row[] = [];
  let nextId = 1;
  const query = async (
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount?: number }> => {
    const p = (params ?? []) as unknown[];
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('INSERT INTO sprite_history')) {
      const row: Row = {
        id: nextId++,
        key: p[0] as string,
        format: p[1] as 'png' | 'webp',
        data: p[2] as Buffer,
        size: p[3] as number,
        frames: p[4] as number,
        label: (p[5] as string | null) ?? null,
        created_at: new Date(),
      };
      rows.push(row);
      return {
        rows: [{ id: row.id, created_at: row.created_at }],
      };
    }

    if (s.startsWith('DELETE FROM sprite_history WHERE key = $1 AND id NOT IN')) {
      const key = p[0] as string;
      const cap = p[1] as number;
      const forKey = rows
        .filter((r) => r.key === key)
        .sort((a, b) => b.id - a.id);
      const keepIds = new Set(forKey.slice(0, cap).map((r) => r.id));
      let removed = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]!;
        if (r.key === key && !keepIds.has(r.id)) {
          rows.splice(i, 1);
          removed++;
        }
      }
      return { rows: [], rowCount: removed };
    }

    if (
      s.startsWith(
        'SELECT id, format, size, frames, label, created_at FROM sprite_history',
      )
    ) {
      const key = p[0] as string;
      const cap = p[1] as number;
      const forKey = rows
        .filter((r) => r.key === key)
        .sort((a, b) => b.id - a.id)
        .slice(0, cap);
      return { rows: forKey };
    }

    if (
      s.startsWith(
        'SELECT id, key, format, data, size, frames, label, created_at FROM sprite_history',
      )
    ) {
      const key = p[0] as string;
      const id = p[1] as number;
      const row = rows.find((r) => r.key === key && r.id === id);
      return { rows: row ? [row] : [] };
    }

    if (s.startsWith('DELETE FROM sprite_history WHERE key = $1')) {
      const key = p[0] as string;
      let removed = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]!.key === key) {
          rows.splice(i, 1);
          removed++;
        }
      }
      return { rows: [], rowCount: removed };
    }

    throw new Error(`unexpected sql: ${s}`);
  };
  return { query } as unknown as pg.Pool;
}

describe('sprite history DAO', () => {
  it('inserts and lists the most-recent entries in id-DESC order', async () => {
    const pool = makeFakePool();
    for (let i = 0; i < 3; i++) {
      await insertSpriteHistory(
        pool,
        'unit-Wasp',
        'png',
        Buffer.from([i]),
        1,
        `pass ${i}`,
      );
    }
    const listed = await listSpriteHistory(pool, 'unit-Wasp');
    expect(listed.length).toBe(3);
    expect(listed.map((r) => r.label)).toEqual(['pass 2', 'pass 1', 'pass 0']);
  });

  it('trim keeps only the last SPRITE_HISTORY_CAP rows per key', async () => {
    const pool = makeFakePool();
    for (let i = 0; i < 5; i++) {
      await insertSpriteHistory(
        pool,
        'unit-Wasp',
        'png',
        Buffer.from([i]),
        1,
        null,
      );
    }
    await trimSpriteHistory(pool, 'unit-Wasp', SPRITE_HISTORY_CAP);
    const listed = await listSpriteHistory(pool, 'unit-Wasp');
    expect(listed.length).toBe(SPRITE_HISTORY_CAP);
    // Oldest two (rows with ids 1, 2) should be gone; most-recent
    // is the id=5 row.
    expect(listed.map((r) => r.id)).toEqual([5, 4, 3]);
  });

  it('trim is scoped per-key — unrelated keys are untouched', async () => {
    const pool = makeFakePool();
    for (let i = 0; i < 4; i++) {
      await insertSpriteHistory(pool, 'unit-Wasp', 'png', Buffer.from([i]), 1, null);
    }
    for (let i = 0; i < 4; i++) {
      await insertSpriteHistory(pool, 'unit-SoldierAnt', 'png', Buffer.from([i]), 1, null);
    }
    await trimSpriteHistory(pool, 'unit-Wasp', SPRITE_HISTORY_CAP);
    // Wasp trimmed, SoldierAnt untouched at 4 entries.
    expect((await listSpriteHistory(pool, 'unit-Wasp', 10)).length).toBe(3);
    expect((await listSpriteHistory(pool, 'unit-SoldierAnt', 10)).length).toBe(4);
  });

  it('getSpriteHistoryById returns the stored bytes for the matching row', async () => {
    const pool = makeFakePool();
    const bytes = Buffer.from('hello');
    const inserted = await insertSpriteHistory(
      pool,
      'unit-Wasp',
      'webp',
      bytes,
      2,
      'pose A',
    );
    const got = await getSpriteHistoryById(pool, 'unit-Wasp', inserted.id);
    expect(got).not.toBeNull();
    expect(got!.data.equals(bytes)).toBe(true);
    expect(got!.format).toBe('webp');
    expect(got!.frames).toBe(2);
    expect(got!.label).toBe('pose A');
  });

  it('getSpriteHistoryById returns null for a mismatched key', async () => {
    const pool = makeFakePool();
    const inserted = await insertSpriteHistory(
      pool,
      'unit-Wasp',
      'png',
      Buffer.from([1]),
      1,
      null,
    );
    const got = await getSpriteHistoryById(pool, 'unit-SoldierAnt', inserted.id);
    expect(got).toBeNull();
  });

  it('deleteSpriteHistory nukes every row for a key', async () => {
    const pool = makeFakePool();
    for (let i = 0; i < 3; i++) {
      await insertSpriteHistory(pool, 'unit-Wasp', 'png', Buffer.from([i]), 1, null);
    }
    await insertSpriteHistory(pool, 'unit-SoldierAnt', 'png', Buffer.from([0]), 1, null);
    const removed = await deleteSpriteHistory(pool, 'unit-Wasp');
    expect(removed).toBe(3);
    expect((await listSpriteHistory(pool, 'unit-Wasp', 10)).length).toBe(0);
    // Sibling key untouched.
    expect((await listSpriteHistory(pool, 'unit-SoldierAnt', 10)).length).toBe(1);
  });
});
