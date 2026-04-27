// Heroes — special, named units the player owns and equips into a
// raid. Distinct from the per-raid swarm units (UnitKind) because:
//
//   1. Persistence: a hero is owned across raids; tinkering with a
//      hero's stats means the player is invested in it. Regular
//      units come and go each raid.
//   2. Cap: only TWO heroes deploy per raid even if the player owns
//      all four. Forces a strategic choice each match.
//   3. Aura: each hero buffs allied units in a radius (PR D wires
//      the buff into the sim — this PR sets up the data layer).
//
// First hero is a free chest gift; the rest are bought with sugar
// + milk per HERO_CATALOG.cost. See server/api/src/routes/player.ts
// for the catalog/buy/equip routes that read this file.

export type HeroKind = 'Mantis' | 'HerculesBeetle' | 'WaspQueen' | 'StagBeetle';

export const HERO_KINDS: readonly HeroKind[] = [
  'Mantis',
  'HerculesBeetle',
  'WaspQueen',
  'StagBeetle',
] as const;

// Aura is the in-raid effect the hero radiates while alive.
// `radius` is in tile units; PR D's combat code reads it directly.
// Each hero has exactly one aura kind so the buff system stays
// composable — no stacking-rules problem.
export type HeroAura =
  | { kind: 'attackSpeed'; pct: number; radius: number }
  | { kind: 'hpBonus'; pct: number; radius: number }
  | { kind: 'heal'; perSec: number; radius: number }
  | { kind: 'buildingDamage'; pct: number; radius: number };

export interface HeroDef {
  kind: HeroKind;
  name: string;
  role: string;
  // Sprite key the BootScene loads from disk (or falls back to a
  // procedural placeholder until art lands).
  spriteKey: string;
  // Combat baseline. Heroes are ~2x stronger than a SoldierAnt at
  // L1 to justify their slot premium; PR D's deck UI surfaces the
  // numbers so players can compare.
  hpMax: number;
  attackDamage: number;
  attackRange: number;
  attackCooldownTicks: number;
  speed: number;
  canFly: boolean;
  canDig: boolean;
  // Aura applied to allied units within radius. Effect resolves in
  // the sim every tick (PR D).
  aura: HeroAura;
  // Acquisition cost. The first hero a player equips is free
  // (chest gift); subsequent buys debit sugar + milk per the
  // matching entry in HERO_PRICE_LADDER. Hero-level "cost" here is
  // the *base price* used when no ladder discount applies.
  baseCost: { sugar: number; aphidMilk: number };
}

// Price ladder applied by /player/heroes/buy. The Nth bought hero
// (after the free chest gift) pays the Nth tier. This makes early
// heroes accessible and gates the full roster behind genuine
// progression.
export const HERO_PRICE_LADDER: ReadonlyArray<{ sugar: number; aphidMilk: number }> = [
  { sugar: 0, aphidMilk: 0 },         // 1st (chest) — free
  { sugar: 50_000, aphidMilk: 100 },  // 2nd
  { sugar: 100_000, aphidMilk: 200 }, // 3rd
  { sugar: 250_000, aphidMilk: 500 }, // 4th
];

// Slot cap: at most this many heroes can be equipped at once.
// The deck UI in PR D enforces this on the client; the equip
// endpoint enforces it server-side.
export const MAX_EQUIPPED_HEROES = 2;

export const HERO_CATALOG: Record<HeroKind, HeroDef> = {
  Mantis: {
    kind: 'Mantis',
    name: 'Praying Mantis',
    role: 'Assassin · attack-speed aura',
    spriteKey: 'hero-Mantis',
    hpMax: 800,
    attackDamage: 60,
    attackRange: 2,
    attackCooldownTicks: 7,
    speed: 4,
    canFly: false,
    canDig: false,
    aura: { kind: 'attackSpeed', pct: 25, radius: 3 },
    baseCost: { sugar: 50_000, aphidMilk: 100 },
  },
  HerculesBeetle: {
    kind: 'HerculesBeetle',
    name: 'Hercules Beetle',
    role: 'Tank · HP aura',
    spriteKey: 'hero-HerculesBeetle',
    hpMax: 2000,
    attackDamage: 30,
    attackRange: 1,
    attackCooldownTicks: 14,
    speed: 2,
    canFly: false,
    canDig: false,
    aura: { kind: 'hpBonus', pct: 30, radius: 3 },
    baseCost: { sugar: 100_000, aphidMilk: 200 },
  },
  WaspQueen: {
    kind: 'WaspQueen',
    name: 'Wasp Queen',
    role: 'Support · healing aura',
    spriteKey: 'hero-WaspQueen',
    hpMax: 600,
    attackDamage: 25,
    attackRange: 3,
    attackCooldownTicks: 10,
    speed: 5,
    canFly: true,
    canDig: false,
    aura: { kind: 'heal', perSec: 10, radius: 3 },
    baseCost: { sugar: 100_000, aphidMilk: 200 },
  },
  StagBeetle: {
    kind: 'StagBeetle',
    name: 'Stag Beetle',
    role: 'Siege · building-damage aura',
    spriteKey: 'hero-StagBeetle',
    hpMax: 1500,
    attackDamage: 50,
    attackRange: 1,
    attackCooldownTicks: 12,
    speed: 3,
    canFly: false,
    canDig: false,
    aura: { kind: 'buildingDamage', pct: 20, radius: 3 },
    baseCost: { sugar: 250_000, aphidMilk: 500 },
  },
};

// Server-tracked persistence shape. `owned` is a presence map (only
// one of each is ownable) and `equipped` is the (≤2) array the
// player has slotted for their next raid. Both default empty.
export interface HeroOwnership {
  owned: Partial<Record<HeroKind, true>>;
  equipped: HeroKind[];
  // Whether the chest-gift first hero has been claimed yet. Drives
  // the "open chest" ceremony on first visit; once claimed, the
  // chest CTA disappears.
  chestClaimed: boolean;
}

export const DEFAULT_HERO_OWNERSHIP: HeroOwnership = {
  owned: {},
  equipped: [],
  chestClaimed: false,
};

// Aura summary text rendered on the Heroes scene + codex. Keeps
// the formatting in one place so the UI doesn't drift from the
// server logic.
export function describeAura(aura: HeroAura): string {
  switch (aura.kind) {
    case 'attackSpeed':
      return `+${aura.pct}% attack speed to allies within ${aura.radius} tiles`;
    case 'hpBonus':
      return `+${aura.pct}% max HP to allies within ${aura.radius} tiles`;
    case 'heal':
      return `Heals allies for ${aura.perSec} HP/sec within ${aura.radius} tiles`;
    case 'buildingDamage':
      return `+${aura.pct}% building damage to allies within ${aura.radius} tiles`;
  }
}
