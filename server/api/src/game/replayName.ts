// Shareable replay naming. Looks at the raid inputs + outcome and
// picks a poetic name from a small template set, seeded by the
// raid id so the same raid always gets the same name.
//
// Zero gameplay effect — purely a cosmetic string the share flow
// and replay feed surface.

import type { Types } from '@hive/shared';

export interface ReplayNameInputs {
  raidId: string;
  stars: number;
  sugarLooted: number;
  inputs: ReadonlyArray<Types.SimInput>;
  queenKilled: boolean;
}

// A loose fingerprint of the raid — single path vs multiple, which
// units dominated, whether the queen fell. Feeds the template picker.
interface RaidShape {
  pathCount: number;
  unitsDeployed: number;
  dominantKind: Types.UnitKind | null;
  layersUsed: Set<Types.Layer>;
}

function summarize(inputs: ReadonlyArray<Types.SimInput>): RaidShape {
  let paths = 0;
  let total = 0;
  const counts = new Map<Types.UnitKind, number>();
  const layers = new Set<Types.Layer>();
  for (const inp of inputs) {
    if (inp.type !== 'deployPath') continue;
    paths++;
    const c = inp.path?.count ?? 0;
    const kind = inp.path?.unitKind;
    total += c;
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + c);
    const layer = inp.path?.spawnLayer;
    if (layer !== undefined) layers.add(layer);
  }
  let dominant: Types.UnitKind | null = null;
  let max = 0;
  for (const [k, v] of counts) {
    if (v > max) {
      max = v;
      dominant = k;
    }
  }
  return { pathCount: paths, unitsDeployed: total, dominantKind: dominant, layersUsed: layers };
}

// Deterministic pick — the same raid id always picks the same name.
function fnv1a(src: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < src.length; i++) {
    h = Math.imul(h ^ src.charCodeAt(i), 16777619) >>> 0;
  }
  return h >>> 0;
}

const TEMPLATES_3STAR = [
  'The {queen}',
  '{dominant} Storm',
  'Pheromone {noun}',
  'The {color} {noun}',
  '{dominant} Symphony',
];
const TEMPLATES_2STAR = [
  '{color} {noun}',
  'The {dominant} Gambit',
  '{noun} in the Grass',
];
const TEMPLATES_1STAR = [
  'A Crack in the Wall',
  '{dominant} Feint',
  'Dust and Sugar',
];
const TEMPLATES_0STAR = [
  'A Fruitless Walk',
  'The Quiet Retreat',
  '{color} Nothing',
];

const COLORS = ['Amber', 'Verdant', 'Obsidian', 'Honeyed', 'Frost', 'Pollen', 'Silver', 'Smoke'];
const NOUNS = ['Serpent', 'Pincer', 'Gambit', 'Tide', 'Waltz', 'Spiral', 'Kiss', 'Hymn', 'Thorn', 'Cradle'];
const QUEENS = ['Queen\'s Kiss', 'Queen\'s Gambit', 'Queen\'s Spiral', 'Queen\'s Vow'];

function pick<T>(arr: ReadonlyArray<T>, seed: number): T {
  return arr[seed % arr.length]!;
}

export function computeReplayName(args: ReplayNameInputs): string {
  const shape = summarize(args.inputs);
  const seed = fnv1a(args.raidId);
  const s1 = seed;
  const s2 = (seed >>> 4) ^ 0x9e3779b9;
  const s3 = (seed >>> 8) ^ 0x85ebca6b;
  const s4 = (seed >>> 12) ^ 0xc2b2ae35;
  const templates =
    args.stars >= 3 ? TEMPLATES_3STAR :
    args.stars === 2 ? TEMPLATES_2STAR :
    args.stars === 1 ? TEMPLATES_1STAR :
    TEMPLATES_0STAR;
  const tpl = pick(templates, s1);
  const dominant = shape.dominantKind ?? 'Pheromone';
  const color = pick(COLORS, s2);
  const noun = pick(NOUNS, s3);
  const queen = pick(QUEENS, s4);
  let name = tpl
    .replace('{dominant}', dominant)
    .replace('{color}', color)
    .replace('{noun}', noun)
    .replace('{queen}', queen);
  if (args.queenKilled && args.stars >= 3) {
    // Elevate a queen-kill 3-star to a "final" name even if the
    // template didn't produce one — the kill is the story of the raid.
    if (!name.includes('Queen')) {
      name = `${name} — Queen Fell`;
    }
  }
  return name;
}
