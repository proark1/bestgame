// Lightweight client-side achievements. Each achievement maps to a
// counter (raids played, 3-star wins, sugar looted, etc.) and a
// threshold. recordEvent() bumps a counter, then checks every
// achievement keyed off that counter and unlocks the first one whose
// threshold the bump just crossed. Purely localStorage today; a
// future server migration can mirror these to player_achievements
// without changing the public surface here.
//
// Wire-in pattern: each raid result calls recordRaidStats({ won,
// stars, sugarLooted, ... }) which fans out to recordEvent() for
// each metric. Toasts surface at the call site.

const STORAGE_KEY = 'hive.achievements.v1';

export type AchievementMetric =
  | 'raids_total'
  | 'raids_won'
  | 'three_stars'
  | 'queen_kills'
  | 'sugar_looted'
  | 'buildings_destroyed'
  | 'win_streak_peak'
  | 'tactics_saved'
  | 'replays_watched';

export interface AchievementDef {
  id: string;
  title: string;
  description: string;
  metric: AchievementMetric;
  threshold: number;
  // Single-glyph icon — emoji is fine, renders in the achievements
  // list and the unlock toast.
  icon: string;
  // Tier groups achievements visually: bronze < silver < gold. Used
  // for badge fill colours and ordering on the shelf.
  tier: 'bronze' | 'silver' | 'gold';
}

// Compact catalog — extend by appending. IDs are stable forever:
// renaming one would orphan unlocks. Thresholds are tuned so the
// ladder rewards a weekend player at bronze/silver and a months-long
// player at gold.
export const ACHIEVEMENTS: ReadonlyArray<AchievementDef> = [
  // Engagement
  { id: 'first_raid',     title: 'First Steps',      description: 'Run your very first raid.',           metric: 'raids_total',         threshold: 1,    icon: '👣', tier: 'bronze' },
  { id: 'ten_raids',      title: 'Sustained Effort', description: 'Run 10 raids.',                       metric: 'raids_total',         threshold: 10,   icon: '🔁', tier: 'bronze' },
  { id: 'hundred_raids',  title: 'Centurion',        description: 'Run 100 raids.',                      metric: 'raids_total',         threshold: 100,  icon: '🏛️', tier: 'silver' },
  { id: 'thousand_raids', title: 'Lifer',            description: 'Run 1000 raids.',                     metric: 'raids_total',         threshold: 1000, icon: '⚔️', tier: 'gold' },
  // Mastery
  { id: 'first_win',      title: 'Drew First Blood', description: 'Win your first raid.',                metric: 'raids_won',           threshold: 1,    icon: '🩸', tier: 'bronze' },
  { id: 'first_3star',    title: 'Triple Crown',     description: 'Earn your first 3-star raid.',        metric: 'three_stars',         threshold: 1,    icon: '★',  tier: 'silver' },
  { id: 'ten_3star',      title: 'Triple Threat',    description: 'Land 10 3-star raids.',               metric: 'three_stars',         threshold: 10,   icon: '✨', tier: 'silver' },
  { id: 'queen_slayer_1', title: 'Queen Slayer',     description: 'Take down your first Queen Chamber.', metric: 'queen_kills',         threshold: 1,    icon: '👑', tier: 'silver' },
  { id: 'queen_slayer_50',title: 'Regicide',         description: 'Topple 50 Queens.',                   metric: 'queen_kills',         threshold: 50,   icon: '🗡️', tier: 'gold' },
  // Economy
  { id: 'sugar_1k',       title: 'Sweet Tooth',      description: 'Loot 1,000 total sugar.',             metric: 'sugar_looted',        threshold: 1000, icon: '🍬', tier: 'bronze' },
  { id: 'sugar_50k',      title: 'Hoarder',          description: 'Loot 50,000 total sugar.',            metric: 'sugar_looted',        threshold: 50_000, icon: '🍯', tier: 'gold' },
  // Combat
  { id: 'demolitionist',  title: 'Demolitionist',    description: 'Destroy 100 buildings across raids.', metric: 'buildings_destroyed', threshold: 100,  icon: '💥', tier: 'silver' },
  // Streaks
  { id: 'streak_3',       title: 'Hat Trick',        description: 'Win 3 raids in a row.',               metric: 'win_streak_peak',     threshold: 3,    icon: '🔥', tier: 'silver' },
  { id: 'streak_10',      title: 'Unstoppable',      description: 'Win 10 raids in a row.',              metric: 'win_streak_peak',     threshold: 10,   icon: '⚡', tier: 'gold' },
  // Meta
  { id: 'tactic_lover',   title: 'Tactician',        description: 'Save 5 tactics to your library.',     metric: 'tactics_saved',       threshold: 5,    icon: '📐', tier: 'bronze' },
  { id: 'replay_fan',     title: 'Spectator',        description: 'Watch 25 replays from the feed.',     metric: 'replays_watched',     threshold: 25,   icon: '🎬', tier: 'silver' },
];

