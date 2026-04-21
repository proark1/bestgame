// Thin client for the admin API. Reads the bearer token from
// localStorage (set via the auth modal) and attaches it to every
// request. On 401 it clears storage and reloads so the modal comes
// back up.

const TOKEN_KEY = 'hive.adminToken';

export interface SpriteFile {
  name: string;
  size: number;
  mtime: number;
}
export interface AdminStatus {
  authMode: 'token' | 'loopback-only';
  spritesDir: string;
  files: SpriteFile[];
}

export interface PromptsFile {
  styleLock: string;
  factions: Record<string, string>;
  units: Record<string, string>;
  buildings: Record<string, string>;
}

export interface GeminiImage {
  mimeType: string;
  data: string;
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}
export function setToken(t: string): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

async function req<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    setToken('');
    // Force the auth modal to reappear.
    window.dispatchEvent(new CustomEvent('admin:unauthorized'));
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const text = await res.text();
    let msg = `${res.status}: ${text.slice(0, 200)}`;
    try {
      const j = JSON.parse(text) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      // leave msg as the raw text
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function fetchStatus(): Promise<AdminStatus> {
  return req<AdminStatus>('/admin/api/status');
}

export async function fetchPrompts(): Promise<PromptsFile> {
  return req<PromptsFile>('/admin/api/prompts');
}

export async function updatePrompt(args: {
  category: 'units' | 'buildings' | 'styleLock';
  key?: string;
  value: string;
}): Promise<void> {
  await req<{ ok: true }>('/admin/api/prompts', {
    method: 'PUT',
    json: args,
  });
}

export async function generateImages(args: {
  prompt: string;
  variants: number;
  temperature?: number;
}): Promise<GeminiImage[]> {
  const { images } = await req<{ images: GeminiImage[] }>('/admin/api/generate', {
    method: 'POST',
    json: args,
  });
  return images;
}

export async function saveSprite(args: {
  key: string;
  data: string;
  format: 'png' | 'webp';
}): Promise<{ path: string; size: number }> {
  return req<{ path: string; size: number; ok: true }>('/admin/api/save', {
    method: 'POST',
    json: args,
  });
}

export async function deleteSprite(key: string): Promise<void> {
  await req<{ ok: true }>(`/admin/api/sprite/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
}
