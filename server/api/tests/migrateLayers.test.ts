import { describe, expect, it } from 'vitest';
import type { Types } from '@hive/shared';

import { normalizeBaseLayers } from '../src/game/migrateLayers.js';

function makeBase(buildings: Types.Building[]): Types.Base {
  return {
    baseId: 'b1',
    ownerId: 'p1',
    faction: 'Ants',
    gridSize: { w: 16, h: 12 },
    buildings,
    tunnels: [],
    resources: { sugar: 0, leafBits: 0, aphidMilk: 0 },
    trophies: 0,
    version: 5,
  };
}

function building(
  id: string,
  kind: Types.BuildingKind,
  layer: Types.Layer,
  x: number,
  y: number,
  footprint = { w: 1, h: 1 },
): Types.Building {
  return {
    id,
    kind,
    anchor: { x, y, layer },
    footprint,
    level: 1,
    hp: 100,
    hpMax: 100,
    ...(kind === 'QueenChamber' ? { spans: [0, 1] as Types.Layer[] } : {}),
  };
}

describe('normalizeBaseLayers', () => {
  it('is a no-op when every building is already on a legal layer', () => {
    const base = makeBase([
      building('q', 'QueenChamber', 0, 7, 5, { w: 2, h: 2 }),
      building('t1', 'MushroomTurret', 0, 3, 3),
      building('v1', 'SugarVault', 1, 5, 8),
    ]);
    const out = normalizeBaseLayers(base);
    expect(out.mutated).toBe(false);
    expect(out.events).toEqual([]);
    expect(out.base).toBe(base);
  });

  it('relocates a now-illegal trap from surface to underground', () => {
    // DungeonTrap is now underground-only; the base has it on
    // surface from a pre-migration save.
    const base = makeBase([
      building('q', 'QueenChamber', 0, 7, 5, { w: 2, h: 2 }),
      building('t1', 'DungeonTrap', 0, 3, 3),
    ]);
    const out = normalizeBaseLayers(base);
    expect(out.mutated).toBe(true);
    expect(out.events).toHaveLength(1);
    const e = out.events[0]!;
    expect(e.kind).toBe('relocate');
    if (e.kind !== 'relocate') return;
    expect(e.building).toBe('t1');
    expect(e.from.layer).toBe(0);
    expect(e.to.layer).toBe(1);
    // Building should now sit on layer 1.
    const moved = out.base.buildings.find((b) => b.id === 't1')!;
    expect(moved.anchor.layer).toBe(1);
    // Version is bumped so clients/replays can distinguish.
    expect(out.base.version).toBe(6);
  });

  it('relocates RootSnare to underground (paired migration)', () => {
    const base = makeBase([
      building('s1', 'RootSnare', 0, 4, 4),
    ]);
    const out = normalizeBaseLayers(base);
    expect(out.mutated).toBe(true);
    const moved = out.base.buildings.find((b) => b.id === 's1')!;
    expect(moved.anchor.layer).toBe(1);
  });

  it('demolishes when the target layer is fully occupied', () => {
    // Fill the entire underground with 1x1 blockers (192 cells on a
    // 16x12 grid). DungeonTrap has nowhere to go → demolished.
    const blockers: Types.Building[] = [];
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 16; x++) {
        blockers.push(building(`u-${x}-${y}`, 'SugarVault', 1, x, y));
      }
    }
    blockers.push(building('t1', 'DungeonTrap', 0, 3, 3));
    const base = makeBase(blockers);
    const out = normalizeBaseLayers(base);
    expect(out.mutated).toBe(true);
    const events = out.events.filter((e) => e.building === 't1');
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('demolish');
    // The trap should be gone from the survivor list.
    expect(out.base.buildings.find((b) => b.id === 't1')).toBeUndefined();
  });

  it('does not relocate cross-layer buildings whose anchor layer is allowed', () => {
    // QueenChamber is allowed on both layers; anchor layer 0 is fine.
    const base = makeBase([
      building('q', 'QueenChamber', 0, 7, 5, { w: 2, h: 2 }),
    ]);
    const out = normalizeBaseLayers(base);
    expect(out.mutated).toBe(false);
  });
});
