import type { Types } from '@hive/shared';
import type { AuthClient } from './Auth.js';

// HTTP client for @hive/api. Attaches the session token to every
// protected request and re-authenticates automatically on 401.
//
// Defaults to same-origin /api so the Railway single-service deploy
// works without env config. Local dev overrides via
// VITE_API_URL=http://localhost:8787.
const DEFAULT_BASE = import.meta.env.VITE_API_URL ?? '/api';

// Healthcheck lives at root, not under /api.
function healthUrl(): string {
  return new URL('/health', window.location.origin).toString();
}

export interface PlayerState {
  id: string;
  displayName: string;
  faction: Types.Faction;
  trophies: number;
  sugar: number;
  leafBits: number;
  aphidMilk: number;
  createdAt: string;
}

export interface PlayerMeResponse {
  player: PlayerState;
  base: Types.Base;
  offlineTrickle: {
    secondsElapsed: number;
    sugarGained: number;
    leafGained: number;
    milkGained: number;
  };
}

export class Api {
  constructor(
    private readonly auth: AuthClient,
    private readonly baseUrl = DEFAULT_BASE,
  ) {}

  async health(): Promise<{ ok: boolean; tick: number }> {
    const res = await fetch(healthUrl());
    if (!res.ok) throw new Error(`health ${res.status}`);
    return (await res.json()) as { ok: boolean; tick: number };
  }

  // Tries the request with whatever token is currently cached. On 401,
  // drives a fresh guest sign-in, then retries once. This makes the
  // app self-heal after a server restart that invalidates in-memory
  // secrets, without the scene code needing to care.
  private async authedFetch(
    path: string,
    init: RequestInit = {},
    retrying = false,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
    };
    if (this.auth.token) headers.authorization = `Bearer ${this.auth.token}`;
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (res.status === 401 && !retrying) {
      await this.auth.signInGuest();
      return this.authedFetch(path, init, true);
    }
    return res;
  }

  async getPlayerMe(): Promise<PlayerMeResponse> {
    const res = await this.authedFetch('/player/me');
    if (!res.ok) throw new Error(`player/me ${res.status}`);
    return (await res.json()) as PlayerMeResponse;
  }

  async putBase(base: Types.Base): Promise<void> {
    const res = await this.authedFetch('/player/base', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base }),
    });
    if (!res.ok) throw new Error(`player/base ${res.status}`);
  }

  async requestMatch(trophies: number): Promise<MatchResponse> {
    const res = await this.authedFetch('/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: this.auth.playerId ?? 'guest',
        trophies,
      }),
    });
    if (!res.ok) throw new Error(`match ${res.status}`);
    return (await res.json()) as MatchResponse;
  }

  async submitRaid(args: {
    defenderId: string | null;
    baseSnapshot: Types.Base;
    seed: number;
    inputs: Types.SimInput[];
    clientResultHash: string;
  }): Promise<RaidSubmitResponse> {
    const res = await this.authedFetch('/raid/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      let msg = `raid/submit ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        // leave msg
      }
      throw new Error(msg);
    }
    return (await res.json()) as RaidSubmitResponse;
  }

  async getRaidHistory(limit = 20): Promise<RaidHistoryEntry[]> {
    const res = await this.authedFetch(`/player/raids?limit=${limit}`);
    if (!res.ok) throw new Error(`player/raids ${res.status}`);
    const body = (await res.json()) as { raids: RaidHistoryEntry[] };
    return body.raids;
  }
}

export interface MatchResponse {
  defenderId: string | null;
  trophiesSought: number;
  seed: number;
  baseSnapshot: Types.Base;
  opponent: { isBot: boolean; displayName: string; trophies: number };
}

export interface RaidSubmitResponse {
  ok: boolean;
  replayId: string;
  result: {
    outcome: string;
    stars: 0 | 1 | 2 | 3;
    sugarLooted: number;
    leafBitsLooted: number;
    tickEnded: number;
  };
  player: {
    trophies: number;
    sugar: number;
    leafBits: number;
    aphidMilk: number;
  };
}

export interface RaidHistoryEntry {
  id: string;
  role: 'attacker' | 'defender';
  opponentId: string | null;
  opponentName: string;
  stars: number;
  sugarLooted: number;
  leafLooted: number;
  trophyDelta: number;
  createdAt: string;
}
