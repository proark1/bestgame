import { describe, expect, it } from 'vitest';
import type { Types } from '@hive/shared';
import {
  MAX_RULES_PER_BUILDING,
  RULES_UNLOCK_QUEEN_LEVEL,
  aiRuleCatalog,
  baseRuleQuota,
  countRulesInBase,
  isAllowedCombo,
  isEffectAllowedOnKind,
  validateRule,
} from '../src/game/aiRules.js';

function ruleOf(
  trigger: Types.AIRuleTrigger,
  effect: Types.AIRuleEffect,
  params: Types.BuildingAIRule['params'] = {},
): Types.BuildingAIRule {
  return { id: 't', trigger, effect, params };
}

describe('aiRules validation', () => {
  it('accepts a canonical onEnemyInRange → boostAttackDamage', () => {
    const r = ruleOf('onEnemyInRange', 'boostAttackDamage', {
      radius: 3,
      percent: 150,
      durationTicks: 60,
    });
    expect(validateRule(r, 'MushroomTurret')).toBeNull();
  });

  it('rejects a disallowed combo', () => {
    const r = ruleOf('onTick', 'revealSelf');
    const err = validateRule(r, 'HiddenStinger');
    expect(err?.code).toBe('bad_combo');
  });

  it('rejects effects that do not match the building kind', () => {
    const r = ruleOf('onEnemyInRange', 'extendAttackRange', {
      radius: 3,
      range: 1,
      durationTicks: 60,
    });
    const err = validateRule(r, 'LeafWall');
    expect(err?.code).toBe('bad_kind');
  });

  it('rejects out-of-range params', () => {
    const r = ruleOf('onEnemyInRange', 'boostAttackDamage', {
      radius: 3,
      percent: 99999, // way above cap
      durationTicks: 60,
    });
    const err = validateRule(r, 'MushroomTurret');
    expect(err?.code).toBe('bad_param');
  });

  it('rejects missing required param', () => {
    const r = ruleOf('onEnemyInRange', 'boostAttackDamage', {
      radius: 3,
      // percent missing
      durationTicks: 60,
    });
    const err = validateRule(r, 'MushroomTurret');
    expect(err?.code).toBe('bad_param');
  });

  it('extraSpawn only allowed on SpiderNest', () => {
    expect(isEffectAllowedOnKind('extraSpawn', 'SpiderNest')).toBe(true);
    expect(isEffectAllowedOnKind('extraSpawn', 'MushroomTurret')).toBe(false);
  });

  it('revealSelf only allowed on HiddenStinger', () => {
    expect(isEffectAllowedOnKind('revealSelf', 'HiddenStinger')).toBe(true);
    expect(isEffectAllowedOnKind('revealSelf', 'QueenChamber')).toBe(false);
  });

  it('isAllowedCombo is sane', () => {
    expect(isAllowedCombo('onEnemyInRange', 'extendAttackRange')).toBe(true);
    expect(isAllowedCombo('onAllyDestroyed', 'revealSelf')).toBe(false);
  });
});

describe('aiRules quotas', () => {
  it('quota is zero before unlock tier', () => {
    for (let i = 1; i < RULES_UNLOCK_QUEEN_LEVEL; i++) {
      expect(baseRuleQuota(i)).toBe(0);
    }
  });

  it('quota is monotonic from unlock tier up', () => {
    let prev = -1;
    for (let i = RULES_UNLOCK_QUEEN_LEVEL; i <= 5; i++) {
      const q = baseRuleQuota(i);
      expect(q).toBeGreaterThanOrEqual(prev);
      prev = q;
    }
  });

  it('per-building cap is sane', () => {
    expect(MAX_RULES_PER_BUILDING).toBeGreaterThanOrEqual(1);
    expect(MAX_RULES_PER_BUILDING).toBeLessThanOrEqual(12);
  });

  it('countRulesInBase aggregates across buildings', () => {
    const base = {
      baseId: 'x', ownerId: 'x', faction: 'Ants' as const,
      gridSize: { w: 16, h: 12 },
      resources: { sugar: 0, leafBits: 0, aphidMilk: 0 },
      trophies: 0, version: 1, tunnels: [],
      buildings: [
        {
          id: 'a', kind: 'MushroomTurret' as const,
          anchor: { x: 1, y: 1, layer: 0 as 0 },
          footprint: { w: 1, h: 1 }, level: 1, hp: 400, hpMax: 400,
          aiRules: [ruleOf('onEnemyInRange', 'boostAttackDamage', { radius: 3, percent: 150, durationTicks: 60 })],
        },
        {
          id: 'b', kind: 'SpiderNest' as const,
          anchor: { x: 3, y: 3, layer: 1 as 1 },
          footprint: { w: 2, h: 2 }, level: 1, hp: 260, hpMax: 260,
          aiRules: [
            ruleOf('onTick', 'extraSpawn', { ticks: 120, maxExtra: 2 }),
            ruleOf('onLowHp', 'extraSpawn', { percent: 40, maxExtra: 2 }),
          ],
        },
      ],
    };
    expect(countRulesInBase(base)).toBe(3);
  });
});

describe('aiRuleCatalog', () => {
  it('includes every trigger / effect the server knows about', () => {
    const cat = aiRuleCatalog();
    // Cross-check: every combo references triggers + effects that
    // appear in the catalog arrays. No ghost ids.
    const tIds = new Set(cat.triggers.map((t) => t.id));
    const eIds = new Set(cat.effects.map((e) => e.id));
    for (const c of cat.combos) {
      expect(tIds.has(c.trigger)).toBe(true);
      expect(eIds.has(c.effect)).toBe(true);
    }
  });

  it('surfaces unlock gating and caps', () => {
    const cat = aiRuleCatalog();
    expect(cat.limits.unlockQueenLevel).toBe(RULES_UNLOCK_QUEEN_LEVEL);
    expect(cat.limits.maxRulesPerBuilding).toBe(MAX_RULES_PER_BUILDING);
  });
});
