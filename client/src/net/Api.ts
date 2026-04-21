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
  unitLevels: Partial<Record<Types.UnitKind, number>>;
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
    matchToken: string;
    inputs: Types.SimInput[];
    clientResultHash: string;
  }): Promise<RaidSubmitResponse> {
    // The server owns the (defenderId, seed, baseSnapshot) tuple —
    // all we submit is the match token + our input timeline + the
    // result hash we computed locally. That prevents a malicious
    // client from spoofing the defender's base to farm loot.
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

  async getBuildingCatalog(): Promise<BuildingCatalog> {
    const res = await this.authedFetch('/player/building/catalog');
    if (!res.ok) throw new Error(`catalog ${res.status}`);
    return (await res.json()) as BuildingCatalog;
  }

  async placeBuilding(args: {
    kind: Types.BuildingKind;
    anchor: { x: number; y: number; layer: Types.Layer };
  }): Promise<PlaceBuildingResponse> {
    const res = await this.authedFetch('/player/building', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      let msg = `place ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        // leave default
      }
      throw new Error(msg);
    }
    return (await res.json()) as PlaceBuildingResponse;
  }

  async deleteBuilding(buildingId: string): Promise<DeleteBuildingResponse> {
    const res = await this.authedFetch(
      `/player/building/${encodeURIComponent(buildingId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) throw new Error(`delete ${res.status}`);
    return (await res.json()) as DeleteBuildingResponse;
  }

  async getLeaderboard(limit = 50): Promise<LeaderboardResponse> {
    const res = await this.authedFetch(`/leaderboard?limit=${limit}`);
    if (!res.ok) throw new Error(`leaderboard ${res.status}`);
    return (await res.json()) as LeaderboardResponse;
  }

  async getUpgrades(): Promise<UpgradesResponse> {
    const res = await this.authedFetch('/player/upgrades');
    if (!res.ok) throw new Error(`upgrades ${res.status}`);
    return (await res.json()) as UpgradesResponse;
  }

  async clanCreate(args: {
    name: string;
    tag: string;
    description?: string;
    isOpen?: boolean;
  }): Promise<{ ok: true; clanId: string }> {
    const res = await this.authedFetch('/clan/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw await errorFromResponse(res, 'clan/create');
    return (await res.json()) as { ok: true; clanId: string };
  }

  async clanBrowse(): Promise<ClanSummary[]> {
    const res = await this.authedFetch('/clan/browse');
    if (!res.ok) throw new Error(`clan/browse ${res.status}`);
    const j = (await res.json()) as { clans: ClanSummary[] };
    return j.clans;
  }

  async clanJoin(clanId: string): Promise<{ ok: true; clanId: string }> {
    const res = await this.authedFetch('/clan/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clanId }),
    });
    if (!res.ok) throw await errorFromResponse(res, 'clan/join');
    return (await res.json()) as { ok: true; clanId: string };
  }

  async clanLeave(): Promise<{ ok: true }> {
    const res = await this.authedFetch('/clan/leave', { method: 'POST' });
    if (!res.ok) throw await errorFromResponse(res, 'clan/leave');
    return (await res.json()) as { ok: true };
  }

  async clanMy(): Promise<ClanMyResponse> {
    const res = await this.authedFetch('/clan/my');
    if (!res.ok) throw new Error(`clan/my ${res.status}`);
    return (await res.json()) as ClanMyResponse;
  }

  async clanMessages(sinceId: number): Promise<ClanMessage[]> {
    const res = await this.authedFetch(`/clan/messages?sinceId=${sinceId}`);
    if (!res.ok) throw new Error(`clan/messages ${res.status}`);
    const j = (await res.json()) as { messages: ClanMessage[] };
    return j.messages;
  }

  async clanMessageSend(content: string): Promise<{ ok: true; id: string }> {
    const res = await this.authedFetch('/clan/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw await errorFromResponse(res, 'clan/message');
    return (await res.json()) as { ok: true; id: string };
  }

  async upgradeUnit(kind: Types.UnitKind): Promise<UpgradeUnitResponse> {
    const res = await this.authedFetch('/player/upgrade-unit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind }),
    });
    if (!res.ok) {
      let msg = `upgrade ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        // fall through
      }
      throw new Error(msg);
    }
    return (await res.json()) as UpgradeUnitResponse;
  }

  // Live PvP: reserve a room slot against a trophy-banded opponent and
  // get back the arenaToken both clients use to rendezvous in the
  // Colyseus picnic room. Idempotent server-side: if we already have
  // an active reservation (as host OR challenger), the same token
  // comes back on the next call.
  async reserveArena(): Promise<ArenaReserveResponse | null> {
    const res = await this.authedFetch('/arena/reserve', { method: 'POST' });
    if (res.status === 409) {
      // No opponent online — caller falls back to a bot arena or
      // retries after a short delay.
      return null;
    }
    if (!res.ok) {
      let msg = `arena reserve ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        // fall through
      }
      throw new Error(msg);
    }
    return (await res.json()) as ArenaReserveResponse;
  }

  // Per-unit animation enable flags. Kept lightweight (no auth) so the
  // boot scene can load it before the session is established. On any
  // failure we resolve to an empty object — scenes fall back to the
  // static sprite on a missing key, which is the safe default.
  async getAnimationSettings(): Promise<Record<string, boolean>> {
    try {
      const res = await fetch(`${this.baseUrl}/settings/animation`);
      if (!res.ok) return {};
      return (await res.json()) as Record<string, boolean>;
    } catch {
      return {};
    }
  }
}

export interface ArenaReserveResponse {
  arenaToken: string;
  role: 'host' | 'challenger';
  seed: number;
  opponent: {
    playerId: string;
    displayName: string;
    trophies: number;
  };
  hostSnapshot: Types.Base;
  challengerSnapshot: Types.Base;
}

export interface ClanSummary {
  id: string;
  name: string;
  tag: string;
  description: string;
  memberCount: number;
  createdAt: string;
}
export interface ClanMember {
  playerId: string;
  displayName: string;
  trophies: number;
  role: 'leader' | 'member';
  joinedAt: string;
}
export interface ClanMessage {
  id: string;
  playerId: string;
  displayName: string;
  content: string;
  createdAt: string;
}
export interface ClanMyResponse {
  clan: {
    id: string;
    name: string;
    tag: string;
    description: string;
    isOpen: boolean;
    leaderId: string | null;
    createdAt: string;
  } | null;
  myRole?: 'leader' | 'member';
  members?: ClanMember[];
  messages?: ClanMessage[];
}

async function errorFromResponse(res: Response, fallback: string): Promise<Error> {
  let msg = `${fallback} ${res.status}`;
  try {
    const j = (await res.json()) as { error?: string };
    if (j.error) msg = j.error;
  } catch {
    // ignore
  }
  return new Error(msg);
}

export interface UnitUpgradeEntry {
  kind: Types.UnitKind;
  level: number;
  maxLevel: number;
  nextCost: { sugar: number; leafBits: number } | null;
}
export interface UpgradesResponse {
  units: UnitUpgradeEntry[];
  resources: { sugar: number; leafBits: number };
}
export interface UpgradeUnitResponse {
  ok: true;
  kind: Types.UnitKind;
  newLevel: number;
  unitLevels: Record<string, number>;
  resources: { sugar: number; leafBits: number };
}

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  displayName: string;
  faction: string;
  trophies: number;
}
export interface LeaderboardResponse {
  top: LeaderboardEntry[];
  me: LeaderboardEntry | null;
  limit: number;
}

export interface MatchResponse {
  // Opaque token the server uses to look up the authoritative base on
  // raid/submit. The client must not forge or re-use this.
  matchToken: string;
  defenderId: string | null;
  trophiesSought: number;
  seed: number;
  // baseSnapshot here is for rendering only — the server holds the real
  // one and ignores whatever the client sends back on submit.
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

export type BuildingCatalog = {
  placeable: Record<
    string,
    { sugar: number; leafBits: number; aphidMilk: number }
  >;
};

export interface PlaceBuildingResponse {
  ok: true;
  building: Types.Building;
  base: Types.Base;
  player: { trophies: number; sugar: number; leafBits: number; aphidMilk: number };
}

export interface DeleteBuildingResponse {
  ok: true;
  base: Types.Base;
  removed: number;
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
