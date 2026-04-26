// Persistent banner dismissal — closeable HUD banners (streak,
// nemesis, comeback) write a dismissal key to localStorage so the
// banner stays gone across page reloads until a new instance lands.
//
// Each banner gets a (kind, identity) pair:
//   - kind     — 'streak' | 'nemesis' | 'comeback' (the banner type)
//   - identity — a string that changes when the banner instance
//                changes (streak day count, nemesis player id, etc.)
//
// Dismissing day-3's streak banner doesn't auto-dismiss day-4 because
// the identity string differs. Same for nemesis: dismissing a ribbon
// for Alice doesn't suppress Bob's later.
//
// Failures (private mode, quota) are silent — the worst case is the
// banner reappears on next reload, which is the existing behaviour.

const STORAGE_PREFIX = 'hive:banner-dismiss:';

export function bannerDismissKey(
  kind: 'streak' | 'nemesis' | 'comeback' | string,
  identity: string,
): string {
  return `${STORAGE_PREFIX}${kind}:${identity}`;
}

export function isBannerDismissed(
  kind: string,
  identity: string,
): boolean {
  try {
    return localStorage.getItem(bannerDismissKey(kind, identity)) === '1';
  } catch {
    return false;
  }
}

export function dismissBanner(kind: string, identity: string): void {
  try {
    localStorage.setItem(bannerDismissKey(kind, identity), '1');
  } catch {
    // Quota / private mode — non-fatal. Banner will re-appear on
    // next reload, which is no worse than today's behaviour.
  }
}

// Test helper — clears every banner-dismiss key for a clean slate.
// Not used at runtime; exposed so unit tests don't need to know the
// internal key format.
export function clearAllBannerDismissalsForTest(): void {
  try {
    const remove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STORAGE_PREFIX)) remove.push(k);
    }
    for (const k of remove) localStorage.removeItem(k);
  } catch {
    // ignore
  }
}
