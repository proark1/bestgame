import { describe, expect, it } from 'vitest';
import {
  QUEST_POOL,
  applyPlacementProgress,
  applyRaidProgress,
  refreshIfStale,
  rollDailyQuests,
  utcDateKey,
} from '../src/game/quests.js';
import {
  CURRENT_SEASON_ID,
  RAID_XP_BY_STARS,
  SEASON_MILESTONES,
  milestoneById,
  xpForRaid,
} from '../src/game/season.js';
import { SHIELD_HOURS_ON_2_STAR, SHIELD_HOURS_ON_3_STAR, shieldHoursForStars } from '../src/game/shield.js';

describe('raid shield', () => {
  it('only grants on 2+ star losses', () => {
    expect(shieldHoursForStars(0)).toBeNull();
    expect(shieldHoursForStars(1)).toBeNull();
    expect(shieldHoursForStars(2)).toBe(SHIELD_HOURS_ON_2_STAR);
    expect(shieldHoursForStars(3)).toBe(SHIELD_HOURS_ON_3_STAR);
  });

  it('3-star shield is longer than 2-star', () => {
    expect(SHIELD_HOURS_ON_3_STAR).toBeGreaterThan(SHIELD_HOURS_ON_2_STAR);
  });
});

describe('daily quest rotation', () => {
  it('produces 3 quests from the pool', () => {
    const rolled = rollDailyQuests('player-abc', '2026-04-23');
    expect(rolled.date).toBe('2026-04-23');
    expect(rolled.quests).toHaveLength(3);
    for (const q of rolled.quests) {
      expect(q.progress).toBe(0);
      expect(q.claimed).toBe(false);
      expect(QUEST_POOL.find((p) => p.id === q.id)).toBeDefined();
    }
  });

  it('is deterministic for the same (player, date)', () => {
    const a = rollDailyQuests('player-xyz', '2026-04-23');
    const b = rollDailyQuests('player-xyz', '2026-04-23');
    expect(a.quests.map((q) => q.id)).toEqual(b.quests.map((q) => q.id));
  });

  it('differs across players', () => {
    // Not guaranteed for any particular pair but should differ across
    // 5 random-ish ids almost all the time — enough signal that the
    // per-player salt is actually applied.
    const seen = new Set<string>();
    for (const pid of ['a', 'b', 'c', 'd', 'e']) {
      const r = rollDailyQuests(pid, '2026-04-23');
      seen.add(r.quests.map((q) => q.id).join(','));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('refreshes when stored date is stale', () => {
    const stale = { date: '2020-01-01', quests: [] };
    const refreshed = refreshIfStale(stale, 'player-1');
    expect(refreshed.date).toBe(utcDateKey());
    expect(refreshed.quests).toHaveLength(3);
  });

  it('keeps progress intact for today', () => {
    const today = utcDateKey();
    const base = rollDailyQuests('player-2', today);
    base.quests[0]!.progress = 1;
    const refreshed = refreshIfStale(base, 'player-2');
    expect(refreshed).toBe(base);
    expect(refreshed.quests[0]!.progress).toBe(1);
  });
});

describe('applyRaidProgress', () => {
  it('credits wins toward win_3_raids', () => {
    // Force a quest we know about into the quest list.
    const state = {
      date: utcDateKey(),
      quests: [
        { id: 'win_3_raids' as const, progress: 0, claimed: false },
      ],
    };
    const after = applyRaidProgress(state, {
      stars: 1,
      sugarLooted: 0,
      leafLooted: 0,
      turretsDestroyed: 0,
      queenKilled: false,
      unitsDeployed: 0,
      deployedKinds: [],
    });
    expect(after.quests[0]!.progress).toBe(1);
  });

  it('caps progress at the goal', () => {
    const state = {
      date: utcDateKey(),
      quests: [
        { id: 'loot_1000_sugar' as const, progress: 950, claimed: false },
      ],
    };
    const after = applyRaidProgress(state, {
      stars: 1,
      sugarLooted: 500,
      leafLooted: 0,
      turretsDestroyed: 0,
      queenKilled: false,
      unitsDeployed: 0,
      deployedKinds: [],
    });
    expect(after.quests[0]!.progress).toBe(1000);
  });

  it('does not touch claimed quests', () => {
    const state = {
      date: utcDateKey(),
      quests: [
        { id: 'three_star_once' as const, progress: 1, claimed: true },
      ],
    };
    const after = applyRaidProgress(state, {
      stars: 3,
      sugarLooted: 0,
      leafLooted: 0,
      turretsDestroyed: 0,
      queenKilled: true,
      unitsDeployed: 0,
      deployedKinds: [],
    });
    expect(after.quests[0]!.progress).toBe(1);
    expect(after.quests[0]!.claimed).toBe(true);
  });

  it('flips raid_with_fireant only when FireAnt was deployed', () => {
    const state = {
      date: utcDateKey(),
      quests: [
        { id: 'raid_with_fireant' as const, progress: 0, claimed: false },
      ],
    };
    const a = applyRaidProgress(state, {
      stars: 0, sugarLooted: 0, leafLooted: 0, turretsDestroyed: 0,
      queenKilled: false, unitsDeployed: 10, deployedKinds: ['SoldierAnt'],
    });
    expect(a.quests[0]!.progress).toBe(0);
    const b = applyRaidProgress(state, {
      stars: 0, sugarLooted: 0, leafLooted: 0, turretsDestroyed: 0,
      queenKilled: false, unitsDeployed: 5, deployedKinds: ['FireAnt'],
    });
    expect(b.quests[0]!.progress).toBe(1);
  });

  it('applyPlacementProgress completes place_1_building', () => {
    const state = {
      date: utcDateKey(),
      quests: [
        { id: 'place_1_building' as const, progress: 0, claimed: false },
      ],
    };
    const after = applyPlacementProgress(state);
    expect(after.quests[0]!.progress).toBe(1);
  });
});

describe('season track', () => {
  it('XP by stars is monotonic', () => {
    expect(xpForRaid(0)).toBe(0);
    expect(xpForRaid(1)).toBeLessThan(xpForRaid(2));
    expect(xpForRaid(2)).toBeLessThan(xpForRaid(3));
    expect(xpForRaid(3)).toBe(RAID_XP_BY_STARS[3]);
  });

  it('milestones are strictly increasing XP thresholds', () => {
    for (let i = 1; i < SEASON_MILESTONES.length; i++) {
      expect(SEASON_MILESTONES[i]!.xpRequired).toBeGreaterThan(
        SEASON_MILESTONES[i - 1]!.xpRequired,
      );
    }
  });

  it('milestoneById returns the right tier', () => {
    const m = milestoneById(3);
    expect(m?.id).toBe(3);
    expect(milestoneById(999)).toBeUndefined();
  });

  it('current season id is set', () => {
    expect(CURRENT_SEASON_ID).toMatch(/^S/);
  });
});
