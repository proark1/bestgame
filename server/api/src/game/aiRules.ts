import type { Types } from '@hive/shared';

// Server-side gatekeeper for player-authored defender AI rules.
//
// The sim (shared/src/sim/ai_rules.ts) can evaluate anything that
// matches the BuildingAIRule shape, so it is THIS module's job to
// keep rules inside a sane balance window:
//
//   * which triggers may pair with which effects (the whitelist)
//   * min/max on every numeric param (no 99999% damage boosts)
//   * per-base + per-building caps
//   * queen-level gating (rules are a mid-game unlock)
//
// Every rule flowing into the DB passes through validateRule() below.
// Rules read back from the DB are not re-validated at every read —
// they're trusted, which is why validation must be exhaustive on write.

export const RULES_UNLOCK_QUEEN_LEVEL = 3;

// Caps. Numbers here track the matching constants in the sim:
//   shared/src/sim/ai_rules.ts :: RULE_MAX_PER_BUILDING = 8
export const MAX_RULES_PER_BUILDING = 8;
// A whole base gets a hard ceiling on total rules too, so a
// defender can't turn every single wall into a mini-fortress.
// Scales linearly with the queen level above the unlock threshold.
export const BASE_RULE_QUOTAS_BY_QUEEN_LEVEL: Record<number, number> = {
  1: 0,
  2: 0,
  3: 4,
  4: 8,
  5: 12,
};

type Trigger = Types.AIRuleTrigger;
type Effect = Types.AIRuleEffect;

interface RequiredParams {
  // Set of param keys that MUST be present and positive for this
  // trigger / effect. Missing / non-finite / <= 0 → reject.
  requires: ReadonlyArray<keyof Types.BuildingAIRule['params']>;
  // Hard caps so a boosted tower isn't 10× stronger than intended.
  caps: Partial<Record<keyof Types.BuildingAIRule['params'], { min?: number; max: number }>>;
}

const TRIGGER_PARAM_RULES: Record<Trigger, RequiredParams> = {
  onLowHp:          { requires: ['percent'],  caps: { percent: { min: 1, max: 99 } } },
  onEnemyInRange:   { requires: ['radius'],   caps: { radius: { min: 0.5, max: 8 } } },
  onFlyerInRange:   { requires: ['radius'],   caps: { radius: { min: 0.5, max: 8 } } },
  onQueenThreatened:{ requires: ['radius'],   caps: { radius: { min: 0.5, max: 8 } } },
  onTick:           { requires: ['ticks'],    caps: { ticks: { min: 15, max: 600 } } },
  onAllyDestroyed:  { requires: [],           caps: {} },
  onCrossLayerEntry:{ requires: ['radius'],   caps: { radius: { min: 0.5, max: 6 } } },
};

const EFFECT_PARAM_RULES: Record<Effect, RequiredParams> = {
  boostAttackDamage:{ requires: ['percent', 'durationTicks'], caps: { percent: { min: 101, max: 300 }, durationTicks: { min: 15, max: 300 } } },
  boostAttackRate:  { requires: ['rate', 'durationTicks'],    caps: { rate:    { min: 2,   max: 4 },   durationTicks: { min: 15, max: 300 } } },
  extendAttackRange:{ requires: ['range', 'durationTicks'],   caps: { range:   { min: 0.5, max: 3 },   durationTicks: { min: 15, max: 300 } } },
  revealSelf:       { requires: [],                           caps: {} },
  extraSpawn:       { requires: ['maxExtra'],                 caps: { maxExtra:{ min: 1,   max: 3 } } },
  healSelf:         { requires: ['hp'],                       caps: { hp:      { min: 10,  max: 400 } } },
  aoeRoot:          { requires: ['radius', 'durationTicks'],  caps: { radius:  { min: 1,   max: 4 },   durationTicks: { min: 15, max: 120 } } },
  forceLayerSwap:   { requires: ['radius'],                   caps: { radius:  { min: 0.5, max: 4 } } },
};

