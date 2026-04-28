// Session win-streak — purely client-side counter that resets on
// loss + when the session ends. Distinct from the server-side
// daily login streak: this is the "I just won three in a row" hot-
// streak that converts in-session momentum into a visible chip on
// the HUD ("🔥 3 in a row! +25% next loot").
//
// Loot multiplier is decorative — applied client-side as a UI
// hint only. Actual loot still comes from the server's clamp
// (clampLootByRank). A future enhancement could pass the streak
// to /raid/submit and have the server mint a real bonus payout;
// for now the chip is a visible celebration that drives the
// "one more raid" pull without a sim/economy change.

const STORAGE_KEY = 'hive.winStreak';

export interface WinStreakState {
  count: number;
  // Wall-clock ms of the last update — lets us gate "still in this
  // session" vs "came back two days later" without a server.
  // Streak resets after STREAK_TIMEOUT_MS of inactivity.
  updatedAt: number;
}

const STREAK_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

const DEFAULT: WinStreakState = { count: 0, updatedAt: 0 };

export function readWinStreak(): WinStreakState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw) as Partial<WinStreakState>;
    const count = typeof parsed.count === 'number' ? parsed.count : 0;
    const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0;
    // Auto-expire stale streaks. Keeps the chip honest — coming back
    // tomorrow shouldn't show "you're on a 3-streak!" from yesterday.
    if (Date.now() - updatedAt > STREAK_TIMEOUT_MS) {
      return { ...DEFAULT };
    }
    return { count: Math.max(0, count), updatedAt };
  } catch {
    return { ...DEFAULT };
  }
}

function write(state: WinStreakState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode */
  }
}

// Called from RaidScene's result handler. Returns the new state so
// the result card can render "🔥 3 in a row!" inline.
export function recordRaidOutcome(won: boolean): WinStreakState {
  const cur = readWinStreak();
  const next: WinStreakState = won
    ? { count: cur.count + 1, updatedAt: Date.now() }
    : { count: 0, updatedAt: Date.now() };
  write(next);
  return next;
}

// Loot bonus multiplier hint, expressed as percent above 100 (e.g.
// 25 = +25%). Tuned so a 1-streak shows nothing, a 3-streak shows
// +25%, a 5-streak +50%, capped at +75% to avoid a runaway curve.
// Decorative until the server adopts the same curve.
export function streakBonusPct(count: number): number {
  if (count < 2) return 0;
  if (count < 3) return 10;
  if (count < 5) return 25;
  if (count < 7) return 50;
  return 75;
}
