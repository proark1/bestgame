import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

// Bearer-token auth for the /admin/api/* routes. The expected token is
// stored in the ADMIN_TOKEN env var; if it's not set, we fall back to
// allow-from-localhost-only so local dev just works without config.
//
// Admin routes can generate images (which burns Gemini quota) and write
// to the server filesystem, so public exposure without auth is
// never acceptable.

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

function isLoopback(req: FastifyRequest): boolean {
  const ip = req.ip;
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip === 'localhost'
  );
}

function isAuthorized(req: FastifyRequest): boolean {
  if (ADMIN_TOKEN === '') {
    // No token configured — only accept loopback requests (local dev).
    return isLoopback(req);
  }
  const auth = req.headers.authorization ?? '';
  const prefix = 'Bearer ';
  if (!auth.startsWith(prefix)) return false;
  const provided = auth.slice(prefix.length);
  // Equalize length and use a constant-time comparison.
  const a = Buffer.from(provided);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  if (!isAuthorized(req)) {
    reply
      .code(401)
      .header('www-authenticate', 'Bearer realm="admin"')
      .send({ error: 'admin token required' });
    return;
  }
  done();
}

export function registerAdminHook(app: FastifyInstance): void {
  // Guard any route whose URL starts with /admin/api/.
  app.addHook('onRequest', (req, reply, done) => {
    if (req.url.startsWith('/admin/api/')) {
      requireAdmin(req, reply, done);
      return;
    }
    done();
  });
}

export function adminAuthConfigured(): boolean {
  return ADMIN_TOKEN !== '';
}
