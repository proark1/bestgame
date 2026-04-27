import { add, fromInt, fromFloat, mul } from '../fixed.js';
import type { Fixed } from '../fixed.js';
import { UNIT_STATS } from '../stats.js';
import { HERO_STATS_FIXED } from '../heroStats.js';
import { levelStatPercent } from '../progression.js';
import type { SimState } from '../state.js';
import type { PheromonePath } from '../../types/pheromone.js';
import type { UnitKind } from '../../types/units.js';

// Deploy system — consumes a `deployPath` input and spawns its units.
//
// Ordering is critical for determinism: for a single path, the Nth unit is
// spawned at slot N/count along the first segment of the polyline. That
// gives a visually pleasing "line of ants" effect AND is fully deterministic.

// Integer-only stat multiplier: scales a Fixed by factor/100 (e.g. 117
// = +17% at level 2). Uses Fixed mul so determinism is preserved; we
// never touch float arithmetic. The percent table lives in
// progression.ts — see docs/GAME_DESIGN.md §6.3.
function scaleFixedByPercent(value: Fixed, percent: number): Fixed {
  return mul(value, fromInt(percent)) / 100 | 0;
}

export function applyDeploy(
  state: SimState,
  ownerSlot: 0 | 1,
  path: PheromonePath,
  attackerUnitLevels?: Partial<Record<UnitKind, number>>,
): void {
  // Hero deployments are capped at 1 unit per path regardless of
  // path.count — heroes are unique, so even a misbehaving client
  // can't spawn 5 Mantises off one drag.
  const isHeroPath = !!path.heroKind;
  const requested = isHeroPath ? Math.min(1, path.count) : path.count;
  const capRemaining = state.deployCapRemaining[ownerSlot];
  const count = Math.min(requested, capRemaining);
  if (count <= 0) return;

  state.deployCapRemaining[ownerSlot] = capRemaining - count;

  // Persist the path so pheromoneFollow can walk it each tick. The
  // optional `modifier` is copied through verbatim — pheromone_follow
  // reads it on each waypoint arrival. heroKind is preserved on the
  // stored path so a future re-spawn or debug tool can recover the
  // intent.
  const storedPath: PheromonePath = {
    pathId: state.nextPathId++,
    spawnLayer: path.spawnLayer,
    unitKind: path.unitKind,
    count,
    points: path.points,
    ...(path.modifier ? { modifier: path.modifier } : {}),
    ...(path.heroKind ? { heroKind: path.heroKind } : {}),
  };
  state.paths.push(storedPath);

  // Stat lookup: hero deployments use HERO_STATS_FIXED keyed by
  // heroKind; everything else stays on UNIT_STATS. Hero HP doesn't
  // scale with attackerUnitLevels — heroes are leveled separately
  // (PR E will add hero leveling); for PR D every hero is L1.
  const stats = isHeroPath
    ? HERO_STATS_FIXED[path.heroKind!]
    : UNIT_STATS[path.unitKind];
  const first = path.points[0];
  const second = path.points[1] ?? first;
  if (!first || !second) return;

  const level = ownerSlot === 0 && !isHeroPath
    ? attackerUnitLevels?.[path.unitKind]
    : undefined;
  const pct = levelStatPercent(level);
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
      spawnLayer: path.spawnLayer,
      x: first.x,
      y: add(first.y, yOffset),
      hp,
      hpMax: hp,
      pathId: storedPath.pathId,
      pathProgress: 0,
      attackCooldown: 0,
      targetBuildingId: 0,
      ...(path.heroKind ? { heroKind: path.heroKind } : {}),
    });
  }

  // Preserve id-sorted invariant — we always append with higher ids, so this
  // is a no-op, but we guard against future insertion paths.
}
