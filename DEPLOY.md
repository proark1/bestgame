# Deploying Hive Wars

Single-service architecture: one Node process (the Fastify API) serves
both the JSON API (`/api/*`, `/admin/api/*`) and the built client
(static files from `client/dist/`). The Colyseus arena runs in the
same container for MVP — it can be split off to a second service
later without changing client code (the client already reads
`ARENA_URL` from an env-stamped runtime config).

## Stack

- **App**: Node 20 + Fastify + Colyseus (one process)
- **DB**: Postgres 15+ (managed)
- **Static**: Served from the app via `@fastify/static`
- **CDN**: Put Cloudflare (or the platform's built-in edge) in front
- **Client**: Vite-built SPA + landing page

## Pick a host

The repo ships with `railway.json`. Railway is the fastest path from
zero to URL:

1. Sign up at [railway.app](https://railway.app).
2. **New project → Deploy from GitHub repo** → point it at this repo
   and branch.
3. Railway detects `railway.json`, runs `pnpm -r build`, boots with
   `pnpm start`, and exposes a public URL.
4. **Add Plugin → Postgres** to the same project.
5. In the **Variables** tab, add `DATABASE_URL` bound to
   `${{Postgres.DATABASE_URL}}`.
6. Add `HIVE_AUTH_SECRET` — generate with `openssl rand -hex 32`.
7. Redeploy. Migrations run automatically at boot; see
   `server/api/src/db/migrate.ts`.

Other hosts work the same shape (Fly, Render, Porter, Railway…). The
only moving parts are:

- Install command: `pnpm install --frozen-lockfile`
- Build command: `pnpm -r build`
- Start command: `pnpm start` (runs `server/api` which serves the
  client from `client/dist/`)
- Healthcheck path: `/health`

## Required environment variables

| Var                  | Purpose                                                      | Required             |
| -------------------- | ------------------------------------------------------------ | -------------------- |
| `DATABASE_URL`       | Postgres connection string                                   | yes (for persistence) |
| `HIVE_AUTH_SECRET`   | HMAC secret for player session tokens (`openssl rand -hex 32`) | yes              |
| `ADMIN_PASSWORD`     | Single-user admin panel password                             | yes for admin panel  |
| `PORT`               | HTTP port (Railway / Fly inject this)                        | no (default 8787)    |
| `HOST`               | Bind address                                                 | no (default 0.0.0.0) |
| `LOG_LEVEL`          | Fastify log level                                            | no (default `info`)  |
| `ARENA_URL`          | Public WebSocket URL for the Colyseus arena                  | yes for arena mode   |
| `SENTRY_DSN_CLIENT`  | Client-side Sentry DSN. Stamped into the page at build time | no                   |
| `SENTRY_DSN_SERVER`  | Server-side Sentry DSN                                       | no                   |
| `POSTHOG_KEY`        | PostHog public project key                                   | no                   |
| `POSTHOG_HOST`       | PostHog ingest host (default `https://app.posthog.com`)      | no                   |

Without `DATABASE_URL` the API still boots and serves the client, but
persistence routes return 503. Without `HIVE_AUTH_SECRET` the server
mints an ephemeral secret on each boot — tokens invalidate on restart.
Both are hard requirements in prod.

Copy `.env.example` to a local `.env` for dev.

## DNS + TLS

Point your apex + www record at the platform's endpoint:

```
hivewars.example       A    <platform-ip>
www.hivewars.example   CNAME hivewars.example
```

Railway provisions Let's Encrypt certs automatically. For Cloudflare
in front: set proxy mode to `Proxied`, **SSL/TLS mode → Full (strict)**.

## First-deploy smoke test

After the deploy is green, run through this on a real phone (not just
desktop):

1. `https://your-domain/` → landing page renders, "Play now" CTA works.
2. Open DevTools → Network. Reload → no `fbinstant.7.1.js` request.
   Confirms the FB script is gone.
3. `https://your-domain/play` → game boots, "Raising the colony" splash
   disappears, HomeScene renders.
4. Check DevTools → Application → Manifest. Hive Wars manifest loads,
   icons resolve.
5. On iOS Safari: **Share → Add to Home Screen**. Icon is the brass
   hive. Opens standalone (no Safari chrome).
6. Start a raid → win → tap "Share". On mobile, the OS share sheet
   appears with the correct text and URL.
7. Tap through a Settings → mute → button click is silent → reload →
   still muted.
8. `curl https://your-domain/health` → `{"ok":true}`.
9. Check Sentry dashboard → at least one `sdk.init` ping.

## Rollback

Railway (+ Fly, Render) keep the last N builds. If a deploy breaks:

- Railway: **Deployments** tab → click the last good one → **Rollback**.
- Fly: `fly releases` then `fly deploy --image <previous-image>`.

DB migrations are forward-only (by design — rolling back schema +
data in a live game is rarely safe). If a migration is the cause,
fix-forward with a new migration rather than rolling back the ref.

## Backup

Postgres: enable managed daily snapshots on the host, OR run nightly
`pg_dump` into S3-compatible storage. Minimum RPO: 24h, RTO: ~30 min.

```bash
pg_dump "$DATABASE_URL" | gzip > "hive-$(date +%F).sql.gz"
```

## Observability

- `/health` is the liveness probe.
- Fastify logs to stdout in JSON (pino format). Pipe into the platform's
  log viewer; in Railway the logs tab is enough at launch scale.
- Sentry catches uncaught exceptions on client + server when the DSNs
  are set.
- PostHog collects funnel events when the key is set.

## Cost at launch scale

- Railway hobby: ~$5/mo baseline + usage. Good for the first ~1000 DAU.
- Postgres shared: included with Railway hobby up to ~1GB.
- Cloudflare: free tier.
- Sentry: 5k events/mo free.
- PostHog: 1M events/mo free.

Plan to upgrade Railway to the Pro plan (~$20/mo) once daily active
users clear 2k — the hobby plan caps RAM at 8 GB and the Phaser client
bundle + arena state can bump against that during raid surges.
