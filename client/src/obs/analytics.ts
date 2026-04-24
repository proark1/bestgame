// PostHog wrapper. Gated on a build-time env var (VITE_POSTHOG_KEY)
// so the SDK is tree-shaken out when analytics aren't configured,
// and a no-op in dev builds by default.
//
// All scene-level telemetry goes through `track(name, props)` which
// falls through to a silent no-op when the SDK isn't initialized.
// Scenes don't need to know if analytics are on or off.

type PosthogLike = {
  capture(name: string, props?: Record<string, unknown>): void;
  opt_out_capturing(): void;
  opt_in_capturing(): void;
  has_opted_out_capturing(): boolean;
};

let ph: PosthogLike | null = null;
let initPromise: Promise<void> | null = null;

function env(): Record<string, string | undefined> {
  return (import.meta as unknown as { env: Record<string, string | undefined> }).env;
}

export async function initAnalyticsIfConfigured(): Promise<void> {
  if (initPromise) return initPromise;
  const key = env().VITE_POSTHOG_KEY;
  if (!key) return;
  initPromise = (async () => {
    try {
      const mod = await import('posthog-js');
      const posthog = mod.default ?? mod;
      posthog.init(key, {
        api_host: env().VITE_POSTHOG_HOST ?? 'https://app.posthog.com',
        autocapture: false,
        // Respect the in-game "opt out of analytics" toggle. See
        // setAnalyticsOptOut().
        persistence: 'localStorage',
        capture_pageview: false,
        disable_session_recording: true,
      });
      ph = posthog as unknown as PosthogLike;
      // If the user previously opted out, keep them opted out. The
      // PostHog SDK persists the opt-out flag itself; this is just
      // defensive against a fresh SDK reading a pre-existing flag
      // that we wrote.
      if (localStorage.getItem('hive.analyticsOptOut') === '1') {
        ph.opt_out_capturing();
      }
    } catch (err) {
      console.warn('posthog init failed', err);
    }
  })();
  return initPromise;
}

export function track(name: string, props?: Record<string, unknown>): void {
  ph?.capture(name, props);
}

export function setAnalyticsOptOut(optedOut: boolean): void {
  try {
    localStorage.setItem('hive.analyticsOptOut', optedOut ? '1' : '0');
  } catch {
    // ignore storage errors
  }
  if (!ph) return;
  if (optedOut) ph.opt_out_capturing();
  else ph.opt_in_capturing();
}
