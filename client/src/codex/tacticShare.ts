// Tactic sharing — encode a SavedTactic into a URL-safe string and
// decode it back. The encoded string lands in window.location.hash
// (e.g. `#tactic=AbC123…`); main.ts calls decode + persist on
// startup so a friend who opens the link is greeted with the tactic
// pre-loaded into their saved set.
//
// We base64url-encode a compact JSON shape that uses single-letter
// keys and rounded coordinates. A 32-point polyline + modifier
// survives at well under URL-length limits on every common browser.
// The spec is deliberately tiny so the URL stays scannable in chat
// previews on mobile.

import { UNIT_CODEX } from './codexData.js';

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
  spawnEdge: 'left' | 'top' | 'bottom' | 'right';
}

// Localstorage key + cap shared with RaidScene.handleSaveTactic and
// main.importTacticFromHashIfPresent. Kept here so all three writers
// agree on the schema and a future bump is one-line.
export const TACTICS_STORAGE_KEY = 'hive:tactics:v1';
export const TACTICS_LIMIT = 8;

// Tighter caps than localStorage allows — anything that fits in
// localStorage also fits here. The decoder rejects oversized
// payloads so a hostile URL can't blow up the deck UI.
const MAX_POINTS = 32;
const MAX_NAME_LEN = 64;

// Defender-side units that the sim spawns autonomously — these
// should never appear in a player-authored tactic and so are
// excluded from the share allow-list. Adding a new ATTACKER kind
// auto-includes it via UNIT_CODEX; the deny-list pattern means the
// tactic-share path doesn't need to track every attacker addition.
const DEFENDER_ONLY_KINDS = new Set<string>(['NestSpider', 'MiniScarab']);
const ALLOWED_KINDS: ReadonlySet<string> = new Set(
  (Object.keys(UNIT_CODEX) as string[]).filter((k) => !DEFENDER_ONLY_KINDS.has(k)),
);
const ALLOWED_EDGES = new Set<SharedTactic['spawnEdge']>([
  'left',
  'top',
  'bottom',
  'right',
]);
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

// UTF-8 → base64url. The raw btoa() input must be a "binary string"
// (each char's code unit ≤ 0xff), so we run UTF-8 bytes through
// TextEncoder first, then String.fromCharCode-walk them into the
// binary form btoa expects. TextEncoder/TextDecoder is the modern
// replacement for the deprecated escape()/unescape() trick.
function base64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const b64 = (typeof btoa === 'function' ? btoa : nodeBtoa)(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const binary = (typeof atob === 'function' ? atob : nodeAtob)(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// Node fallback for the rare path where this runs outside a browser
// (vitest jsdom usually provides btoa/atob, but bare Node CI steps
// might not). The browser bundle never reaches these branches.
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

// Build a shareable URL pointing at the play page, resolved relative
// to the caller's current URL. Using the URL constructor with a base
// keeps the share link valid under subpath deployments
// (`/games/hive/`) and behind reverse proxies — `new URL('play.html',
// 'https://example.com/games/hive/index.html')` correctly resolves
// to `https://example.com/games/hive/play.html`. The hash payload
// keeps the tactic purely client-side.
export function buildTacticShareUrl(currentUrl: string, t: SharedTactic): string {
  const url = new URL('play.html', currentUrl);
  url.hash = `tactic=${encodeTactic(t)}`;
  return url.toString();
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
