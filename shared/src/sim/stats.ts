import { fromFloat, fromInt } from './fixed.js';
import type { Fixed } from './fixed.js';
import type { UnitKind } from '../types/units.js';
import type { UnitStats } from '../types/units.js';
import type { BuildingKind } from '../types/base.js';

// All stats as Fixed (Q16.16). Balance numbers; tune freely.
//
// Speed is in Fixed tiles / tick (sim runs at 30 Hz; 0.08 tiles/tick ≈ 2.4
// tiles/sec, takes ~6 seconds to cross the 16-tile map).

export const UNIT_STATS: Record<UnitKind, UnitStats> = {
  WorkerAnt: {
    hpMax: fromInt(20),
    speed: fromFloat(0.08),
    attackRange: fromFloat(0.6),
    attackDamage: fromInt(2),
    attackCooldownTicks: 18,
    canFly: false,
    canDig: false,
  },
  SoldierAnt: {
    hpMax: fromInt(40),
    speed: fromFloat(0.07),
    attackRange: fromFloat(0.8),
    attackDamage: fromInt(6),
    attackCooldownTicks: 24,
    canFly: false,
    canDig: false,
  },
  DirtDigger: {
    hpMax: fromInt(30),
    speed: fromFloat(0.05),
    attackRange: fromFloat(0.5),
    attackDamage: fromInt(4),
    attackCooldownTicks: 30,
    canFly: false,
    canDig: true,
  },
  Forager: {
    hpMax: fromInt(15),
    speed: fromFloat(0.12),
    attackRange: fromFloat(0.5),
    attackDamage: fromInt(2),
    attackCooldownTicks: 20,
    canFly: true,
    canDig: false,
  },
  Wasp: {
    hpMax: fromInt(25),
    speed: fromFloat(0.10),
    attackRange: fromFloat(2.5),
    attackDamage: fromInt(5),
    attackCooldownTicks: 30,
    canFly: true,
    canDig: false,
  },
  HoneyTank: {
    hpMax: fromInt(80),
    speed: fromFloat(0.04),
    attackRange: fromFloat(0.8),
    attackDamage: fromInt(8),
    attackCooldownTicks: 36,
    canFly: false,
    canDig: false,
  },
  ShieldBeetle: {
    hpMax: fromInt(120),
    speed: fromFloat(0.05),
    attackRange: fromFloat(0.6),
    attackDamage: fromInt(4),
    attackCooldownTicks: 30,
    canFly: false,
    canDig: false,
  },
  BombBeetle: {
    hpMax: fromInt(30),
    speed: fromFloat(0.09),
    attackRange: fromFloat(0.4),
    attackDamage: fromInt(25),
    attackCooldownTicks: 1,
    canFly: false,
    canDig: false,
  },
  Roller: {
    hpMax: fromInt(50),
    speed: fromFloat(0.11),
    attackRange: fromFloat(0.7),
    attackDamage: fromInt(10),
    attackCooldownTicks: 45,
    canFly: false,
    canDig: false,
  },
  Jumper: {
    hpMax: fromInt(35),
    speed: fromFloat(0.10),
    attackRange: fromFloat(0.6),
    attackDamage: fromInt(7),
    attackCooldownTicks: 22,
    canFly: false,
    canDig: false,
  },
  WebSetter: {
    hpMax: fromInt(25),
    speed: fromFloat(0.07),
    attackRange: fromFloat(2.0),
    attackDamage: fromInt(1),
    attackCooldownTicks: 40,
    canFly: false,
    canDig: false,
  },
  Ambusher: {
    hpMax: fromInt(30),
    speed: fromFloat(0.09),
    attackRange: fromFloat(0.7),
    attackDamage: fromInt(12),
    attackCooldownTicks: 30,
    canFly: false,
    canDig: false,
  },
  // Burn-DoT specialist — modest direct hit, lights a sticky burn on
  // whatever it touches. Burn parameters live in UNIT_BEHAVIOR.
  FireAnt: {
    hpMax: fromInt(28),
    speed: fromFloat(0.08),
    attackRange: fromFloat(0.6),
    attackDamage: fromInt(3),
    attackCooldownTicks: 24,
    canFly: false,
    canDig: false,
  },
  // Anti-building specialist — 2× damage vs buildings (UNIT_BEHAVIOR),
  // baseline vs units. Low hp; needs a meatshield escort.
  Termite: {
    hpMax: fromInt(35),
    speed: fromFloat(0.07),
    attackRange: fromFloat(0.5),
    attackDamage: fromInt(6),
    attackCooldownTicks: 22,
    canFly: false,
    canDig: true,
  },
  // Fast low-HP flyer — scouts splash/mortar clusters, dodges ground
  // defenses. Vulnerable to SporeTower (anti-air).
  Dragonfly: {
    hpMax: fromInt(22),
    speed: fromFloat(0.13),
    attackRange: fromFloat(1.6),
    attackDamage: fromInt(4),
    attackCooldownTicks: 28,
    canFly: true,
    canDig: false,
  },
  // Single-target burst. Hits hard on cooldown, not DPS-efficient.
  // Intended as a Queen / SugarVault finisher.
  Mantis: {
    hpMax: fromInt(55),
    speed: fromFloat(0.08),
    attackRange: fromFloat(0.9),
    attackDamage: fromInt(22),
    attackCooldownTicks: 48,
    canFly: false,
    canDig: false,
  },
  // Swarm enabler — spawns 2 mini-scarabs on death (UNIT_BEHAVIOR
  // deathSpawn). Think CoC Witch vibes, minus the necromancy.
  Scarab: {
    hpMax: fromInt(60),
    speed: fromFloat(0.07),
    attackRange: fromFloat(0.7),
    attackDamage: fromInt(5),
    attackCooldownTicks: 30,
    canFly: false,
    canDig: false,
  },
  // Death-spawn offspring of a Scarab. Cannot be directly deployed
  // (gate this via UNIT_UNLOCK_QUEEN_LEVEL / isUpgradeableUnit —
  // neither treats MiniScarab as deployable).
  MiniScarab: {
    hpMax: fromInt(12),
    speed: fromFloat(0.10),
    attackRange: fromFloat(0.5),
    attackDamage: fromInt(2),
    attackCooldownTicks: 20,
    canFly: false,
    canDig: false,
  },
  // Defender AI unit spawned by SpiderNest. Short leash (fixed lifespan
  // handled in combat.ts); acts on owner === 1 side.
  NestSpider: {
    hpMax: fromInt(22),
    speed: fromFloat(0.10),
    attackRange: fromFloat(0.6),
    attackDamage: fromInt(4),
    attackCooldownTicks: 22,
    canFly: false,
    canDig: false,
  },
  // Bee-faction MVP. HoneyBee is a fast cheap flyer — fills the early
  // Bee curve like SoldierAnt does for Ants but with flight, trading
  // HP for path freedom. Tuned just under Wasp on damage so Bee
  // strategies still favor swarm volume over single-bee finishes.
  HoneyBee: {
    hpMax: fromInt(22),
    speed: fromFloat(0.11),
    attackRange: fromFloat(0.7),
    attackDamage: fromInt(4),
    attackCooldownTicks: 22,
    canFly: true,
    canDig: false,
  },
  // Heavy flying tank — slow, high HP, melee. Acts as the Bee equivalent
  // of HoneyTank with a flight bypass. No anti-armor splash today; the
  // ability scaffold (UnitAbilityKind detonate) is the future hook for a
  // rotor-blade splash on death.
  HiveDrone: {
    hpMax: fromInt(95),
    speed: fromFloat(0.05),
    attackRange: fromFloat(0.8),
    attackDamage: fromInt(9),
    attackCooldownTicks: 34,
    canFly: true,
    canDig: false,
  },
};

