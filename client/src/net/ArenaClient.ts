import { Client, Room } from 'colyseus.js';
import type { Types } from '@hive/shared';

// Thin typed wrapper over colyseus.js for the live-arena "picnic" room.
//
// Netcode contract (mirrors server/arena/src/rooms/PicnicRoom.ts):
//   out  drawPath    { polyline, unitGroupId, intendedTick }
//   out  ready       (no body)
//   in   tickConfirm { tick, confirmedInputs, stateHash }
//
// The server runs the authoritative sim; clients run their own local
// copy of @hive/shared's step() against the same seed+inputs and
// reconcile on hash mismatch.
//
// Default URL: wss://<origin>/arena — works if the arena is deployed
// behind the same domain. Local dev and split-host deploys override
// via VITE_ARENA_URL.

const DEFAULT_URL = (() => {
  if (typeof import.meta.env.VITE_ARENA_URL === 'string' && import.meta.env.VITE_ARENA_URL) {
    return import.meta.env.VITE_ARENA_URL;
  }
  if (typeof window !== 'undefined') {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${window.location.host}/arena`;
  }
  return 'ws://localhost:2567';
})();

export interface ArenaTickEvent {
  tick: number;
  confirmedInputs: Types.SimInput[];
  stateHash: string;
}

export type ArenaEvent =
  | { kind: 'connecting' }
  | { kind: 'joined'; slot: 0 | 1 }
  | { kind: 'both-ready' }
  | { kind: 'tick'; data: ArenaTickEvent }
  | { kind: 'opponent-left' }
  | { kind: 'error'; error: Error }
  | { kind: 'closed' };

export class ArenaClient {
  private client: Client | null = null;
  private room: Room | null = null;
  private listener: ((e: ArenaEvent) => void) | null = null;
  readonly url: string;

  constructor(url: string = DEFAULT_URL) {
    this.url = url;
  }

  on(listener: (e: ArenaEvent) => void): void {
    this.listener = listener;
  }

  async joinOrCreate(playerId: string): Promise<void> {
    this.listener?.({ kind: 'connecting' });
    try {
      this.client = new Client(this.url);
      this.room = await this.client.joinOrCreate('picnic', { playerId });
    } catch (err) {
      this.listener?.({ kind: 'error', error: err as Error });
      return;
    }
    // Slot is assigned by the server based on join order. We read it
    // from the first state change; until then we optimistically assume
    // slot 0 (first player in).
    // NOTE: PicnicRoom uses Phaser @schema; we only care about the
    // onMessage channel in the client. Slot tracking here is a
    // placeholder — a richer server would expose `slot` explicitly.
    this.listener?.({ kind: 'joined', slot: 0 });

    this.room.onMessage('tickConfirm', (data: ArenaTickEvent) => {
      this.listener?.({ kind: 'tick', data });
    });
    this.room.onLeave(() => {
      this.listener?.({ kind: 'closed' });
    });
    this.room.onError((_code, msg) => {
      this.listener?.({ kind: 'error', error: new Error(msg ?? 'arena error') });
    });

    // Ready up immediately. The server waits until both slots send
    // ready before starting the tick loop.
    this.room.send('ready');
  }

  sendDrawPath(args: {
    polyline: Types.PheromonePoint[];
    unitKind: Types.UnitKind;
    count: number;
    spawnLayer: Types.Layer;
    intendedTick: number;
  }): void {
    if (!this.room) return;
    this.room.send('drawPath', {
      path: {
        pathId: 0,
        spawnLayer: args.spawnLayer,
        unitKind: args.unitKind,
        count: args.count,
        points: args.polyline,
      } satisfies Types.PheromonePath,
      intendedTick: args.intendedTick,
    });
  }

  async leave(): Promise<void> {
    if (!this.room) return;
    try {
      await this.room.leave();
    } catch {
      // ignore — the room may already be closed
    }
    this.room = null;
    this.client = null;
  }
}
