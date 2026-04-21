import { Room, Client } from 'colyseus';
import { Schema, type } from '@colyseus/schema';
import { Sim, Types } from '@hive/shared';

// PicnicRoom — the live 2-minute arena.
//
// Netcode: server-authoritative with input-delay lockstep. The @schema
// transport here is used ONLY for bookkeeping visible to spectators
// (tick, both-players-ready). The actual sim state lives in plain TS
// structs — it's hashed every 4 ticks and broadcast for reconciliation.
//
// Map source: we ask the API to redeem the client-supplied arenaToken
// (minted by POST /api/arena/reserve) and use the persisted
// host_snapshot as the map. That makes every live match play against
// a real, trophy-banded opponent's base — no more neutral placeholder.
// If token redemption fails (dev, no API reachable, expired token) we
// fall back to NEUTRAL_MAP so local dev still runs.

class PicnicState extends Schema {
  @type('number') tick = 0;
  @type('number') readyCount = 0;
  @type('string') outcome = 'ongoing';
  @type('string') stateHash = '';
  @type('string') hostPlayerId = '';
  @type('string') challengerPlayerId = '';
  @type('number') mapSeed = 0;
}

const TICK_HZ = 30;
const MATCH_SECONDS = 120;
const MAX_TICKS = TICK_HZ * MATCH_SECONDS;
const HASH_EVERY = 4;

// Fallback map used when no arenaToken is supplied or lookup fails.
// A single QueenChamber lets the sim run without crashing while we're
// in dev or a test harness.
const NEUTRAL_MAP: Types.Base = {
  baseId: 'picnic-neutral',
  ownerId: 'server',
  faction: 'Ants',
  gridSize: { w: 16, h: 12 },
  resources: { sugar: 0, leafBits: 0, aphidMilk: 0 },
  trophies: 0,
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
  ],
};

interface ArenaLookupResponse {
  hostPlayerId: string;
  challengerPlayerId: string;
  seed: number;
  hostSnapshot: Types.Base;
  challengerSnapshot: Types.Base;
}

