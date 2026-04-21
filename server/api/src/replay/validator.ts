import { Sim } from '@hive/shared';
import type { Types } from '@hive/shared';

// Re-runs a submitted replay and compares the resulting SimState hash to
// what the client reported. If they disagree, the replay is rejected —
// the client either cheated, has stale sim code, or encountered an
// engine-specific determinism bug (which the CI determinism gate should
// catch before this ever fires in production).

export interface ReplayValidation {
  ok: boolean;
  serverHash: string;
  result: {
    outcome: 'attackerWin' | 'defenderWin' | 'draw' | 'ongoing';
    stars: 0 | 1 | 2 | 3;
    sugarLooted: number;
    leafBitsLooted: number;
    tickEnded: number;
  };
}

export function validateReplay(args: {
  seed: number;
  baseSnapshot: Types.Base;
  inputs: Types.SimInput[];
  clientHash: string;
  // Per-kind levels the attacker has unlocked via /api/player/upgrade-unit.
  // Pulled from the DB at submit time, not from the client — never trust
  // the attacker to self-report their own upgrade state.
  attackerUnitLevels?: Partial<Record<Types.UnitKind, number>>;
}): ReplayValidation {
  const cfg: Sim.SimConfig = {
    tickRate: 30,
    maxTicks: 2700, // 90 s
    initialSnapshot: args.baseSnapshot,
    seed: args.seed,
    ...(args.attackerUnitLevels ? { attackerUnitLevels: args.attackerUnitLevels } : {}),
  };
  const initial = Sim.createInitialState(cfg);
  const final = Sim.runReplay(initial, cfg, args.inputs);
  const serverHash = Sim.hashToHex(Sim.hashSimState(final));

  // Stars: 0 if no buildings destroyed, 1 for queen dead OR 50%+, 2 for
  // queen + 50%, 3 for everything. Real formula lives in shared sim later;
  // week-1 stub.
  let destroyed = 0;
  let total = 0;
  let queenDead = false;
  for (const b of final.buildings) {
    total++;
    if (b.hp <= 0) {
      destroyed++;
      if (b.kind === 'QueenChamber') queenDead = true;
    }
  }
  const pct = total === 0 ? 0 : destroyed / total;
  const stars: 0 | 1 | 2 | 3 =
    queenDead && pct >= 0.9 ? 3 : queenDead || pct >= 0.5 ? 2 : pct > 0 ? 1 : 0;

  return {
    ok: serverHash === args.clientHash,
    serverHash,
    result: {
      outcome: final.outcome,
      stars,
      sugarLooted: final.attackerSugarLooted,
      leafBitsLooted: final.attackerLeafBitsLooted,
      tickEnded: final.tick,
    },
  };
}
