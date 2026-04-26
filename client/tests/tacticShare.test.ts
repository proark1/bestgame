import { describe, expect, it } from 'vitest';
import {
  buildTacticShareUrl,
  decodeTactic,
  encodeTactic,
  readTacticFromHash,
  type SharedTactic,
} from '../src/codex/tacticShare.js';

const SAMPLE: SharedTactic = {
  name: 'Pincer dig',
  unitKind: 'DirtDigger',
  pointsTile: [
    { x: 0, y: 5 },
    { x: 4, y: 5 },
    { x: 8, y: 5 },
  ],
  modifier: { kind: 'dig', pointIndex: 1 },
  spawnEdge: 'left',
};

describe('encodeTactic / decodeTactic', () => {
  it('round-trips a typical tactic', () => {
    const enc = encodeTactic(SAMPLE);
    const dec = decodeTactic(enc);
    expect(dec).toEqual(SAMPLE);
  });

  it('round-trips without a modifier', () => {
    const t: SharedTactic = { ...SAMPLE };
    delete t.modifier;
    const dec = decodeTactic(encodeTactic(t));
    expect(dec).toEqual(t);
  });

  it('rounds coordinates to 2 decimal places', () => {
    const t: SharedTactic = {
      ...SAMPLE,
      pointsTile: [
        { x: 0.123456, y: 5.987654 },
        { x: 4.5, y: 5 },
      ],
    };
    const dec = decodeTactic(encodeTactic(t));
    expect(dec?.pointsTile[0]).toEqual({ x: 0.12, y: 5.99 });
  });

  it('produces URL-safe base64 (no +, /, or = padding)', () => {
    const enc = encodeTactic(SAMPLE);
    expect(enc).not.toMatch(/[+/=]/);
  });

  it('truncates the polyline at MAX_POINTS', () => {
    const t: SharedTactic = {
      ...SAMPLE,
      pointsTile: Array.from({ length: 50 }, (_, i) => ({ x: i % 16, y: 5 })),
      modifier: undefined,
    };
    const dec = decodeTactic(encodeTactic(t));
    expect(dec?.pointsTile.length).toBe(32);
  });

  it('rejects garbage strings', () => {
    expect(decodeTactic('')).toBeNull();
    expect(decodeTactic('not-base64-?')).toBeNull();
    expect(decodeTactic('AAAA')).toBeNull(); // valid base64 but not JSON
  });

  it('rejects unknown unit kinds', () => {
    const enc = encodeTactic({ ...SAMPLE, unitKind: 'NestSpider' });
    expect(decodeTactic(enc)).toBeNull();
  });

  it('rejects bogus spawn edges', () => {
    const enc = encodeTactic({ ...SAMPLE, spawnEdge: 'right' as 'left' });
    expect(decodeTactic(enc)).toBeNull();
  });

  it('rejects modifiers that point outside the polyline', () => {
    const enc = encodeTactic({
      ...SAMPLE,
      modifier: { kind: 'dig', pointIndex: 99 },
    });
    expect(decodeTactic(enc)).toBeNull();
  });

  it('rejects coordinates outside the grid sanity range', () => {
    const enc = encodeTactic({
      ...SAMPLE,
      pointsTile: [
        { x: 0, y: 5 },
        { x: 9999, y: 5 },
      ],
    });
    expect(decodeTactic(enc)).toBeNull();
  });

  it('clips an oversized name', () => {
    const t: SharedTactic = { ...SAMPLE, name: 'x'.repeat(200) };
    const dec = decodeTactic(encodeTactic(t));
    expect(dec?.name.length).toBe(64);
  });
});

describe('readTacticFromHash', () => {
  it('extracts a tactic from a hash', () => {
    const hash = `#tactic=${encodeTactic(SAMPLE)}`;
    expect(readTacticFromHash(hash)).toEqual(SAMPLE);
  });

  it('handles missing leading #', () => {
    const hash = `tactic=${encodeTactic(SAMPLE)}`;
    expect(readTacticFromHash(hash)).toEqual(SAMPLE);
  });

  it('returns null for hashes without a tactic param', () => {
    expect(readTacticFromHash('#other=1')).toBeNull();
    expect(readTacticFromHash('')).toBeNull();
  });

  it('returns null when the encoded payload is malformed', () => {
    expect(readTacticFromHash('#tactic=junk')).toBeNull();
  });
});

describe('buildTacticShareUrl', () => {
  it('joins origin and tactic hash cleanly', () => {
    const url = buildTacticShareUrl('https://hive.example', SAMPLE);
    expect(url.startsWith('https://hive.example/play.html#tactic=')).toBe(true);
  });

  it('strips a trailing slash from the origin', () => {
    const url = buildTacticShareUrl('https://hive.example/', SAMPLE);
    expect(url.startsWith('https://hive.example/play.html#tactic=')).toBe(true);
  });
});
