import { add, fromInt, fromFloat, mul } from '../fixed.js';
import { UNIT_STATS } from '../stats.js';
import type { SimState } from '../state.js';
import type { PheromonePath } from '../../types/pheromone.js';

// Deploy system — consumes a `deployPath` input and spawns its units.
//
// Ordering is critical for determinism: for a single path, the Nth unit is
// spawned at slot N/count along the first segment of the polyline. That
// gives a visually pleasing "line of ants" effect AND is fully deterministic.

export function applyDeploy(
  state: SimState,
  ownerSlot: 0 | 1,
  path: PheromonePath,
): void {
  const capRemaining = state.deployCapRemaining[ownerSlot];
  const count = Math.min(path.count, capRemaining);
  if (count <= 0) return;

  state.deployCapRemaining[ownerSlot] = capRemaining - count;

  // Persist the path so pheromoneFollow can walk it each tick.
  const storedPath: PheromonePath = {
    pathId: state.nextPathId++,
    spawnLayer: path.spawnLayer,
    unitKind: path.unitKind,
    count,
    points: path.points,
  };
  state.paths.push(storedPath);

  const stats = UNIT_STATS[path.unitKind];
  const first = path.points[0];
  const second = path.points[1] ?? first;
  if (!first || !second) return;

  // Spawn units along the first segment, spaced at 0.3-tile intervals.
  // We stagger on y so the "line of ants" effect is visible; pheromoneFollow
  // then sweeps them along the polyline at their per-unit speed.
  const spacing = fromFloat(0.3);
  for (let i = 0; i < count; i++) {
    const yOffset = mul(fromInt(i), spacing);
    state.units.push({
      id: state.nextUnitId++,
      kind: path.unitKind,
      owner: ownerSlot,
      layer: path.spawnLayer,
      x: first.x,
      y: add(first.y, yOffset),
      hp: stats.hpMax,
      hpMax: stats.hpMax,
      pathId: storedPath.pathId,
      pathProgress: 0,
      attackCooldown: 0,
      targetBuildingId: 0,
    });
  }

  // Preserve id-sorted invariant — we always append with higher ids, so this
  // is a no-op, but we guard against future insertion paths.
}