// Extended per-unit behavior flags that don't fit neatly into UnitStats.
// Keeping these in a separate table keeps UnitStats lean (speed/range/dmg
// only) and makes it easy to add a new behaviour without touching every
// unit. Absent entry = no special behaviour (the default for all the
// original 12 kinds).
export interface UnitBehavior {
  // FireAnt / ThornHedge reflect: lay a burn on the target. Duration in
  // ticks, damage Fixed HP per tick.
  burnTicks?: number;
  burnDamagePerTick?: Fixed;
  // Termite: multiplier applied when the target is a building. 200 =
  // 2× damage. Applied on top of the per-level stat percent.
  vsBuildingPercent?: number;
  // Beetle faction signature: damage multiplier applied ONLY when the
  // target is a wall (LeafWall / ThornHedge). 125 = +25% damage.
  // Stacks multiplicatively with vsBuildingPercent so a future
  // hybrid kind (e.g. a Termite-Beetle) compounds correctly.
  vsWallPercent?: number;
  // Scarab: kind + count of units spawned at death. Spawned unit is
  // owner=0 (attacker-side) for a Scarab death.
  deathSpawnKind?: UnitKind;
  deathSpawnCount?: number;
  // Hidden flag: the client hides these from the deploy roster /
  // upgrade catalog. Used for MiniScarab (not directly summonable) and
  // NestSpider (defender AI, never in the attacker's hand).
  hiddenFromRoster?: boolean;
  // Detonate-on-death: when this unit's hp drops to 0, apply splash
  // damage to enemies in radius. Mirrors building splash (AcidSpitter)
  // for unit deaths. Applied once per death — combat tags the corpse
  // with `detonated` so a re-cull pass can't double-fire. BombBeetle
  // is the canonical case (kamikaze sapper).
  detonateRadius?: Fixed;     // Fixed tiles
  detonateDamage?: Fixed;     // Fixed HP
}

