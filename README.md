# Hive Wars

A browser-native 2D casual strategy game: backyard insect colonies raiding
each other's mushroom-turret fortresses. Clash-of-Clans-style loop
(build → raid → upgrade) with two novel mechanics:

- **Dual-layer base.** Every base has a surface grid and an underground
  tunnel grid. Attackers pick which layer to invade; some units can dig
  between layers mid-raid.
- **Pheromone paths.** Instead of drop-and-forget troop deployment,
  players draw the route their swarm will follow.

Shipping to Facebook Instant Games first; then itch.io / Poki / Telegram
Mini Apps.

## Current status: week 1 scaffold

The repo currently contains:

- Deterministic shared sim (`shared/`) with fixed-point Q16.16 math, PCG32
  RNG, step reducer, and a hash-diff determinism test suite.
- Phaser 3 + Vite client (`client/`) with Boot/Home/Raid scenes and an
  FB Instant SDK bridge that falls back to guest auth off-platform.
- Fastify API (`server/api/`) with `/health`, `/match`, and
  `/raid/submit` (with server-side replay re-simulation + hash check).
- Colyseus arena (`server/arena/`) with a `PicnicRoom` implementing
  input-delay-lockstep netcode.
- CI workflows: determinism gate (Node and jsdom), typecheck, unit
  tests, bundle-size budget.
- Gemini art pipeline scaffold and headless bot-tester.

What's still missing: atlas generation, real matchmaking persistence
(Supabase), clan chat, deploy pipeline, full UI.

## Quickstart

```sh
corepack enable
pnpm install

# Run the determinism gate — should pass in <1 s:
pnpm --filter @hive/shared test

# Dev servers (three terminals):
pnpm dev:client   # Vite on http://localhost:5173
pnpm dev:api      # Fastify on http://localhost:8787
pnpm dev:arena    # Colyseus on ws://localhost:2567

# Bundle-size check:
pnpm --filter @hive/client build
pnpm --filter @hive/client bundle:report
```

## Architecture at a glance

```
┌──────────────┐   HTTP    ┌────────────┐
│   @hive/     │──────────▶│ @hive/api  │─── Supabase ──▶ Postgres
│    client    │           │  (Fastify) │                 (bases, replays,
│  (Phaser 3)  │           └─────┬──────┘                  clans, trophies)
│              │                 │
│              │     WS          │ re-runs shared sim
│              │────────────┐    │ on every raid submit
│              │            │    ▼
│              │            │   ┌────────────┐
│              │            └──▶│@hive/arena │
│              │                │ (Colyseus) │
│              │                └────────────┘
└──────┬───────┘
       │
       ▼
   @hive/shared  ← the SAME deterministic sim (Q16.16 fixed-point +
   PCG32 RNG) is imported unchanged by client, api, and arena.
```

The single source of truth for sim behavior lives at
`shared/src/sim/step.ts`. Client uses it for raid replay + arena
prediction. API uses it for async-replay validation. Arena uses it
as the authoritative simulator. Because it's bit-deterministic,
replays are just `{seed, inputs}` (~2 KB) — not video.

## The determinism rule

Every piece of code inside `shared/src/sim/` must obey:

- **Fixed-point math only.** No `Math.sin/cos/sqrt/random` — use the
  helpers in `shared/src/sim/fixed.ts` and the PCG32 `Rng` class.
- **Fixed timestep.** 30 Hz logical tick; renderer decoupled.
- **No Map/Set iteration.** Lookups are fine (`.get(key)`); iterating
  keys/values is banned. Use sorted arrays keyed by stable entity IDs.
- **No `Date.now()`.** The sim has no wall clock.
- **No allocations that depend on GC timing** (e.g., no WeakMap).

The determinism CI gate runs a scripted 300-tick scenario and diffs
state hashes every 100 ticks. If a PR flakes the hash, it's blocked.

## Layout

- `client/` — Phaser 3 + Vite app (FB Instant entry point)
- `server/api/` — Fastify + Supabase (auth, replays, clans)
- `server/arena/` — Colyseus rooms (live 1v1 Picnic Clash)
- `shared/` — deterministic sim (imported by all three)
- `protocol/` — wire schemas (Colyseus messages, HTTP DTOs)
- `tools/gemini-art/` — offline Gemini sprite generator + atlas packer
- `tools/bot-tester/` — headless balance harness

## License

All rights reserved. This repo is a private game prototype.
