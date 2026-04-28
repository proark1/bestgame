// Convert a replay's deployPath inputs into a SavedTactic and persist
// it to the local tactic library. Powers the "Steal this tactic"
// button on ReplayFeedScene + RaidHistoryScene — turns a watched
// replay into a one-tap copy of the attacker's plan.
//
// Picks the FIRST deployPath in the replay's input timeline. That's
// usually the marquee opening move (the player's signature pheromone
// trail); any later inputs after the queen falls or the timer ends
// aren't worth copying. If a later improvement wants to import the
// full sequence, it can iterate inputs[] instead.
//
// Lives in client/src/codex/ alongside tacticShare.ts so all the
// tactic mutators agree on the same SavedTactic shape and the same
// localStorage key.

import { Sim, Types } from '@hive/shared';
import {
  TACTICS_STORAGE_KEY,
  TACTICS_LIMIT,
  type SharedTactic,
} from './tacticShare.js';

const TILE = 48;
const SPAWN_ZONE_W = TILE * 2;
const SPAWN_ZONE_H = TILE * 2;
const BOARD_W = TILE * 16;
const BOARD_H = TILE * 12;

function inferSpawnEdge(firstX: number, firstY: number): SharedTactic['spawnEdge'] {
  // Mirror RaidScene's edge-detection thresholds. Tiles → screen px
  // before comparing against SPAWN_ZONE_W/H so the same logic that
  // tagged the original tactic edge applies here.
  const px = firstX * TILE;
  const py = firstY * TILE;
  if (px <= SPAWN_ZONE_W) return 'left';
  if (px >= BOARD_W - SPAWN_ZONE_W) return 'right';
  if (py <= SPAWN_ZONE_H) return 'top';
  if (py >= BOARD_H - SPAWN_ZONE_H) return 'bottom';
  return 'left';
}

interface ReplayInputLike {
  type: string;
  tick: number;
  ownerSlot?: number;
  path?: {
    unitKind: Types.UnitKind;
    points?: Array<{ x: unknown; y: unknown }>;
    modifier?: { kind: string; pointIndex: number };
  };
}

// Extract a SavedTactic-shaped object from the replay inputs. Returns
// null when no usable deployPath exists (e.g. the attacker
// surrendered without deploying).
export function tacticFromReplayInputs(
  inputs: ReplayInputLike[],
  attackerName: string,
): {
  name: string;
  unitKind: Types.UnitKind;
  pointsTile: Array<{ x: number; y: number }>;
  modifier?: Types.PathModifier;
  spawnEdge: SharedTactic['spawnEdge'];
} | null {
  const first = inputs.find(
    (i) => i.type === 'deployPath' && i.path && Array.isArray(i.path.points),
  );
  if (!first || !first.path || !first.path.points) return null;
  const pts: Array<{ x: number; y: number }> = [];
  for (const p of first.path.points) {
    // Replay points are stored as Q16.16 fixed (numbers post-JSON);
    // toFloat() reverses to tile units. Filter NaN/non-finite so a
    // truncated payload can't seed garbage into the tactic library.
    const x = Sim.toFloat(p.x as Sim.Fixed);
    const y = Sim.toFloat(p.y as Sim.Fixed);
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y });
  }
  if (pts.length < 2) return null;
  // Cap to the same 32-point ceiling RaidScene enforces on draws
  // and tactic-share imports. Long replay paths get downsampled by
  // even-stride keep so the shape survives.
  if (pts.length > 32) {
    const stride = pts.length / 32;
    const downsampled: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 32; i++) {
      const idx = Math.min(pts.length - 1, Math.floor(i * stride));
      downsampled.push(pts[idx]!);
    }
    // Always preserve the last point so the tactic ends where the
    // original did, not at a downsampled neighbour.
    downsampled[downsampled.length - 1] = pts[pts.length - 1]!;
    pts.splice(0, pts.length, ...downsampled);
  }
  const unitKind = first.path.unitKind;
  const modifier =
    first.path.modifier &&
    (first.path.modifier.kind === 'split' ||
      first.path.modifier.kind === 'ambush' ||
      first.path.modifier.kind === 'dig')
      ? {
          kind: first.path.modifier.kind as Types.PathModifierKind,
          pointIndex: first.path.modifier.pointIndex,
        }
      : undefined;
  const spawnEdge = inferSpawnEdge(pts[0]!.x, pts[0]!.y);
  const trimmed = (attackerName ?? 'Stolen').slice(0, 24);
  return {
    name: `Stolen · ${trimmed}`,
    unitKind,
    pointsTile: pts,
    ...(modifier ? { modifier } : {}),
    spawnEdge,
  };
}

// Persist a freshly extracted tactic to the local library (FIFO with
// a soft cap). Returns true on success — caller surfaces a toast.
export function stashTactic(tactic: {
  name: string;
  unitKind: Types.UnitKind;
  pointsTile: Array<{ x: number; y: number }>;
  modifier?: Types.PathModifier;
  spawnEdge: SharedTactic['spawnEdge'];
}): boolean {
  try {
    const raw = localStorage.getItem(TACTICS_STORAGE_KEY);
    let list: unknown[] = [];
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    }
    list.unshift(tactic);
    list = list.slice(0, TACTICS_LIMIT);
    localStorage.setItem(TACTICS_STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