// Redeem the arenaToken minted by /api/arena/reserve. Returns null on
// any non-2xx so the room can fall back to NEUTRAL_MAP in dev. The API
// URL is configurable via HIVE_API_URL so dev (localhost:8787) and
// deploy (same-host) both work.
async function redeemArenaToken(
  arenaToken: string,
): Promise<ArenaLookupResponse | null> {
  const base = process.env.HIVE_API_URL ?? 'http://127.0.0.1:8787';
  const secret = process.env.ARENA_SHARED_SECRET;
  try {
    const res = await fetch(`${base}/api/arena/_lookup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { 'x-arena-secret': secret } : {}),
      },
      body: JSON.stringify({ arenaToken }),
    });
    if (!res.ok) return null;
    return (await res.json()) as ArenaLookupResponse;
  } catch {
    return null;
  }
}

async function reportArenaResult(
  arenaToken: string,
  payload: {
    outcome: string;
    winnerSlot: number | null;
    ticks: number;
    finalStateHash: string;
  },
): Promise<void> {
  const base = process.env.HIVE_API_URL ?? 'http://127.0.0.1:8787';
  const secret = process.env.ARENA_SHARED_SECRET;
  try {
    await fetch(`${base}/api/arena/_result`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { 'x-arena-secret': secret } : {}),
      },
      body: JSON.stringify({ arenaToken, ...payload }),
    });
  } catch {
    // Best-effort: a missing result record is less bad than crashing
    // the room on a failed POST. The match still finishes client-side.
  }
}

interface PicnicCreateOptions {
  arenaToken?: string;
}

export class PicnicRoom extends Room<PicnicState> {
  override maxClients = 2;

  private sim!: Sim.SimState;
  private cfg!: Sim.SimConfig;
  private pendingInputs: Types.SimInput[] = [];
  // exactOptionalPropertyTypes: explicitly union undefined so reassignment is legal.
  private tickTimer: ReturnType<typeof setInterval> | undefined = undefined;
  private started = false;
  private arenaToken: string | undefined = undefined;
  private mapSource: 'db' | 'fallback' = 'fallback';

  override async onCreate(options: PicnicCreateOptions = {}): Promise<void> {
    this.setState(new PicnicState());

    let snapshot: Types.Base = NEUTRAL_MAP;
    let seed: number = Math.floor(Math.random() * 0xffffffff) | 0;

    if (options.arenaToken) {
      const lookup = await redeemArenaToken(options.arenaToken);
      if (lookup) {
        // Current sim is single-snapshot (no per-building ownership), so
        // we run the match on the host's base and both players deploy
        // against it. Symmetric A-vs-A-vs-B-vs-B is a sim refactor
        // tracked in docs/GAME_DESIGN.md — this is the interim shape
        // that already uses real, persisted bases.
        snapshot = lookup.hostSnapshot;
        seed = lookup.seed;
        this.arenaToken = options.arenaToken;
        this.mapSource = 'db';
        this.state.hostPlayerId = lookup.hostPlayerId;
        this.state.challengerPlayerId = lookup.challengerPlayerId;
        this.state.mapSeed = seed;
      }
    }

    this.cfg = {
      tickRate: 30,
      maxTicks: MAX_TICKS,
      initialSnapshot: snapshot,
      seed,
    };
    this.sim = Sim.createInitialState(this.cfg);

    this.onMessage('drawPath', (client, msg: { path: Types.PheromonePath; intendedTick: number }) => {
      // Input-delay netcode: client tells us which tick to apply this on.
      // We clamp to a minimum forward delay so opponents have time to see
      // each other's inputs before they resolve.
      const ownerSlot = this.slotForClient(client);
      if (ownerSlot === null) return;
      const applyAt = Math.max(msg.intendedTick, this.sim.tick + 3);
      this.pendingInputs.push({
        type: 'deployPath',
        tick: applyAt,
        ownerSlot,
        path: msg.path,
      });
    });

    this.onMessage('ready', () => {
      this.state.readyCount++;
      if (this.state.readyCount >= 2 && !this.started) {
        this.started = true;
        this.tickTimer = setInterval(() => this.tick(), 1000 / TICK_HZ);
      }
    });
  }

  override onJoin(client: Client): void {
    // Slot assignment by join order. Spectators rejected via maxClients=2.
    client.userData = { slot: this.clients.length - 1 };
  }

  override onLeave(): void {
    // If a player disconnects mid-match, abort the room cleanly.
    this.stopTicking();
    this.state.outcome = 'aborted';
    void this.reportResultIfDb('aborted', null);
  }

  override onDispose(): void {
    this.stopTicking();
  }

  private reportedResult = false;
  private async reportResultIfDb(
    outcome: string,
    winnerSlot: number | null,
  ): Promise<void> {
    if (this.reportedResult) return;
    this.reportedResult = true;
    if (this.mapSource !== 'db' || !this.arenaToken) return;
    await reportArenaResult(this.arenaToken, {
      outcome,
      winnerSlot,
      ticks: this.sim.tick,
      finalStateHash: Sim.hashToHex(Sim.hashSimState(this.sim)),
    });
  }

  private slotForClient(client: Client): 0 | 1 | null {
    const slot = (client.userData as { slot?: number } | undefined)?.slot;
    if (slot === 0 || slot === 1) return slot;
    return null;
  }

  private tick(): void {
    if (this.sim.outcome !== 'ongoing' || this.sim.tick >= MAX_TICKS) {
      this.stopTicking();
      const winnerSlot =
        this.sim.outcome === 'attackerWin'
          ? 0
          : this.sim.outcome === 'defenderWin'
            ? 1
            : null;
      void this.reportResultIfDb(this.sim.outcome, winnerSlot);
      return;
    }
    const nextTick = this.sim.tick + 1;
    const batch: Types.SimInput[] = [];
    // Dequeue inputs scheduled for this tick.
    const kept: Types.SimInput[] = [];
    for (const inp of this.pendingInputs) {
      if (inp.tick <= nextTick) batch.push(inp);
      else kept.push(inp);
    }
    this.pendingInputs = kept;
    Sim.step(this.sim, this.cfg, batch);
    this.state.tick = this.sim.tick;
    this.state.outcome = this.sim.outcome;

    if (this.sim.tick % HASH_EVERY === 0) {
      this.state.stateHash = Sim.hashToHex(Sim.hashSimState(this.sim));
      this.broadcast('tickConfirm', {
        tick: this.sim.tick,
        confirmedInputs: batch,
        stateHash: this.state.stateHash,
      });
    }
  }

  private stopTicking(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }
}
