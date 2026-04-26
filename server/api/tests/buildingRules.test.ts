import { describe, expect, it } from 'vitest';
import type { Types } from '@hive/shared';
import {
  ALLOWED_LAYERS,
  MAX_QUEEN_LEVEL,
  MIN_QUEEN_LEVEL,
  QUEEN_UPGRADE_COST,
  QUOTA_BY_TIER,
  buildingRulesPayload,
  countOfKind,
  isLayerAllowed,
  queenLevel,
  quotaFor,
} from '../src/game/buildingRules.js';

// Shape invariants for the town-builder rules table. These pin the
// contract every caller on the server + client depends on — a
// rename / off-by-one here would silently break either the picker
// gate or the placement route.

function makeBase(overrides: Partial<Types.Base> = {}): Types.Base {
  return {
    baseId: 't',
    ownerId: 't',
    faction: 'Ants',
    gridSize: { w: 16, h: 12 },
    resources: { sugar: 0, leafBits: 0, aphidMilk: 0 },
    trophies: 0,
    version: 1,
    tunnels: [],
    buildings: [],
    ...overrides,
  };
}

describe('ALLOWED_LAYERS', () => {
  it('has an entry for every building kind', () => {
    const kinds: Types.BuildingKind[] = [
      'QueenChamber',
      'DewCollector',
      'MushroomTurret',
      'LeafWall',
      'PebbleBunker',
      'LarvaNursery',
      'SugarVault',
      'TunnelJunction',
      'DungeonTrap',
    ];
    for (const k of kinds) expect(ALLOWED_LAYERS[k]).toBeDefined();
  });

  it('defensive buildings live on the surface only', () => {
    for (const k of ['MushroomTurret', 'LeafWall', 'PebbleBunker', 'DewCollector'] as const) {
      expect([...ALLOWED_LAYERS[k]]).toEqual([0]);
    }
  });

  it('economy + nursery live underground only', () => {
    for (const k of ['LarvaNursery', 'SugarVault'] as const) {
      expect([...ALLOWED_LAYERS[k]]).toEqual([1]);
    }
  });

  it('tunnel junction + Queen Chamber span both layers', () => {
    for (const k of ['QueenChamber', 'TunnelJunction'] as const) {
      expect([...ALLOWED_LAYERS[k]].sort()).toEqual([0, 1]);
    }
  });

  it('traps live underground (paired with vault + nursery in the loot heart)', () => {
    for (const k of ['DungeonTrap', 'RootSnare'] as const) {
      expect([...ALLOWED_LAYERS[k]]).toEqual([1]);
    }
  });
});

describe('QUOTA_BY_TIER', () => {
  it('has exactly MAX_QUEEN_LEVEL entries per kind', () => {
    for (const k of Object.keys(QUOTA_BY_TIER) as Types.BuildingKind[]) {
      expect(QUOTA_BY_TIER[k].length).toBe(MAX_QUEEN_LEVEL);
    }
  });

  it('is monotonically non-decreasing per kind (tiers only unlock, never revoke)', () => {
    for (const k of Object.keys(QUOTA_BY_TIER) as Types.BuildingKind[]) {
      const row = QUOTA_BY_TIER[k];
      for (let i = 1; i < row.length; i++) {
        expect(
          row[i]! >= row[i - 1]!,
          `${k} tier ${i + 1} (${row[i]}) < tier ${i} (${row[i - 1]})`,
        ).toBe(true);
      }
    }
  });
});