export const UNIT_BEHAVIOR: Partial<Record<UnitKind, UnitBehavior>> = {
  FireAnt: {
    burnTicks: 90, // 3 seconds at 30 Hz
    burnDamagePerTick: fromInt(1),
  },
  // BombBeetle keeps its 25-dmg attack pattern. New: when killed, it
  // detonates — splash to enemies within ~1.5 tiles. The on-death
  // handler in combat.ts iterates state.units and state.buildings
  // once per detonation, so list order stays the same and the gate
  // is deterministic.
  BombBeetle: {
    detonateRadius: fromFloat(1.5),
    detonateDamage: fromInt(35),
    vsWallPercent: 125, // Beetle faction signature: +25% vs walls
  },
  // Beetle faction signature: +25% damage when the target is a wall
  // (LeafWall / ThornHedge). Cements the "Beetles break walls"
  // identity. Spread across every Beetle-faction kind so the
  // mechanic reads as a faction rule, not a one-unit tag.
  ShieldBeetle: { vsWallPercent: 125 },
  Roller: { vsWallPercent: 125 },
  Mantis: { vsWallPercent: 125 },
  Termite: {
    vsBuildingPercent: 200,
  },
  Scarab: {
    deathSpawnKind: 'MiniScarab',
    deathSpawnCount: 2,
    vsWallPercent: 125,
  },
  MiniScarab: {
    hiddenFromRoster: true,
    vsWallPercent: 125,
  },
  NestSpider: {
    hiddenFromRoster: true,
  },
};

export interface BuildingStats {
  hpMax: number;
  canAttack: boolean;
  attackRange: number; // Fixed tiles
  attackDamage: number; // Fixed hp per hit
  attackCooldownTicks: number;
  dropsSugarOnDestroy: number;
  dropsLeafBitsOnDestroy: number;
}

