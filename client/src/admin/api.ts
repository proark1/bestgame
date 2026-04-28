// Thin client for the admin API. Reads the bearer token from
// localStorage (set via the auth modal) and attaches it to every
// request. On 401 it clears storage and reloads so the modal comes
// back up.

const TOKEN_KEY = 'hive.adminToken';

export interface SpriteFile {
  name: string;
  size: number;
  mtime: number;
  // 'db' means the authoritative bytes live in Postgres and will
  // survive Railway redeploys; 'dist' and 'public' are the on-disk
  // mirrors. Absent on older server builds.
  source?: 'dist' | 'public' | 'db';
}
export interface AdminStatus {
  authMode: 'token' | 'loopback-only';
  spritesDir: string;
  // 'connected' means admin saves are persisted durably. 'not-configured'
  // means bytes land on disk only and vanish on the next redeploy.
  dbPersistence?: 'connected' | 'not-configured';
  mirrorsPublic?: boolean;
  files: SpriteFile[];
}

export interface PromptsFile {
  styleLock: string;
  factions: Record<string, string>;
  units: Record<string, string>;
  buildings: Record<string, string>;
  // Walk-cycle prompts for the animated units. Parallel to `units`
  // but produces a 512x128 horizontal spritesheet strip instead of a
  // single 128x128 sprite. Absent on old bundles that predate the
  // animation feature.
  walkCycles?: Record<string, string>;
  // Menu UI prompts for the game chrome (buttons, panels, HUD,
  // banners, board tiles). Parallel to `units` but generates UI
  // asset images designed for 9-slice or tiling. When enabled via
  // /admin/api/settings/ui-overrides, the game renders these in
  // place of the default Graphics/CSS fallback.
  menuUi?: Record<string, string>;
  // Hero prompts (PR C). Persistent special units the player owns
  // and equips per raid. Parallel to `units` — same 128x128 single-
  // sprite output, just routed through the heroes admin tab.
  heroes?: Record<string, string>;
  // Comic-strip panel prompts. Each key matches the sprite key the
  // landing-page swiper looks up (e.g. `story-springs-1`). Output is
  // a wide 1024x576 cinematic painterly illustration, opaque PNG ok.
  // Story → panel grouping lives in tools/gemini-art/stories.json.
  stories?: Record<string, string>;
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

// Comic-strip metadata. Public endpoint (no auth) so the landing
// page and the admin both consume the same shape. Each panel's
// `key` is the sprite key the manifest uses; the actual prompt
// lives in prompts.json under the `stories` bucket.
export interface StoryPanel {
  key: string;
  caption: string;
}
export interface Story {
  id: string;
  title: string;
  subtitle: string;
  panels: StoryPanel[];
}
export interface StoriesFile {
  stories: Story[];
}
export async function fetchStories(): Promise<StoriesFile> {
  return req<StoriesFile>('/api/stories');
}

export async function updatePrompt(args: {
  category: 'units' | 'buildings' | 'walkCycles' | 'menuUi' | 'styleLock' | 'heroes' | 'stories';
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
  // Optional multimodal reference images. When present, Gemini treats
  // them as visual references — "produce a new image like THIS but
  // different in X way". The walk-cycle generator pins pose B to
  // pose A so the two frames share character, palette, and camera.
  referenceImages?: ReadonlyArray<GeminiImage>;
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
  // Optional: horizontal spritesheet frame count. Defaults to 1 on
  // server-side. Set to 4 when saving a walk-cycle strip so the
  // client loads it as a Phaser spritesheet.
  frames?: number;
  // Optional: short free-text label stored alongside the history
  // row. Shown in the version carousel so the admin can identify
  // a generation by intent ("warmer colors") not just timestamp.
  label?: string;
}): Promise<{ path: string; size: number }> {
  return req<{ path: string; size: number; ok: true }>('/admin/api/save', {
    method: 'POST',
    json: args,
  });
}

// Sprite history: last-N generations of a single key. Metadata
// only — preview bytes come from a separate endpoint so the list
// response stays small.
export interface SpriteHistoryEntry {
  id: number;
  format: 'png' | 'webp';
  size: number;
  frames: number;
  label: string | null;
  createdAt: string;
}
export interface SpriteHistoryResponse {
  dbPersistence: 'connected' | 'not-configured';
  entries: SpriteHistoryEntry[];
}

export async function fetchSpriteHistory(
  key: string,
): Promise<SpriteHistoryResponse> {
  return req<SpriteHistoryResponse>(
    `/admin/api/sprite/${encodeURIComponent(key)}/history`,
  );
}

// URL the admin UI uses for preview thumbnails. Bearer token is
// attached via fetch (not as a query string) so we mimic that by
// loading through fetch → object URL instead of a raw <img src=>.
// Returns an object URL the caller must revoke when done.
export async function loadSpriteHistoryBytes(
  key: string,
  id: number,
): Promise<string> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(
    `/admin/api/sprite/${encodeURIComponent(key)}/history/${id}/bytes`,
    { headers },
  );
  if (!res.ok) throw new Error(`preview ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function restoreSpriteHistory(
  key: string,
  id: number,
): Promise<{ ok: true; format: 'png' | 'webp'; size: number }> {
  return req<{ ok: true; format: 'png' | 'webp'; size: number }>(
    `/admin/api/sprite/${encodeURIComponent(key)}/history/${id}/restore`,
    { method: 'POST' },
  );
}

// Animation toggle read/write. `kinds` is the server-owned allowlist
// of which units can be animated; `values` is the current per-kind on/
// off state. Unknown kinds in the PUT body are silently dropped by
// the server to keep the JSONB blob shape-stable.
export interface AnimationSettings {
  kinds: readonly string[];
  values: Record<string, boolean>;
  dbPersistence: 'connected' | 'not-configured';
}

export async function fetchAnimationSettings(): Promise<AnimationSettings> {
  return req<AnimationSettings>('/admin/api/settings/animation');
}

export async function putAnimationSettings(
  values: Record<string, boolean>,
): Promise<{ ok: true; values: Record<string, boolean> }> {
  return req<{ ok: true; values: Record<string, boolean> }>(
    '/admin/api/settings/animation',
    { method: 'PUT', json: { values } },
  );
}

// Menu UI image-override settings. Same shape as AnimationSettings,
// different key set.
export interface UiOverrideSettings {
  keys: readonly string[];
  values: Record<string, boolean>;
  dbPersistence: 'connected' | 'not-configured';
}
export async function fetchUiOverrideSettings(): Promise<UiOverrideSettings> {
  return req<UiOverrideSettings>('/admin/api/settings/ui-overrides');
}
export async function putUiOverrideSettings(
  values: Record<string, boolean>,
): Promise<{ ok: true; values: Record<string, boolean> }> {
  return req<{ ok: true; values: Record<string, boolean> }>(
    '/admin/api/settings/ui-overrides',
    { method: 'PUT', json: { values } },
  );
}

export async function deleteSprite(key: string): Promise<void> {
  await req<{ ok: true }>(`/admin/api/sprite/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------
// User management — admin CRUD over the `users` login table.
//
// Matches the shape returned by server/api/src/routes/adminUsers.ts.
// `email` and the linked player fields are nullable: a user without
// a recorded email is legal; a user not yet attached to a player
// (no game session) has playerId + displayName = null.
// ---------------------------------------------------------------------
export interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  playerId: string | null;
  displayName: string | null;
  // Joined from the linked players row. Null when no player has
  // been minted yet (user signed up but never logged in). The
  // admin UI surfaces these as inline number inputs and lets the
  // operator overwrite them via PUT /admin/api/users/:id.
  sugar: number | null;
  leafBits: number | null;
  aphidMilk: number | null;
  trophies: number | null;
}
export interface AdminUsersResponse {
  users: AdminUser[];
  total: number;
  limit: number;
  offset: number;
}

export async function listUsers(args: {
  limit?: number;
  offset?: number;
  q?: string;
} = {}): Promise<AdminUsersResponse> {
  const params = new URLSearchParams();
  if (args.limit !== undefined) params.set('limit', String(args.limit));
  if (args.offset !== undefined) params.set('offset', String(args.offset));
  if (args.q) params.set('q', args.q);
  const qs = params.toString();
  return req<AdminUsersResponse>(`/admin/api/users${qs ? `?${qs}` : ''}`);
}

export async function createUser(args: {
  username: string;
  email?: string | null;
  password: string;
}): Promise<{ user: AdminUser }> {
  return req<{ user: AdminUser }>('/admin/api/users', {
    method: 'POST',
    json: args,
  });
}

export async function updateUser(
  id: string,
  args: {
    username?: string;
    email?: string | null;
    password?: string;
    // Player-side fields, applied to the user's linked players row.
    // The server returns 400 if no players row is linked yet (the
    // user has never logged in to mint one).
    sugar?: number;
    leafBits?: number;
    aphidMilk?: number;
    trophies?: number;
  },
): Promise<{ user: AdminUser }> {
  return req<{ user: AdminUser }>(`/admin/api/users/${encodeURIComponent(id)}`, {
    method: 'PUT',
    json: args,
  });
}

export async function deleteUser(id: string): Promise<void> {
  await req<{ ok: true }>(`/admin/api/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// Trigger a browser download of the whole sprites folder as a zip. The
// endpoint sets content-disposition: attachment, so assigning the auth'd
// URL to an anchor and clicking it would drop the token into history —
// instead, fetch as a blob with the auth header and hand it to the user
// via a temporary object URL.
export async function downloadAllSprites(): Promise<void> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch('/admin/api/download-all', { headers });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.download = `hive-sprites-${stamp}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