// (trigger, effect) combos that make gameplay sense. Adding a combo
// is an additive change; stripping one out is a nerf that players
// will feel, so keep this table explicit.
//
// The intent is:
//  * reveal-type effects only pair with range-based triggers
//  * extraSpawn pairs with state triggers (low hp / queen threatened
//    / tick cadence), NOT with range triggers (would spam under
//    pressure)
//  * boost effects can pair with anything
const ALLOWED_COMBOS: ReadonlyArray<readonly [Trigger, Effect]> = [
  ['onLowHp',           'boostAttackDamage'],
  ['onLowHp',           'boostAttackRate'],
  ['onLowHp',           'healSelf'],
  ['onLowHp',           'extraSpawn'],
  ['onEnemyInRange',    'boostAttackDamage'],
  ['onEnemyInRange',    'boostAttackRate'],
  ['onEnemyInRange',    'extendAttackRange'],
  ['onEnemyInRange',    'revealSelf'],
  ['onEnemyInRange',    'aoeRoot'],
  ['onFlyerInRange',    'boostAttackDamage'],
  ['onFlyerInRange',    'boostAttackRate'],
  ['onFlyerInRange',    'extendAttackRange'],
  ['onFlyerInRange',    'revealSelf'],
  ['onQueenThreatened', 'extraSpawn'],
  ['onQueenThreatened', 'aoeRoot'],
  ['onQueenThreatened', 'healSelf'],
  ['onTick',            'extraSpawn'],
  ['onTick',            'boostAttackDamage'],
  ['onAllyDestroyed',   'boostAttackRate'],
  ['onAllyDestroyed',   'boostAttackDamage'],
  // Trapdoor combo — defenders that punish the attacker's `dig`
  // path modifier. Pairs reactivity with relocation; the bounced
  // unit re-emerges where the trapdoor wants it.
  ['onCrossLayerEntry', 'forceLayerSwap'],
  ['onCrossLayerEntry', 'aoeRoot'],
  ['onCrossLayerEntry', 'boostAttackDamage'],
];

const COMBO_SET = new Set(ALLOWED_COMBOS.map(([t, e]) => `${t}:${e}`));

export function isAllowedCombo(trigger: Trigger, effect: Effect): boolean {
  return COMBO_SET.has(`${trigger}:${effect}`);
}

// Per-building restrictions: some effects only make sense attached
// to specific building kinds. extraSpawn only on SpiderNest, revealSelf
// only on HiddenStinger, etc. Other effects are building-agnostic.
export function isEffectAllowedOnKind(
  effect: Effect,
  kind: Types.BuildingKind,
): boolean {
  switch (effect) {
    case 'extraSpawn':
      return kind === 'SpiderNest';
    case 'revealSelf':
      return kind === 'HiddenStinger';
    case 'boostAttackDamage':
    case 'boostAttackRate':
    case 'extendAttackRange':
      // Only makes sense on buildings that can actually attack.
      return (
        kind === 'MushroomTurret' ||
        kind === 'DungeonTrap' ||
        kind === 'AcidSpitter' ||
        kind === 'SporeTower' ||
        kind === 'HiddenStinger' ||
        kind === 'RootSnare'
      );
    case 'healSelf':
      // Every building has HP; healSelf is universally applicable.
      return true;
    case 'aoeRoot':
      // AoE root as a "panic button" on attacking defenders.
      return (
        kind === 'MushroomTurret' ||
        kind === 'AcidSpitter' ||
        kind === 'HiddenStinger' ||
        kind === 'SpiderNest' ||
        kind === 'QueenChamber'
      );
    case 'forceLayerSwap':
      // Trapdoor logic — only buildings that thematically belong to
      // the cross-layer mechanic carry this. DungeonTrap is the
      // physical trapdoor; TunnelJunction is the surveyed "we own
      // this layer transition" tile; QueenChamber gets it as a
      // last-line panic flip when attackers are on the move.
      return (
        kind === 'DungeonTrap' ||
        kind === 'TunnelJunction' ||
        kind === 'QueenChamber'
      );
  }
}

export interface RuleValidationError {
  code: 'bad_shape' | 'bad_combo' | 'bad_kind' | 'bad_param' | 'too_many' | 'gated';
  message: string;
}

function validParam(
  rule: Types.BuildingAIRule,
  paramRules: RequiredParams,
): RuleValidationError | null {
  for (const key of paramRules.requires) {
    const v = rule.params[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      return { code: 'bad_param', message: `param '${key}' must be a positive number` };
    }
  }
  for (const [key, cap] of Object.entries(paramRules.caps)) {
    const v = rule.params[key as keyof Types.BuildingAIRule['params']];
    if (v === undefined) continue;
    if (cap.min !== undefined && v < cap.min) {
      return { code: 'bad_param', message: `param '${key}' below min ${cap.min}` };
    }
    if (v > cap.max) {
      return { code: 'bad_param', message: `param '${key}' above max ${cap.max}` };
    }
  }
  return null;
}

