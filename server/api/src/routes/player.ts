import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Types } from '@hive/shared';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';
import {
  BUILDING_DEFAULTS,
  BUILDING_PLACEMENT_COSTS,
  MAX_BUILDINGS_PER_BASE,
  isPlayerPlaceable,
} from '../game/buildingCosts.js';
import {
  isUpgradeableUnit,
  upgradeCatalog,
  upgradeCost,
  MAX_UNIT_LEVEL,
} from '../game/upgradeCosts.js';
import type { Types as HiveTypes } from '@hive/shared';

// Resource columns are BIGINT, so DB values come back as strings. JS
// Number loses precision past 2^53 (~9 quadrillion); once a long-lived
// economy crosses that, the wire shape will have to switch to string
// or BigInt end-to-end.
//
// We wrap the conversion in this helper so the precision ceiling is
// surfaced in logs the moment a real economy approaches it, without
// silently truncating or crashing today's gameplay. Change the wire
// format in a focused PR the first time this warning fires.
function safeBigintToNumber(value: string, column: string, logger?: { warn: (obj: object, msg: string) => void }): number {
  const n = Number(value);
  if (n > Number.MAX_SAFE_INTEGER) {
    logger?.warn({ value, column }, 'resource value exceeds MAX_SAFE_INTEGER — wire format needs upgrade');
  }
  return n;
}

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
  unit_levels: Record<string, number>;
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
          sugar: safeBigintToNumber(newSugar.toString(), 'sugar', app.log),
          leafBits: safeBigintToNumber(newLeaf.toString(), 'leaf_bits', app.log),
          aphidMilk: safeBigintToNumber(newMilk.toString(), 'aphid_milk', app.log),
          unitLevels: player.unit_levels ?? {},
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

  // Recent raids involving the player (attacker OR defender). Used by
  // HomeScene to show a revenge button / recent activity feed.
  app.get('/player/raids', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const limit = Math.max(1, Math.min(50, Number((req.query as { limit?: string } | null)?.limit) || 20));

    const res = await pool.query<{
      id: string;
      attacker_id: string;
      defender_id: string | null;
      attacker_name: string | null;
      defender_name: string | null;
      stars: number;
      sugar_looted: string;
      leaf_looted: string;
      attacker_trophies_delta: number;
      defender_trophies_delta: number;
      created_at: Date;
    }>(
      `SELECT r.id, r.attacker_id, r.defender_id,
              ap.display_name AS attacker_name,
              dp.display_name AS defender_name,
              r.stars, r.sugar_looted, r.leaf_looted,
              r.attacker_trophies_delta, r.defender_trophies_delta,
              r.created_at
         FROM raids r
         LEFT JOIN players ap ON ap.id = r.attacker_id
         LEFT JOIN players dp ON dp.id = r.defender_id
        WHERE r.attacker_id = $1 OR r.defender_id = $1
        ORDER BY r.created_at DESC
        LIMIT $2`,
      [playerId, limit],
    );

    return {
      raids: res.rows.map((r) => ({
        id: r.id,
        role: r.attacker_id === playerId ? ('attacker' as const) : ('defender' as const),
        opponentId: r.attacker_id === playerId ? r.defender_id : r.attacker_id,
        opponentName:
          (r.attacker_id === playerId ? r.defender_name : r.attacker_name) ??
          (r.defender_id === null ? 'Beetle Outpost (bot)' : 'Unknown'),
        stars: r.stars,
        sugarLooted: safeBigintToNumber(r.sugar_looted, 'sugar_looted', app.log),
        leafLooted: safeBigintToNumber(r.leaf_looted, 'leaf_looted', app.log),
        trophyDelta:
          r.attacker_id === playerId
            ? r.attacker_trophies_delta
            : r.defender_trophies_delta,
        createdAt: r.created_at.toISOString(),
      })),
    };
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
      base.buildings.length > MAX_BUILDINGS_PER_BASE ||
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

  // POST /api/player/building — place a new building.
  // Body: { kind, anchor: { x, y, layer } }
  // Server owns the id, footprint, HP, cost validation, resource debit.
  // All in a single transaction so a crash mid-flight never leaves a
  // half-placed building or silently-debited player.
  interface PlaceBuildingBody {
    kind: Types.BuildingKind;
    anchor: { x: number; y: number; layer: Types.Layer };
  }
  app.post<{ Body: PlaceBuildingBody }>('/player/building', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const body = req.body;
    if (
      !body || !body.kind || !body.anchor ||
      typeof body.anchor.x !== 'number' ||
      typeof body.anchor.y !== 'number' ||
      (body.anchor.layer !== 0 && body.anchor.layer !== 1)
    ) {
      reply.code(400);
      return { error: 'kind + anchor{x,y,layer} required' };
    }
    if (!isPlayerPlaceable(body.kind)) {
      reply.code(400);
      return { error: `${body.kind} is not player-placeable` };
    }
    const defaults = BUILDING_DEFAULTS[body.kind];
    const cost = BUILDING_PLACEMENT_COSTS[body.kind];
    if (!defaults || !cost) {
      reply.code(400);
      return { error: 'unknown building kind' };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const baseRes = await client.query<{ snapshot: Types.Base }>(
        'SELECT snapshot FROM bases WHERE player_id = $1 FOR UPDATE',
        [playerId],
      );
      if (baseRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'base not found' };
      }
      const base = baseRes.rows[0]!.snapshot;

      // Bounds check inside the base grid.
      if (
        body.anchor.x < 0 ||
        body.anchor.y < 0 ||
        body.anchor.x + defaults.w > base.gridSize.w ||
        body.anchor.y + defaults.h > base.gridSize.h
      ) {
        await client.query('ROLLBACK');
        reply.code(400);
        return { error: 'building extends outside grid' };
      }

      // Collision check. The candidate building occupies every layer in
      // its `spans` (or just its anchor layer for single-layer buildings
      // like the current player-placeable set); an existing building
      // blocks every layer in ITS spans. Walk every candidate layer and
      // bail on the first overlap so forward-compatibility with future
      // multi-layer placeable kinds is built in.
      const candidateLayers = new Set<Types.Layer>(
        defaults.spans ?? [body.anchor.layer],
      );
      for (const existing of base.buildings) {
        const existingLayers = new Set<Types.Layer>(
          existing.spans ?? [existing.anchor.layer],
        );
        // Quick reject if the layer sets don't intersect.
        let layersIntersect = false;
        for (const layer of candidateLayers) {
          if (existingLayers.has(layer)) {
            layersIntersect = true;
            break;
          }
        }
        if (!layersIntersect) continue;
        const ex = existing.anchor.x;
        const ey = existing.anchor.y;
        const ew = existing.footprint.w;
        const eh = existing.footprint.h;
        const overlaps =
          body.anchor.x < ex + ew &&
          body.anchor.x + defaults.w > ex &&
          body.anchor.y < ey + eh &&
          body.anchor.y + defaults.h > ey;
        if (overlaps) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: 'tile occupied' };
        }
      }
      if (base.buildings.length >= MAX_BUILDINGS_PER_BASE) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: `base at building cap (${MAX_BUILDINGS_PER_BASE})` };
      }

      // Debit resources first (fails atomically if insufficient).
      const debitRes = await client.query<{
        trophies: number;
        sugar: string;
        leaf_bits: string;
        aphid_milk: string;
      }>(
        `UPDATE players
            SET sugar      = sugar - $2,
                leaf_bits  = leaf_bits - $3,
                aphid_milk = aphid_milk - $4,
                last_seen_at = NOW()
          WHERE id = $1
            AND sugar >= $2
            AND leaf_bits >= $3
            AND aphid_milk >= $4
      RETURNING trophies, sugar, leaf_bits, aphid_milk`,
        [playerId, cost.sugar, cost.leafBits, cost.aphidMilk],
      );
      if (debitRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(402); // Payment Required
        return { error: 'insufficient resources', cost };
      }

      // Build the Types.Building row, mutate the snapshot, persist.
      const id = `b-${randomBytes(6).toString('hex')}`;
      const newBuilding: Types.Building = {
        id,
        kind: body.kind,
        anchor: body.anchor,
        footprint: { w: defaults.w, h: defaults.h },
        level: 1,
        hp: defaults.hp,
        hpMax: defaults.hp,
        ...(defaults.spans ? { spans: defaults.spans } : {}),
      };
      const updatedBase: Types.Base = {
        ...base,
        buildings: [...base.buildings, newBuilding],
        version: (base.version ?? 0) + 1,
      };
      await client.query(
        `UPDATE bases
            SET snapshot = $2::jsonb,
                version = version + 1,
                updated_at = NOW()
          WHERE player_id = $1`,
        [playerId, JSON.stringify(updatedBase)],
      );

      await client.query('COMMIT');
      const debited = debitRes.rows[0]!;
      return {
        ok: true,
        building: newBuilding,
        base: updatedBase,
        player: {
          trophies: debited.trophies,
          sugar: safeBigintToNumber(debited.sugar, 'sugar', app.log),
          leafBits: safeBigintToNumber(debited.leaf_bits, 'leaf_bits', app.log),
          aphidMilk: safeBigintToNumber(debited.aphid_milk, 'aphid_milk', app.log),
        },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'player/building POST failed');
      reply.code(500);
      return { error: 'placement failed' };
    } finally {
      client.release();
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/player/building/:id',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      // sanity check id shape — server-generated ids are b-<12 hex>
      const id = req.params.id;
      if (!/^[a-z0-9][a-z0-9-_]{1,63}$/i.test(id)) {
        reply.code(400);
        return { error: 'invalid building id' };
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const baseRes = await client.query<{ snapshot: Types.Base }>(
          'SELECT snapshot FROM bases WHERE player_id = $1 FOR UPDATE',
          [playerId],
        );
        if (baseRes.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'base not found' };
        }
        const base = baseRes.rows[0]!.snapshot;
        const before = base.buildings.length;
        // Protect the QueenChamber — deleting it would brick the base.
        const target = base.buildings.find((b) => b.id === id);
        if (!target) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'building not found' };
        }
        if (target.kind === 'QueenChamber') {
          await client.query('ROLLBACK');
          reply.code(400);
          return { error: 'cannot delete the Queen Chamber' };
        }
        const updated: Types.Base = {
          ...base,
          buildings: base.buildings.filter((b) => b.id !== id),
          version: (base.version ?? 0) + 1,
        };
        await client.query(
          `UPDATE bases
              SET snapshot = $2::jsonb,
                  version = version + 1,
                  updated_at = NOW()
            WHERE player_id = $1`,
          [playerId, JSON.stringify(updated)],
        );
        await client.query('COMMIT');
        return { ok: true, base: updated, removed: before - updated.buildings.length };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'player/building DELETE failed');
        reply.code(500);
        return { error: 'delete failed' };
      } finally {
        client.release();
      }
    },
  );

  // Costs + catalog for the client picker. Keeps the source of truth
  // on the server — clients never compute cost locally.
  app.get('/player/building/catalog', async () => {
    return {
      placeable: Object.fromEntries(
        Object.entries(BUILDING_PLACEMENT_COSTS).filter(([k]) =>
          isPlayerPlaceable(k as Types.BuildingKind),
        ),
      ),
    };
  });

  // Unit upgrade catalog + current levels. Clients use this to render
  // the upgrade screen; cost scaling is always re-computed server-side
  // before a debit.
  app.get('/player/upgrades', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const res = await pool.query<{
      unit_levels: Record<string, number>;
      sugar: string;
      leaf_bits: string;
    }>(
      'SELECT unit_levels, sugar, leaf_bits FROM players WHERE id = $1',
      [playerId],
    );
    if (res.rows.length === 0) {
      reply.code(404);
      return { error: 'player not found' };
    }
    const row = res.rows[0]!;
    const levels = row.unit_levels ?? {};
    const catalog = upgradeCatalog();
    // For each kind, compute the "next level cost" so the client can
    // render affordability without re-deriving the ramp.
    const entries = Object.entries(catalog).map(([kind, base]) => {
      const level = levels[kind] ?? 1;
      const next = upgradeCost(kind as Types.UnitKind, level);
      return {
        kind,
        level,
        maxLevel: base.maxLevel,
        nextCost: next,
      };
    });
    return {
      units: entries,
      resources: {
        sugar: Number(row.sugar),
        leafBits: Number(row.leaf_bits),
      },
    };
  });

  interface UpgradeUnitBody {
    kind: Types.UnitKind;
  }
  app.post<{ Body: UpgradeUnitBody }>(
    '/player/upgrade-unit',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const body = req.body;
      if (!body || typeof body.kind !== 'string') {
        reply.code(400);
        return { error: 'kind required' };
      }
      if (!isUpgradeableUnit(body.kind as HiveTypes.UnitKind)) {
        reply.code(400);
        return { error: `${body.kind} is not upgradeable` };
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const lock = await client.query<{
          unit_levels: Record<string, number>;
          sugar: string;
          leaf_bits: string;
        }>(
          'SELECT unit_levels, sugar, leaf_bits FROM players WHERE id = $1 FOR UPDATE',
          [playerId],
        );
        if (lock.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'player not found' };
        }
        const currentLevels = lock.rows[0]!.unit_levels ?? {};
        const currentLevel = currentLevels[body.kind] ?? 1;
        if (currentLevel >= MAX_UNIT_LEVEL) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: `already at max level (${MAX_UNIT_LEVEL})` };
        }
        const cost = upgradeCost(body.kind as HiveTypes.UnitKind, currentLevel);
        if (!cost) {
          await client.query('ROLLBACK');
          reply.code(400);
          return { error: 'cannot compute cost' };
        }

        // Atomic resource debit + level increment. One round-trip avoids
        // a TOCTOU gap between the SELECT FOR UPDATE above and the
        // update we're about to do. Returns the new resource totals.
        const upd = await client.query<{
          sugar: string;
          leaf_bits: string;
          unit_levels: Record<string, number>;
        }>(
          `UPDATE players
              SET sugar = sugar - $2,
                  leaf_bits = leaf_bits - $3,
                  unit_levels = jsonb_set(
                    COALESCE(unit_levels, '{}'::jsonb),
                    ARRAY[$4::text],
                    to_jsonb($5::int),
                    true
                  )
            WHERE id = $1
              AND sugar >= $2
              AND leaf_bits >= $3
          RETURNING sugar, leaf_bits, unit_levels`,
          [playerId, cost.sugar, cost.leafBits, body.kind, currentLevel + 1],
        );
        if (upd.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(402);
          return { error: 'insufficient resources', cost };
        }
        await client.query('COMMIT');
        const r = upd.rows[0]!;
        return {
          ok: true,
          kind: body.kind,
          newLevel: currentLevel + 1,
          unitLevels: r.unit_levels,
          resources: {
            sugar: Number(r.sugar),
            leafBits: Number(r.leaf_bits),
          },
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'upgrade-unit failed');
        reply.code(500);
        return { error: 'upgrade failed' };
      } finally {
        client.release();
      }
    },
  );
}
