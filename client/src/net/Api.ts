// HTTP client for the @hive/api server. Kept minimal for the week-1
// scaffold; routes grow in week 2 (raid upload, matchmaking, clan).
//
// Defaults to same-origin /api so the Railway single-service deploy
// (API serving the static client) works with no env config. Local
// dev overrides via VITE_API_URL=http://localhost:8787.
const DEFAULT_BASE = import.meta.env.VITE_API_URL ?? '/api';

// Healthcheck lives at the root, not /api/health.
const HEALTH_URL = new URL('/health', window.location.origin).toString();

export class Api {
  constructor(private readonly baseUrl = DEFAULT_BASE) {}

  async health(): Promise<{ ok: boolean; tick: number }> {
    const res = await fetch(HEALTH_URL);
    if (!res.ok) throw new Error(`health ${res.status}`);
    return (await res.json()) as { ok: boolean; tick: number };
  }

  // Placeholder — real shape lands with the raid route in week 3.
  async requestMatch(playerId: string, trophies: number): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/match`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, trophies }),
    });
    if (!res.ok) throw new Error(`match ${res.status}`);
    return await res.json();
  }
}
