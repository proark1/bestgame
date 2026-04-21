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
    // wait for a parent iframe that isn't there. So we short-circuit if
    // either (a) the SDK never loaded, or (b) we're the top-level window
    // (Facebook always hosts the game in an iframe).
    const isTopLevel = typeof window !== 'undefined' && window.top === window;
    if (!sdk || isTopLevel) {
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
