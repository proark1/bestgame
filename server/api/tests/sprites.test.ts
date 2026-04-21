import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hydrateSpritesToDisk, type SpriteRowWithData } from '../src/db/sprites.js';

// Sprite DB layer: the only logic that's unit-testable without a live
// Postgres is the on-disk hydration helper. We stub the pg Pool with a
// handful of `query()` calls that return fixture rows, then assert that
// hydrateSpritesToDisk actually materializes the bytes onto disk and
// skips files that are already up-to-date (the fast-path for reboots).

interface FakeRow {
  key: string;
  format: 'png' | 'webp';
  data: Buffer;
  size: number;
  updated_at: Date;
}

function makePool(rows: FakeRow[]): { query: (sql: string, params?: unknown[]) => Promise<unknown> } {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('SELECT key, format, size, updated_at')) {
        return { rows };
      }
      if (sql.startsWith('SELECT key, format, data, size, updated_at')) {
        const wanted = (params as [string])[0];
        const row = rows.find((r) => r.key === wanted);
        return { rows: row ? [row] : [] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

describe('hydrateSpritesToDisk', () => {
  it('writes DB rows to disk and reports the count', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hive-sprites-'));
    const pool = makePool([
      {
        key: 'unit-SoldierAnt',
        format: 'webp',
        data: Buffer.from('fake-webp-bytes'),
        size: 15,
        updated_at: new Date(Date.now() - 1000),
      },
    ]);
    const log = vi.fn();
    const result = await hydrateSpritesToDisk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool as any,
      [dir],
      log,
    );
    expect(result).toEqual({ written: 1, skipped: 0 });
    const names = await readdir(dir);
    expect(names).toContain('unit-SoldierAnt.webp');
    const bytes = await readFile(join(dir, 'unit-SoldierAnt.webp'));
    expect(bytes.toString()).toBe('fake-webp-bytes');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('sprites hydrated: 1 written'),
    );
  });

  it('skips files already up to date (size + mtime match)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hive-sprites-'));
    const filePath = join(dir, 'unit-Wasp.webp');
    await writeFile(filePath, Buffer.from('existing-bytes'));
    const currentStat = await stat(filePath);
    const pool = makePool([
      {
        key: 'unit-Wasp',
        format: 'webp',
        data: Buffer.from('existing-bytes'),
        size: currentStat.size,
        // updated_at is a moment before the disk mtime → skip.
        updated_at: new Date(currentStat.mtimeMs - 500),
      },
    ]);
    const result = await hydrateSpritesToDisk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool as any,
      [dir],
      () => undefined,
    );
    expect(result).toEqual({ written: 0, skipped: 1 });
  });

  it('removes a stale sibling in the opposite format on format flip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hive-sprites-'));
    // Pretend a previous PNG is on disk; DB now has the WebP variant.
    await writeFile(join(dir, 'unit-Forager.png'), Buffer.from('old-png'));
    const pool = makePool([
      {
        key: 'unit-Forager',
        format: 'webp',
        data: Buffer.from('new-webp'),
        size: 8,
        updated_at: new Date(),
      },
    ]);
    await hydrateSpritesToDisk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool as any,
      [dir],
      () => undefined,
    );
    const names = await readdir(dir);
    expect(names).toContain('unit-Forager.webp');
    expect(names).not.toContain('unit-Forager.png');
  });

  it('silently skips non-existent target directories', async () => {
    const pool = makePool([
      {
        key: 'unit-X',
        format: 'png',
        data: Buffer.from('x'),
        size: 1,
        updated_at: new Date(),
      },
    ]);
    const result = await hydrateSpritesToDisk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool as any,
      ['/definitely/does/not/exist/ever'],
      () => undefined,
    );
    expect(result).toEqual({ written: 0, skipped: 0 });
    // The spread-over-targets pattern intentionally doesn't throw so a
    // deployed bundle without a public/ mirror still boots cleanly.
  });

  it('returns zero for both when the DB has no sprites', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hive-sprites-'));
    const pool = makePool([]);
    const result = await hydrateSpritesToDisk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool as any,
      [dir],
      () => undefined,
    );
    expect(result).toEqual({ written: 0, skipped: 0 });
  });

  // Force the type-export to be exercised so a rename doesn't break
  // downstream imports without a compile error.
  it('type export SpriteRowWithData is defined', () => {
    const sample: SpriteRowWithData = {
      key: 'x',
      format: 'png',
      data: Buffer.alloc(0),
      size: 0,
      updatedAt: new Date(),
    };
    expect(sample.key).toBe('x');
  });
});