interface State {
  counters: Partial<Record<AchievementMetric, number>>;
  unlocked: Record<string, string>; // id → ISO date
}

function read(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { counters: {}, unlocked: {} };
    const parsed = JSON.parse(raw) as Partial<State>;
    return {
      counters: parsed.counters ?? {},
      unlocked: parsed.unlocked ?? {},
    };
  } catch {
    return { counters: {}, unlocked: {} };
  }
}

function write(s: State): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

export function getAchievementCounters(): Record<AchievementMetric, number> {
  const s = read();
  return {
    raids_total: s.counters.raids_total ?? 0,
    raids_won: s.counters.raids_won ?? 0,
    three_stars: s.counters.three_stars ?? 0,
    queen_kills: s.counters.queen_kills ?? 0,
    sugar_looted: s.counters.sugar_looted ?? 0,
    buildings_destroyed: s.counters.buildings_destroyed ?? 0,
    win_streak_peak: s.counters.win_streak_peak ?? 0,
    tactics_saved: s.counters.tactics_saved ?? 0,
    replays_watched: s.counters.replays_watched ?? 0,
  };
}

export function getUnlocked(): Record<string, string> {
  return read().unlocked;
}

// Bump a counter and unlock any achievements whose threshold the bump
// just crossed. Returns the list of newly-unlocked defs so the caller
// can stack toasts.
export function recordEvent(
  metric: AchievementMetric,
  delta: number,
): AchievementDef[] {
  if (!Number.isFinite(delta) || delta === 0) return [];
  const s = read();
  const before = s.counters[metric] ?? 0;
  // For "peak" metrics (e.g. win_streak_peak) we set rather than
  // accumulate — caller passes the new peak value. Detected by
  // metric name suffix to keep the API tiny.
  const isPeak = metric.endsWith('_peak');
  const after = isPeak ? Math.max(before, delta) : before + delta;
  s.counters[metric] = after;
  const unlocked: AchievementDef[] = [];
  for (const def of ACHIEVEMENTS) {
    if (def.metric !== metric) continue;
    if (s.unlocked[def.id]) continue;
    if (after >= def.threshold) {
      s.unlocked[def.id] = new Date().toISOString();
      unlocked.push(def);
    }
  }
  write(s);
  return unlocked;
}

// Convenience for the raid-result handler — emits all relevant
// metrics in one call. Returns the union of newly-unlocked defs.
export function recordRaidStats(args: {
  won: boolean;
  stars: 0 | 1 | 2 | 3;
  queenKilled: boolean;
  sugarLooted: number;
  buildingsDestroyed: number;
  winStreakAfter: number;
}): AchievementDef[] {
  const out: AchievementDef[] = [];
  out.push(...recordEvent('raids_total', 1));
  if (args.won) out.push(...recordEvent('raids_won', 1));
  if (args.stars === 3) out.push(...recordEvent('three_stars', 1));
  if (args.queenKilled) out.push(...recordEvent('queen_kills', 1));
  if (args.sugarLooted > 0) out.push(...recordEvent('sugar_looted', args.sugarLooted));
  if (args.buildingsDestroyed > 0) {
    out.push(...recordEvent('buildings_destroyed', args.buildingsDestroyed));
  }
  out.push(...recordEvent('win_streak_peak', args.winStreakAfter));
  return out;
}
