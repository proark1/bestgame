import { describe, expect, it } from 'vitest';
import { createInitialState } from '../src/sim/init.js';
import type { Base } from '../src/types/base.js';
import type { SimConfig } from '../src/sim/state.js';

// Minimal helper: a Base with one Queen Chamber, varied placement so
// the symmetric mirror produces a visible coordinate flip.
function fakeBase(ownerId: string, queenAnchorX: number): Base {
  return {
    baseId: `b-${ownerId}`,
    ownerId,
    faction: 'Ants',
    gridSize: { w: 16, h: 12 },
    buildings: [
      {
        id: 'q1',
        kind: 'QueenChamber',
        anchor: { x: queenAnchorX, y: 5, layer: 0 },
        footprint: { w: 2, h: 2 },
        spans: [0, 1],
        level: 1,
        hp: 800,
        hpMax: 800,
      },
    ],
    tunnels: [],
    resources: { sugar: 0, leafBits: 0, aphidMilk: 0 },
    trophies: 0,
    version: 1,
  };
}

const cfgFor = (extras: Partial<SimConfig> = {}): SimConfig => ({
  tickRate: 30,
  maxTicks: 2700,
  initialSnapshot: fakeBase('def', 7),
  seed: 0xc0ffee,
  ...extras,
});

describe('symmetric per-building ownership', () => {
  it('single-base raid stamps every building owner=1', () => {
    const s = createInitialState(cfgFor());
    expect(s.buildings.length).toBeGreaterThan(0);
    for (const b of s.buildings) {
      expect(b.owner).toBe(1);
    }
  });

  it('secondSnapshot ingests as owner=0 with mirrored X', () => {
    const s = createInitialState(
      cfgFor({ secondSnapshot: fakeBase('att', 2) }),
    );
    const owner0 = s.buildings.filter((b) => b.owner === 0);
    const owner1 = s.buildings.filter((b) => b.owner === 1);
    // Defender base (owner=1) keeps its authored anchorX.
    expect(owner1.every((b) => b.anchorX === 7)).toBe(true);
    // Attacker base (owner=0) is mirrored: x = gridW(16) - x(2) - w(2) = 12.
    expect(owner0.every((b) => b.anchorX === 12)).toBe(true);
  });

  it('id allocator stays globally unique across both bases', () => {
    const s = createInitialState(
      cfgFor({ secondSnapshot: fakeBase('att', 2) }),
    );
    const ids = s.buildings.map((b) => b.id);
    const set = new Set(ids);
    expect(set.size).toBe(ids.length);
  });
});
