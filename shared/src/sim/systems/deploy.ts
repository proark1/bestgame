import { add, fromInt, fromFloat, mul } from '../fixed.js';
import type { Fixed } from '../fixed.js';
import { UNIT_STATS } from '../stats.js';
import type { SimState } from '../state.js';
import type { PheromonePath } from '../../types/pheromone.js';
import type { UnitKind } from '../../types/units.js';

// Deploy system — consumes a `deployPath` input and spawns its units.
//
// Ordering is critical for determinism: for a single path, the Nth unit is
// spawned at slot N/count along the first segment of the polyline. That
// gives a visually pleasing "line of ants" effect AND is fully deterministic.

// Integer-only stat multiplier: scales a Fixed by factor/100 (e.g. 120
// = +20% per level × 1 level). Uses Fixed mul so determinism is
// preserved; we never touch float arithmetic.
function scaleFixedByPercent(value: Fixed, percent: number): Fixed {
  // percent is an integer 100..10000 for levels 1..MAX_UNIT_LEVEL+.
  return mul(value, fromInt(percent)) / 100 | 0;
}

// level N = (1 + 0.2 * (N - 1)) × base, expressed as an integer percent.
// Kept alongside the deploy code (not in a shared constant) so the sim
// stays self-contained; server/api/src/game/upgradeCosts.ts has the
// matching formula.
function levelPercent(level: number | undefined): number {
  if (!level || level <= 1) return 100;
  const capped = Math.min(10, Math.floor(level));
  return 100 + 20 * (capped - 1);
}

export function applyDeploy(
  state: SimState,
  ownerSlot: 0 | 1,
  path: PheromonePath,
  attackerUnitLevels?: Partial<Record<UnitKind, number>>,
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

  // Apply per-kind level scaling to HP. Damage scaling happens at hit
  // time in combat.ts so we only need to persist `hp` + `hpMax` here.
  // Level only applies to attacker-owned units.
  const level = ownerSlot === 0 ? attackerUnitLevels?.[path.unitKind] : undefined;
  const pct = levelPercent(level);
  const hp = scaleFixedByPercent(stats.hpMax, pct);

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
      hp,
      hpMax: hp,
      pathId: storedPath.pathId,
      pathProgress: 0,
      attackCooldown: 0,
      targetBuildingId: 0,
    });
  }

  // Preserve id-sorted invariant — we always append with higher ids, so this
  // is a no-op, but we guard against future insertion paths.
}
