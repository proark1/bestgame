import type { FastifyInstance } from 'fastify';
import { Sim } from '@hive/shared';
import type { Types } from '@hive/shared';
import { validateReplay } from '../replay/validator.js';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';

// Raid submission. The client sends the matchToken it received from
// /api/match plus its input timeline and the computed result hash.
// The server looks up the AUTHORITATIVE (defenderId, seed, baseSnapshot)
// tuple by token and runs the sim against those — never against a
// client-supplied base. This closes the spoofed-base-snapshot attack.

interface RaidSubmissionBody {
  matchToken: string;
  inputs: Types.SimInput[];
  clientResultHash: string;
}

// Trophy table by star count. Keep attacker gains ≤ defender losses so
// the ladder isn't inflationary.
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
    if (
      !body ||
      typeof body.matchToken !== 'string' ||
      body.matchToken.length < 16 ||
      !Array.isArray(body.inputs) ||
      typeof body.clientResultHash !== 'string'
    ) {
      reply.code(400);
      return { error: 'bad request' };
    }

    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Pop the pending match (atomic consumption — a token is valid
      // exactly once so a replay can't be re-submitted to farm loot
      // twice).
      const popped = await client.query<{
        defender_id: string | null;
        seed: string;
        base_snapshot: Types.Base;
      }>(
        `DELETE FROM pending_matches
          WHERE token = $1 AND attacker_id = $2 AND expires_at > NOW()
          RETURNING defender_id, seed, base_snapshot`,
        [body.matchToken, attackerId],
      );
      if (popped.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'unknown, expired, or already-used match token' };
      }
      const row = popped.rows[0]!;
      const defenderId = row.defender_id;
      const seed = Number(row.seed);
      const baseSnapshot = row.base_snapshot;

      // Authoritative replay validation runs against the server-owned
      // snapshot. A malicious client can't spoof defenses away because
      // it never gets to submit the snapshot in the first place.
      const { ok, serverHash, result } = validateReplay({
        seed,
        baseSnapshot,
        inputs: body.inputs,
        clientHash: body.clientResultHash,
      });
      if (!ok) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: 'replay hash mismatch', serverHash };
      }

      const stars = result.stars;
      const trophyDelta = TROPHY_TABLE[stars];
      const sugarLooted = Math.max(0, result.sugarLooted);
      const leafLooted = Math.max(0, result.leafBitsLooted);

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

      if (defenderId) {
        await client.query(
          `UPDATE players
              SET trophies  = GREATEST(0, trophies + $2),
                  sugar     = GREATEST(0, sugar - $3),
                  leaf_bits = GREATEST(0, leaf_bits - $4)
            WHERE id = $1`,
          [defenderId, trophyDelta.def, sugarLooted, leafLooted],
        );
      }

      // Stringify array-typed JSONB params (inputs, result). pg-node
      // auto-JSONs objects but serializes arrays as Postgres arrays,
      // which the ::jsonb cast rejects.
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
          defenderId,
          seed,
          JSON.stringify(baseSnapshot),
          JSON.stringify(body.inputs),
          JSON.stringify(result),
          stars,
          sugarLooted,
          leafLooted,
          trophyDelta.att,
          defenderId ? trophyDelta.def : 0,
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

  void Sim;
}
