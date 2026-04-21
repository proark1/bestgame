import type { FastifyInstance } from 'fastify';

// Matchmaking — week-1 stub returns a hardcoded bot base. Week 3 replaces
// this with a Supabase query for a real player within a trophy band.

interface MatchRequestBody {
  playerId: string;
  trophies: number;
}

export function registerMatchmaking(app: FastifyInstance): void {
  app.post<{ Body: MatchRequestBody }>('/match', async (req, reply) => {
    const { playerId, trophies } = req.body ?? { playerId: '', trophies: 0 };
    if (!playerId) {
      reply.code(400);
      return { error: 'playerId required' };
    }
    return {
      defenderId: 'bot-0',
      trophiesSought: trophies,
      // Seed is mixed from playerId + current hour to give stable raids
      // within an hour but variety over time. The specific seed becomes
      // part of the replay contract.
      seed: hashStringToU32(playerId + ':' + Math.floor(Date.now() / 3600000)),
      baseSnapshot: {
        baseId: 'bot-0',
        ownerId: 'bot-0',
        faction: 'Ants',
        gridSize: { w: 16, h: 12 },
        resources: { sugar: 1200, leafBits: 300, aphidMilk: 0 },
        trophies: Math.max(0, trophies - 10),
        version: 1,
        buildings: [
          {
            id: 'b-queen',
            kind: 'QueenChamber',
            anchor: { x: 7, y: 5, layer: 0 },
            footprint: { w: 2, h: 2 },
            spans: [0, 1],
            level: 1,
            hp: 800,
            hpMax: 800,
          },
          {
            id: 'b-turret-1',
            kind: 'MushroomTurret',
            anchor: { x: 3, y: 3, layer: 0 },
            footprint: { w: 1, h: 1 },
            level: 1,
            hp: 400,
            hpMax: 400,
          },
        ],
        tunnels: [],
      },
    };
  });
}

function hashStringToU32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  }
  return h >>> 0;
}