export const BUILDING_STATS: Record<BuildingKind, BuildingStats> = {
  QueenChamber: {
    hpMax: 800,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 0,
  },
  DewCollector: {
    hpMax: 200,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 100,
    dropsLeafBitsOnDestroy: 0,
  },
  MushroomTurret: {
    hpMax: 400,
    canAttack: true,
    attackRange: fromFloat(3.0),
    attackDamage: fromInt(5),
    attackCooldownTicks: 30,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 20,
  },
  LeafWall: {
    hpMax: 600,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 5,
  },
  PebbleBunker: {
    hpMax: 900,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 10,
  },
  LarvaNursery: {
    hpMax: 300,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 60,
    dropsLeafBitsOnDestroy: 0,
  },
  SugarVault: {
    hpMax: 350,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 500,
    dropsLeafBitsOnDestroy: 0,
  },
  TunnelJunction: {
    hpMax: 250,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 0,
  },
  DungeonTrap: {
    hpMax: 100,
    canAttack: true,
    attackRange: fromFloat(1.0),
    attackDamage: fromInt(20),
    attackCooldownTicks: 120,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 5,
  },
  // Mortar-style splash. Long range, heavy reload. Splash radius
  // lives in BUILDING_BEHAVIOR so we don't pollute the base stats shape.
  AcidSpitter: {
    hpMax: 350,
    canAttack: true,
    attackRange: fromFloat(5.0),
    attackDamage: fromInt(8),
    attackCooldownTicks: 90,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 15,
  },
  // Anti-air only. Won't acquire ground targets — BUILDING_BEHAVIOR
  // sets antiAirOnly which combat.ts filters by.
  SporeTower: {
    hpMax: 280,
    canAttack: true,
    attackRange: fromFloat(4.0),
    attackDamage: fromInt(14),
    attackCooldownTicks: 36,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 12,
  },
  // Single-shot trap. hp=1 so killing its "attack" state drops it
  // from the building list like any destroyed building; combat.ts
  // zeros hp the tick it fires.
  RootSnare: {
    hpMax: 1,
    canAttack: true,
    attackRange: fromFloat(1.2),
    attackDamage: fromInt(12),
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 3,
  },
  // CoC Tesla analog — cloaked until combat.ts flips `revealed` on
  // the tick a unit enters range.
  HiddenStinger: {
    hpMax: 220,
    canAttack: true,
    attackRange: fromFloat(2.5),
    attackDamage: fromInt(10),
    attackCooldownTicks: 18,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 18,
  },
  // Spawns NestSpider defenders every N ticks while attackers are
  // present. BUILDING_BEHAVIOR.spawnIntervalTicks controls cadence;
  // spawns happen in combat.ts.
  SpiderNest: {
    hpMax: 260,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 20,
  },
  // Wall T2. Reflects chip burn on melee contact (BUILDING_BEHAVIOR
  // reflectBurn). Still not `canAttack` — the reflect is implicit.
  ThornHedge: {
    hpMax: 1100,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 12,
  },
  // Premium producer. Doesn't attack, modest hp (it's a glass cannon
  // for raiders — destroying one nets a chunky leaf payout). Drops a
  // bit of leaf on destruction so attacking it isn't pure spoils-of-
  // currency-the-attacker-can't-bank.
  AphidFarm: {
    hpMax: 320,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 25,
  },
  // Storage buildings — purely defensive, fat HP, drop a chunk of
  // their stored resource on destruction so raiders are rewarded
  // for prioritising them over plain walls.
  LeafSilo: {
    hpMax: 600,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 80,
  },
  MilkPot: {
    hpMax: 700,
    canAttack: false,
    attackRange: 0,
    attackDamage: 0,
    attackCooldownTicks: 0,
    dropsSugarOnDestroy: 0,
    dropsLeafBitsOnDestroy: 0,
  },
};

// Extended per-building behavior. Same pattern as UNIT_BEHAVIOR:
// everything that doesn't fit the flat "range/damage/cooldown" mold
// goes here so BuildingStats stays minimal and the combat system can
// branch on a single behaviour table.
export interface BuildingBehavior {
  // AcidSpitter: Fixed-point radius within which the splash hit lands
  // on every enemy unit. 0 or missing = single-target.
  splashRadius?: number;
  // SporeTower: true means only units with canFly can be targeted.
  antiAirOnly?: boolean;
  // HiddenStinger: true means the building is invisible to units /
  // client until the first target enters range. Cannot be targeted
  // by attackers while hidden (combat.ts skips hp pull on it).
  stealth?: boolean;
  // RootSnare: apply a root to the target (ticks of immobilisation)
  // on its single trigger in addition to its damage.
  rootTicks?: number;
  // RootSnare: one-shot flag. After firing, hp is zeroed so it counts
  // toward the destroyed-building outcome share.
  singleUse?: boolean;
  // SpiderNest: cadence (ticks) between spawns while a raid is live.
  spawnIntervalTicks?: number;
  // SpiderNest: kind + max concurrent defenders. Extra spawns are
  // suppressed until some of the existing defenders die.
  spawnKind?: UnitKind;
  spawnMaxAlive?: number;
  // SpiderNest: how many ticks each spawned defender lives before the
  // combat system auto-kills it. Keeps the nest from stockpiling.
  spawnLifetimeTicks?: number;
  // ThornHedge: on melee contact (unit attack against this building),
  // lay a burn back onto the attacker. Same shape as UnitBehavior.
  reflectBurnTicks?: number;
  reflectBurnDamagePerTick?: number; // Fixed HP per tick
}

export const BUILDING_BEHAVIOR: Partial<Record<BuildingKind, BuildingBehavior>> = {
  AcidSpitter: { splashRadius: fromFloat(1.4) },
  SporeTower: { antiAirOnly: true },
  HiddenStinger: { stealth: true },
  RootSnare: {
    rootTicks: 60, // 2 seconds
    singleUse: true,
  },
  SpiderNest: {
    spawnIntervalTicks: 120, // ~4 seconds
    spawnKind: 'NestSpider',
    spawnMaxAlive: 3,
    spawnLifetimeTicks: 360, // 12 seconds
  },
  ThornHedge: {
    reflectBurnTicks: 45,
    reflectBurnDamagePerTick: fromInt(1),
  },
};
