// Base and building data models. Kept plain-data (no methods) so they
// serialize cleanly into replay blobs and Colyseus payloads.

export type Layer = 0 | 1; // 0 = surface, 1 = underground

export interface Cell {
  x: number;
  y: number;
  layer: Layer;
}

export type Faction = 'Ants' | 'Bees' | 'Beetles' | 'Spiders';

export type BuildingKind =
  | 'QueenChamber'
  | 'DewCollector'
  | 'MushroomTurret'
  | 'LeafWall'
  | 'PebbleBunker'
  | 'LarvaNursery'
  | 'SugarVault'
  | 'TunnelJunction'
  | 'DungeonTrap'
  // Expanded defensive roster (Clash-style). Each kind has a distinct
  // combat role — see shared/src/sim/stats.ts BUILDING_STATS for
  // concrete numbers and shared/src/sim/systems/combat.ts for the
  // splash / anti-air / stealth / trap / nest-spawn semantics.
  | 'AcidSpitter'    // long-range splash (mortar analog)
  | 'SporeTower'     // anti-air only (cannot hit ground)
  | 'RootSnare'      // one-shot trap, roots/slows on trigger
  | 'HiddenStinger'  // cloaked until a unit enters range, then reveals
  | 'SpiderNest'     // periodically spawns defender units during a raid
  | 'ThornHedge'     // tier-2 wall: higher hp + chip-damage reflect
  // Premium economy. Slow producer of AphidMilk, the third currency.
  // Late-tier unlock; sets the foundation for future builder-time-skip
  // monetization (GDD §9 / §12). Underground-only and limited per
  // queen tier so early bases can't farm milk for an instant skip.
  | 'AphidFarm';

export interface Building {
  id: string;
  kind: BuildingKind;
  anchor: Cell;
  footprint: { w: number; h: number };
  // If set, this building occupies multiple layers. QueenChamber spans [0,1]
  // — a surface turret wired to an underground throne room.
  spans?: Layer[];
  level: number;
  hp: number;
  hpMax: number;
  // Orientation in 90-degree steps: 0 = default, 1 = 90°, 2 = 180°,
  // 3 = 270°. Absent on buildings that haven't been rotated yet
  // (implicit 0). Used by wall-like buildings so the admin / player
  // can draw aesthetic wall lines + corners the way Clash of Clans
  // does. The sim ignores rotation for collision + combat — it's a
  // purely cosmetic transform applied at render time.
  rotation?: 0 | 1 | 2 | 3;
  // Player-authored defender AI rules attached to this building. The
  // sim's `ai_rules` system evaluates them each tick and mutates
  // SimBuilding state (boost timers, extra spawns, reveal, etc.).
  //
  // This is the innovation beam of the game — CoC-style base defense
  // is usually a static config; letting the defender program a few
  // if/then rules per building turns every base into a hand-crafted
  // puzzle. Rules are a fixed (triggerKind × effectKind) matrix so
  // balance stays tractable and every combo is pre-validated on the
  // server (see server/api/src/game/aiRules.ts::validateRule).
  aiRules?: BuildingAIRule[];
  // Builder time gate (GDD §6.6). When the player queues an upgrade on
  // this building, the cost is debited immediately and these two
  // fields are set; `level` does NOT change until the timer elapses
  // and the next /player/me lazily promotes it. Both absent means
  // "no upgrade in progress" — the default for any pre-existing
  // building. ISO-8601 timestamp string so JSON round-trip stays
  // deterministic; the server is authoritative on timing.
  pendingCompletesAt?: string;
  pendingToLevel?: number;
}

