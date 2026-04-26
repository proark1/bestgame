// Tactic sharing — encode a SavedTactic into a URL-safe string and
// decode it back. The encoded string lands in window.location.hash
// (e.g. `#tactic=AbC123…`); BootScene (or any other early entry
// point) calls decode + persist on startup so a friend who opens the
// link is greeted with the tactic pre-loaded into their saved set.
//
// We base64-encode a compact JSON shape that uses single-letter keys
// and rounded coordinates. A 32-point polyline + modifier survives
// at well under URL-length limits on every common browser. The
// spec is deliberately tiny so the URL stays scannable in chat
// previews on mobile.

// Mirror the SavedTactic shape from RaidScene without importing it
// (would create a Phaser dependency from a util that should stay
// pure for testing). Callers cast on the way out.
export interface SharedTacticPoint {
  x: number;
  y: number;
}
export interface SharedTacticModifier {
  kind: 'split' | 'ambush' | 'dig';
  pointIndex: number;
}
export interface SharedTactic {
  name: string;
  unitKind: string;
  pointsTile: SharedTacticPoint[];
  modifier?: SharedTacticModifier;
  spawnEdge: 'left' | 'top' | 'bottom';
}

// Tighter caps than localStorage allows — anything that fits in
// localStorage also fits here. The decoder rejects oversized
// payloads so a hostile URL can't blow up the deck UI.
const MAX_POINTS = 32;
const MAX_NAME_LEN = 64;
const ALLOWED_KINDS = new Set<string>([
  'WorkerAnt', 'SoldierAnt', 'DirtDigger', 'Forager', 'Wasp',
  'HoneyTank', 'ShieldBeetle', 'BombBeetle', 'Roller', 'Jumper',
  'WebSetter', 'Ambusher', 'FireAnt', 'Termite', 'Dragonfly',
  'Mantis', 'Scarab',
]);
const ALLOWED_EDGES = new Set<SharedTactic['spawnEdge']>(['left', 'top', 'bottom']);
const ALLOWED_MOD_KINDS = new Set<SharedTacticModifier['kind']>(['split', 'ambush', 'dig']);

interface CompactTactic {
  n: string;
  k: string;
  e: string;
  p: number[][];
  m?: [string, number];
}

// Round to two decimals — half-tile precision is more than enough to
// re-stamp a path on the same 16×12 grid and it shaves URL length.
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function base64UrlEncode(s: string): string {
  // btoa handles latin1; we wrap with TextEncoder/decoder semantics
  // by URI-encoding non-ASCII first, then unescaping.
  const ascii = unescape(encodeURIComponent(s));
  const b64 = (typeof btoa === 'function' ? btoa : nodeBtoa)(ascii);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const ascii = (typeof atob === 'function' ? atob : nodeAtob)(b64);
    return decodeURIComponent(escape(ascii));
  } catch {
    return null;
  }
}

// Node fallback for the rare path where this runs outside a browser
// (vitest jsdom usually provides btoa/atob, but bare Node CI steps
// might not). Avoids an explicit Buffer import to keep the bundle
// browser-only when transpiled.
interface NodeBufferShim {
  from(input: string, encoding: string): { toString(encoding: string): string };
}
function nodeBuffer(): NodeBufferShim | null {
  if (typeof globalThis === 'undefined') return null;
  const candidate = (globalThis as unknown as { Buffer?: NodeBufferShim }).Buffer;
  return candidate ?? null;
}
function nodeBtoa(s: string): string {
  const Buf = nodeBuffer();
  if (Buf) return Buf.from(s, 'binary').toString('base64');
  throw new Error('no base64 encoder available');
}
function nodeAtob(s: string): string {
  const Buf = nodeBuffer();
  if (Buf) return Buf.from(s, 'base64').toString('binary');
  throw new Error('no base64 decoder available');
}

export function encodeTactic(t: SharedTactic): string {
  const compact: CompactTactic = {
    n: t.name.slice(0, MAX_NAME_LEN),
    k: t.unitKind,
    e: t.spawnEdge,
    p: t.pointsTile.slice(0, MAX_POINTS).map((p) => [round2(p.x), round2(p.y)]),
  };
  if (t.modifier) {
    compact.m = [t.modifier.kind, t.modifier.pointIndex];
  }
  return base64UrlEncode(JSON.stringify(compact));
}

// Returns null on any malformed/oversized/out-of-range input. The
// caller treats null as "drop silently" — sharing should never crash
// the scene that's trying to import.
export function decodeTactic(s: string): SharedTactic | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > 4000) return null;
  const json = base64UrlDecode(s);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const c = parsed as Partial<CompactTactic>;
  if (typeof c.n !== 'string') return null;
  if (typeof c.k !== 'string' || !ALLOWED_KINDS.has(c.k)) return null;
  if (typeof c.e !== 'string' || !ALLOWED_EDGES.has(c.e as SharedTactic['spawnEdge'])) return null;
  if (!Array.isArray(c.p) || c.p.length < 2 || c.p.length > MAX_POINTS) return null;
  const pts: SharedTacticPoint[] = [];
  for (const p of c.p) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [x, y] = p;
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < -2 || x > 24 || y < -2 || y > 18) return null; // grid sanity
    pts.push({ x, y });
  }
  let modifier: SharedTacticModifier | undefined;
  if (c.m !== undefined) {
    if (!Array.isArray(c.m) || c.m.length !== 2) return null;
    const [kind, idx] = c.m;
    if (typeof kind !== 'string' || !ALLOWED_MOD_KINDS.has(kind as SharedTacticModifier['kind'])) return null;
    if (typeof idx !== 'number' || !Number.isInteger(idx)) return null;
    if (idx < 0 || idx >= pts.length) return null;
    modifier = { kind: kind as SharedTacticModifier['kind'], pointIndex: idx };
  }
  return {
    name: c.n.slice(0, MAX_NAME_LEN),
    unitKind: c.k,
    pointsTile: pts,
    spawnEdge: c.e as SharedTactic['spawnEdge'],
    ...(modifier ? { modifier } : {}),
  };
}

// Build a shareable URL pointing at the play page. Hash-only payload
// so the share link doesn't pollute server logs or analytics — the
// tactic stays purely client-side.
export function buildTacticShareUrl(origin: string, t: SharedTactic): string {
  return `${origin.replace(/\/+$/, '')}/play.html#tactic=${encodeTactic(t)}`;
}

// Pull a tactic out of the current page's URL hash, if any. Idempotent
// — does not mutate window.location. Caller is responsible for
// stripping the hash after import (typically with history.replaceState
// to avoid leaving the shared payload visible after import).
export function readTacticFromHash(hash: string): SharedTactic | null {
  if (!hash) return null;
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(trimmed);
  const v = params.get('tactic');
  if (!v) return null;
  return decodeTactic(v);
}
