import { fromInt } from './fixed.js';
import { Rng } from './rng.js';
import { BUILDING_STATS } from './stats.js';
import type { Base, BuildingAIRule } from '../types/base.js';
import type { SimBuilding, SimConfig, SimRuleState, SimState } from './state.js';

// Turn a player-authored rule into its runtime mirror. Keeps the
// original rule object (read-only — the sim treats it as
// configuration) and adds the mutable state the evaluator needs.
function hydrateRule(r: BuildingAIRule): SimRuleState {
  return {
    rule: r,
    remaining: r.remainingUses === undefined || r.remainingUses < 0
      ? null
      : r.remainingUses,
    rearmCooldown: 0,
    prevConditionTrue: false,
    tickAccumulator: 0,
    extraSpawnsGranted: 0,
  };
}

// Build an initial SimState from a Base snapshot + seed.
// The attacker starts with no units on field; all deploys come from input.

export function createInitialState(cfg: SimConfig): SimState {
  const rng = new Rng(cfg.seed);
  const buildings: SimBuilding[] = [];

  let nextId = 1;

  // Walk a single snapshot, stamp owner, optionally mirror the X
  // coordinate (for symmetric arena where the second base sits on the
  // left half of the grid). Returns the next id to use after this
  // snapshot's buildings — caller chains both sides through one
  // counter so ids stay globally unique + sortable.
  const ingest = (snap: Base, owner: 0 | 1, mirrorX: boolean): void => {
    // Iterate the snapshot's building list in sorted id order so the
    // resulting SimState.buildings array is deterministic (the Base
    // snapshot itself is canonical JSON from the server; we don't
    // trust insertion order).
    const sorted = [...snap.buildings].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const gridW = snap.gridSize?.w ?? 16;
    const reflectX = (x: number, w: number): number =>
      mirrorX ? gridW - x - w : x;

    for (const b of sorted) {
      const stats = BUILDING_STATS[b.kind];
      const spans = b.spans ? [...b.spans].sort() : null;
      const ax = reflectX(b.anchor.x, b.footprint.w);
      // A cross-layer building becomes one SimBuilding per layer so
      // the per-layer renderer + hit detection stay simple. HP is
      // shared by storing the same id on both copies; combat updates
      // hp on whichever copy gets hit but the combat system keys by
      // id and applies damage to the first matching instance — both
      // copies get marked destroyed when hp hits 0.
      if (spans && spans.length > 0) {
        // Cross-layer buildings (Queen Chamber etc.) share a SINGLE id
        // across both layers — combat looks up the first id match, so
        // damage applied to one copy is mirrored to the other. Assign
        // the id once before the layer loop; allocating per-layer
        // would silently break the linkage.
        const sharedId = nextId++;
        for (const layer of spans) {
          buildings.push({
            id: sharedId,
            kind: b.kind,
            owner,
            layer,
            anchorX: ax,
            anchorY: b.anchor.y,
            w: b.footprint.w,
            h: b.footprint.h,
            spans,
            hp: fromInt(b.hp),
            hpMax: fromInt(stats.hpMax),
            level: b.level,
            attackCooldown: 0,
            ...(b.aiRules && b.aiRules.length > 0
              ? { rules: b.aiRules.map(hydrateRule) }
              : {}),
          });
        }
      } else {
        buildings.push({
          id: nextId++,
          kind: b.kind,
          owner,
          layer: b.anchor.layer,
          anchorX: ax,
          anchorY: b.anchor.y,
          w: b.footprint.w,
          h: b.footprint.h,
          spans: null,
          hp: fromInt(b.hp),
          hpMax: fromInt(stats.hpMax),
          level: b.level,
          attackCooldown: 0,
          ...(b.aiRules && b.aiRules.length > 0
            ? { rules: b.aiRules.map(hydrateRule) }
            : {}),
        });
      }
    }
  };

  // Defender base — always present. Owner=1 (asymmetric raid default).
  // No X-mirroring: this is the only base in single-base mode and stays
  // in its authored position.
  ingest(cfg.initialSnapshot, 1, false);
  // Symmetric arena mode: a second base sits on the LEFT half of the
  // grid as owner=0. We mirror X coordinates so the second player's
  // authored layout reads left-to-right intuitively from their POV.
  if (cfg.secondSnapshot) {
    ingest(cfg.secondSnapshot, 0, true);
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
