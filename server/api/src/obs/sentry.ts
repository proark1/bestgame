// Server-side Sentry init. Gated on `SENTRY_DSN_SERVER` being set —
// without it this is a no-op and the SDK stays idle.
//
// We only import `@sentry/node` inside the enabled branch so that
// a prod deploy without Sentry doesn't pay the startup cost of
// wiring up the SDK's instrumentation.

let initialized = false;

export function initServerSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN_SERVER;
  if (!dsn) return;
  try {
    // Dynamic `require`-style import: keep it async-free for start-up
    // simplicity. The `@sentry/node` package supports CommonJS-style
    // access through its default export.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    import('@sentry/node').then((Sentry) => {
      Sentry.init({
        dsn,
        tracesSampleRate: 0.05,
        environment: process.env.NODE_ENV ?? 'production',
        release: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_SHA,
      });
      initialized = true;
    });
  } catch (err) {
    console.warn('sentry init failed', err);
  }
}
