// Trophy tier — visible ladder identity.
//
// Distinct from `colonyRank` (which gates loot caps based on lifetime
// investment): this is the public-facing ladder badge a player wears
// based on current trophy count. Worker → Soldier → Drone → Sentinel
// → Queen → Hive Lord. Each tier subdivides into 3 stripes (I/II/III)
// so progression feels granular even within a tier.
//
// Pure function so the client + server agree without a round-trip,
// and it can be surfaced anywhere a trophy count appears (HUD chip,
// leaderboard badge, raid result card).

export interface TrophyTier {
  id: number;            // 0 = Worker I … grows monotonically
  name: string;          // 'Worker', 'Soldier', etc.
  stripe: 'I' | 'II' | 'III';
  threshold: number;     // trophies required to reach THIS tier
  nextThreshold: number | null; // trophies for next tier; null at top
  // Hex tint for rendering the badge — caller picks fill vs. text
  // contrast. Steps from earthy bronze through hot gold so the
  // ladder reads at a glance.
  color: number;
  // Glyph rendered in the badge. Single emoji so the renderer can
  // drop it into a text node without atlas plumbing.
  glyph: string;
}

// Hand-tuned curve. Spacing is denser at the bottom (frequent
// promotions early) and stretches at the top (Hive Lord stays rare).
// A casual player at ~120 trophies sits at Worker II; a serious
// daily player ends a season around Drone III; ladder leaders push
// past Hive Lord.
const TIER_TABLE: ReadonlyArray<Omit<TrophyTier, 'nextThreshold'>> = [
  { id: 0,  name: 'Worker',   stripe: 'I',   threshold: 0,    color: 0xb8a285, glyph: '🐜' },
  { id: 1,  name: 'Worker',   stripe: 'II',  threshold: 80,   color: 0xb8a285, glyph: '🐜' },
  { id: 2,  name: 'Worker',   stripe: 'III', threshold: 160,  color: 0xb8a285, glyph: '🐜' },
  { id: 3,  name: 'Soldier',  stripe: 'I',   threshold: 280,  color: 0x8edaa1, glyph: '🛡' },
  { id: 4,  name: 'Soldier',  stripe: 'II',  threshold: 420,  color: 0x8edaa1, glyph: '🛡' },
  { id: 5,  name: 'Soldier',  stripe: 'III', threshold: 600,  color: 0x8edaa1, glyph: '🛡' },
  { id: 6,  name: 'Drone',    stripe: 'I',   threshold: 820,  color: 0x9cdaef, glyph: '🦋' },
  { id: 7,  name: 'Drone',    stripe: 'II',  threshold: 1080, color: 0x9cdaef, glyph: '🦋' },
  { id: 8,  name: 'Drone',    stripe: 'III', threshold: 1380, color: 0x9cdaef, glyph: '🦋' },
  { id: 9,  name: 'Sentinel', stripe: 'I',   threshold: 1720, color: 0xff90a8, glyph: '⚔' },
  { id: 10, name: 'Sentinel', stripe: 'II',  threshold: 2120, color: 0xff90a8, glyph: '⚔' },
  { id: 11, name: 'Sentinel', stripe: 'III', threshold: 2580, color: 0xff90a8, glyph: '⚔' },
  { id: 12, name: 'Queen',    stripe: 'I',   threshold: 3100, color: 0xfdcd6a, glyph: '👑' },
  { id: 13, name: 'Queen',    stripe: 'II',  threshold: 3700, color: 0xfdcd6a, glyph: '👑' },
  { id: 14, name: 'Queen',    stripe: 'III', threshold: 4400, color: 0xfdcd6a, glyph: '👑' },
  { id: 15, name: 'Hive Lord',stripe: 'I',   threshold: 5200, color: 0xff7a92, glyph: '🏆' },
  { id: 16, name: 'Hive Lord',stripe: 'II',  threshold: 6200, color: 0xff7a92, glyph: '🏆' },
  { id: 17, name: 'Hive Lord',stripe: 'III', threshold: 7500, color: 0xff7a92, glyph: '🏆' },
];

// Resolve a trophy count to its tier. Linear search is fine: 18
// entries, one ladder lookup per HUD render.
export function trophyTierFor(trophies: number): TrophyTier {
  const t = Math.max(0, Math.floor(trophies));
  let chosen = TIER_TABLE[0]!;
  for (let i = TIER_TABLE.length - 1; i >= 0; i--) {
    const row = TIER_TABLE[i]!;
    if (t >= row.threshold) {
      chosen = row;
      break;
    }
  }
  const next = TIER_TABLE[chosen.id + 1];
  return {
    ...chosen,
    nextThreshold: next ? next.threshold : null,
  };
}

// Returns 0..1 progress through the current tier toward the next.
// 1 means "you have enough to promote" — useful for a thin progress
// pill under the tier badge.
export function trophyTierProgress(trophies: number): number {
  const tier = trophyTierFor(trophies);
  if (tier.nextThreshold === null) return 1;
  const span = tier.nextThreshold - tier.threshold;
  const into = Math.max(0, Math.floor(trophies) - tier.threshold);
  return Math.max(0, Math.min(1, span === 0 ? 1 : into / span));
}
