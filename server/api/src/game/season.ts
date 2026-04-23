// Season XP track — the "keep pulling me back for 30 days" lever.
//
// A season is a named window (e.g. "S1") with a shared milestone
// curve that every player chases in parallel. XP comes in from three
// sources:
//   * every successful raid (1+ star)              → RAID_XP_BY_STARS
//   * claiming a daily quest                        → QuestDef.rewardXp
//   * (future) placing / upgrading buildings
//
// Milestones sit at flat XP thresholds and pay out one-time rewards
// (sugar, leaf bits, and eventually cosmetics). Each milestone is
// claim-once-per-season per player, tracked in the
// `season_milestones_claimed` int array.
//
// Rolling to a new season is as simple as bumping CURRENT_SEASON_ID
// and (optionally) running a background job that zeroes season_xp on
// all players. This module is the single source of truth so the UI,
// claim endpoint, and XP award points agree.

export const CURRENT_SEASON_ID = 'S1';

// XP awarded per raid outcome. 0-star raids don't move the track —
// the quest system already pays out on any engagement, and unearned
// XP inflates the curve.
export const RAID_XP_BY_STARS: Readonly<Record<0 | 1 | 2 | 3, number>> = {
  0: 0,
  1: 20,
  2: 40,
  3: 80,
};

export interface SeasonMilestone {
  id: number;      // stable ordinal; don't renumber once shipped
  xpRequired: number;
  label: string;
  rewardSugar: number;
  rewardLeaf: number;
}

// Curve: ~1 milestone per day for a mid-engagement player (≈ 4 raids
// at 2 stars = 160 XP/day). 12 milestones = ~12 days of active play
// to clear the track. Tune the curve by editing thresholds only —
// client reads this table unchanged for the progress bar.
export const SEASON_MILESTONES: ReadonlyArray<SeasonMilestone> = [
  { id: 1,  xpRequired: 100,   label: 'Milestone 1',  rewardSugar: 300,   rewardLeaf: 80 },
  { id: 2,  xpRequired: 250,   label: 'Milestone 2',  rewardSugar: 500,   rewardLeaf: 120 },
  { id: 3,  xpRequired: 500,   label: 'Milestone 3',  rewardSugar: 800,   rewardLeaf: 200 },
  { id: 4,  xpRequired: 900,   label: 'Milestone 4',  rewardSugar: 1200,  rewardLeaf: 300 },
  { id: 5,  xpRequired: 1500,  label: 'Milestone 5',  rewardSugar: 1800,  rewardLeaf: 450 },
  { id: 6,  xpRequired: 2200,  label: 'Milestone 6',  rewardSugar: 2500,  rewardLeaf: 600 },
  { id: 7,  xpRequired: 3000,  label: 'Milestone 7',  rewardSugar: 3200,  rewardLeaf: 800 },
  { id: 8,  xpRequired: 4000,  label: 'Milestone 8',  rewardSugar: 4000,  rewardLeaf: 1000 },
  { id: 9,  xpRequired: 5200,  label: 'Milestone 9',  rewardSugar: 5000,  rewardLeaf: 1250 },
  { id: 10, xpRequired: 6600,  label: 'Milestone 10', rewardSugar: 6000,  rewardLeaf: 1500 },
  { id: 11, xpRequired: 8200,  label: 'Milestone 11', rewardSugar: 7200,  rewardLeaf: 1800 },
  { id: 12, xpRequired: 10000, label: 'Milestone 12', rewardSugar: 9000,  rewardLeaf: 2200 },
];

export function milestoneById(id: number): SeasonMilestone | undefined {
  return SEASON_MILESTONES.find((m) => m.id === id);
}

export function xpForRaid(stars: 0 | 1 | 2 | 3): number {
  return RAID_XP_BY_STARS[stars];
}
