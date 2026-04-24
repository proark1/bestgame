// Lean share + guest-id helpers for the standalone browser build.
// Replaces the old FBInstantBridge now that Hive Wars ships as a
// regular web game. Two moving parts:
//
//   1. shareOutcome(...) — tries the Web Share API first (on mobile
//      this pops the native OS share sheet with iMessage / WhatsApp /
//      Instagram / …), then falls back to clipboard. The caller gets
//      back which transport actually ran so we can show the right
//      toast copy ("Shared!" vs "Copied to clipboard").
//
//   2. readOrCreateGuestId() — a stable device-scoped identifier
//      stored in localStorage. The server's /api/auth/guest accepts
//      this as `deviceId` and returns the same player on every
//      subsequent boot. The previous FB-hosted path minted an
//      opaque FB player ID here; keeping the key name consistent
//      means existing installs keep their progress across the cutover.

export type ShareMode = 'web-share' | 'clipboard' | 'unavailable';

export async function shareOutcome(args: {
  text: string;
  url?: string;
  title?: string;
}): Promise<ShareMode> {
  const shareUrl = args.url ?? window.location.origin;
  const nav = typeof navigator !== 'undefined' ? navigator : null;

  // Web Share API — mobile browsers surface the OS share sheet;
  // desktop Chrome / Safari 17+ show a similar sheet. Non-supporting
  // browsers (most desktops pre-2024) hit the clipboard branch.
  if (nav && typeof nav.share === 'function') {
    try {
      await nav.share({
        title: args.title ?? 'Hive Wars',
        text: args.text,
        url: shareUrl,
      });
      return 'web-share';
    } catch (err) {
      // AbortError = the user dismissed the sheet. That's still a
      // successful surface; don't fall through to clipboard or we'd
      // silently re-copy and look weird.
      const name = (err as Error).name ?? '';
      if (name === 'AbortError') return 'web-share';
      // NotAllowedError and SecurityError (transient-activation,
      // Permissions-Policy) → fall through to clipboard.
      console.warn('navigator.share failed, falling back:', err);
    }
  }

  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    try {
      await nav.clipboard.writeText(`${args.text}\n${shareUrl}`);
      return 'clipboard';
    } catch (err) {
      console.warn('clipboard write failed:', err);
    }
  }
  return 'unavailable';
}

export function readOrCreateGuestId(): string {
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
