// Seasonal narrative campaign. Each chapter is a scripted story arc
// themed around a Hive Wars faction; chapters deliver a sequence of
// scripted raids (defender base + unit loadout are fixed), a short
// cinematic-style text crawl between raids, and a milestone reward
// for completion — typically a cosmetic Queen skin + a pile of sugar.
//
// This module is the single source of truth. The server route
// /api/campaign/state returns the structure in full; the client
// renders the chapter list and triggers `/api/campaign/attempt/:id`
// before each scripted raid so the campaign stays server-authoritative.
//
// A chapter is considered "complete" when every mission id in its
// missions list has been added to `campaign_completed_missions` on
// the player row. The flat int column `campaign_progress` counts how
// many of the current chapter's missions are done, so the client can
// draw a progress bar without fetching the full mission log.

export interface CampaignMission {
  id: number;
  slug: string;
  title: string;
  intro: string;     // shown before the mission
  outro: string;     // shown on clear
  difficulty: 'tutorial' | 'easy' | 'medium' | 'hard' | 'boss';
  // Rewards on first clear. Re-playing a cleared mission pays nothing.
  rewardSugar: number;
  rewardLeaf: number;
  rewardXp: number;
}

export interface CampaignChapter {
  id: number;
  slug: string;
  title: string;
  subtitle: string;
  synopsis: string;
  villain: string;
  // Completion reward: awarded once when every mission in the chapter
  // is cleared. `unlockSkinId` is the cosmetic skin ID; null means
  // sugar-only.
  completionSugar: number;
  completionLeaf: number;
  completionAphidMilk: number;
  unlockSkinId: string | null;
  missions: ReadonlyArray<CampaignMission>;
}

export const CAMPAIGN_CHAPTERS: ReadonlyArray<CampaignChapter> = [
  {
    id: 1,
    slug: 'the-first-raid',
    title: 'The First Raid',
    subtitle: 'Chapter 1',
    synopsis:
      'The old hive fractures. Your queen steps into the sun for the first time. ' +
      'The backyard is smaller than the stories promised — and far more dangerous.',
    villain: 'Red Scout',
    completionSugar: 500,
    completionLeaf: 150,
    completionAphidMilk: 1,
    unlockSkinId: null,
    missions: [
      {
        id: 101, slug: 'awakening', title: 'Awakening',
        intro: 'Your scouts have found a rival outpost. The path is short — follow it.',
        outro: 'The outpost falls. The queen smiles. Briefly.',
        difficulty: 'tutorial',
        rewardSugar: 100, rewardLeaf: 30, rewardXp: 20,
      },
      {
        id: 102, slug: 'tunnel-feint', title: 'Tunnel Feint',
        intro: 'Two paths this time — one on the leaves, one through the dirt.',
        outro: 'The warrens run deeper than you knew. Remember that.',
        difficulty: 'easy',
        rewardSugar: 200, rewardLeaf: 60, rewardXp: 40,
      },
      {
        id: 103, slug: 'red-scout', title: 'The Red Scout',
        intro: 'A raider colony has watched your hive for weeks. Tonight we answer.',
        outro: 'The Red Scout breaks. Your queen breathes. The backyard listens.',
        difficulty: 'medium',
        rewardSugar: 400, rewardLeaf: 100, rewardXp: 80,
      },
    ],
  },
  {
    id: 2,
    slug: 'the-long-cold',
    title: 'The Long Cold',
    subtitle: 'Chapter 2',
    synopsis:
      "The north wind returns. Whole colonies freeze overnight. Your queen's breath crystallizes. " +
      'Beneath the frost, something older is awake — and it remembers the first hives.',
    villain: 'Ice Drone',
    completionSugar: 1200,
    completionLeaf: 300,
    completionAphidMilk: 3,
    unlockSkinId: 'frost',
    missions: [
      {
        id: 201, slug: 'frost-march', title: 'Frost March',
        intro: 'The snow makes paths visible. It also makes us visible.',
        outro: 'Victory in the snow is a sharper thing. Write this down.',
        difficulty: 'medium',
        rewardSugar: 350, rewardLeaf: 90, rewardXp: 80,
      },
      {
        id: 202, slug: 'hollow-root', title: 'Hollow Root',
        intro: 'A frozen colony, or so the scouts claim. Verify. Loot. Leave.',
        outro: 'It was not frozen. It was waiting.',
        difficulty: 'medium',
        rewardSugar: 500, rewardLeaf: 120, rewardXp: 100,
      },
      {
        id: 203, slug: 'ice-drone', title: 'The Ice Drone',
        intro: "It walks on six legs of frost. It does not speak. It does not surrender.",
        outro: 'The Drone melts into steam. For a breath, the backyard is warm.',
        difficulty: 'boss',
        rewardSugar: 900, rewardLeaf: 220, rewardXp: 180,
      },
    ],
  },
  {
    id: 3,
    slug: 'verdant-return',
    title: 'The Verdant Return',
    subtitle: 'Chapter 3',
    synopsis:
      "Spring arrives. The moss remembers. In the green shade beneath the fence, " +
      'a council of queens convenes — and one of them wears a crown of roots.',
    villain: 'Moss Matriarch',
    completionSugar: 2500,
    completionLeaf: 600,
    completionAphidMilk: 5,
    unlockSkinId: 'verdant',
    missions: [
      {
        id: 301, slug: 'root-knock', title: 'Root Knock',
        intro: 'The roots of the oak have dug into our tunnels. Cut them or learn from them.',
        outro: "The roots spoke first. They said 'follow.'",
        difficulty: 'hard',
        rewardSugar: 700, rewardLeaf: 180, rewardXp: 150,
      },
      {
        id: 302, slug: 'moss-council', title: 'The Moss Council',
        intro: 'Six queens around a stone. One of them is you. One of them is hungry.',
        outro: 'You walk out. That is enough.',
        difficulty: 'hard',
        rewardSugar: 1000, rewardLeaf: 250, rewardXp: 200,
      },
      {
        id: 303, slug: 'matriarch', title: 'The Matriarch',
        intro: 'Her crown is alive. Her voice is every queen who came before.',
        outro: 'The crown falls. It is yours to wear — if you dare.',
        difficulty: 'boss',
        rewardSugar: 1800, rewardLeaf: 450, rewardXp: 300,
      },
    ],
  },
];

