import type { Fixed } from '../sim/fixed.js';
import type { Layer } from './base.js';

export type UnitKind =
  | 'WorkerAnt'
  | 'SoldierAnt'
  | 'DirtDigger'
  | 'Forager'
  | 'Wasp'
  | 'HoneyTank'
  | 'ShieldBeetle'
  | 'BombBeetle'
  | 'Roller'
  | 'Jumper'
  | 'WebSetter'
  | 'Ambusher'
  // Expanded attacker roster — each is unlocked at a specific Queen
  // Chamber level (see server/api/src/game/buildingRules.ts
  // UNIT_UNLOCK_QUEEN_LEVEL). FireAnt lays a burn DoT; Termite gets a
  // 2× damage bonus vs buildings; Dragonfly is a fast low-hp flyer;
  // Mantis is single-target burst; Scarab spawns two mini-scarabs on
  // death.
  | 'FireAnt'
  | 'Termite'
  | 'Dragonfly'
  | 'Mantis'
  | 'Scarab'
  | 'MiniScarab'
  // Defender-side unit spawned by SpiderNest during a raid. Not in the
  // player's deployable roster — the combat system owns its lifecycle.
  | 'NestSpider';

// A live unit inside a running sim. Positions are Fixed (Q16.16) in world
// sub-tile coordinates; the grid is 16x12 tiles so values stay small.
export interface Unit {
  id: number;
  kind: UnitKind;
  owner: 0 | 1; // 0 = attacker, 1 = defender
  layer: Layer;
  x: Fixed;
  y: Fixed;
  hp: Fixed;
  hpMax: Fixed;
  // The layer this unit was originally spawned on, before any dig
  // modifier or trapdoor flip moved it. Used by combat.ts to detect
  // cross-layer kills (unit kills a building whose layer differs
  // from spawnLayer) so the loot system can grant a small bonus per
  // such kill. Optional so legacy replays without the field still
  // deserialise — combat treats absent as `layer` (no bonus).
  spawnLayer?: Layer;
  // Index of the pheromone path this unit is following, -1 if none.
  pathId: number;
  // How far along the current path (in Fixed "arclength units") — used by
  // the pheromoneFollow system to advance through waypoints in order.
  pathProgress: Fixed;
  // Cooldown ticks until the unit can attack again.
  attackCooldown: number;
  // Target building id, 0 if none. Units prefer buildings but auto-switch
  // to nearby enemy units via the combat system.
  targetBuildingId: number;
  // DoT — remaining ticks of burn damage (FireAnt, ThornHedge reflect).
  // Zero when not burning. Damage-per-tick is fixed per source kind;
  // combat.ts drips burnDamagePerTick of HP each tick while > 0.
  burnTicks?: number;
  burnDamagePerTick?: Fixed;
  // Root/slow — remaining ticks while the unit is immobilised (speed
  // clamped to 0 in pheromoneFollow). Set when a RootSnare triggers on
  // this unit. Zero or absent = free to move.
  rootedTicks?: number;
  // Player-authored ambush marker — set when the unit arrives at a
  // pheromone path's `ambush` modifier. Counted down each tick in
  // combat.ts; while > 0, pheromone_follow holds position.
  ambushTicks?: number;
  // Dig animation timer — set when the unit arrives at a `dig` marker.
  // While > 0 the unit holds position (visible + targetable by surface
  // turrets) and counts down each tick in combat.ts. On the tick it
  // hits 0, pheromone_follow flips u.layer to the opposite layer. The
  // exposure window is the gameplay cost of crossing layers — a
  // surface defender has those ticks to break the digger before it
  // disappears underground.
  diggingTicks?: number;
  // Target layer the dig will land on when `diggingTicks` expires.
  // Stored explicitly (not just inferred from `u.layer`) so a future
  // forceLayerSwap mid-dig doesn't accidentally flip back.
  diggingTargetLayer?: 0 | 1;
  // Latches set by pheromone_follow when a path modifier has fired on
  // this unit. Forward-only motion makes the segIdx threshold a
  // sufficient single-fire guard, but storing the latch keeps the
  // intent explicit and survives any future segment re-walks (e.g.
  // pull-back effects).
  hasSplit?: boolean;
  hasDug?: boolean;
  hasAmbushed?: boolean;
  // Per-tick edge flag — true if this unit's layer changed during
  // the current sim tick. Set by pheromone_follow when the dig
  // modifier fires; cleared at the top of pheromone_follow on the
  // next tick. Read by ai_rules.ts to drive `onCrossLayerEntry` and
  // by `forceLayerSwap`. Optional so pre-existing replays without
  // the field deserialise unchanged.
  layerCrossedThisTick?: boolean;
  // Hero identity, when this unit was deployed via an equipped
  // hero card (PR D). When set, the sim looks up HERO_STATS_FIXED
  // instead of UNIT_STATS for combat numbers, the renderer uses
  // the hero sprite key, and the unit emits an aura that buffs
  // allied units in a radius. `kind` is still set (to a sentinel
  // SoldierAnt) so existing UnitKind-keyed tables don't have to
  // grow a Hero entry. Absence = ordinary swarm unit.
  heroKind?: import('./heroes.js').HeroKind;
  // Aura buff flags re-derived each tick by the auras system.
  // Combat reads these to scale attack cooldown / damage. Heal
  // is applied directly as +HP (capped at hpMax) at the same time.
  // All integers; absence = no buff.
  auraAttackSpeedPct?: number;       // 0..100 integer
  auraBuildingDamagePct?: number;    // 0..100 integer
  // hpBonus aura is one-shot: the first tick a unit comes within
  // a HerculesBeetle's radius, hpMax + hp are bumped by
  // aura.pct. We persist the highest applied bonus on the unit
  // so the buff doesn't re-apply each tick. The bonus also
  // outlives the hero — leaving the radius doesn't shrink HP.
  auraHpBonusApplied?: number;
}

export interface UnitStats {
  hpMax: Fixed;
  speed: Fixed; // Fixed tiles per tick
  attackRange: Fixed; // Fixed tiles
  attackDamage: Fixed; // Fixed HP per hit
  attackCooldownTicks: number;
  canFly: boolean;
  canDig: boolean;
}