describe('queenLevel + countOfKind + quotaFor + isLayerAllowed', () => {
  it('queenLevel reads from QueenChamber.level, clamped to [MIN, MAX]', () => {
    const l0 = queenLevel(makeBase({ buildings: [{ id: 'q', kind: 'QueenChamber', anchor: { x: 0, y: 0, layer: 0 }, footprint: { w: 2, h: 2 }, spans: [0, 1], level: 3, hp: 1, hpMax: 1 }] }));
    expect(l0).toBe(3);
    // No queen → default to MIN_QUEEN_LEVEL.
    expect(queenLevel(makeBase())).toBe(MIN_QUEEN_LEVEL);
    // Above cap clamps.
    const hi = queenLevel(makeBase({ buildings: [{ id: 'q', kind: 'QueenChamber', anchor: { x: 0, y: 0, layer: 0 }, footprint: { w: 2, h: 2 }, spans: [0, 1], level: 99, hp: 1, hpMax: 1 }] }));
    expect(hi).toBe(MAX_QUEEN_LEVEL);
  });

  it('countOfKind counts every row regardless of hp', () => {
    const base = makeBase({
      buildings: [
        { id: '1', kind: 'MushroomTurret', anchor: { x: 0, y: 0, layer: 0 }, footprint: { w: 1, h: 1 }, level: 1, hp: 0, hpMax: 100 },
        { id: '2', kind: 'MushroomTurret', anchor: { x: 1, y: 0, layer: 0 }, footprint: { w: 1, h: 1 }, level: 1, hp: 50, hpMax: 100 },
        { id: '3', kind: 'LeafWall', anchor: { x: 2, y: 0, layer: 0 }, footprint: { w: 1, h: 1 }, level: 1, hp: 50, hpMax: 100 },
      ],
    });
    expect(countOfKind(base, 'MushroomTurret')).toBe(2);
    expect(countOfKind(base, 'LeafWall')).toBe(1);
    expect(countOfKind(base, 'PebbleBunker')).toBe(0);
  });

  it('quotaFor clamps out-of-range levels', () => {
    // Queen 0 → treated as level 1.
    expect(quotaFor('MushroomTurret', 0)).toBe(QUOTA_BY_TIER.MushroomTurret[0]);
    // Queen 99 → treated as MAX.
    expect(quotaFor('MushroomTurret', 99)).toBe(
      QUOTA_BY_TIER.MushroomTurret[MAX_QUEEN_LEVEL - 1],
    );
  });

  it('isLayerAllowed rejects surface buildings on layer 1', () => {
    expect(isLayerAllowed('MushroomTurret', 0)).toBe(true);
    expect(isLayerAllowed('MushroomTurret', 1)).toBe(false);
    expect(isLayerAllowed('SugarVault', 0)).toBe(false);
    expect(isLayerAllowed('SugarVault', 1)).toBe(true);
    expect(isLayerAllowed('TunnelJunction', 0)).toBe(true);
    expect(isLayerAllowed('TunnelJunction', 1)).toBe(true);
  });
});

describe('QUEEN_UPGRADE_COST', () => {
  it('has MAX_QUEEN_LEVEL - 1 entries (one per 1→2, 2→3, …, (max-1)→max)', () => {
    expect(QUEEN_UPGRADE_COST.length).toBe(MAX_QUEEN_LEVEL - 1);
  });

  it('cost is strictly increasing per tier', () => {
    for (let i = 1; i < QUEEN_UPGRADE_COST.length; i++) {
      expect(QUEEN_UPGRADE_COST[i]!.sugar > QUEEN_UPGRADE_COST[i - 1]!.sugar).toBe(true);
      expect(QUEEN_UPGRADE_COST[i]!.leafBits > QUEEN_UPGRADE_COST[i - 1]!.leafBits).toBe(true);
    }
  });

  it('first upgrade is intentionally cheap (hook the new player)', () => {
    expect(QUEEN_UPGRADE_COST[0]!.sugar).toBeLessThanOrEqual(1000);
  });
});

describe('buildingRulesPayload', () => {
  it('is JSON-serializable and mirrors the in-memory tables', () => {
    const payload = buildingRulesPayload();
    const roundtripped = JSON.parse(JSON.stringify(payload));
    expect(roundtripped.MushroomTurret.allowedLayers).toEqual([0]);
    expect(roundtripped.MushroomTurret.quotaByTier.length).toBe(MAX_QUEEN_LEVEL);
  });

  it('exposes every known kind', () => {
    const payload = buildingRulesPayload();
    for (const k of Object.keys(ALLOWED_LAYERS) as Types.BuildingKind[]) {
      expect(payload[k]).toBeDefined();
    }
  });
});