export function validateRule(
  rule: Types.BuildingAIRule,
  buildingKind: Types.BuildingKind,
): RuleValidationError | null {
  if (!rule || typeof rule !== 'object') {
    return { code: 'bad_shape', message: 'rule is not an object' };
  }
  const triggerRules = TRIGGER_PARAM_RULES[rule.trigger];
  const effectRules = EFFECT_PARAM_RULES[rule.effect];
  if (!triggerRules || !effectRules) {
    return { code: 'bad_shape', message: 'unknown trigger or effect' };
  }
  if (!isAllowedCombo(rule.trigger, rule.effect)) {
    return {
      code: 'bad_combo',
      message: `trigger '${rule.trigger}' cannot be paired with effect '${rule.effect}'`,
    };
  }
  if (!isEffectAllowedOnKind(rule.effect, buildingKind)) {
    return {
      code: 'bad_kind',
      message: `effect '${rule.effect}' not allowed on building '${buildingKind}'`,
    };
  }
  const tErr = validParam(rule, triggerRules);
  if (tErr) return tErr;
  const eErr = validParam(rule, effectRules);
  if (eErr) return eErr;
  // remainingUses: -1 allowed (unlimited); 0 rejected (pointless);
  // positive ints allowed up to a sane cap.
  if (rule.remainingUses !== undefined) {
    if (
      !Number.isInteger(rule.remainingUses) ||
      rule.remainingUses === 0 ||
      rule.remainingUses > 20 ||
      rule.remainingUses < -1
    ) {
      return { code: 'bad_param', message: 'remainingUses must be -1 or 1..20' };
    }
  }
  if (rule.cooldownTicks !== undefined) {
    if (
      !Number.isInteger(rule.cooldownTicks) ||
      rule.cooldownTicks < 0 ||
      rule.cooldownTicks > 600
    ) {
      return { code: 'bad_param', message: 'cooldownTicks must be 0..600' };
    }
  }
  return null;
}

export function baseRuleQuota(queenLevel: number): number {
  const clamped = Math.max(1, Math.min(5, Math.floor(queenLevel)));
  return BASE_RULE_QUOTAS_BY_QUEEN_LEVEL[clamped] ?? 0;
}

export function countRulesInBase(base: Types.Base): number {
  let n = 0;
  for (const b of base.buildings) {
    n += b.aiRules?.length ?? 0;
  }
  return n;
}

// Serializable payload for the rule-editor UI. Lists every allowed
// (trigger, effect) pair, plus the kinds each effect may be attached
// to. The client renders dropdowns off this — keeping the catalog
// server-authored means balance changes don't require a client
// redeploy.
export interface AIRuleCatalog {
  triggers: Array<{
    id: Trigger;
    label: string;
    params: ReadonlyArray<keyof Types.BuildingAIRule['params']>;
  }>;
  effects: Array<{
    id: Effect;
    label: string;
    params: ReadonlyArray<keyof Types.BuildingAIRule['params']>;
    allowedKinds: Types.BuildingKind[];
  }>;
  combos: Array<{ trigger: Trigger; effect: Effect }>;
  limits: {
    maxRulesPerBuilding: number;
    quotaByQueenLevel: Record<number, number>;
    unlockQueenLevel: number;
  };
}

const TRIGGER_LABEL: Record<Trigger, string> = {
  onLowHp:           'When my HP drops below X%',
  onEnemyInRange:    'When any enemy is within X tiles',
  onFlyerInRange:    'When a flyer is within X tiles',
  onQueenThreatened: 'When an enemy is within X tiles of the Queen',
  onTick:            'Every X ticks',
  onAllyDestroyed:   'When an ally building is destroyed',
  onCrossLayerEntry: 'When an enemy digs through layers within X tiles',
};

const EFFECT_LABEL: Record<Effect, string> = {
  boostAttackDamage: 'Boost my damage by +X% for Y ticks',
  boostAttackRate:   'Fire X× faster for Y ticks',
  extendAttackRange: 'Extend my range by +X tiles for Y ticks',
  revealSelf:        'Reveal myself (for stealth buildings)',
  extraSpawn:        'Spawn an extra defender (SpiderNest, up to X)',
  healSelf:          'Heal myself by X HP',
  aoeRoot:           'Root enemies within X tiles for Y ticks',
  forceLayerSwap:    'Flip layer of every digger within X tiles (trapdoor)',
};

const ALL_BUILDING_KINDS: Types.BuildingKind[] = [
  'QueenChamber', 'DewCollector', 'MushroomTurret', 'LeafWall',
  'PebbleBunker', 'LarvaNursery', 'SugarVault', 'TunnelJunction',
  'DungeonTrap', 'AcidSpitter', 'SporeTower', 'RootSnare',
  'HiddenStinger', 'SpiderNest', 'ThornHedge',
];

export function aiRuleCatalog(): AIRuleCatalog {
  const triggers = (Object.keys(TRIGGER_PARAM_RULES) as Trigger[]).map((t) => ({
    id: t,
    label: TRIGGER_LABEL[t],
    params: TRIGGER_PARAM_RULES[t].requires,
  }));
  const effects = (Object.keys(EFFECT_PARAM_RULES) as Effect[]).map((e) => ({
    id: e,
    label: EFFECT_LABEL[e],
    params: EFFECT_PARAM_RULES[e].requires,
    allowedKinds: ALL_BUILDING_KINDS.filter((k) => isEffectAllowedOnKind(e, k)),
  }));
  return {
    triggers,
    effects,
    combos: ALLOWED_COMBOS.map(([trigger, effect]) => ({ trigger, effect })),
    limits: {
      maxRulesPerBuilding: MAX_RULES_PER_BUILDING,
      quotaByQueenLevel: BASE_RULE_QUOTAS_BY_QUEEN_LEVEL,
      unlockQueenLevel: RULES_UNLOCK_QUEEN_LEVEL,
    },
  };
}
