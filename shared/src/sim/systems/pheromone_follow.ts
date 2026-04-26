import { add, sub, mul, div, sqrt, dist2, fromInt } from '../fixed.js';
import type { Fixed } from '../fixed.js';
import { BUILDING_BEHAVIOR, UNIT_STATS } from '../stats.js';
import type { SimState } from '../state.js';
import type { PheromonePath } from '../../types/pheromone.js';
import type { Unit } from '../../types/units.js';
import { AMBUSH_TICKS } from '../../types/pheromone.js';

// Apply a path modifier to a unit at the moment it arrives at the
// marker waypoint. Returns true if the unit should stop processing its
// path for the remainder of this tick (ambush pause / split break-off);
// false to continue walking. Called from pheromoneFollowSystem only.
function applyPathModifierOnArrival(u: Unit, path: PheromonePath): boolean {
  const mod = path.modifier;
  if (!mod) return false;
  const kind = mod.kind;
  if (kind === 'split') {
    if (u.hasSplit) return false;
    u.hasSplit = true;
    // Deterministic break-off: units with odd id leave the path. Their
    // ids increase monotonically in deploy.ts, so within a single
    // 5-unit burst this is a clean ~50/50 fork.
    if ((u.id & 1) === 1) {
      u.pathId = -1;
      return true;
    }
    return false;
  }
  if (kind === 'dig') {
    if (u.hasDug) return false;
    u.hasDug = true;
    // Only diggers can swap layers. Non-diggers no-op (the marker is
    // still consumed so we don't keep checking).
    const stats = UNIT_STATS[u.kind];
    if (stats.canDig) {
      u.layer = u.layer === 0 ? 1 : 0;
      // Edge flag for AI rules — `onCrossLayerEntry` reads this in
      // the same tick. pheromone_follow clears it at the top of the
      // next tick before any new layer flips can occur.
      u.layerCrossedThisTick = true;
    }
    return false;
  }
  if (kind === 'ambush') {
    if (u.hasAmbushed) return false;
    u.hasAmbushed = true;
    u.ambushTicks = AMBUSH_TICKS;
    return true;
  }
  return false;
}

// Pheromone follow — advances each unit along its assigned polyline by its
// per-tick speed. When a unit reaches the end of its path, pathId is set to
// -1 and the combat system takes over (unit targets nearest building).

// Precondition: units are sorted by id; paths are keyed by pathId in
// insertion order; both invariants are preserved by deploy.ts.

