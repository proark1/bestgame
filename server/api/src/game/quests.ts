// Daily quests — the "why would I open the game today" lever.
//
// Each UTC day we roll 3 quests from the pool per player. The roll is
// deterministic over (player_id, date) so a client that opens /quests
// twice on the same day sees the same 3 cards. Server-side, progress
// and claim state live on the player row as a single JSONB blob —
// one row write per raid, no per-quest table churn.
//
// The pool is static (balance-tuned in code, no admin table). Adding
// a quest means appending to QUEST_POOL and shipping; removing a
// quest means removing from QUEST_POOL — players whose stored quest
// references an ID we no longer have will see it re-roll at the next
// day boundary.

import type { Types } from '@hive/shared';

export type QuestId =
  | 'win_3_raids'
  | 'loot_1000_sugar'
  | 'destroy_5_turrets'
  | 'three_star_once'
  | 'deploy_30_units'
  | 'kill_queen_once'
  | 'raid_with_fireant'
  | 'raid_with_scarab'
  | 'place_1_building';

export interface QuestDef {
  id: QuestId;
  label: string;
  goal: number;
  // Reward paid out on claim. Kept modest; main reward is season XP.
  rewardSugar: number;
  rewardLeaf: number;
  rewardXp: number;
}

export const QUEST_POOL: ReadonlyArray<QuestDef> = [
  { id: 'win_3_raids',      label: 'Win 3 raids (1+ star)',                  goal: 3,    rewardSugar: 500,  rewardLeaf: 120, rewardXp: 100 },
  { id: 'loot_1000_sugar',  label: 'Loot 1,000 sugar total',                 goal: 1000, rewardSugar: 300,  rewardLeaf: 80,  rewardXp: 80 },
  { id: 'destroy_5_turrets',label: 'Destroy 5 turrets or spitters in raids', goal: 5,    rewardSugar: 400,  rewardLeaf: 100, rewardXp: 90 },
  { id: 'three_star_once',  label: 'Three-star a raid',                      goal: 1,    rewardSugar: 800,  rewardLeaf: 200, rewardXp: 150 },
  { id: 'deploy_30_units',  label: 'Deploy 30 units in raids',               goal: 30,   rewardSugar: 350,  rewardLeaf: 90,  rewardXp: 70 },
  { id: 'kill_queen_once',  label: 'Kill a defender Queen Chamber',          goal: 1,    rewardSugar: 700,  rewardLeaf: 180, rewardXp: 140 },
  { id: 'raid_with_fireant',label: 'Raid using FireAnt',                     goal: 1,    rewardSugar: 400,  rewardLeaf: 100, rewardXp: 100 },
  { id: 'raid_with_scarab', label: 'Raid using Scarab',                      goal: 1,    rewardSugar: 500,  rewardLeaf: 120, rewardXp: 120 },
  { id: 'place_1_building', label: 'Place a new building in your base',      goal: 1,    rewardSugar: 200,  rewardLeaf: 60,  rewardXp: 60 },
];

export interface DailyQuestState {
  id: QuestId;
  progress: number;
  claimed: boolean;
}

export interface DailyQuests {
  date: string; // YYYY-MM-DD in UTC
  quests: DailyQuestState[];
}

// FNV-1a 32-bit. Same algorithm as matchmaking's deterministicSeed so
// the "today's 3 quests are X/Y/Z" choice is reproducible + stable
// across server restarts.
function fnv1a(src: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < src.length; i++) {
    h = Math.imul(h ^ src.charCodeAt(i), 16777619) >>> 0;
  }
  return h >>> 0;
}

export function utcDateKey(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Deterministic 3-quest pick for a given player + date. Picks without
// replacement by shuffling the pool using a simple seeded swap pass
// and taking the first 3. Stable across multiple calls for the same
// (player, date).
export function rollDailyQuests(playerId: string, dateKey: string): DailyQuests {
  const seed = fnv1a(`${playerId}:${dateKey}`);
  const order = [...QUEST_POOL.map((_, i) => i)];
  // Linear congruential shuffle seeded by fnv. Enough entropy for a
  // 9-element pool — we don't need crypto randomness here.
  let s = seed || 1;
  for (let i = order.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  const picked = order.slice(0, 3).map((idx) => ({
    id: QUEST_POOL[idx]!.id,
    progress: 0,
    claimed: false,
  }));
  return { date: dateKey, quests: picked };
}

// Ensure the stored daily_quests JSONB is fresh. If the stored date
// lags today's UTC date, re-roll and keep claim/progress from being
// carried forward. Call this on any read or write path that touches
// quest state.
export function refreshIfStale(
  stored: unknown,
  playerId: string,
  now: Date = new Date(),
): DailyQuests {
  const today = utcDateKey(now);
  const s = stored as DailyQuests | null | undefined;
  if (!s || typeof s !== 'object' || !Array.isArray(s.quests) || s.date !== today) {
    return rollDailyQuests(playerId, today);
  }
  return s;
}

export interface RaidProgressSignals {
  stars: 0 | 1 | 2 | 3;
  sugarLooted: number;
  leafLooted: number;
  // Count of defender buildings of attacker-interest kinds destroyed.
  // raid.ts computes from the sim result before calling applyRaidProgress.
  turretsDestroyed: number;
  queenKilled: boolean;
  unitsDeployed: number;
  deployedKinds: ReadonlyArray<Types.UnitKind>;
}

// Apply raid signals to active quests. Pure function: takes the
// current daily state, returns the updated copy. Caller is responsible
// for persisting the result.
export function applyRaidProgress(
  current: DailyQuests,
  signals: RaidProgressSignals,
): DailyQuests {
  const next: DailyQuests = {
    date: current.date,
    quests: current.quests.map((q) => ({ ...q })),
  };
  for (const q of next.quests) {
    if (q.claimed) continue;
    const def = QUEST_POOL.find((p) => p.id === q.id);
    if (!def) continue;
    if (q.progress >= def.goal) continue;

    switch (q.id) {
      case 'win_3_raids':
        if (signals.stars >= 1) q.progress++;
        break;
      case 'loot_1000_sugar':
        q.progress = Math.min(def.goal, q.progress + signals.sugarLooted);
        break;
      case 'destroy_5_turrets':
        q.progress = Math.min(def.goal, q.progress + signals.turretsDestroyed);
        break;
      case 'three_star_once':
        if (signals.stars === 3) q.progress = def.goal;
        break;
      case 'deploy_30_units':
        q.progress = Math.min(def.goal, q.progress + signals.unitsDeployed);
        break;
      case 'kill_queen_once':
        if (signals.queenKilled) q.progress = def.goal;
        break;
      case 'raid_with_fireant':
        if (signals.deployedKinds.includes('FireAnt')) q.progress = def.goal;
        break;
      case 'raid_with_scarab':
        if (signals.deployedKinds.includes('Scarab')) q.progress = def.goal;
        break;
      // place_1_building progresses on the building-placement route,
      // not here. No-op in raid signals.
    }
  }
  return next;
}

// Building-placement progress path used by /api/player/building.
export function applyPlacementProgress(current: DailyQuests): DailyQuests {
  const next: DailyQuests = {
    date: current.date,
    quests: current.quests.map((q) => ({ ...q })),
  };
  for (const q of next.quests) {
    if (q.claimed) continue;
    const def = QUEST_POOL.find((p) => p.id === q.id);
    if (!def) continue;
    if (q.id === 'place_1_building' && q.progress < def.goal) {
      q.progress = def.goal;
    }
  }
  return next;
}

export function questDef(id: QuestId): QuestDef | undefined {
  return QUEST_POOL.find((p) => p.id === id);
}
