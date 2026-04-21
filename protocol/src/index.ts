import type { Types } from '@hive/shared';

// Protocol — wire-format contracts between client/api/arena. Kept separate
// from @hive/shared so the wire cadence can evolve independently of the
// sim logic.

// Arena (Colyseus) messages.
export namespace Arena {
  export interface ClientReady {
    type: 'ready';
  }
  export interface ClientDrawPath {
    type: 'drawPath';
    path: Types.PheromonePath;
    intendedTick: number;
  }
  export interface ServerTickConfirm {
    type: 'tickConfirm';
    tick: number;
    confirmedInputs: Types.SimInput[];
    stateHash: string;
  }
}

// Async raid DTOs (HTTP).
export namespace Raid {
  export interface SubmitRequest {
    attackerId: string;
    defenderId: string;
    baseSnapshot: Types.Base;
    seed: number;
    inputs: Types.SimInput[];
    clientResultHash: string;
  }
  export interface SubmitResponse {
    ok: boolean;
    replayId: string;
    result: {
      outcome: string;
      stars: 0 | 1 | 2 | 3;
      sugarLooted: number;
      leafBitsLooted: number;
      tickEnded: number;
    };
  }
}

// Matchmaking.
export namespace Matchmaking {
  export interface Request {
    playerId: string;
    trophies: number;
  }
  export interface Response {
    defenderId: string;
    trophiesSought: number;
    seed: number;
    baseSnapshot: Types.Base;
  }
}
