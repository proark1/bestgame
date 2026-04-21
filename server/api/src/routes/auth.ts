import type { FastifyInstance } from 'fastify';
import { Sim } from '@hive/shared';
import type { Types } from '@hive/shared';
import { getPool } from '../db/pool.js';
import { mintSessionToken } from '../auth/playerAuth.js';

// Guest authentication: the client sends a stable deviceId (persisted
// in localStorage) and we upsert a players row on it. Returns an HMAC
// bearer token that identifies the player on every subsequent request.

interface GuestLoginBody {
  deviceId: string;
  displayName?: string;
  faction?: Types.Faction;
}

// Every new player starts with a sensible 6-building base so HomeScene
// has something to show before they upgrade/place. Built from the Sim
// defaults so the schema stays owned by @hive/shared.
function startingBase(playerId: string, faction: Types.Faction): Types.Base {
  return {
    baseId: playerId,
    ownerId: playerId,
    faction,
    gridSize: { w: 16, h: 12 },
    resources: { sugar: 1200, leafBits: 300, aphidMilk: 0 },
    trophies: 100,
    version: 1,
    tunnels: [],
    buildings: [
      {
        id: 'b-queen',
        kind: 'QueenChamber',
        anchor: { x: 7, y: 5, layer: 0 },
        footprint: { w: 2, h: 2 },
        spans: [0, 1],
        level: 1,
        hp: 800,
        hpMax: 800,
      },
      {
        id: 'b-turret-1',
        kind: 'MushroomTurret',
        anchor: { x: 3, y: 3, layer: 0 },
        footprint: { w: 1, h: 1 },
        level: 1,
        hp: 400,
        hpMax: 400,
      },
      {
        id: 'b-turret-2',
        kind: 'MushroomTurret',
        anchor: { x: 11, y: 3, layer: 0 },
        footprint: { w: 1, h: 1 },
        level: 1,
        hp: 400,
        hpMax: 400,
      },
      {
        id: 'b-dew-1',
        kind: 'DewCollector',
        anchor: { x: 2, y: 8, layer: 0 },
        footprint: { w: 1, h: 1 },
        level: 1,
        hp: 200,
        hpMax: 200,
      },
      {
        id: 'b-vault-1',
        kind: 'SugarVault',
        anchor: { x: 10, y: 8, layer: 1 },
        footprint: { w: 1, h: 1 },
        level: 1,
        hp: 350,
        hpMax: 350,
      },
      {
        id: 'b-nursery-1',
        kind: 'LarvaNursery',
        anchor: { x: 4, y: 7, layer: 1 },
        footprint: { w: 1, h: 1 },
        level: 1,
        hp: 300,
        hpMax: 300,
      },
    ],
  };
}

const ALLOWED_FACTIONS: ReadonlyArray<Types.Faction> = [
  'Ants',
  'Bees',
  'Beetles',
  'Spiders',
];
const DEVICE_ID_RE = /^[A-Za-z0-9-_]{4,64}$/;

export function registerAuth(app: FastifyInstance): void {
  app.post<{ Body: GuestLoginBody }>('/auth/guest', async (req, reply) => {
    const { deviceId, displayName, faction } = req.body ?? { deviceId: '' };
    if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
      reply.code(400);
      return { error: 'deviceId required (4-64 chars, [A-Za-z0-9-_])' };
    }
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }

    const safeName = (displayName ?? '').slice(0, 40) || 'Hive Wanderer';
    const safeFaction: Types.Faction = ALLOWED_FACTIONS.includes(
      faction as Types.Faction,
    )
      ? (faction as Types.Faction)
      : 'Ants';

    // Idempotent upsert: returns the existing row if deviceId is known,
    // otherwise creates a new row and its starting base.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM players WHERE device_id = $1',
        [deviceId],
      );
      let playerId: string;
      let isNew = false;
      if (existing.rows.length > 0) {
        playerId = existing.rows[0]!.id;
        await client.query(
          'UPDATE players SET last_seen_at = NOW() WHERE id = $1',
          [playerId],
        );
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO players (device_id, display_name, faction)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [deviceId, safeName, safeFaction],
        );
        playerId = inserted.rows[0]!.id;
        isNew = true;
      }
      if (isNew) {
        const base = startingBase(playerId, safeFaction);
        await client.query(
          `INSERT INTO bases (player_id, faction, snapshot)
           VALUES ($1, $2, $3)`,
          [playerId, safeFaction, base],
        );
      }
      await client.query('COMMIT');
      const token = mintSessionToken(playerId);
      return { playerId, token, isNew };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'auth/guest failed');
      reply.code(500);
      return { error: 'auth failed' };
    } finally {
      client.release();
    }
  });

  // Basic server-side helpful for Hive admin dashboards and integration
  // tests — returns the configured state without exposing the token itself.
  void Sim; // keep named import stable for future starting-base overrides
}
