import { add, sub, mul, div, sqrt, dist2, fromInt } from '../fixed.js';
import type { Fixed } from '../fixed.js';
import { BUILDING_BEHAVIOR, UNIT_STATS } from '../stats.js';
import type { SimState } from '../state.js';

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

  for (let i = 0; i < state.units.length; i++) {
    const u = state.units[i]!;
    if (u.hp <= 0) continue;
    // Rooted units (RootSnare trigger) skip movement until the root
    // expires. Combat.ts decrements rootedTicks each tick.
    if (u.rootedTicks && u.rootedTicks > 0) continue;
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
    // Only attackers (owner=0) target buildings — defender AI units run
    // in combat.ts and target attacker units instead.
    if (u.pathId < 0 && u.owner === 0) {
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
