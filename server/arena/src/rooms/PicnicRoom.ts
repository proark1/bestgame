import { Room, Client } from 'colyseus';
import { Schema, type } from '@colyseus/schema';
import { Sim, Types } from '@hive/shared';

// PicnicRoom — the live 2-minute symmetric arena.
//
// Netcode: server-authoritative with input-delay lockstep. The @schema
// transport here is used ONLY for bookkeeping visible to spectators
// (tick, both-players-ready). The actual sim state lives in plain TS
// structs — it's hashed every 4 ticks and broadcast for reconciliation.

class PicnicState extends Schema {
  @type('number') tick = 0;
  @type('number') readyCount = 0;
  @type('string') outcome = 'ongoing';
  @type('string') stateHash = '';
}

const TICK_HZ = 30;
const MATCH_SECONDS = 120;
const MAX_TICKS = TICK_HZ * MATCH_SECONDS;
const HASH_EVERY = 4;

// Symmetric neutral-map base used for both sides. Real content loads from
// shared fixtures in week 2; this is a weekly-1 placeholder.
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

export class PicnicRoom extends Room<PicnicState> {
  override maxClients = 2;

  private sim!: Sim.SimState;
  private cfg!: Sim.SimConfig;
  private pendingInputs: Types.SimInput[] = [];
  // exactOptionalPropertyTypes: explicitly union undefined so reassignment is legal.
  private tickTimer: ReturnType<typeof setInterval> | undefined = undefined;
  private started = false;

  override onCreate(): void {
    this.setState(new PicnicState());

    this.cfg = {
      tickRate: 30,
      maxTicks: MAX_TICKS,
      initialSnapshot: NEUTRAL_MAP,
      seed: Math.floor(Math.random() * 0xffffffff) | 0,
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
  }

  override onDispose(): void {
    this.stopTicking();
  }

  private slotForClient(client: Client): 0 | 1 | null {
    const slot = (client.userData as { slot?: number } | undefined)?.slot;
    if (slot === 0 || slot === 1) return slot;
    return null;
  }

  private tick(): void {
    if (this.sim.outcome !== 'ongoing' || this.sim.tick >= MAX_TICKS) {
      this.stopTicking();
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
