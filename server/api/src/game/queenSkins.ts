// Queen skin catalog — the Queen is the player's identity anchor.
// Every skin is cosmetic-only (no stat effects); gameplay impact is
// strictly zero so matchmaking stays on a level field.
//
// Unlock rules are intentionally mixed:
//   - 'default' — always owned
//   - season-chapter unlocks — awarded when the player finishes a
//     campaign chapter (see campaign.ts)
//   - achievement unlocks — awarded by reaching a threshold (trophies,
//     season XP, login streak day)
//   - shop unlocks — paid (AphidMilk) stubs in the catalog; no purchase
//     route is exposed yet, but the shape is stable so the shop can
//     bolt on later.
//
// Adding a skin is a one-line addition here. The client reads the
// catalog via /api/player/queen-skins.

export type QueenSkinUnlockKind =
  | { kind: 'default' }
  | { kind: 'trophies';   threshold: number }
  | { kind: 'streak';     day: number }
  | { kind: 'seasonXp';   xp: number }
  | { kind: 'chapter';    chapterId: number }
  | { kind: 'shop';       aphidMilk: number };

export interface QueenSkinDef {
  id: string;
  name: string;
  tagline: string;
  // Client renders the portrait from `/assets/ui/queens/${portraitKey}.png`,
  // falling back to a Graphics-painted silhouette when the sprite
  // isn't generated yet. Keeps the skin list usable before all art
  // lands.
  portraitKey: string;
  unlock: QueenSkinUnlockKind;
  // Small palette triplet so the client can tint the silhouette
  // fallback in distinctive colors.
  palette: { primary: number; accent: number; glow: number };
}

export const QUEEN_SKINS: ReadonlyArray<QueenSkinDef> = [
  {
    id: 'default',
    name: 'Amber Queen',
    tagline: 'The matriarch of the warm hollow.',
    portraitKey: 'queen-default',
    unlock: { kind: 'default' },
    palette: { primary: 0xd9a05a, accent: 0x7a4a22, glow: 0xffe7b0 },
  },
  {
    id: 'obsidian',
    name: 'Obsidian Queen',
    tagline: 'Carved from the volcanic roots of the old hive.',
    portraitKey: 'queen-obsidian',
    unlock: { kind: 'trophies', threshold: 800 },
    palette: { primary: 0x222028, accent: 0x5a4a7a, glow: 0xa090ff },
  },
  {
    id: 'honeydew',
    name: 'Honeydew Queen',
    tagline: 'Rumored to sweeten sugar with a single breath.',
    portraitKey: 'queen-honeydew',
    unlock: { kind: 'streak', day: 7 },
    palette: { primary: 0xf5d26a, accent: 0x7a5a10, glow: 0xfff8c0 },
  },
  {
    id: 'frost',
    name: 'Frost Queen',
    tagline: 'She walked through the Long Cold unharmed.',
    portraitKey: 'queen-frost',
    unlock: { kind: 'chapter', chapterId: 2 },
    palette: { primary: 0xaad0e8, accent: 0x355a7a, glow: 0xe0f0ff },
  },
  {
    id: 'ember',
    name: 'Ember Queen',
    tagline: 'Drawn to the furnace of every raid.',
    portraitKey: 'queen-ember',
    unlock: { kind: 'seasonXp', xp: 3000 },
    palette: { primary: 0xe8503a, accent: 0x7a1a10, glow: 0xffa078 },
  },
  {
    id: 'verdant',
    name: 'Verdant Queen',
    tagline: 'Crowned in moss by the roots of the world.',
    portraitKey: 'queen-verdant',
    unlock: { kind: 'chapter', chapterId: 3 },
    palette: { primary: 0x78b050, accent: 0x305020, glow: 0xc8ffa0 },
  },
  {
    id: 'silver',
    name: 'Silver Queen',
    tagline: 'The scout who returned bearing news of a second sun.',
    portraitKey: 'queen-silver',
    unlock: { kind: 'shop', aphidMilk: 400 },
    palette: { primary: 0xc8d0d8, accent: 0x3a4858, glow: 0xf0f8ff },
  },
];

export function skinById(id: string): QueenSkinDef | undefined {
  return QUEEN_SKINS.find((s) => s.id === id);
}

export interface SkinUnlockCheckState {
  trophies: number;
  streakCount: number;
  seasonXp: number;
  campaignChapter: number;
}

// Scan the catalog, returning every skin id the player has now qualified
// for based on their stats. Purchases aren't auto-unlocked — they stay
// pending until the shop route debits resources.
export function scanUnlockedSkins(state: SkinUnlockCheckState): string[] {
  const unlocked: string[] = [];
  for (const s of QUEEN_SKINS) {
    if (unlockRuleSatisfied(s.unlock, state)) unlocked.push(s.id);
  }
  return unlocked;
}

function unlockRuleSatisfied(
  rule: QueenSkinUnlockKind,
  state: SkinUnlockCheckState,
): boolean {
  switch (rule.kind) {
    case 'default':
      return true;
    case 'trophies':
      return state.trophies >= rule.threshold;
    case 'streak':
      return state.streakCount >= rule.day;
    case 'seasonXp':
      return state.seasonXp >= rule.xp;
    case 'chapter':
      return state.campaignChapter > rule.chapterId;
    case 'shop':
      return false; // purchased-only; caller adds explicitly
  }
}
