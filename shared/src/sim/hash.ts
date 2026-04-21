import type { SimState } from './state.js';

// Deterministic 32-bit hash of a SimState. Used by the determinism CI gate
// and by live-arena reconciliation. Must be stable across engines:
// no floats, no Map iteration, no object-key iteration order reliance.
//
// Uses FNV-1a 32-bit — simple, fast, and its arithmetic (multiplication
// truncated to 32 bits) is identical everywhere JS runs.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function mixU32(h: number, x: number): number {
  h ^= x & 0xff;
  h = Math.imul(h, FNV_PRIME) >>> 0;
  h ^= (x >>> 8) & 0xff;
  h = Math.imul(h, FNV_PRIME) >>> 0;
  h ^= (x >>> 16) & 0xff;
  h = Math.imul(h, FNV_PRIME) >>> 0;
  h ^= (x >>> 24) & 0xff;
  h = Math.imul(h, FNV_PRIME) >>> 0;
  return h;
}

function mixStr(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), FNV_PRIME) >>> 0;
  }
  return h;
}

export function hashSimState(s: SimState): number {
  let h = FNV_OFFSET >>> 0;
  h = mixU32(h, s.tick);
  h = mixU32(h, s.nextUnitId);
  h = mixU32(h, s.nextPathId);
  h = mixU32(h, s.attackerSugarLooted);
  h = mixU32(h, s.attackerLeafBitsLooted);
  h = mixU32(h, s.deployCapRemaining[0]!);
  h = mixU32(h, s.deployCapRemaining[1]!);
  h = mixStr(h, s.outcome);
  h = mixStr(h, s.rngState.state);
  h = mixStr(h, s.rngState.inc);

  // Units sorted by id — we maintain this invariant on insertion so a
  // simple index walk is stable.
  for (let i = 0; i < s.units.length; i++) {
    const u = s.units[i]!;
    h = mixU32(h, u.id);
    h = mixU32(h, u.owner);
    h = mixU32(h, u.layer);
    h = mixU32(h, u.x);
    h = mixU32(h, u.y);
    h = mixU32(h, u.hp);
    h = mixU32(h, u.hpMax);
    h = mixU32(h, u.pathId);
    h = mixU32(h, u.pathProgress);
    h = mixU32(h, u.attackCooldown);
    h = mixU32(h, u.targetBuildingId);
    h = mixStr(h, u.kind);
  }
  for (let i = 0; i < s.buildings.length; i++) {
    const b = s.buildings[i]!;
    h = mixU32(h, b.id);
    h = mixU32(h, b.layer);
    h = mixU32(h, b.anchorX);
    h = mixU32(h, b.anchorY);
    h = mixU32(h, b.w);
    h = mixU32(h, b.h);
    h = mixU32(h, b.hp);
    h = mixU32(h, b.hpMax);
    h = mixU32(h, b.level);
    h = mixU32(h, b.attackCooldown);
    h = mixStr(h, b.kind);
  }
  return h >>> 0;
}

export function hashToHex(h: number): string {
  return h.toString(16).padStart(8, '0');
}
