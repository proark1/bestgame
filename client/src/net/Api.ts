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

export interface StreakReward {
  day: number;
  sugar: number;
  leafBits: number;
  aphidMilk: number;
  label: string;
}

export interface StreakState {
  count: number;
  lastDay: string;
  lastClaim: number;
  creditedToday: boolean;
  comebackPending: boolean;
  nextReward: StreakReward;
  rewards: StreakReward[];
  comebackReward: { sugar: number; leafBits: number; aphidMilk: number };
}

export interface NemesisStub {
  playerId: string;
  stars: number;
  setAt: string | null;
  avenged: boolean;
}

export interface QueenSkinState {
  equipped: string;
  owned: string[];
}

export interface CampaignBrief {
  chapter: number;
  progress: number;
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
  // Stickiness features (0013). All optional so older servers work.
  streak?: StreakState;
  nemesis?: NemesisStub | null;
  queenSkin?: QueenSkinState;
  tutorialStage?: number;
  campaign?: CampaignBrief;
  // Resource economy surface (GDD §6.8 / §5.3). Storage caps are
  // derived from the player's economy buildings; incomePerSecond is
  // the totals across all live producers. Both are optional so a
  // pre-storage server still loads (HUD falls back to "no cap").
  storage?: { sugarCap: number; leafCap: number };
  incomePerSecond?: { sugar: number; leafBits: number; aphidMilk: number };
  // Colony Rank meta-progression (GDD §6.7). Optional so older servers
  // keep working — client treats missing field as rank 0 + uncapped.
  colony?: {
    totalInvested: number;
    rank: number;
    lootCap: { sugar: number; leafBits: number };
  };
  // Donated units waiting for the player's next raid. Map of unit
  // kind → count, credited by clanmates via /clan/donate. RaidScene
  // merges this into the deck on raid start; /raid/submit clears it
  // on success. Optional so older servers stay compatible (treated
  // as empty by the client).
  donationInventory?: Record<string, number>;
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

// Defender AI rule catalog served by /player/ai-rules/catalog. Mirrors
// the server's AIRuleCatalog shape so the editor can render dropdowns
// without re-hardcoding the allowed trigger/effect list.
export type AIRuleParamKey =
  | 'percent'
  | 'radius'
  | 'ticks'
  | 'durationTicks'
  | 'rate'
  | 'range'
  | 'maxExtra'
  | 'hp';
export interface AIRuleCatalogTrigger {
  id: Types.AIRuleTrigger;
  label: string;
  params: AIRuleParamKey[];
}
export interface AIRuleCatalogEffect {
  id: Types.AIRuleEffect;
  label: string;
  params: AIRuleParamKey[];
  allowedKinds: Types.BuildingKind[];
}
export interface AIRuleCatalogResponse {
  triggers: AIRuleCatalogTrigger[];
  effects: AIRuleCatalogEffect[];
  combos: Array<{ trigger: Types.AIRuleTrigger; effect: Types.AIRuleEffect }>;
  limits: {
    maxRulesPerBuilding: number;
    quotaByQueenLevel: Record<number, number>;
    unlockQueenLevel: number;
  };
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

  async requestMatch(
    trophies: number,
    targetDefenderId?: string,
  ): Promise<MatchResponse> {
    // `targetDefenderId` is the revenge / direct-attack hook. The
    // server validates the target (real player, not self, has a base,
    // not shielded) and falls through to random matchmaking if the
    // pin is invalid — revenge against a now-shielded defender just
    // becomes a normal match instead of failing.
    const res = await this.authedFetch('/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: this.auth.playerId ?? 'guest',
        trophies,
        ...(targetDefenderId ? { targetDefenderId } : {}),
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

  async moveBuilding(args: {
    buildingId: string;
    anchor: { x: number; y: number; layer: Types.Layer };
  }): Promise<MoveBuildingResponse> {
    const res = await this.authedFetch(
      `/player/building/${encodeURIComponent(args.buildingId)}/move`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anchor: args.anchor }),
      },
    );
    if (!res.ok) throw await errorFromResponse(res, 'move');
    return (await res.json()) as MoveBuildingResponse;
  }

