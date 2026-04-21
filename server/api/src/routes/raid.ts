import type { FastifyInstance } from 'fastify';
import { Sim } from '@hive/shared';
import type { Types } from '@hive/shared';
import { validateReplay } from '../replay/validator.js';

// Raid ingestion. Client plays an async raid, submits the complete input
// timeline + their computed final hash. Server re-runs the shared sim
// authoritatively and rejects if the hash doesn't match — that's the
// full anti-cheat story for async raids.

interface RaidSubmissionBody {
  attackerId: string;
  defenderId: string;
  baseSnapshot: Types.Base;
  seed: number;
  inputs: Types.SimInput[];
  clientResultHash: string;
}

export function registerRaid(app: FastifyInstance): void {
  app.post<{ Body: RaidSubmissionBody }>('/raid/submit', async (req, reply) => {
    const body = req.body;
    if (!body || !body.baseSnapshot || !Array.isArray(body.inputs)) {
      reply.code(400);
      return { error: 'bad request' };
    }
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
    // TODO(week 3): persist replay blob to Supabase Storage +
    // insert metadata row; award trophies to attacker/defender.
    return {
      ok: true,
      replayId: 'stub-' + Sim.hashToHex(Sim.hashSimState(Sim.createInitialState({
        tickRate: 30,
        maxTicks: 1,
        initialSnapshot: body.baseSnapshot,
        seed: body.seed,
      }))),
      result,
    };
  });
}
