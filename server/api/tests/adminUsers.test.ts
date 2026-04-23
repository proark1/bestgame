import { describe, expect, it } from 'vitest';
import { _testables } from '../src/routes/adminUsers.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

const { validateUsername, validateEmail, validatePassword, normaliseEmail } =
  _testables;

// Pure-function tests for the admin/users validator helpers. These
// cover every rejection class — the HTTP route is just a thin shell
// that maps each return to a 400 / 409 / 500, so a failure here is
// the most likely way a bad request lands in the DB.

describe('validateUsername', () => {
  it('accepts 3-32 chars of [A-Za-z0-9_.-]', () => {
    expect(validateUsername('alice')).toBeNull();
    expect(validateUsername('Alice_Bob-1.23')).toBeNull();
    // 32 chars — right on the upper boundary.
    expect(validateUsername('a'.repeat(32))).toBeNull();
  });

  it('rejects too-short / too-long / bad chars', () => {
    expect(validateUsername('ab')).toMatch(/3–32/);
    expect(validateUsername('a'.repeat(33))).toMatch(/3–32/);
    expect(validateUsername('with space')).toMatch(/3–32/);
    expect(validateUsername('name@domain')).toMatch(/3–32/);
    expect(validateUsername('drop;tables')).toMatch(/3–32/);
  });

  it('rejects non-string input', () => {
    expect(validateUsername(null as unknown as string)).toMatch(/string/);
    expect(validateUsername(42 as unknown as string)).toMatch(/string/);
  });
});

describe('validateEmail', () => {
  it('accepts undefined / null (email is optional)', () => {
    expect(validateEmail(undefined)).toBeNull();
    expect(validateEmail(null)).toBeNull();
  });

  it('accepts well-formed addresses', () => {
    expect(validateEmail('a@b.co')).toBeNull();
    expect(validateEmail('alice+tag@example.org')).toBeNull();
  });

  it('rejects obviously malformed addresses', () => {
    expect(validateEmail('not-an-email')).toMatch(/email/);
    expect(validateEmail('@missing-local.org')).toMatch(/email/);
    expect(validateEmail('missing-at.sign')).toMatch(/email/);
    expect(validateEmail('has spaces@example.com')).toMatch(/email/);
  });

  it('rejects excessively long addresses', () => {
    const huge = 'a'.repeat(300) + '@example.com';
    expect(validateEmail(huge)).toMatch(/too long/);
  });
});

describe('validatePassword', () => {
  it('accepts 8+ char strings', () => {
    expect(validatePassword('correcthorse')).toBeNull();
    expect(validatePassword('a'.repeat(128))).toBeNull();
  });

  it('rejects too-short / too-long / non-string', () => {
    expect(validatePassword('short')).toMatch(/at least 8/);
    expect(validatePassword('a'.repeat(129))).toMatch(/at most 128/);
    expect(validatePassword(undefined as unknown as string)).toMatch(/string/);
  });
});

describe('normaliseEmail', () => {
  it('trims whitespace and canonicalises empty to null', () => {
    expect(normaliseEmail('  alice@example.com  ')).toBe('alice@example.com');
    expect(normaliseEmail('')).toBeNull();
    expect(normaliseEmail('   ')).toBeNull();
  });
  it('passes null through, skips undefined', () => {
    expect(normaliseEmail(null)).toBeNull();
    expect(normaliseEmail(undefined)).toBeUndefined();
  });
});

// Integration: the create / update flow hashes with the same
// algorithm the /auth/login endpoint verifies against. Wire break
// here would mean "admin-created users cannot log in" — quiet,
// serious. Guard with an end-to-end roundtrip.
describe('password hashing roundtrip', () => {
  it('scrypt hash written on create verifies on login-style call', async () => {
    const { hash, salt } = await hashPassword('adminPickedPassword123');
    const ok = await verifyPassword('adminPickedPassword123', hash, salt);
    const wrong = await verifyPassword('wrongPassword', hash, salt);
    expect(ok).toBe(true);
    expect(wrong).toBe(false);
  });

  it('new password on edit produces a fresh salt', async () => {
    const a = await hashPassword('samePassword123');
    const b = await hashPassword('samePassword123');
    // Same plaintext, different salts → different hashes.
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
});
