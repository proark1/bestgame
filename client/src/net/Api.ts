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
  // Retention loop — nullable/optional so older servers keep working.
  shieldExpiresAt?: string | null;
  seasonId?: string;
  seasonXp?: number;
  seasonMilestonesClaimed?: number[];
}

export interface DailyQuestState {
  id: string;
  progress: number;
  claimed: boolean;
}
export interface DailyQuests {
  date: string;
  quests: DailyQuestState[];
}
export interface QuestDef {
  id: string;
  label: string;
  goal: number;
  rewardSugar: number;
  rewardLeaf: number;
  rewardXp: number;
}
export interface SeasonMilestone {
  id: number;
  xpRequired: number;
  label: string;
  rewardSugar: number;
  rewardLeaf: number;
}
export interface QuestsResponse {
  dailyQuests: DailyQuests;
  questDefs: QuestDef[];
  season: {
    id: string;
    xp: number;
    milestonesClaimed: number[];
    milestones: SeasonMilestone[];
  };
}

export interface ClanWarState {
  id: string;
  clanAId: string;
  clanBId: string;
  myClanSide: 'A' | 'B';
  status: string;
  startedAt: string;
  endsAt: string;
  starsA: number;
  starsB: number;
  attacks: Array<{
    attackerPlayerId: string;
    attackerClanId: string;
    stars: number;
  }>;
}
export interface ClanWarCurrentResponse {
  inClan: boolean;
  clanId?: string;
  war: ClanWarState | null;
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

  // Advance the Queen one tier. Fails with 409 at max level and 402
  // when the player can't afford the cost.
  async upgradeQueen(): Promise<UpgradeQueenResponse> {
    const res = await this.authedFetch('/player/upgrade-queen', {
      method: 'POST',
    });
    if (!res.ok) {
      let msg = `queen upgrade ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        // fall through
      }
      throw new Error(msg);
    }
    return (await res.json()) as UpgradeQueenResponse;
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

  // UI-image override flags (`ui-button-primary-bg`, `ui-panel-bg`,
  // …). Same contract as getAnimationSettings: no auth, empty on
  // failure. Consumers combine this with a texture-exists check so
  // a flag flipped on without art still falls back to Graphics.
  async getUiOverrideSettings(): Promise<Record<string, boolean>> {
    try {
      const res = await fetch(`${this.baseUrl}/settings/ui-overrides`);
      if (!res.ok) return {};
      return (await res.json()) as Record<string, boolean>;
    } catch {
      return {};
    }
  }

  // ---- Retention loop ----------------------------------------------------
  //
  // Daily quests + season progress + milestone claims. These are the
  // "why open the game today" and "what do I grind for this month"
  // endpoints. See server/api/src/routes/quests.ts for the server
  // side; shape mirrors the route return types.
  async getQuests(): Promise<QuestsResponse> {
    const res = await this.authedFetch('/player/quests');
    if (!res.ok) throw await errorFromResponse(res, 'quests fetch failed');
    return (await res.json()) as QuestsResponse;
  }

  async claimQuest(questId: string): Promise<{
    ok: true;
    questId: string;
    reward: { sugar: number; leafBits: number; xp: number };
    dailyQuests: DailyQuests;
    resources: { sugar: number; leafBits: number };
    seasonXp: number;
  }> {
    const res = await this.authedFetch('/player/quests/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questId }),
    });
    if (!res.ok) throw await errorFromResponse(res, 'quest claim failed');
    return (await res.json()) as Awaited<ReturnType<Api['claimQuest']>>;
  }

  async claimSeasonMilestone(milestoneId: number): Promise<{
    ok: true;
    milestoneId: number;
    reward: { sugar: number; leafBits: number };
    resources: { sugar: number; leafBits: number };
    milestonesClaimed: number[];
  }> {
    const res = await this.authedFetch('/player/season/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ milestoneId }),
    });
    if (!res.ok) throw await errorFromResponse(res, 'milestone claim failed');
    return (await res.json()) as Awaited<ReturnType<Api['claimSeasonMilestone']>>;
  }

  // ---- Clan wars ---------------------------------------------------------
  async warCurrent(): Promise<ClanWarCurrentResponse> {
    const res = await this.authedFetch('/clan/war/current');
    if (!res.ok) throw await errorFromResponse(res, 'war fetch failed');
    return (await res.json()) as ClanWarCurrentResponse;
  }

  async warStart(opponentClanId: string): Promise<{
    ok: true;
    warId: string;
    endsAt: string;
  }> {
    const res = await this.authedFetch('/clan/war/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ opponentClanId }),
    });
    if (!res.ok) throw await errorFromResponse(res, 'war start failed');
    return (await res.json()) as Awaited<ReturnType<Api['warStart']>>;
  }

  async warSubmitAttack(args: {
    defenderPlayerId: string;
    stars: 0 | 1 | 2 | 3;
  }): Promise<{ ok: true; warId: string }> {
    const res = await this.authedFetch('/clan/war/attack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw await errorFromResponse(res, 'war attack failed');
    return (await res.json()) as Awaited<ReturnType<Api['warSubmitAttack']>>;
  }

  async warEnd(warId: string): Promise<{
    ok: true;
    alreadyEnded?: boolean;
    winningClanId: string | null;
    starsA: number;
    starsB: number;
    bonusPerMember?: number;
  }> {
    const res = await this.authedFetch('/clan/war/end', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ warId }),
    });
    if (!res.ok) throw await errorFromResponse(res, 'war end failed');
    return (await res.json()) as Awaited<ReturnType<Api['warEnd']>>;
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
  // Queen level required to deploy this kind in a raid. Upgrade UI
  // uses it to show a lock badge on kinds that aren't yet deployable.
  // Server returns 1 for kinds that are unlocked from account start.
  unlockQueenLevel?: number;
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
  // Per-kind rules shipped with the catalog so the picker can
  // disable unplaceable slots (wrong layer / over cap) with a clear
  // inline hint, rather than round-tripping to /player/building and
  // bouncing with an error. Absent on old servers that predate the
  // town-builder-tier work.
  rules?: Record<
    string,
    { allowedLayers: number[]; quotaByTier: number[] }
  >;
  maxQueenLevel?: number;
};

export interface UpgradeQueenResponse {
  ok: true;
  newQueenLevel: number;
  base: Types.Base;
  player: { trophies: number; sugar: number; leafBits: number; aphidMilk: number };
}

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
