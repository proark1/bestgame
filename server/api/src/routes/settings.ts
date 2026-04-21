import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import {
  DEFAULT_UNIT_ANIMATION,
  SETTING_UNIT_ANIMATION,
  getSetting,
  type UnitAnimationSettings,
} from '../db/settings.js';

// Publicly-readable game settings. The client polls these at boot so
// the player sees the admin's current config — the main consumer right
// now is the walk-cycle animation toggle, gated per unit kind.
//
// We intentionally don't require auth here. The values are cosmetic
// (animated vs static sprite), and the boot scene should render
// something even for unauthenticated / offline sessions.

export function registerSettings(app: FastifyInstance): void {
  app.get('/settings/animation', async (_req, reply) => {
    const pool = await getPool();
    if (!pool) {
      // DB offline → return the safe defaults so the client boots cleanly.
      // 200 with default payload is better UX than 503 here; nothing
      // gameplay-critical breaks.
      return DEFAULT_UNIT_ANIMATION;
    }
    try {
      const row = await getSetting<UnitAnimationSettings>(
        pool,
        SETTING_UNIT_ANIMATION,
      );
      return row ?? DEFAULT_UNIT_ANIMATION;
    } catch (err) {
      app.log.warn({ err }, '/settings/animation lookup failed');
      reply.code(200); // still return defaults
      return DEFAULT_UNIT_ANIMATION;
    }
  });
}
