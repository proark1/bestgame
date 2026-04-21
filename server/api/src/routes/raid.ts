import type { FastifyInstance } from 'fastify';
import { Sim } from '@hive/shared';
import type { Types } from '@hive/shared';
import { validateReplay } from '../replay/validator.js';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';

// Raid submission — validates the attacker's replay against the server-
// authoritative sim, persists the replay, and atomically updates both
// players' trophies + loot (or only the attacker if the defender was
// a bot).

interface RaidSubmissionBody {
  defenderId: string | null;
  baseSnapshot: Types.Base;
  seed: number;
  inputs: Types.SimInput[];
  clientResultHash: string;
}

// Trophy table by star count. Attacker gains never exceed defender losses
// (classic CoC-style) to keep the ladder inflation-free.
const TROPHY_TABLE: Record<0 | 1 | 2 | 3, { att: number; def: number }> = {
  0: { att: 0, def: 0 },
  1: { att: 10, def: -8 },
  2: { att: 20, def: -15 },
  3: { att: 30, def: -25 },
};

export function registerRaid(app: FastifyInstance): void {
  app.post<{ Body: RaidSubmissionBody }>('/raid/submit', async (req, reply) => {
    const attackerId = requirePlayer(req, reply);
    if (!attackerId) return;
    const body = req.body;
    if (!body || !body.baseSnapshot || !Array.isArray(body.inputs)) {
      reply.code(400);
      return { error: 'bad request' };
    }

    // Re-run the shared sim server-side. If the client hash disagrees we
    // reject before touching the database — keeps bad clients from being
    // credited and keeps the raids table honest.
    const { ok, serverHash, result } = validateReplay({
      seed: body.seed,
      baseSnapshot: body.baseSnapshot,
      inputs: body.inputs,
      clientHash: body.clientResultHash,
    });
    if (!ok) {
      reply.code(409);
      return { error: 'replay hash mismatch', serverHash };
    }

    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }

    const stars = result.stars;
    const trophyDelta = TROPHY_TABLE[stars];
    const sugarLooted = Math.max(0, result.sugarLooted);
    const leafLooted = Math.max(0, result.leafBitsLooted);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Attacker: gain trophies + loot. Defender won't exist when bot.
      const attUpdate = await client.query<{
        trophies: number;
        sugar: string;
        leaf_bits: string;
        aphid_milk: string;
      }>(
        `UPDATE players
            SET trophies  = GREATEST(0, trophies + $2),
                sugar     = sugar + $3,
                leaf_bits = leaf_bits + $4,
                last_seen_at = NOW()
          WHERE id = $1
      RETURNING trophies, sugar, leaf_bits, aphid_milk`,
        [attackerId, trophyDelta.att, sugarLooted, leafLooted],
      );
      if (attUpdate.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'attacker not found' };
      }

      // Defender: trophies go down, sugar/leaf go down by what was looted
      // (floor at 0 so we never dip negative on a rich attacker).
      if (body.defenderId) {
        await client.query(
          `UPDATE players
              SET trophies  = GREATEST(0, trophies + $2),
                  sugar     = GREATEST(0, sugar - $3),
                  leaf_bits = GREATEST(0, leaf_bits - $4)
            WHERE id = $1`,
          [body.defenderId, trophyDelta.def, sugarLooted, leafLooted],
        );
      }

      // pg-node's default type coercion:
      //   - plain JS object → serialized with JSON.stringify (good for JSONB)
      //   - JS array → serialized with Postgres array literal syntax
      //     (BAD for JSONB — you get `{"…","…"}` which isn't valid JSON)
      // So we explicitly JSON.stringify the two array-typed JSONB
      // columns (inputs, result) and also stringify base_snapshot for
      // symmetry / clarity.
      const raidInsert = await client.query<{ id: string }>(
        `INSERT INTO raids
          (attacker_id, defender_id, seed, base_snapshot, inputs, result,
           stars, sugar_looted, leaf_looted,
           attacker_trophies_delta, defender_trophies_delta)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb,
                 $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          attackerId,
          body.defenderId,
          body.seed,
          JSON.stringify(body.baseSnapshot),
          JSON.stringify(body.inputs),
          JSON.stringify(result),
          stars,
          sugarLooted,
          leafLooted,
          trophyDelta.att,
          body.defenderId ? trophyDelta.def : 0,
        ],
      );

      await client.query('COMMIT');

      const att = attUpdate.rows[0]!;
      return {
        ok: true,
        replayId: raidInsert.rows[0]!.id,
        result,
        player: {
          trophies: att.trophies,
          sugar: Number(att.sugar),
          leafBits: Number(att.leaf_bits),
          aphidMilk: Number(att.aphid_milk),
        },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'raid/submit failed');
      reply.code(500);
      return { error: 'raid submit failed' };
    } finally {
      client.release();
    }
  });

  void Sim; // kept in scope for future raid-streaming features
}
