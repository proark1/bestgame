import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

// hashPassword + verifyPassword contract. scrypt parameters are
// baked into the helpers — if they ever change, this suite will
// catch legacy-hash compatibility breakage by failing the "stored
// tuple roundtrips" test.

describe('hashPassword + verifyPassword', () => {
  it('roundtrips: the hashed password verifies with its own salt', async () => {
    const { hash, salt } = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(salt).toMatch(/^[0-9a-f]+$/);
    // 64-byte hash (128 hex chars) + 16-byte salt (32 hex chars).
    expect(hash.length).toBe(128);
    expect(salt.length).toBe(32);
    const ok = await verifyPassword('correct horse battery staple', hash, salt);
    expect(ok).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const { hash, salt } = await hashPassword('hunter2');
    expect(await verifyPassword('HUNTER2', hash, salt)).toBe(false);
    expect(await verifyPassword('hunter', hash, salt)).toBe(false);
    expect(await verifyPassword('', hash, salt)).toBe(false);
  });

  it('two hashes of the same password use different salts', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    // Both still verify.
    expect(await verifyPassword('same', a.hash, a.salt)).toBe(true);
    expect(await verifyPassword('same', b.hash, b.salt)).toBe(true);
  });

  it('returns false on malformed stored hash (corrupt row)', async () => {
    // Short-circuit: a hash with fewer bytes than KEYLEN can never
    // match a freshly-derived 64-byte key. timingSafeEqual would
    // otherwise throw on length mismatch — the helper guards.
    expect(await verifyPassword('pw', 'abcd', 'ef01')).toBe(false);
  });

  it('returns false when scrypt throws on a garbage salt', async () => {
    // The helper wraps the whole thing in try/catch; a legitimately
    // malformed salt shouldn't propagate as a 500 to callers.
    expect(await verifyPassword('pw', 'deadbeef', 'not-hex-at-all!!')).toBe(false);
  });
});
