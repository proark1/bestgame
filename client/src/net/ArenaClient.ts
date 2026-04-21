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
// via VITE_ARENA_URL. See normalizeArenaUrl() for the scheme coercion
// rules: http→ws, https→wss, bare hostname → wss://hostname.

// Accept ws://, wss://, http://, https:// or a bare hostname. Returns
// null if the input can't be coerced into something WebSocket-like.
// The main failure modes we've seen in production:
//   - user pastes `https://arena.example.com` (auto-coerce to wss://)
//   - user pastes `arena.example.com` (auto-prefix wss://)
//   - trailing slash / trailing whitespace (trim)
//   - env var is literal `"undefined"` string (Vite build quirk)
export function normalizeArenaUrl(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return null;
  let candidate = trimmed;
  // If the input has an explicit scheme, it must be one we know how
  // to coerce. Rejecting ftp://, file://, etc. up front keeps the
  // bare-hostname branch below from accidentally accepting them as
  // "wss://ftp://…".
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(candidate);
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    if (!['ws', 'wss', 'http', 'https'].includes(scheme)) return null;
  }
  // Coerce http(s) → ws(s). Colyseus handles ws/wss natively; feeding
  // it http(s) occasionally trips its internal URL parsing.
  if (candidate.startsWith('https://')) candidate = 'wss://' + candidate.slice(8);
  else if (candidate.startsWith('http://')) candidate = 'ws://' + candidate.slice(7);
  else if (!/^wss?:\/\//.test(candidate)) {
    // Bare hostname — assume TLS. Drops the need for users to
    // remember the `wss://` prefix in the env var.
    candidate = 'wss://' + candidate;
  }
  // Strip a trailing slash so Colyseus's matchmaker path is appended
  // cleanly (avoids accidental `//` in the request URL).
  if (candidate.endsWith('/')) candidate = candidate.slice(0, -1);
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

const DEFAULT_URL: string = (() => {
  const fromEnv = normalizeArenaUrl(
    typeof import.meta.env.VITE_ARENA_URL === 'string'
      ? import.meta.env.VITE_ARENA_URL
      : undefined,
  );
  if (fromEnv) return fromEnv;
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

  async joinOrCreate(playerId: string, arenaToken?: string): Promise<void> {
    this.listener?.({ kind: 'connecting' });
    // Pre-flight URL validation so a malformed VITE_ARENA_URL produces
    // a readable error — previously Colyseus's internal URL constructor
    // threw "Failed to construct 'URL': Invalid URL" with no context.
    if (!normalizeArenaUrl(this.url)) {
      this.listener?.({
        kind: 'error',
        error: new Error(
          `Arena URL is malformed: "${this.url}". Expected ws://… or wss://…`,
        ),
      });
      return;
    }
    try {
      this.client = new Client(this.url);
      // arenaToken lets the server bind client → slot deterministically:
      // host (lower UUID) always becomes slot 0, challenger is slot 1.
      // Without a token the server falls back to first-come-first-
      // serve on the neutral map (dev / solo-test path).
      const joinOpts: { playerId: string; arenaToken?: string } = { playerId };
      if (arenaToken) joinOpts.arenaToken = arenaToken;
      this.room = await this.client.joinOrCreate('picnic', joinOpts);
    } catch (err) {
      // Make the URL visible in the message so an admin debugging a
      // split-host deploy can see exactly what the build baked in.
      const e = err as Error;
      const msg = e.message?.includes(this.url)
        ? e.message
        : `${e.message ?? 'arena connect failed'} (url=${this.url})`;
      this.listener?.({ kind: 'error', error: new Error(msg) });
      return;
    }
    // Slot is assigned by the server based on identity (when an
    // arenaToken is supplied) or join order (neutral-map fallback).
    // Client-side we don't yet read the assigned slot back — the
    // server-authoritative sim hashes every 4 ticks so a mismatch
    // surfaces as a reconcile, not a silent split-brain.
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
