// Thin wrapper over the Facebook Instant Games SDK. When running outside
// FB (local dev, itch.io, Poki), all methods resolve gracefully so the
// client code path stays the same.

// Minimal subset of the SDK surface we use. The full ambient type lives
// on the globalThis FBInstant; declaring only what we call keeps compile
// surface small.
interface FBInstantSdk {
  initializeAsync(): Promise<void>;
  setLoadingProgress(p: number): void;
  startGameAsync(): Promise<void>;
  getPlayerID(): string;
  getPlayerName(): string;
  context: {
    getID(): string | null;
    getType(): 'SOLO' | 'THREAD' | 'GROUP' | 'POST';
    chooseAsync(options?: Record<string, unknown>): Promise<void>;
  };
  shareAsync(payload: Record<string, unknown>): Promise<void>;
  getLocale(): string;
  quit(): void;
}

declare global {
  interface Window {
    FBInstant?: FBInstantSdk;
  }
}

export interface HiveInstantContext {
  available: boolean;
  playerId: string;
  playerName: string;
  contextId: string | null;
}

export class FBInstantBridge {
  private ctx: HiveInstantContext = {
    available: false,
    playerId: 'guest-local',
    playerName: 'Guest',
    contextId: null,
  };

  async initialize(onProgress: (p: number) => void): Promise<HiveInstantContext> {
    const sdk = window.FBInstant;
    // Off-platform fast path. The FBInstant SDK's `initializeAsync` /
    // `startGameAsync` never resolve outside Facebook's wrapper — they
    // wait for a parent iframe that isn't there. Short-circuit unless
    // we can positively identify a Facebook/Messenger host so third-
    // party iframe embeds (itch, Poki, Kongregate) don't eat ~6 s
    // waiting for the two timeouts to fire.
    if (!sdk || !isFacebookHost()) {
      this.ctx.playerId = readOrCreateGuestId();
      return this.ctx;
    }
    try {
      // Belt-and-braces timeout: even inside an iframe, if the SDK stalls
      // we bail to guest rather than freeze the boot splash.
      await withTimeout(sdk.initializeAsync(), 3000, 'initializeAsync');
      sdk.setLoadingProgress(0);
      onProgress(0);
      await withTimeout(sdk.startGameAsync(), 3000, 'startGameAsync');
      this.ctx = {
        available: true,
        playerId: sdk.getPlayerID(),
        playerName: sdk.getPlayerName(),
        contextId: sdk.context.getID(),
      };
    } catch (err) {
      // SDK failure mode — bad context, user closed, or timeout. Guest.
      console.warn('FBInstant init failed; falling back to guest', err);
      this.ctx.playerId = readOrCreateGuestId();
    }
    return this.ctx;
  }

  setLoadingProgress(p: number): void {
    window.FBInstant?.setLoadingProgress(Math.max(0, Math.min(100, p * 100)));
  }

  async shareRaidResult(text: string): Promise<void> {
    const sdk = window.FBInstant;
    if (!sdk) return; // no-op off-platform
    try {
      await sdk.shareAsync({
        intent: 'SHARE',
        image: '', // set by caller
        text,
        data: { source: 'raid-result' },
      });
    } catch (err) {
      console.warn('share failed', err);
    }
  }

  get context(): HiveInstantContext {
    return this.ctx;
  }
}

// Positively identify a Facebook-hosted runtime (Facebook, Messenger,
// or the FB sandbox CDN). When the game is embedded in a non-FB iframe
// (itch, Poki, Kongregate), the FBInstant script tag still loads and
// populates window.FBInstant, but its async methods hang indefinitely.
// Detecting host first avoids the ~6 s of dead timeouts in that case.
const FB_HOST_PATTERNS = ['facebook.com', 'messenger.com', 'fbsbx.com'];

function hostMatches(url: string | undefined | null): boolean {
  if (!url) return false;
  const s = url.toLowerCase();
  for (const p of FB_HOST_PATTERNS) {
    if (s.includes(p)) return true;
  }
  return false;
}

function isFacebookHost(): boolean {
  try {
    if (hostMatches(document.referrer)) return true;
    // Chromium exposes the full iframe ancestor chain here; other engines
    // leave it undefined, so this is best-effort on top of referrer.
    const origins = (
      window.location as unknown as { ancestorOrigins?: DOMStringList }
    ).ancestorOrigins;
    if (origins) {
      for (let i = 0; i < origins.length; i++) {
        if (hostMatches(origins[i])) return true;
      }
    }
  } catch {
    // Ignore — hostile environments (sandbox, file://) just go guest.
  }
  return false;
}

function readOrCreateGuestId(): string {
  const KEY = 'hive.guestId';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = 'guest-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return 'guest-local';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
