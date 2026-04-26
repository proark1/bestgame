// Lazy data migration that normalizes a base snapshot to the current
// ALLOWED_LAYERS rules. Runs on every /player/me; if the snapshot
// already matches the rules it's a no-op. When a building is found
// on a layer it can no longer occupy (e.g. DungeonTrap on surface
// after we moved traps underground-only), we relocate it to the
// first empty cell on its first allowed layer. If no empty cell
// exists on that layer, the building is demolished — there's no
// alternative and we can't leave a base in an invalid state.
//
// Idempotency: a base that is already valid is returned unchanged
// and `mutated` is false. Running this many times is safe.

import type { Types } from '@hive/shared';
import { ALLOWED_LAYERS, isLayerAllowed } from './buildingRules.js';

export interface LayerMigrationResult {
  base: Types.Base;
  mutated: boolean;
  // Every relocate / demolish is recorded so the API log shows what
  // changed for a given player; callers can optionally surface a
  // toast to the player on next login.
  events: Array<
    | { kind: 'relocate'; building: string; from: Types.Cell; to: Types.Cell }
    | { kind: 'demolish'; building: string; reason: 'no-space' }
  >;
}

export function normalizeBaseLayers(base: Types.Base): LayerMigrationResult {
  const events: LayerMigrationResult['events'] = [];

  // Two passes so a relocation never picks a tile that a still-legal
  // building OCCUPIES later in the array. Single-pass logic that
  // appends survivors as it goes only collides against earlier
  // entries and would happily overlap a relocation onto a building
  // it hasn't seen yet. Cross-layer buildings (QueenChamber,
  // TunnelJunction) are valid on their anchor layer because
  // ALLOWED_LAYERS lists both, so this filter handles them
  // correctly — no special-case branch needed.
  const survivors: Types.Building[] = base.buildings.filter((b) =>
    isLayerAllowed(b.kind, b.anchor.layer),
  );
  const misplaced = base.buildings.filter(
    (b) => !isLayerAllowed(b.kind, b.anchor.layer),
  );

  for (const b of misplaced) {
    const allowed = ALLOWED_LAYERS[b.kind];
    let placed = false;
    for (const targetLayer of allowed) {
      const spot = findEmptyCell(base, survivors, targetLayer, b.footprint);
      if (!spot) continue;
      const moved: Types.Building = {
        ...b,
        anchor: { x: spot.x, y: spot.y, layer: targetLayer },
      };
      events.push({
        kind: 'relocate',
        building: b.id,
        from: b.anchor,
        to: moved.anchor,
      });
      survivors.push(moved);
      placed = true;
      break;
    }
    if (!placed) {
      events.push({
        kind: 'demolish',
        building: b.id,
        reason: 'no-space',
      });
      // Nothing pushed to survivors → building is gone.
    }
  }

  if (events.length === 0) {
    return { base, mutated: false, events };
  }
  return {
    base: {
      ...base,
      buildings: survivors,
      version: (base.version ?? 0) + 1,
    },
    mutated: true,
    events,
  };
}

// Find the lexicographically-first empty cell on `layer` that fits
// the given footprint. Empty = no surviving building's footprint
// rectangle overlaps the candidate rectangle. Deterministic scan
// order keeps migration replays stable across servers.
function findEmptyCell(
  base: Types.Base,
  survivors: readonly Types.Building[],
  layer: Types.Layer,
  footprint: { w: number; h: number },
): { x: number; y: number } | null {
  const W = base.gridSize.w;
  const H = base.gridSize.h;
  for (let y = 0; y <= H - footprint.h; y++) {
    for (let x = 0; x <= W - footprint.w; x++) {
      if (cellsClear(survivors, layer, x, y, footprint.w, footprint.h)) {
        return { x, y };
      }
    }
  }
  return null;
}

function cellsClear(
  survivors: readonly Types.Building[],
  layer: Types.Layer,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  for (const s of survivors) {
    // A building occupies its anchor layer plus any extra layers in
    // `spans`. If the candidate layer is none of those, this survivor
    // doesn't conflict on that layer.
    const occupiesLayer =
      s.anchor.layer === layer || (s.spans?.includes(layer) ?? false);
    if (!occupiesLayer) continue;
    const sx = s.anchor.x;
    const sy = s.anchor.y;
    const sw = s.footprint.w;
    const sh = s.footprint.h;
    if (x + w > sx && sx + sw > x && y + h > sy && sy + sh > y) {
      return false;
    }
  }
  return true;
}