export function pheromoneFollowSystem(state: SimState): void {
  // Linear path lookup. We intentionally avoid allocating a Map per tick
  // (GC-timing-sensitive — violates the sim's no-per-tick-alloc rule).
  // With the design cap of ~16 concurrent paths and ~30 units, the inner
  // O(paths) scan is trivial (~500 comparisons in the worst case).

  // Clear the per-tick layer-cross edge flag before any new dig
  // modifier could fire this tick. ai_rules ran on the PREVIOUS
  // tick's flag; keeping it set into this tick would double-fire
  // any onCrossLayerEntry rule.
  for (let i = 0; i < state.units.length; i++) {
    if (state.units[i]!.layerCrossedThisTick) state.units[i]!.layerCrossedThisTick = false;
  }

  for (let i = 0; i < state.units.length; i++) {
    const u = state.units[i]!;
    if (u.hp <= 0) continue;
    // Rooted units (RootSnare trigger) skip movement until the root
    // expires. Combat.ts decrements rootedTicks each tick.
    if (u.rootedTicks && u.rootedTicks > 0) continue;
    // Ambushed units hold position until the marker timer expires.
    // combat.ts decrements ambushTicks the same tick this check runs,
    // so a unit that lands on the marker pauses for AMBUSH_TICKS full
    // sim ticks before resuming the polyline.
    if (u.ambushTicks && u.ambushTicks > 0) continue;
    if (u.pathId < 0) continue;
    if (u.targetBuildingId !== 0) continue; // combat owns it now

    let path = null as (typeof state.paths)[number] | null;
    for (let j = 0; j < state.paths.length; j++) {
      if (state.paths[j]!.pathId === u.pathId) {
        path = state.paths[j]!;
        break;
      }
    }
    if (!path) {
      u.pathId = -1;
      continue;
    }
    const stats = UNIT_STATS[u.kind];
    let budget: Fixed = stats.speed; // distance remaining to travel this tick

    // Walk the polyline, consuming budget across segments.
    while (budget > 0) {
      // Determine current segment index from pathProgress. We store
      // pathProgress as a Fixed "waypoint index with fractional part".
      const segIdx = (u.pathProgress >> 16) | 0; // integer part
      if (segIdx >= path.points.length - 1) {
        u.pathId = -1; // reached end of path
        break;
      }
      const p0 = path.points[segIdx]!;
      const p1 = path.points[segIdx + 1]!;
      const segDx: Fixed = sub(p1.x, p0.x);
      const segDy: Fixed = sub(p1.y, p0.y);
      const segLen2: Fixed = add(mul(segDx, segDx), mul(segDy, segDy));
      const segLen: Fixed = sqrt(segLen2);
      if (segLen === 0) {
        u.pathProgress = ((segIdx + 1) << 16) | 0;
        if (path.modifier && path.modifier.pointIndex === segIdx + 1) {
          if (applyPathModifierOnArrival(u, path)) break;
        }
        continue;
      }

      // Fractional part of pathProgress = fraction within current segment.
      const fracBits: Fixed = u.pathProgress & 0xffff;
      // Scale fracBits (0..FIXED_ONE) to segLen to get distance already
      // walked on segment.
      const walked: Fixed = mul(fracBits << 0, segLen);
      const remainingOnSeg: Fixed = sub(segLen, walked);

      if (budget >= remainingOnSeg) {
        // Consume the rest of this segment and advance to next waypoint.
        budget = sub(budget, remainingOnSeg);
        u.pathProgress = ((segIdx + 1) << 16) | 0;
        u.x = p1.x;
        u.y = p1.y;
        if (path.modifier && path.modifier.pointIndex === segIdx + 1) {
          if (applyPathModifierOnArrival(u, path)) break;
        }
      } else {
        // Move partway along segment.
        const newWalked: Fixed = add(walked, budget);
        const newFrac: Fixed = div(newWalked, segLen); // 0..FIXED_ONE
        u.pathProgress = ((segIdx << 16) | (newFrac & 0xffff)) | 0;
        u.x = add(p0.x, mul(segDx, newFrac));
        u.y = add(p0.y, mul(segDy, newFrac));
        budget = 0;
      }
    }

    // Once the unit finishes its path, acquire nearest enemy building.
    // Both sides run this scan in symmetric arena. The inner-loop
    // owner-mismatch filter (`b.owner === u.owner` continue) does the
    // actual side filtering, so in raid mode where every building is
    // owner=1 and every attacker is owner=0 we keep the original
    // behavior; defender-side units (NestSpiders) still skip via
    // pheromone_follow because they have no path id (handled in
    // combat.ts).
    if (u.pathId < 0) {
      let bestId = 0;
      let bestDist2: Fixed = fromInt(9999);
      for (let j = 0; j < state.buildings.length; j++) {
        const b = state.buildings[j]!;
        if (b.hp <= 0) continue;
        // Owner filter for symmetric arena. Single-base raid mode
        // stamps every building owner=1 so this is a no-op there.
        if (b.owner === u.owner) continue;
        // Hidden stealth buildings (HiddenStinger pre-reveal) are
        // invisible to target acquisition. Reveal happens inside combat
        // when the building first fires.
        const beh = BUILDING_BEHAVIOR[b.kind];
        if (beh?.stealth && !b.revealed) continue;
        // Unit and building must share a layer OR one of them spans both.
        const canReach =
          b.layer === u.layer || (b.spans && b.spans.includes(u.layer));
        if (!canReach) continue;
        const bx = add(fromInt(b.anchorX), fromInt(b.w) >> 1);
        const by = add(fromInt(b.anchorY), fromInt(b.h) >> 1);
        const d2 = dist2(u.x, u.y, bx, by);
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestId = b.id;
        }
      }
      u.targetBuildingId = bestId;
    }
  }
}
