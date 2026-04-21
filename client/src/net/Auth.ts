// Client-side session authentication. Stores a persistent device id
// and the current bearer token in localStorage; on boot, calls
// POST /api/auth/guest to mint a fresh token against the backend.
//
// The device id is the stable identity — re-installing the game on
// the same browser keeps progress; clearing site data starts over.

const TOKEN_KEY = 'hive.sessionToken';
const DEVICE_KEY = 'hive.deviceId';
const PLAYER_KEY = 'hive.playerId';

function randomDeviceId(): string {
  // 192 bits of entropy base64url-ish. crypto.randomUUID if present.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  const bytes = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function readOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing && existing.length >= 4) return existing;
    const fresh = randomDeviceId();
    localStorage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    // Private-mode Safari etc.; fall back to a non-persisted id.
    return randomDeviceId();
  }
}

export interface Session {
  playerId: string;
  token: string;
  isNew: boolean;
}

// Default base is same-origin `/api`; local dev can override via
// VITE_API_URL=http://localhost:8787.
const DEFAULT_API = import.meta.env.VITE_API_URL ?? '/api';

export class AuthClient {
  private session: Session | null = null;
  constructor(private readonly apiBase = DEFAULT_API) {}

  async signInGuest(
    opts: { displayName?: string; faction?: string } = {},
  ): Promise<Session> {
    const deviceId = readOrCreateDeviceId();
    const res = await fetch(`${this.apiBase}/auth/guest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        ...(opts.displayName ? { displayName: opts.displayName } : {}),
        ...(opts.faction ? { faction: opts.faction } : {}),
      }),
    });
    if (!res.ok) {
      let msg = `auth/guest ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        // non-JSON response, keep default msg
      }
      throw new Error(msg);
    }
    const body = (await res.json()) as Session;
    this.session = body;
    try {
      localStorage.setItem(TOKEN_KEY, body.token);
      localStorage.setItem(PLAYER_KEY, body.playerId);
    } catch {
      // storage unavailable — keep session in-memory
    }
    return body;
  }

  // Resume from whatever is in localStorage. Does NOT validate the token
  // against the server — that happens implicitly on the next authed
  // request (401 will re-drive guest signup via Api.ts).
  tryResume(): Session | null {
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const playerId = localStorage.getItem(PLAYER_KEY);
      if (token && playerId) {
        this.session = { token, playerId, isNew: false };
        return this.session;
      }
    } catch {
      // ignore
    }
    return null;
  }

  get token(): string | null {
    return this.session?.token ?? null;
  }
  get playerId(): string | null {
    return this.session?.playerId ?? null;
  }

  logout(): void {
    this.session = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(PLAYER_KEY);
    } catch {
      // ignore
    }
  }
}
