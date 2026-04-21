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

  // Claim the current guest as a real user account. If the caller is
  // already authenticated, the server attaches their existing player
  // (base, trophies, resources) to the new user row — progress is
  // preserved. Subsequent /auth/login from any device returns the
  // same player.
  async register(username: string, password: string): Promise<Session> {
    const res = await fetch(`${this.apiBase}/auth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.session?.token
          ? { authorization: `Bearer ${this.session.token}` }
          : {}),
      },
      body: JSON.stringify({ username, password }),
    });
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as
      | { ok: true; playerId: string; token: string; userId: string; username: string }
      | { error: string };
    if (!res.ok || !('ok' in body)) {
      const errMsg = 'error' in body ? body.error : `register ${res.status}`;
      throw new Error(errMsg);
    }
    const session: Session = {
      playerId: body.playerId,
      token: body.token,
      isNew: true,
    };
    this.session = session;
    try {
      localStorage.setItem(TOKEN_KEY, session.token);
      localStorage.setItem(PLAYER_KEY, session.playerId);
    } catch {
      // ignore
    }
    return session;
  }

  async login(username: string, password: string): Promise<Session> {
    const res = await fetch(`${this.apiBase}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as
      | { ok: true; playerId: string; token: string; userId: string; username: string }
      | { error: string };
    if (!res.ok || !('ok' in body)) {
      const errMsg = 'error' in body ? body.error : `login ${res.status}`;
      throw new Error(errMsg);
    }
    const session: Session = {
      playerId: body.playerId,
      token: body.token,
      isNew: false,
    };
    this.session = session;
    try {
      localStorage.setItem(TOKEN_KEY, session.token);
      localStorage.setItem(PLAYER_KEY, session.playerId);
    } catch {
      // ignore
    }
    return session;
  }

  // Server-truth view of the current session — whether the token
  // points at a guest or a user-owned player, and the username when
  // applicable. Scenes use it to flip the account-button label.
  async fetchMe(): Promise<{
    playerId: string;
    userId: string | null;
    username: string | null;
    isGuest: boolean;
  } | null> {
    if (!this.session?.token) return null;
    const res = await fetch(`${this.apiBase}/auth/me`, {
      headers: { authorization: `Bearer ${this.session.token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as {
      playerId: string;
      userId: string | null;
      username: string | null;
      isGuest: boolean;
    };
  }
}
