// Client-side Sentry init. Gated on a build-time env var so dev
// builds don't bundle Sentry at all and prod builds don't do anything
// until a DSN is provided. Keeping the import inside the enabled
// branch lets the bundler tree-shake the module when the DSN is
// missing in prod builds too.

export async function initSentryIfConfigured(): Promise<void> {
  // Vite stamps import.meta.env.* at build time. The var has to be
  // prefixed with VITE_ to be exposed to the client bundle. We accept
  // both VITE_SENTRY_DSN and SENTRY_DSN_CLIENT (documented in
  // DEPLOY.md) — whichever is set wins.
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  const dsn = env.VITE_SENTRY_DSN ?? env.SENTRY_DSN_CLIENT;
  if (!dsn) return;
  try {
    const Sentry = await import('@sentry/browser');
    Sentry.init({
      dsn,
      // Keep the sample rates conservative at launch so we don't burn
      // through the free tier on day one.
      tracesSampleRate: 0.05,
      // Replays are off until we know we need them — bundle savings
      // matter on mobile.
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      release: env.VITE_BUILD_SHA,
      environment: env.MODE,
    });
  } catch (err) {
    console.warn('sentry init failed', err);
  }
}