  async rotateBuilding(args: {
    buildingId: string;
    rotation?: 0 | 1 | 2 | 3;
  }): Promise<RotateBuildingResponse> {
    const res = await this.authedFetch(
      `/player/building/${encodeURIComponent(args.buildingId)}/rotate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          args.rotation === undefined ? {} : { rotation: args.rotation },
        ),
      },
    );
    if (!res.ok) throw await errorFromResponse(res, 'rotate');
    return (await res.json()) as RotateBuildingResponse;
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

  // Clan unit donation system — request → donate → close. The
  // requester opens a slot for N units of one kind; clanmates fulfill
  // partial or full counts in exchange for a small sugar+leaf reward.
  // Drives the daily "ask & give" loop that's traditionally the social
  // glue in Clash-of-Clans-style games.
  async clanRequestUnits(
    unitKind: Types.UnitKind,
    count: number,
  ): Promise<{ ok: true; requestId: number }> {
    const res = await this.authedFetch('/clan/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unitKind, count }),
    });
    if (!res.ok) throw await errorFromResponse(res, 'clan/request');
    return (await res.json()) as { ok: true; requestId: number };
  }

  async clanDonate(
    requestId: number,
    count: number,
  ): Promise<{
    ok: true;
    donated: number;
    fulfilled: number;
    closed: boolean;
    reward: { sugar: number; leafBits: number };
  }> {
    const res = await this.authedFetch('/clan/donate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, count }),
    });
    if (!res.ok) throw await errorFromResponse(res, 'clan/donate');
    return (await res.json()) as Awaited<ReturnType<Api['clanDonate']>>;
  }

  async clanRequests(): Promise<{ requests: ClanUnitRequest[] }> {
    const res = await this.authedFetch('/clan/requests');
    if (!res.ok) throw await errorFromResponse(res, 'clan/requests');
    return (await res.json()) as { requests: ClanUnitRequest[] };
  }

  // Giant-map hive war — read the current season + enrollments so
  // the client can render the map view in one round-trip. Returns
  // `season: null` when no open/active season exists (extremely
  // unlikely once the seed migration runs, but the loader handles
  // it cleanly).
  async getHiveWarSeason(): Promise<HiveWarSeasonResponse> {
    const res = await this.authedFetch('/hivewar/season/current');
    if (!res.ok) throw await errorFromResponse(res, 'hivewar/season');
    return (await res.json()) as HiveWarSeasonResponse;
  }

  async hiveWarEnroll(
    seasonId: number,
  ): Promise<{ ok: true; alreadyEnrolled: boolean; slotX: number; slotY: number }> {
    const res = await this.authedFetch(
      `/hivewar/season/${encodeURIComponent(String(seasonId))}/enroll`,
      { method: 'POST' },
    );
    if (!res.ok) throw await errorFromResponse(res, 'hivewar/enroll');
    return (await res.json()) as Awaited<ReturnType<Api['hiveWarEnroll']>>;
  }

  // Read-only "base tour" — fetch a clanmate's full base snapshot for
  // tour-mode rendering. Server enforces same-clan membership; 403
  // for outsiders, 404 for missing player. The first slice of the
  // step-8 "shared underground tunnels" feature: tour today, sim
  // integration on top later.
  async getClanmateBase(playerId: string): Promise<{
    playerId: string;
    displayName: string;
    trophies: number;
    base: Types.Base;
  }> {
    const res = await this.authedFetch(`/clan/base/${encodeURIComponent(playerId)}`);
    if (!res.ok) throw await errorFromResponse(res, 'clan/base');
    return (await res.json()) as Awaited<ReturnType<Api['getClanmateBase']>>;
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

  // Upgrade a single building by one level. Costs scale with the
  // building's placement price and the Fibonacci multiplier curve;
  // server is authoritative and returns the new snapshot.
  async upgradeBuilding(buildingId: string): Promise<UpgradeBuildingResponse> {
    const res = await this.authedFetch('/player/upgrade-building', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ buildingId }),
    });
    if (!res.ok) throw await errorFromResponse(res, 'upgrade-building');
    return (await res.json()) as UpgradeBuildingResponse;
  }

  // Pay AphidMilk to instantly complete a pending building upgrade.
  // Fails with 409 if the building has no pending job and 402 if the
  // wallet is short on milk. Skip cost scales with remaining time —
  // see shared/src/sim/builderGates.ts::skipCostMilk().
  async skipBuilder(buildingId: string): Promise<BuilderSkipResponse> {
    const res = await this.authedFetch('/player/builder/skip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ buildingId }),
    });
    if (!res.ok) throw await errorFromResponse(res, 'builder/skip');
    return (await res.json()) as BuilderSkipResponse;
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

  // ---- Defender AI rules -------------------------------------------------
  async getAIRulesCatalog(): Promise<AIRuleCatalogResponse> {
    const res = await this.authedFetch('/player/ai-rules/catalog');
    if (!res.ok) throw await errorFromResponse(res, 'ai catalog fetch failed');
    return (await res.json()) as AIRuleCatalogResponse;
  }

  async setBuildingRules(
    buildingId: string,
    rules: Types.BuildingAIRule[],
  ): Promise<{
    ok: true;
    base: Types.Base;
    building: Types.Building;
    quota: number;
    rulesUsed: number;
  }> {
    const res = await this.authedFetch(
      `/player/building/${encodeURIComponent(buildingId)}/ai`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rules }),
      },
    );
    if (!res.ok) throw await errorFromResponse(res, 'rule save failed');
    return (await res.json()) as Awaited<ReturnType<Api['setBuildingRules']>>;
  }

  // ---- Stickiness: streak / nemesis / queen skin ------------------------
  async claimStreak(): Promise<{
    ok: true;
    streakDay: number;
    reward: StreakReward;
    resources: { sugar: number; leafBits: number; aphidMilk: number };
  }> {
    const res = await this.authedFetch('/player/streak/claim', { method: 'POST' });
    if (!res.ok) throw await errorFromResponse(res, 'streak/claim');
    return (await res.json()) as Awaited<ReturnType<Api['claimStreak']>>;
  }

  async claimComeback(): Promise<{
    ok: true;
    reward: { sugar: number; leafBits: number; aphidMilk: number };
    resources: { sugar: number; leafBits: number; aphidMilk: number };
  }> {
    const res = await this.authedFetch('/player/comeback/claim', { method: 'POST' });
    if (!res.ok) throw await errorFromResponse(res, 'comeback/claim');
    return (await res.json()) as Awaited<ReturnType<Api['claimComeback']>>;
  }

  async getNemesis(): Promise<{
    nemesis: {
      playerId: string;
      displayName: string;
      trophies: number;
      faction: string;
      queenSkinId: string;
      stars: number;
      setAt: string | null;
      avenged: boolean;
      onlineRecent: boolean;
    } | null;
  }> {
    const res = await this.authedFetch('/player/nemesis');
    if (!res.ok) throw await errorFromResponse(res, 'nemesis fetch');
    return (await res.json()) as Awaited<ReturnType<Api['getNemesis']>>;
  }

  async getQueenSkins(): Promise<QueenSkinCatalog> {
    const res = await this.authedFetch('/player/queen-skins');
    if (!res.ok) throw await errorFromResponse(res, 'queen skin list');
    return (await res.json()) as QueenSkinCatalog;
  }

  async equipQueenSkin(skinId: string): Promise<{
    ok: true;
    equipped: string;
    owned: string[];
  }> {
    const res = await this.authedFetch('/player/queen-skins/equip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skinId }),
    });
    if (!res.ok) throw await errorFromResponse(res, 'queen skin equip');
    return (await res.json()) as Awaited<ReturnType<Api['equipQueenSkin']>>;
  }

  async setTutorialStage(stage: number): Promise<{ ok: true; stage: number }> {
    const res = await this.authedFetch('/player/tutorial', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage }),
    });
    if (!res.ok) throw await errorFromResponse(res, 'tutorial stage');
    return (await res.json()) as { ok: true; stage: number };
  }

  // ---- Stickiness: campaign -------------------------------------------
  async getCampaignState(): Promise<CampaignStateResponse> {
    const res = await this.authedFetch('/campaign/state');
    if (!res.ok) throw await errorFromResponse(res, 'campaign/state');
    return (await res.json()) as CampaignStateResponse;
  }

  async completeMission(missionId: number): Promise<{
    ok: true;
    firstClear: boolean;
    chapterId: number;
    missionId: number;
    progressInChapter: number;
    reward: { sugar: number; leafBits: number };
    resources: { sugar: number; leafBits: number };
  }> {
    const res = await this.authedFetch(`/campaign/mission/${missionId}/complete`, {
      method: 'POST',
    });
    if (!res.ok) throw await errorFromResponse(res, 'mission/complete');
    return (await res.json()) as Awaited<ReturnType<Api['completeMission']>>;
  }

  async claimChapter(chapterId: number): Promise<{
    ok: true;
    chapterId: number;
    unlockedChapter: number;
    unlockedSkinId: string | null;
    reward: { sugar: number; leafBits: number; aphidMilk: number; skinId: string | null };
    resources: { sugar: number; leafBits: number; aphidMilk: number };
    ownedSkins: string[];
  }> {
    const res = await this.authedFetch(`/campaign/chapter/${chapterId}/claim`, {
      method: 'POST',
    });
    if (!res.ok) throw await errorFromResponse(res, 'chapter/claim');
    return (await res.json()) as Awaited<ReturnType<Api['claimChapter']>>;
  }

  // ---- Stickiness: builder queue --------------------------------------
  async getBuilder(): Promise<BuilderQueueResponse> {
    const res = await this.authedFetch('/player/builder');
    if (!res.ok) throw await errorFromResponse(res, 'builder');
    return (await res.json()) as BuilderQueueResponse;
  }

  async enqueueBuild(args: {
    targetKind: 'unit' | 'building' | 'queen';
    targetId: string;
    levelTo: number;
  }): Promise<{ ok: true; entry: BuilderEntry }> {
    const res = await this.authedFetch('/player/builder/enqueue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw await errorFromResponse(res, 'builder/enqueue');
    return (await res.json()) as Awaited<ReturnType<Api['enqueueBuild']>>;
  }

  async skipBuild(
    entryId: string,
    useAphidMilk: boolean,
  ): Promise<{ ok: true; id: string; usedAphidMilk: boolean }> {
    const res = await this.authedFetch(`/player/builder/${encodeURIComponent(entryId)}/skip`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ useAphidMilk }),
    });
    if (!res.ok) throw await errorFromResponse(res, 'builder/skip');
    return (await res.json()) as Awaited<ReturnType<Api['skipBuild']>>;
  }

  async finishBuild(entryId: string): Promise<{
    ok: true;
    id: string;
    appliedKind: 'unit' | 'building' | 'queen';
    appliedId: string;
    appliedLevel: number;
  }> {
    const res = await this.authedFetch(`/player/builder/${encodeURIComponent(entryId)}/finish`, {
      method: 'POST',
    });
    if (!res.ok) throw await errorFromResponse(res, 'builder/finish');
    return (await res.json()) as Awaited<ReturnType<Api['finishBuild']>>;
  }

  // ---- Stickiness: replay feed + sharing ------------------------------
  async replayFeed(cursor?: string, limit = 20): Promise<ReplayFeedResponse> {
    const q = new URLSearchParams();
    q.set('limit', String(limit));
    if (cursor) q.set('cursor', cursor);
    const res = await this.authedFetch(`/replay/feed?${q.toString()}`);
    if (!res.ok) throw await errorFromResponse(res, 'replay/feed');
    return (await res.json()) as ReplayFeedResponse;
  }

  async replay(id: string): Promise<ReplayDetailResponse> {
    const res = await this.authedFetch(`/replay/${encodeURIComponent(id)}`);
    if (!res.ok) throw await errorFromResponse(res, 'replay');
    return (await res.json()) as ReplayDetailResponse;
  }

  async replayView(id: string): Promise<{
    ok: true;
    rewarded: boolean;
    reward: { sugar: number; leafBits: number } | null;
    watchesToday: number;
  }> {
    const res = await this.authedFetch(`/replay/${encodeURIComponent(id)}/view`, {
      method: 'POST',
    });
    if (!res.ok) throw await errorFromResponse(res, 'replay/view');
    return (await res.json()) as Awaited<ReturnType<Api['replayView']>>;
  }

  async replayUpvote(id: string): Promise<{
    ok: true;
    hasMyUpvote: boolean;
    upvoteCount: number;
  }> {
    const res = await this.authedFetch(`/replay/${encodeURIComponent(id)}/upvote`, {
      method: 'POST',
    });
    if (!res.ok) throw await errorFromResponse(res, 'replay/upvote');
    return (await res.json()) as Awaited<ReturnType<Api['replayUpvote']>>;
  }

  async replayComments(
    id: string,
    afterId = 0,
    limit = 30,
  ): Promise<{ comments: ReplayComment[] }> {
    const q = new URLSearchParams();
    if (afterId > 0) q.set('afterId', String(afterId));
    if (limit !== 30) q.set('limit', String(limit));
    const path = `/replay/${encodeURIComponent(id)}/comments`;
    const url = q.toString() ? `${path}?${q.toString()}` : path;
    const res = await this.authedFetch(url);
    if (!res.ok) throw await errorFromResponse(res, 'replay/comments');
    return (await res.json()) as { comments: ReplayComment[] };
  }

  async replayCommentPost(
    id: string,
    content: string,
  ): Promise<{ ok: true; comment: ReplayComment }> {
    const res = await this.authedFetch(`/replay/${encodeURIComponent(id)}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw await errorFromResponse(res, 'replay/comments POST');
    return (await res.json()) as { ok: true; comment: ReplayComment };
  }

  // ---- Stickiness: clan war target ------------------------------------
  async warFindTarget(): Promise<WarTargetResponse | null> {
    const res = await this.authedFetch('/clan/war/find-target', { method: 'POST' });
    if (res.status === 404) return null;
    if (!res.ok) throw await errorFromResponse(res, 'war/find-target');
    return (await res.json()) as WarTargetResponse;
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

// Open-request snapshot returned by GET /clan/requests. `canDonate`
// is server-computed (false when the requester is the caller), so the
// client doesn't have to thread playerId through the render path.
export interface HiveWarSeason {
  id: number;
  name: string;
  startsAt: string;
  endsAt: string;
  boardW: number;
  boardH: number;
  state: 'open' | 'active' | 'finished';
}
export interface HiveWarEnrollment {
  clanId: string;
  clanName: string;
  clanTag: string;
  slotX: number;
  slotY: number;
  score: number;
  attacksMade: number;
  attacksReceived: number;
}
export interface HiveWarSeasonResponse {
  season: HiveWarSeason | null;
  enrollments: HiveWarEnrollment[];
  myClanId: string | null;
  myEnrollment: {
    slotX: number;
    slotY: number;
    score: number;
    attacksMade: number;
    attacksReceived: number;
  } | null;
}

export interface ClanUnitRequest {
  id: number;
  requesterId: string;
  requesterName: string;
  unitKind: Types.UnitKind;
  requestedCount: number;
  fulfilledCount: number;
  remaining: number;
  createdAt: string;
  canDonate: boolean;
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
  replayName?: string;
  result: {
    outcome: string;
    stars: 0 | 1 | 2 | 3;
    sugarLooted: number;
    leafBitsLooted: number;
    tickEnded: number;
  };
  // Loot summary post-Colony-Rank cap. Optional so older servers
  // (pre-#colony-rank-loot-cap) still parse; client falls back to
  // result.sugarLooted / leafBitsLooted in that case.
  loot?: {
    sugar: number;
    leafBits: number;
    rawSugar: number;
    rawLeaf: number;
    capped: boolean;
    colonyRank: number;
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
  // Upgrade cost curve + per-kind base costs so the building info
  // modal can render accurate previews without duplicating these
  // tables. Absent on older servers; clients fall back to inline
  // placeholders when missing. `baseCost` includes NON-placeable
  // kinds (Queen Chamber, pre-placed starters) since those still
  // get an upgrade preview — the server just rejects placement of
  // non-placeable kinds.
  levelCostMult?: number[];
  baseCost?: Record<
    string,
    { sugar: number; leafBits: number; aphidMilk: number }
  >;
  incomePerSecond?: Record<
    string,
    { sugar: number; leafBits: number; aphidMilk: number }
  >;
  // Queen upgrade cost curve, one entry per current-level→next-level
  // step. The building info modal's Queen-chamber branch uses this
  // to render an affordability preview before the /upgrade-queen
  // submit debits resources.
  queenUpgradeCost?: Array<{
    sugar: number;
    leafBits: number;
    aphidMilk: number;
  }>;
};

export interface UpgradeQueenResponse {
  ok: true;
  newQueenLevel: number;
  base: Types.Base;
  player: { trophies: number; sugar: number; leafBits: number; aphidMilk: number };
}

// Now returns the pending fields instead of newLevel — the level bump
// is delayed until the timer elapses. /me lazily promotes; the
// /builder/skip endpoint can short-circuit it for AphidMilk.
export interface UpgradeBuildingResponse {
  ok: true;
  buildingId: string;
  pendingToLevel: number;
  pendingCompletesAt: string;
  cost: { sugar: number; leafBits: number; aphidMilk: number };
  base: Types.Base;
  player: { trophies: number; sugar: number; leafBits: number; aphidMilk: number };
}

export interface BuilderSkipResponse {
  ok: true;
  buildingId: string;
  newLevel: number;
  milkSpent: number;
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

export interface MoveBuildingResponse {
  ok: true;
  base: Types.Base;
  building: Types.Building;
}

export interface RotateBuildingResponse {
  ok: true;
  base: Types.Base;
  building: Types.Building;
  rotation: 0 | 1 | 2 | 3;
}

// ----- Stickiness response shapes -----

export interface QueenSkinDef {
  id: string;
  name: string;
  tagline: string;
  portraitKey: string;
  unlock:
    | { kind: 'default' }
    | { kind: 'trophies'; threshold: number }
    | { kind: 'streak'; day: number }
    | { kind: 'seasonXp'; xp: number }
    | { kind: 'chapter'; chapterId: number }
    | { kind: 'shop'; aphidMilk: number };
  palette: { primary: number; accent: number; glow: number };
}
export interface QueenSkinCatalog {
  catalog: QueenSkinDef[];
  owned: string[];
  equipped: string;
}

export interface CampaignMissionDef {
  id: number;
  slug: string;
  title: string;
  intro: string;
  outro: string;
  difficulty: 'tutorial' | 'easy' | 'medium' | 'hard' | 'boss';
  rewardSugar: number;
  rewardLeaf: number;
  rewardXp: number;
}
export interface CampaignChapterDef {
  id: number;
  slug: string;
  title: string;
  subtitle: string;
  synopsis: string;
  villain: string;
  completionSugar: number;
  completionLeaf: number;
  completionAphidMilk: number;
  unlockSkinId: string | null;
  missions: CampaignMissionDef[];
}
export interface CampaignStateResponse {
  chapters: CampaignChapterDef[];
  playerState: {
    unlockedChapter: number;
    activeChapterId: number;
    progressInChapter: number;
    chapterComplete: boolean;
    completedMissions: number[];
    claimedChapters: number[];
    ownedSkins: string[];
  };
}

export interface BuilderEntry {
  id: string;
  targetKind: 'unit' | 'building' | 'queen';
  targetId: string;
  levelTo: number;
  startedAt: string;
  endsAt: string;
  secondsRemaining: number;
  skipCostAphidMilk: number;
}
export interface BuilderQueueResponse {
  entries: BuilderEntry[];
  slots: number;
  freeSkipAvailable: boolean;
  aphidMilk: number;
}

export interface ReplayFeedEntry {
  id: string;
  attackerId: string;
  attackerName: string;
  attackerTrophies: number;
  defenderId: string | null;
  defenderName: string;
  stars: number;
  sugarLooted: number;
  replayName: string;
  viewCount: number;
  upvoteCount: number;
  // Optional so older servers (before migrations/0019) keep loading.
  // The client treats absent as zero so the badge just doesn't render.
  commentCount?: number;
  hasMyUpvote: boolean;
  createdAt: string;
}

export interface ReplayComment {
  id: number;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
}
export interface ReplayFeedResponse {
  entries: ReplayFeedEntry[];
  nextCursor: string | null;
}
export interface ReplayDetailResponse {
  replay: {
    id: string;
    seed: number;
    baseSnapshot: Types.Base;
    inputs: Types.SimInput[];
    result: {
      outcome: string;
      stars: number;
      sugarLooted: number;
      leafBitsLooted: number;
      tickEnded: number;
    };
    stars: number;
    replayName: string;
    viewCount: number;
    upvoteCount: number;
    createdAt: string;
    attackerId: string;
    attackerName: string;
    defenderId: string | null;
    defenderName: string;
  };
}

export interface WarTargetResponse {
  ok: true;
  matchToken: string;
  warId: string;
  defenderId: string;
  seed: number;
  expiresAt: string;
  opponent: { isBot: false; displayName: string; trophies: number };
  baseSnapshot: Types.Base;
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
