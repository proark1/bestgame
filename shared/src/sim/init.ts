import { fromInt } from './fixed.js';
import { Rng } from './rng.js';
import { BUILDING_STATS } from './stats.js';
import type { Base } from '../types/base.js';
import type { SimBuilding, SimConfig, SimState } from './state.js';

// Build an initial SimState from a Base snapshot + seed.
// The attacker starts with no units on field; all deploys come from input.

export function createInitialState(cfg: SimConfig): SimState {
  const rng = new Rng(cfg.seed);
  const buildings: SimBuilding[] = [];

  let nextId = 1;
  // Iterate the snapshot's building list in sorted id order so the resulting
  // SimState.buildings array is deterministic (the Base snapshot itself is
  // canonical JSON from the server; we don't trust insertion order).
  const sorted = [...cfg.initialSnapshot.buildings].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  for (const b of sorted) {
    const stats = BUILDING_STATS[b.kind];
    const spans = b.spans ? [...b.spans].sort() : null;
    // A cross-layer building becomes one SimBuilding per layer so the
    // per-layer renderer + hit detection stay simple. HP is shared by
    // storing the same id on both copies; combat updates hp on whichever
    // copy gets hit but the combat system keys by id and applies damage
    // to the first matching instance — both copies get marked destroyed
    // when hp hits 0.
    if (spans && spans.length > 0) {
      for (const layer of spans) {
        buildings.push({
          id: nextId++,
          kind: b.kind,
          layer,
          anchorX: b.anchor.x,
          anchorY: b.anchor.y,
          w: b.footprint.w,
          h: b.footprint.h,
          spans,
          hp: fromInt(b.hp),
          hpMax: fromInt(stats.hpMax),
          level: b.level,
          attackCooldown: 0,
        });
      }
    } else {
      buildings.push({
        id: nextId++,
        kind: b.kind,
        layer: b.anchor.layer,
        anchorX: b.anchor.x,
        anchorY: b.anchor.y,
        w: b.footprint.w,
        h: b.footprint.h,
        spans: null,
        hp: fromInt(b.hp),
        hpMax: fromInt(stats.hpMax),
        level: b.level,
        attackCooldown: 0,
      });
    }
  }

  return {
    tick: 0,
    units: [],
    buildings,
    paths: [],
    nextUnitId: 1,
    nextPathId: 1,
    rngState: rng.snapshot(),
    attackerSugarLooted: 0,
    attackerLeafBitsLooted: 0,
    deployCapRemaining: [30, 30],
    outcome: 'ongoing',
  };
}
