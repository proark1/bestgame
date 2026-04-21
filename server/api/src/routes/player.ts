import type { FastifyInstance } from 'fastify';
import type { Types } from '@hive/shared';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';

// /api/player/me — returns the authenticated player + their base, with
// offline income trickled forward based on elapsed time since
// last_seen_at. The client uses this as the source of truth on boot.
//
// /api/player/base — PUT the full base snapshot. Used by the home scene
// (place/upgrade flow — even without it, the snapshot is updated any
// time the client makes a local change and syncs.)

// Offline income per producer building per second. Kept in sync with
// client/src/scenes/HomeScene.ts's INCOME_PER_SECOND. Small enough that
// raiding always matters more than AFK idling.
const INCOME_PER_SECOND: Partial<
  Record<Types.BuildingKind, { sugar: number; leafBits: number; aphidMilk: number }>
> = {
  DewCollector: { sugar: 8, leafBits: 0, aphidMilk: 0 },
  LarvaNursery: { sugar: 0, leafBits: 3, aphidMilk: 0 },
  SugarVault: { sugar: 2, leafBits: 0, aphidMilk: 0 },
};
// Cap offline earnings at 8h so leaving the game tab open for weeks
// doesn't flood the economy.
const MAX_OFFLINE_SECONDS = 60 * 60 * 8;

interface PlayerRow {
  id: string;
  display_name: string;
  faction: string;
  trophies: number;
  sugar: string; // bigint comes back as string from pg
  leaf_bits: string;
  aphid_milk: string;
  last_seen_at: Date;
  created_at: Date;
}

interface BaseRow {
  player_id: string;
  faction: string;
  snapshot: Types.Base;
  updated_at: Date;
}

function incomePerSecond(base: Types.Base): { sugar: number; leafBits: number; aphidMilk: number } {
  let sugar = 0, leafBits = 0, aphidMilk = 0;
  for (const b of base.buildings) {
    if (b.hp <= 0) continue;
    const inc = INCOME_PER_SECOND[b.kind];
    if (!inc) continue;
    const mult = Math.max(1, b.level); // level scales income linearly for MVP
    sugar += inc.sugar * mult;
    leafBits += inc.leafBits * mult;
    aphidMilk += inc.aphidMilk * mult;
  }
  return { sugar, leafBits, aphidMilk };
}

export function registerPlayer(app: FastifyInstance): void {
  app.get('/player/me', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pRes = await client.query<PlayerRow>(
        'SELECT * FROM players WHERE id = $1',
        [playerId],
      );
      if (pRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'player not found' };
      }
      const bRes = await client.query<BaseRow>(
        'SELECT * FROM bases WHERE player_id = $1',
        [playerId],
      );
      if (bRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(500);
        return { error: 'player has no base (corrupt state)' };
      }
      const player = pRes.rows[0]!;
      const base = bRes.rows[0]!;

      // Offline trickle. Compute from last_seen_at → now, cap, add.
      const lastSeenMs = player.last_seen_at.getTime();
      const elapsedSec = Math.max(
        0,
        Math.min(
          MAX_OFFLINE_SECONDS,
          Math.floor((Date.now() - lastSeenMs) / 1000),
        ),
      );
      const tick = incomePerSecond(base.snapshot);
      const gainedSugar = tick.sugar * elapsedSec;
      const gainedLeaf = tick.leafBits * elapsedSec;
      const gainedMilk = tick.aphidMilk * elapsedSec;

      const newSugar = BigInt(player.sugar) + BigInt(gainedSugar);
      const newLeaf = BigInt(player.leaf_bits) + BigInt(gainedLeaf);
      const newMilk = BigInt(player.aphid_milk) + BigInt(gainedMilk);

      if (gainedSugar + gainedLeaf + gainedMilk > 0 || elapsedSec > 0) {
        await client.query(
          `UPDATE players
             SET sugar = $2,
                 leaf_bits = $3,
                 aphid_milk = $4,
                 last_seen_at = NOW()
           WHERE id = $1`,
          [playerId, newSugar.toString(), newLeaf.toString(), newMilk.toString()],
        );
      }
      await client.query('COMMIT');

      return {
        player: {
          id: player.id,
          displayName: player.display_name,
          faction: player.faction,
          trophies: player.trophies,
          sugar: Number(newSugar),
          leafBits: Number(newLeaf),
          aphidMilk: Number(newMilk),
          createdAt: player.created_at.toISOString(),
        },
        base: base.snapshot,
        offlineTrickle: {
          secondsElapsed: elapsedSec,
          sugarGained: gainedSugar,
          leafGained: gainedLeaf,
          milkGained: gainedMilk,
        },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'player/me failed');
      reply.code(500);
      return { error: 'lookup failed' };
    } finally {
      client.release();
    }
  });

  interface PutBaseBody {
    base: Types.Base;
  }
  app.put<{ Body: PutBaseBody }>('/player/base', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const body = req.body;
    if (!body || !body.base || typeof body.base !== 'object') {
      reply.code(400);
      return { error: 'base payload required' };
    }
    // Cheap sanity checks. Full structural validation lives in @hive/shared
    // types (compile-time) — at runtime we guard against obvious tampering.
    const base = body.base;
    if (
      !Array.isArray(base.buildings) ||
      base.buildings.length > 60 ||
      !base.gridSize ||
      typeof base.gridSize.w !== 'number' ||
      typeof base.gridSize.h !== 'number' ||
      base.gridSize.w > 24 ||
      base.gridSize.h > 20
    ) {
      reply.code(400);
      return { error: 'invalid base shape' };
    }

    const res = await pool.query(
      `UPDATE bases
         SET snapshot = $2,
             faction = $3,
             version = version + 1,
             updated_at = NOW()
       WHERE player_id = $1`,
      [playerId, base, base.faction],
    );
    if (res.rowCount === 0) {
      reply.code(404);
      return { error: 'base not found for player' };
    }
    return { ok: true, version: 'incremented' };
  });
}
