// Login streaks + comeback bonus. Triggered off `GET /api/player/me`,
// which is the first call every client session makes; incrementing on
// the first visit of each UTC day, resetting on a miss.
//
// The contract is deliberately small:
//   - one day of "credit" per UTC day (no double-dipping in a single day)
//   - a 1-day gap is forgiven (streak stays intact)
//   - a 2+ day gap resets the streak to 1 AND flags the player as
//     "comeback eligible" so HomeScene can show a welcome banner.
//
// Rewards are consumed via /player/streak/claim. The streak_last_claim
// column guards against re-claiming the same milestone within one run of
// the streak, without blocking the NEXT milestone after streak_count
// advances.

import { utcDateKey } from './quests.js';

// Compounding weekly curve — hand-tuned so "make it a week" is a
// visible payoff. Day 7 is deliberately juicy; rare cosmetic tokens
// could eventually layer on top.
export interface StreakReward {
  day: number;
  sugar: number;
  leafBits: number;
  aphidMilk: number;
  label: string;
}

export const STREAK_REWARDS: ReadonlyArray<StreakReward> = [
  { day: 1, sugar: 150,  leafBits: 40,  aphidMilk: 0,  label: 'Day 1 — Welcome' },
  { day: 2, sugar: 250,  leafBits: 60,  aphidMilk: 0,  label: 'Day 2 — Again' },
  { day: 3, sugar: 400,  leafBits: 100, aphidMilk: 0,  label: 'Day 3 — Committed' },
  { day: 4, sugar: 600,  leafBits: 150, aphidMilk: 0,  label: 'Day 4 — Routine' },
  { day: 5, sugar: 900,  leafBits: 220, aphidMilk: 1,  label: 'Day 5 — Regular' },
  { day: 6, sugar: 1300, leafBits: 320, aphidMilk: 2,  label: 'Day 6 — So Close' },
  { day: 7, sugar: 2000, leafBits: 500, aphidMilk: 5,  label: 'Day 7 — Hive Master' },
];

// Reward for a pending comeback flag. Once paid we clear the flag.
export const COMEBACK_REWARD: Omit<StreakReward, 'day' | 'label'> = {
  sugar: 1200,
  leafBits: 300,
  aphidMilk: 3,
};

export function rewardForDay(day: number): StreakReward {
  if (day <= 0) return STREAK_REWARDS[0]!;
  // Past day 7 the table wraps — same rewards but the counter keeps
  // ticking so the UI always shows "Day N". Tuning the wrap later is
  // a one-line change once we have real data on how many players
  // actually roll past a week.
  return STREAK_REWARDS[Math.min(STREAK_REWARDS.length, day) - 1]!;
}

export interface StreakResolution {
  streakCount: number;
  lastDay: string;
  comebackPending: boolean;
  creditedToday: boolean; // set when we tick the streak on this call
}

// Pure core: given stored state + today's date, decide the new state.
export function resolveStreak(
  prevCount: number,
  prevDay: string,
  prevComeback: boolean,
  today: string = utcDateKey(),
): StreakResolution {
  if (!prevDay) {
    // First ever credit.
    return {
      streakCount: 1,
      lastDay: today,
      comebackPending: false,
      creditedToday: true,
    };
  }
  if (prevDay === today) {
    // Already credited this UTC day.
    return {
      streakCount: prevCount,
      lastDay: prevDay,
      comebackPending: prevComeback,
      creditedToday: false,
    };
  }
  const gap = dayGap(prevDay, today);
  if (gap <= 0) {
    // Clock went backwards (DB-side NOW vs app clock) — ignore.
    return {
      streakCount: prevCount,
      lastDay: prevDay,
      comebackPending: prevComeback,
      creditedToday: false,
    };
  }
  if (gap === 1) {
    return {
      streakCount: prevCount + 1,
      lastDay: today,
      comebackPending: false,
      creditedToday: true,
    };
  }
  // gap >= 2 → streak broken. Flag comeback if they were away 3+ days.
  const triggerComeback = gap >= 3;
  return {
    streakCount: 1,
    lastDay: today,
    comebackPending: triggerComeback,
    creditedToday: true,
  };
}

function dayGap(fromKey: string, toKey: string): number {
  const a = parseDateKey(fromKey);
  const b = parseDateKey(toKey);
  if (!a || !b) return 1;
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / 86_400_000);
}

function parseDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
