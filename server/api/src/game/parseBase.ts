import type { Types } from '@hive/shared';

// Runtime shape guard for `Types.Base` values that arrive from
// untrusted-but-server-stored sources — JSONB columns on the
// pending_matches / arena_matches / bases tables. Postgres returns the
// stored JSON verbatim with no schema validation, so a corrupted row
// (out-of-band write, partial migration, manual edit) would otherwise
// reach the deterministic sim and explode there with an opaque error.
//
// Keep the check shallow on purpose: deep validation of every Building
// would duplicate the sim's own type system without catching anything
// the sim doesn't already reject. We just verify the top-level shape
// is what callers will reach for in the same line.

export function isBaseShape(v: unknown): v is Types.Base {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  if (typeof b.baseId !== 'string') return false;
  if (typeof b.ownerId !== 'string') return false;
  if (!Array.isArray(b.buildings)) return false;
  if (!b.gridSize || typeof b.gridSize !== 'object') return false;
  const g = b.gridSize as Record<string, unknown>;
  if (typeof g.w !== 'number' || typeof g.h !== 'number') return false;
  if (!b.resources || typeof b.resources !== 'object') return false;
  return true;
}

export function parseBase(raw: unknown): Types.Base | null {
  return isBaseShape(raw) ? raw : null;
}
