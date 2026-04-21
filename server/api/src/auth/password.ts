import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// scrypt-based password hashing via node:crypto — no external
// dependency. Parameters chosen per the OWASP 2024 baseline (N=2^14,
// r=8, p=1, 64-byte derived key, 16-byte random salt). Adjust by
// bumping PARAMS_VERSION if we need to rotate later; verify() will
// handle legacy hashes as long as they share the same salt/hash
// split format.

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<{
  hash: string;
  salt: string;
}> {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const derived = await scrypt(password, salt, KEYLEN);
  return { hash: derived.toString('hex'), salt };
}

export async function verifyPassword(
  password: string,
  hashHex: string,
  saltHex: string,
): Promise<boolean> {
  try {
    const derived = await scrypt(password, saltHex, KEYLEN);
    const stored = Buffer.from(hashHex, 'hex');
    // timingSafeEqual requires equal-length buffers; a mismatched
    // stored hash length means the row is corrupt or from a future
    // scheme — treat as a verification failure, not an error.
    if (stored.length !== derived.length) return false;
    return timingSafeEqual(stored, derived);
  } catch {
    return false;
  }
}
