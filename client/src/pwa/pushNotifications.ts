// Push notification opt-in. Asks the user for permission, subscribes
// the active service worker to the push manager, and POSTs the
// PushSubscription JSON to the API so the server can later send
// targeted pushes (builder finished, you were attacked, clan war
// kicked off).
//
// Designed to be cheap to call multiple times — re-using an existing
// subscription instead of asking permission again — so the settings
// modal can offer a one-tap toggle.
//
// VAPID public key lives on `window.HIVE_VAPID_PUBLIC_KEY` (set by
// the server when it serves index.html, or hard-wired into a build
// config later). When unset we still surface the toggle but skip the
// actual subscription so the UI degrades gracefully on local dev.

const STORAGE_KEY = 'hive.push.optedIn';

export type PushPermission = 'unsupported' | 'default' | 'denied' | 'granted';

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function pushPermission(): PushPermission {
  if (!pushSupported()) return 'unsupported';
  return Notification.permission as PushPermission;
}

export function isOptedIn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function setOptedIn(v: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
  } catch {
    // ignore quota
  }
}

// Convert a base64url public key (server-supplied) to the Uint8Array
// shape PushManager.subscribe wants. Web push spec quirk; every push
// client does this same dance.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getVapidPublicKey(
  authedFetch: SubscribeOptions['authedFetch'],
): Promise<string | null> {
  // Prefer a server fetch — pulls the live VAPID key from the API
  // so a deploy that flips the env var doesn't require a client
  // rebuild. window.HIVE_VAPID_PUBLIC_KEY (legacy) still works as a
  // fast-path fallback for offline/PWA install scenarios where the
  // initial fetch hasn't landed.
  try {
    const res = await authedFetch('/push/public-key');
    if (res.ok) {
      const j = (await res.json()) as { publicKey?: string };
      if (j.publicKey) return j.publicKey;
    }
  } catch {
    // network down — fall through to the window-global path
  }
  const fromWindow = (window as unknown as { HIVE_VAPID_PUBLIC_KEY?: string })
    .HIVE_VAPID_PUBLIC_KEY;
  return fromWindow ?? null;
}

export interface SubscribeOptions {
  // Authed fetcher — caller passes runtime.api.authedFetch so the
  // module stays decoupled from the Api class.
  authedFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

// Idempotent: prompts for permission if needed, subscribes the SW,
// posts to the server. Returns true on success.
export async function subscribePush(opts: SubscribeOptions): Promise<boolean> {
  if (!pushSupported()) return false;
  if (Notification.permission === 'denied') return false;
  if (Notification.permission === 'default') {
    const ask = await Notification.requestPermission();
    if (ask !== 'granted') return false;
  }
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  let sub = existing;
  if (!sub) {
    const key = await getVapidPublicKey(opts.authedFetch);
    if (!key) {
      // Server isn't configured to send pushes yet — record the user
      // intent so we can subscribe automatically once VAPID lands.
      setOptedIn(true);
      return false;
    }
    // Cast through ArrayBuffer — browsers accept the BufferSource shape
    // but TS lib types tightened to disallow ArrayBufferLike. The
    // backing buffer is always a real ArrayBuffer here.
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key).buffer as ArrayBuffer,
    });
  }
  try {
    const res = await opts.authedFetch('/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  setOptedIn(true);
  return true;
}

export async function unsubscribePush(opts: SubscribeOptions): Promise<void> {
  setOptedIn(false);
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  try {
    await opts.authedFetch('/push/unsubscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  } catch {
    // Server cleanup best-effort; the local unsubscribe still proceeds.
  }
  await sub.unsubscribe().catch(() => undefined);
}