// Rule trigger / effect enums are intentionally small (v1): 6 triggers
// × 7 effects = a 42-cell matrix, with a whitelist of legal combos on
// the server. Adding a new kind is an additive change across (a) this
// file, (b) shared/src/sim/ai_rules.ts, and (c) the server validator.
export type AIRuleTrigger =
  // Building dropped below `thresholdPercent` of hpMax (param.percent).
  | 'onLowHp'
  // Any attacker-owned unit entered `param.radius` Fixed tiles.
  | 'onEnemyInRange'
  // Like onEnemyInRange but only flying units.
  | 'onFlyerInRange'
  // Any attacker within `param.radius` tiles of the QueenChamber.
  | 'onQueenThreatened'
  // Fires every `param.ticks` ticks (heartbeat). Useful pairing with
  // extraSpawn so a SpiderNest pulses on a cadence the player sets.
  | 'onTick'
  // Any ally building was destroyed this tick. Free parameters (we
  // could filter by kind later — skipping to keep v1 small).
  | 'onAllyDestroyed'
  // Any attacker unit crossed layers (surface ↔ underground) within
  // `param.radius` Fixed tiles this tick. Direct counter to the
  // attacker `dig` path modifier — a defender can plant a trapdoor
  // that punishes the moment the swarm tries to slip layers.
  | 'onCrossLayerEntry';

export type AIRuleEffect =
  // Multiply this building's attack damage by `param.percent` for the
  // next `param.durationTicks`. Stacks with level scaling by taking
  // the max of any concurrent boost (no unbounded stacking).
  | 'boostAttackDamage'
  // Divide this building's attack cooldown by `param.rate` for
  // `param.durationTicks`.
  | 'boostAttackRate'
  // Add `param.range` Fixed tiles to attackRange for
  // `param.durationTicks`.
  | 'extendAttackRange'
  // Force-reveal this (stealth) building immediately. One-shot.
  | 'revealSelf'
  // SpiderNest: spawn one extra defender immediately, up to
  // `param.maxExtra` over the whole raid to cap inflation.
  | 'extraSpawn'
  // Self-heal `param.hp` (integer HP, Fixed in the sim). One-shot per
  // trigger fire.
  | 'healSelf'
  // Slow/root every attacker within `param.radius` for
  // `param.durationTicks`. Think AOE snare on a trigger.
  | 'aoeRoot'
  // Force-flip the layer of every attacker within `param.radius`.
  // Pairs with onCrossLayerEntry as the canonical "trapdoor" combo:
  // a swarm trying to dig through finds itself surfacing right under
  // a turret line. Ignores units that can't dig themselves (those
  // can't be in the underground in the first place via this path).
  | 'forceLayerSwap';

export interface BuildingAIRule {
  // Stable id so the client can update an existing rule in place
  // rather than blanket-replacing the whole array. Server-assigned.
  id: string;
  trigger: AIRuleTrigger;
  effect: AIRuleEffect;
  // Sparse parameter bag — which fields are relevant depends on the
  // trigger/effect pair. Server validates the shape before storing.
  // Scalars only so determinism + JSONB round-trip stay clean.
  params: {
    percent?: number;      // trigger thresholdPercent / effect boost%
    radius?: number;       // Fixed tiles for trigger / aoeRoot
    ticks?: number;        // onTick cadence
    durationTicks?: number;// effect window
    rate?: number;         // boostAttackRate divisor
    range?: number;        // extendAttackRange amount in Fixed
    maxExtra?: number;     // extraSpawn cap per raid
    hp?: number;           // healSelf amount
  };
  // How many more times this rule may still fire this raid. -1 = no
  // cap. Copied into SimBuilding state at init; decremented as the
  // rule fires. Zero-latency way to enforce one-shots and per-raid
  // caps without per-rule server state.
  remainingUses?: number;
  // Trigger-internal cooldown, in ticks. Prevents onLowHp/onFlyer
  // spam-firing every tick while the condition is true — the rule
  // re-arms after `cooldownTicks` of the trigger being false (or of
  // elapsed time, for onTick).
  cooldownTicks?: number;
}

export interface Base {
  baseId: string;
  ownerId: string;
  faction: Faction;
  gridSize: { w: number; h: number };
  buildings: Building[];
  tunnels: { from: Cell; to: Cell }[];
  resources: {
    sugar: number;
    leafBits: number;
    aphidMilk: number;
  };
  trophies: number;
  version: number;
}

export const DEFAULT_GRID_SIZE = { w: 16, h: 12 } as const;
