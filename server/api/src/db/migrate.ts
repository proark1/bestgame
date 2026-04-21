import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

// Forward-only SQL migrations. Files under ./migrations/NNNN-name.sql are
// applied in numeric order; applied IDs are tracked in _migrations so
// reruns skip already-applied files.
//
// Runs inside a transaction per file: if any statement throws, the
// migration is rolled back and startup halts — better than a partially
// migrated schema.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export async function runMigrations(pool: pg.Pool, log: (msg: string) => void): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const applied = new Set<number>();
    const existing = await client.query<{ id: number }>(
      'SELECT id FROM _migrations',
    );
    for (const row of existing.rows) applied.add(row.id);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => /^\d{4}-.+\.sql$/.test(f))
      .sort();

    for (const file of files) {
      const idMatch = /^(\d{4})-/.exec(file);
      if (!idMatch) continue;
      const id = Number(idMatch[1]);
      if (applied.has(id)) continue;

      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      log(`[migrate] applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _migrations (id, name) VALUES ($1, $2)',
          [id, file],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(
          `migration ${file} failed: ${(err as Error).message}`,
        );
      }
    }
  } finally {
    client.release();
  }
}