export function chapterById(id: number): CampaignChapter | undefined {
  return CAMPAIGN_CHAPTERS.find((c) => c.id === id);
}

export function missionById(id: number): { chapter: CampaignChapter; mission: CampaignMission } | undefined {
  for (const c of CAMPAIGN_CHAPTERS) {
    const m = c.missions.find((mm) => mm.id === id);
    if (m) return { chapter: c, mission: m };
  }
  return undefined;
}

// Given a completed-missions set, compute:
//   - which chapter is currently "active" (first chapter with at least
//     one unfinished mission, bounded by what the player has unlocked)
//   - completed-mission count inside that chapter
//   - whether the chapter itself is fully cleared (milestone ready)
export function computeCampaignState(
  completedMissionIds: ReadonlyArray<number>,
  unlockedChapter: number,
): {
  activeChapterId: number;
  progressInChapter: number;
  chapterComplete: boolean;
} {
  const completed = new Set(completedMissionIds);
  let activeId = 1;
  for (const c of CAMPAIGN_CHAPTERS) {
    if (c.id > unlockedChapter) break;
    const remaining = c.missions.some((m) => !completed.has(m.id));
    if (remaining) {
      const progressInChapter = c.missions.filter((m) => completed.has(m.id)).length;
      return {
        activeChapterId: c.id,
        progressInChapter,
        chapterComplete: false,
      };
    }
    activeId = c.id;
  }
  // Fully-cleared chapter but haven't unlocked the next one yet.
  const chapter = chapterById(activeId);
  const progressInChapter = chapter ? chapter.missions.length : 0;
  return {
    activeChapterId: activeId,
    progressInChapter,
    chapterComplete: true,
  };
}
