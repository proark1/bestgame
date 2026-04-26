import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  bannerDismissKey,
  clearAllBannerDismissalsForTest,
  dismissBanner,
  isBannerDismissed,
} from '../src/ui/banners.js';

afterEach(() => {
  clearAllBannerDismissalsForTest();
});

// Stub localStorage in case the vitest env doesn't ship one. The
// real browser path uses window.localStorage; the helpers swallow
// thrown errors so we don't need a perfect mock — just enough that
// the round-trip works.
beforeAll(() => {
  if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      get length() { return store.size; },
      clear: () => store.clear(),
      getItem: (k) => store.get(k) ?? null,
      key: (i) => Array.from(store.keys())[i] ?? null,
      removeItem: (k) => { store.delete(k); },
      setItem: (k, v) => { store.set(k, v); },
    } satisfies Storage;
  }
});

describe('banner dismissal', () => {
  it('returns false for never-dismissed banners', () => {
    expect(isBannerDismissed('streak', '5')).toBe(false);
  });

  it('returns true after dismissBanner is called', () => {
    dismissBanner('streak', '5');
    expect(isBannerDismissed('streak', '5')).toBe(true);
  });

  it('does NOT cross-dismiss different identities', () => {
    // Dismissing day-3's streak banner mustn't suppress day-4 when
    // it lands the next day.
    dismissBanner('streak', '3');
    expect(isBannerDismissed('streak', '3')).toBe(true);
    expect(isBannerDismissed('streak', '4')).toBe(false);
  });

  it('does NOT cross-dismiss different kinds', () => {
    // Dismissing the streak banner mustn't suppress the nemesis
    // ribbon — they are independent UX moments.
    dismissBanner('streak', '5');
    expect(isBannerDismissed('nemesis', 'some-uuid')).toBe(false);
  });

  it('namespaces keys via the shared prefix', () => {
    // Pin the storage-key shape so a future refactor can't silently
    // change it and orphan everyone's existing dismissals.
    expect(bannerDismissKey('streak', '5')).toBe('hive:banner-dismiss:streak:5');
    expect(bannerDismissKey('nemesis', 'uuid')).toBe('hive:banner-dismiss:nemesis:uuid');
  });

  it('clearAllBannerDismissalsForTest wipes every key', () => {
    dismissBanner('streak', '5');
    dismissBanner('nemesis', 'a');
    dismissBanner('comeback', 'pending');
    clearAllBannerDismissalsForTest();
    expect(isBannerDismissed('streak', '5')).toBe(false);
    expect(isBannerDismissed('nemesis', 'a')).toBe(false);
    expect(isBannerDismissed('comeback', 'pending')).toBe(false);
  });
});

