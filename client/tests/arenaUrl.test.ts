import { describe, expect, it } from 'vitest';
import { normalizeArenaUrl } from '../src/net/ArenaClient.js';

// normalizeArenaUrl is the last-line-of-defense against a misconfigured
// VITE_ARENA_URL — the cases below are every real-world shape we've
// seen reported as "Live arena unavailable / Failed to construct URL":
// wrong scheme, trailing slash, bare hostname, literal "undefined",
// whitespace. Each coerces to a canonical ws(s):// URL or null.

describe('normalizeArenaUrl', () => {
  it('passes a proper wss url through unchanged (minus trailing slash)', () => {
    expect(normalizeArenaUrl('wss://arena.example.com')).toBe('wss://arena.example.com');
    expect(normalizeArenaUrl('wss://arena.example.com/')).toBe('wss://arena.example.com');
  });

  it('coerces https → wss and http → ws', () => {
    expect(normalizeArenaUrl('https://arena.example.com')).toBe('wss://arena.example.com');
    expect(normalizeArenaUrl('http://localhost:2567')).toBe('ws://localhost:2567');
  });

  it('assumes wss for a bare hostname', () => {
    expect(normalizeArenaUrl('arena.example.com')).toBe('wss://arena.example.com');
    expect(normalizeArenaUrl('arena.example.com:9000')).toBe('wss://arena.example.com:9000');
  });

  it('trims whitespace', () => {
    expect(normalizeArenaUrl('  wss://arena.example.com  ')).toBe('wss://arena.example.com');
  });

  it('returns null for undefined / empty / "undefined" string', () => {
    expect(normalizeArenaUrl(undefined)).toBeNull();
    expect(normalizeArenaUrl('')).toBeNull();
    expect(normalizeArenaUrl('   ')).toBeNull();
    // Vite's define() has been known to inline missing env vars as the
    // literal string "undefined" — catch that too.
    expect(normalizeArenaUrl('undefined')).toBeNull();
    expect(normalizeArenaUrl('null')).toBeNull();
  });

  it('returns null for inputs the URL constructor rejects', () => {
    // URL() tolerates more than you'd expect, but some shapes still
    // throw. Guarded via try/catch so a bad env var can't explode
    // the arena scene.
    expect(normalizeArenaUrl('://missing-scheme')).toBeNull();
  });

  it('returns null for schemes that are neither ws nor http', () => {
    // After scheme coercion we only allow ws/wss; reject anything
    // else so Colyseus never gets a URL it can't dial.
    expect(normalizeArenaUrl('ftp://arena.example.com')).toBeNull();
  });
});
