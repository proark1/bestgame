import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Lightweight HMAC-signed bearer tokens for player sessions.
//
// Format: `${base64url(body)}.${base64url(hmacSHA256(secret, body))}` where
// body is `{ sub: playerId, iat, exp }`. No external JWT dependency.
//
// Secret sources, in priority:
//   1. HIVE_AUTH_SECRET env var (recommended for production)
//   2. Ephemeral random bytes generated at startup (tokens invalidate
//      on redeploy — acceptable for a guest-login MVP; player just
//      re-auths on next load via their persistent device_id.)

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days
let runtimeSecret: string | null = null;

function secret(): string {
  if (process.env.HIVE_AUTH_SECRET) return process.env.HIVE_AUTH_SECRET;
  if (runtimeSecret) return runtimeSecret;
  runtimeSecret = randomBytes(48).toString('hex');
  console.warn(
    '[auth] HIVE_AUTH_SECRET not set — using an ephemeral secret; tokens will invalidate on restart.',
  );
  return runtimeSecret;
}

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(
    s.replace(/-/g, '+').replace(/_/g, '/') + pad,
    'base64',
  );
}

export interface SessionClaims {
  sub: string; // player id (UUID)
  iat: number; // seconds
  exp: number; // seconds
}

export function mintSessionToken(playerId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const body: SessionClaims = {
    sub: playerId,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  const bodyB64 = b64urlEncode(Buffer.from(JSON.stringify(body)));
  const sig = createHmac('sha256', secret()).update(bodyB64).digest();
  return `${bodyB64}.${b64urlEncode(sig)}`;
}

export function verifySessionToken(token: string): SessionClaims | null {
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;
  const bodyB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const expected = createHmac('sha256', secret()).update(bodyB64).digest();
  const provided = b64urlDecode(sigB64);
  if (expected.length !== provided.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(b64urlDecode(bodyB64).toString('utf8')) as SessionClaims;
  } catch {
    return null;
  }
  if (!claims || typeof claims.sub !== 'string' || typeof claims.exp !== 'number') {
    return null;
  }
  if (claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

// Fastify hook: populate req.playerId from Authorization: Bearer <token>.
// Leaves it undefined if no/invalid token — individual routes decide
// whether to require it.
declare module 'fastify' {
  interface FastifyRequest {
    playerId?: string;
  }
}

export function registerPlayerAuthHook(app: FastifyInstance): void {
  app.addHook('onRequest', (req, _reply, done) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      const claims = verifySessionToken(auth.slice('Bearer '.length));
      if (claims) req.playerId = claims.sub;
    } else {
      // EventSource fallback — browsers won't let us set custom
      // headers on /clan/messages/stream, so SSE clients send the
      // bearer token via `?token=`. Token-in-query is OK for SSE
      // because the URL never appears in cross-site referers
      // (EventSource is same-origin) and the request never carries
      // a body.
      const token = (req.query as { token?: string } | undefined)?.token;
      if (typeof token === 'string' && token.length > 0) {
        const claims = verifySessionToken(token);
        if (claims) req.playerId = claims.sub;
      }
    }
    done();
  });
}

export function requirePlayer(
  req: FastifyRequest,
  reply: FastifyReply,
): string | null {
  if (!req.playerId) {
    reply.code(401).send({ error: 'authentication required' });
    return null;
  }
  return req.playerId;
}
