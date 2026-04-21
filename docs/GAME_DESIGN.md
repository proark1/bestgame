# Hive Wars — Game Design Document

**Status:** Living document. Last major revision: progression curve v1 (2026-04).
**Scope:** Single source of truth for design intent. Implementation details live
in code; this file explains *why*. When code and GDD disagree, open a PR that
updates both.

---

## 1. Pitch

Hive Wars is a 2D casual-strategy game about backyard insect colonies raiding
each other's mushroom-turret fortresses. The loop — build base, raid rival,
loot resources, upgrade — is proven (Clash of Clans, Boom Beach). We
differentiate with two mechanics that no existing Clash-like has:

- **Dual-layer bases.** Every base has a surface grid (layer 0) and a
  parallel tunnel grid (layer 1). Attackers decide per-unit which layer
  to invade; a few unit kinds (DirtDigger) can switch layers mid-raid
  through TunnelJunctions.
- **Pheromone paths.** Instead of "tap to drop, watch the AI," players
  draw a route their swarm will walk. Path-drawing rewards spatial
  planning without the APM of an RTS.

Target platforms, in ship order: Facebook Instant Games → itch.io / Poki /
Telegram Mini Apps → native wrappers.

## 2. Target audience and retention shape

Primary: casual strategy players on mobile/web, 25–45, familiar with
Clash-like loops. Play session: 3–8 minutes, 2–4 sessions/day.

Retention goals (industry benchmarks for the category):

| Day | Target retention | Design lever |
|-----|------------------|--------------|
| D1  | 40%              | Hook loop: first 10 min delivers 3+ visible upgrades |
| D7  | 18%              | Daily raid cadence + resource trickle cap |
| D30 | 7%               | Clan, ladder, new-content drip |

We tune the progression curve (§6) to maximize D1 retention specifically,
because D1 is the leakiest point in the funnel and the one most responsive
to early-game feel.

## 3. Core gameplay loop

```
 ┌──► HOME   place/upgrade buildings,
 │     │     spend resources, plan army
 │     ▼
 │    RAID   find opponent, draw pheromone
 │     │     paths, deploy units, watch sim
 │     ▼
 │    LOOT   stars → loot + trophies,
 │     │     resources credit to Home
 │     ▼
 └── UPGRADE next unit level unlocks
```

Secondary loops (added as content unlocks):

- **Clan war** (multi-player team raids) — week-cadence engagement.
- **Ladder** (trophy-based matchmaking) — session-cadence stakes.
- **Offline trickle** (income while away) — push notification driver.

## 4. Factions (flavour, not balance)

Three factions — Ants, Beetles, Wasps — chosen at account creation. Faction
affects cosmetic identity, starter base layout, and eventually a
faction-exclusive unit per tier. Combat stats are **identical across
factions**; we deliberately avoid rock-paper-scissors asymmetry to keep the
balance surface small.

## 5. Entities

### 5.1 Units (12)

All stats in `shared/src/sim/stats.ts::UNIT_STATS`. Glossary in
[`GLOSSARY.md`](./GLOSSARY.md#units).

Role buckets:

| Role      | Units                           | Notes |
|-----------|---------------------------------|-------|
| Chaff     | WorkerAnt, Forager              | Cheap, soak hits, trigger traps |
| Frontline | SoldierAnt, ShieldBeetle, HoneyTank | High HP, engage turrets |
| Burst     | BombBeetle, Roller, Jumper      | Break walls / priority targets |
| Ranged    | Wasp, WebSetter                 | Pick off turrets from distance |
| Utility   | DirtDigger, Ambusher            | Dig through layers / ambush |

Balance target: any 3-role army should reach 1★ on a same-trophy base.
No "solved" comp should reach 3★ without hard counters.

### 5.2 Buildings (9)

All stats in `shared/src/sim/stats.ts::BUILDING_STATS`.
Placement/costs in `server/api/src/game/buildingCosts.ts`.

| Role      | Buildings                             |
|-----------|---------------------------------------|
| Core      | QueenChamber (auto-loss if destroyed) |
| Defense   | MushroomTurret, LeafWall, PebbleBunker, DungeonTrap |
| Economy   | DewCollector, LarvaNursery, SugarVault |
| Utility   | TunnelJunction (layer transitions)    |

Max buildings per base: 60 (`MAX_BUILDINGS_PER_BASE`).

### 5.3 Resources

| Resource    | Source                          | Sink                            |
|-------------|---------------------------------|---------------------------------|
| Sugar       | DewCollector, SugarVault, raid loot | Unit upgrades, building placement |
| LeafBits    | LarvaNursery, raid loot         | Unit upgrades, building placement |
| AphidMilk   | (future) premium producer        | (future) prestige unlocks        |

AphidMilk is reserved for a future premium/prestige tier. Not used in
MVP cost tables.

## 6. Progression — The Sophisticated Curve

This section is the heart of the design. Everything else is in service of
making this curve feel right.

### 6.1 Design target: sigmoid progression

Plot of "total power" vs "total play time" should be **sigmoid-shaped**:

```
power │                    ┌──────────  (plateau: mastery phase, wk 3+)
      │                ┌───┘
      │           ┌────┘              (inflection: habit phase, d 2–14)
      │       ┌───┘
      │   ┌───┘                       (hook phase, first 30 min)
      │───┘
      └──────────────────────────────► time
```

Concretely:

- **Hook phase (0–30 min):** First upgrade is half price. Player gains
  their first 3 upgrades inside the first session. Each upgrade delivers
  a visible stat bump (+17% on first level). Hook is **maximally
  front-loaded**.
- **Habit phase (d1–d14):** Each upgrade costs roughly 2× the last.
  Session length stays 5 min but frequency rises as player chases
  timers. Stat gains per upgrade taper to +5–8%.
- **Mastery phase (wk 3+):** Each upgrade costs 30–60× the first. Stat
  gains down to +2–3%. Motivation shifts from raw progression to ladder
  competition and clan events.

### 6.2 Cost curve — Golden-ratio Fibonacci

**Formula:** `cost(L → L+1) = baseCost × mult[L]` where

```
mult = [0.5, 1.0, 1.6, 2.6, 4.2, 6.8, 11.0, 17.8, 28.8]
       // L=1  L=2  L=3  L=4  L=5  L=6  L=7  L=8  L=9
```

Derived from `0.5 × φ^L` where φ ≈ 1.618 (golden ratio), rounded to
nearby "clean" numbers.

**Why golden-ratio Fibonacci?** Each multiplier is ~1.6× the previous,
giving compound growth without the punishing feel of pure doubling
(2^L hits 512× at L9). The 1.6 ratio lands on "roughly twice as hard
as last time" — the human sweet spot for perceived progression pacing
(this is why Clash of Clans, Hay Day, and Last War all cluster around
a 1.5–1.8 ratio). The 0.5× first-level scalar is a deliberate **hook
discount** — the first upgrade should be free-feeling.

**Totals** (for cost calibration):

| Milestone | Sum of mult | Fraction of L10 | Typical time to reach |
|-----------|-------------|------------------|-----------------------|
| L3        | 1.5         | 2%               | ~10 min               |
| L5        | 5.7         | 8%               | ~1 day                |
| L7        | 16.7        | 22%              | ~1 week               |
| L9        | 45.5        | 61%              | ~3 weeks              |
| L10       | 74.3        | 100%             | ~6 weeks              |

Canonical implementation: `server/api/src/game/progression.ts::LEVEL_COST_MULT`.

### 6.3 Stat-gain curve — Logarithmic diminishing returns

**Formula:** `statMultiplier(L) ≈ 1 + 0.25 × ln(L)`, pre-computed and
rounded to integer percentages for deterministic sim math:

```
LEVEL_STAT_PERCENT = [100, 117, 127, 135, 140, 145, 150, 155, 157, 160]
                     // L=1  L=2  L=3  L=4  L=5  L=6  L=7  L=8  L=9 L=10
```

Per-level gain decays: **+17% → +10% → +8% → +5% → +5% → +5% → +5% →
+2% → +3%**. The first upgrade is the most impactful in both directions
(cheapest AND biggest relative stat jump), front-loading the dopamine
hit.

Why log instead of linear? The previous `+20% per level` is linear —
every upgrade feels the same. Log gives the classic "first upgrade
feels huge, ninth upgrade feels incremental" arc that drives habit
formation in the early week but avoids infinite inflation in the late
game.

Canonical implementation: `shared/src/sim/progression.ts::LEVEL_STAT_PERCENT`.
This is the **only source of truth** for sim stat scaling — `deploy.ts`
and `combat.ts` import it rather than duplicating the formula.

### 6.4 Progression-rate envelope

Combine cost (exponential up) and stat gain (logarithmic up) to get
"stat per sugar spent":

```
rate(L) = statDelta(L) / cost(L)
```

| L | cost mult | stat Δ | rate |
|---|-----------|--------|------|
| 1 | 0.5       | +17    | 34   |
| 3 | 1.6       | +8     | 5.0  |
| 5 | 4.2       | +5     | 1.2  |
| 7 | 11.0      | +5     | 0.45 |
| 9 | 28.8      | +3     | 0.10 |

**340× drop** in stat-per-sugar from L1 to L9. That's the "slowing
progress" feeling, mathematized. This ratio should drop monotonically
— if we ever add a new level tier, preserve the monotonic drop.

### 6.5 Trophy ladder — ELO with tiered K-factor

Previous design: flat table (+10/+20/+30 per 1/2/3 stars). Problem:
inflationary at low trophies (bots farm endless trophies), flat at
high trophies (no matchmaking signal).

**New design:** standard ELO with trophy-tiered K-factor.

```
K(trophies) = { 48 if t < 400,   // hook bracket, fast ramp
                32 if t < 1500,  // standard
                20 if t < 3000,  // plateau
                12 otherwise }   // prestige

expected = 1 / (1 + 10^((defenderTrophies - attackerTrophies) / 400))
actual   = stars / 3                                  // 0, 1/3, 2/3, 1

attackerGain  = round(K × (actual - expected))
defenderLoss  = round(K × (actual - expected) × 0.8)  // dampened
```

- **Hook effect:** a new player (t=100, K=48) 3-starring a same-level
  opponent gains ~24 trophies per win. They can hit 400 in 16 wins
  (~2 hrs of play).
- **Plateau effect:** at t=3000+ (K=12), beating an equal-trophy
  opponent for 3★ gains only 6 trophies. Climbing to 4000 requires
  ~160 clean wins.
- **Auto-correcting:** beating weaker opponents gains almost nothing;
  beating stronger opponents gains a lot. Trophy distribution stays
  Gaussian-ish around the average opponent strength rather than
  drifting up forever.
- **Slight inflation:** defenderLoss × 0.8 < attackerGain → trophies
  slowly inflate at the aggregate. Intentional — keeps casual players
  feeling like they're progressing. Recalibrate K values if the median
  climbs more than ~5% per month.

Minimum guarantees (so any 3★ win feels rewarded):

- If `stars ≥ 1` and computed gain < 1, gain = 1.
- If `stars == 0`, neither player's trophies change.
- Attacker trophies floor at 0 (can't go negative).

Canonical implementation: `server/api/src/game/progression.ts::trophyDelta()`.

### 6.6 Time gates (future work)

Currently upgrades are instant. A future "builder slot" system will add
time gates as the second dimension of progression (alongside cost):

```
buildTime(L) = clamp(baseTime × mult[L] × 0.3, 10s, 48h)
```

With baseTime = 30s, L1 upgrade takes 10s (floor), L9 upgrade takes ~26h
(capped at 48h). Players can pay AphidMilk to skip timers — this is the
planned monetization hook.

### 6.7 Colony Rank (future work)

An aggregate "Town Hall-like" rank derived from total invested resources.
Unlocks new building kinds and raises placement caps. Rank formula:

```
colonyRank = floor(log₂(1 + totalInvested / 1000))
```

At MVP, we operate at implicit rank 1 (all kinds unlocked at start).

## 7. Combat model

- 30 Hz deterministic sim. 2700 ticks = 90-second raid.
- Star conditions: 1★ = any damage to QueenChamber OR >50% destruction;
  2★ = >75% destruction; 3★ = QueenChamber destroyed OR 100%
  destruction.
- Loot formula (post-raid): `loot = min(defenderStock × 0.15, attackerCap)`
  where cap scales with attacker Colony Rank (future).
- Pheromone paths: polyline of fixed-point waypoints. Units spawn
  evenly along the first segment; follow the polyline until engaged.

## 8. Matchmaking

### 8.1 Async raid (single-player feel)

- Trophy band: ±75 trophies (`TROPHY_BAND` in
  `server/api/src/routes/matchmaking.ts`).
- Active window: 3 days (skip ghost defenders).
- Fallback: deterministic bot base (`botBase()`) if no live match found.
- Pending match has a 15-minute TTL; consumed atomically on submit to
  prevent replay farming.

### 8.2 Live PvP (arena)

- Trophy band: ±120 trophies (wider than async so a room fills faster).
- Active window: 10 minutes (needs a fresh pool of online players).
- Host pick: lower UUID wins deterministically; the host's base becomes
  the live map.
- `/api/arena/reserve` stores both players' snapshots in `arena_matches`
  keyed by a random token; both clients connect to the Colyseus `picnic`
  room with that token.
- The Colyseus arena redeems the token via `POST /api/arena/_lookup`
  (auth: `ARENA_SHARED_SECRET` header, or loopback-only if unset) and
  seeds the sim with the persisted `host_snapshot`. On match end,
  `POST /api/arena/_result` writes `outcome`, `winner_slot`, `ticks`,
  and `final_state_hash` back into the row.
- **Today's sim limitation:** the core sim has no per-building
  ownership, so live matches run on the host's base only — both players
  deploy against it and the loser is whoever lost their deploy cap
  first (or whoever dealt less damage at tick 2700). Full symmetric
  base-vs-base PvP is a sim refactor: add `ownerSlot` to `SimBuilding`
  and partition the map into left/right halves. The storage + wire
  shape already carries both snapshots so no further migration will be
  needed when the sim lands.

## 9. Monetization (post-MVP)

Free-to-play. Pay-for-time, not pay-for-power:

1. **AphidMilk packs:** skip builder timers. Does not grant stat bypass.
2. **Cosmetic skins:** faction variants, particle themes.
3. **Clan war pass:** seasonal ladder rewards.

Never sell direct power (stat boosts, level skips). This preserves
competitive integrity and matches FB Instant's policies.

## 10. Balance change process

1. Adjust numbers in the constants module (`progression.ts`,
   `stats.ts`, etc).
2. Run `pnpm test` (determinism + unit).
3. Run `pnpm --filter @hive/bot-tester run` — headless bot harness that
   simulates 10k raids and reports win-rate/loot distributions.
4. If the curve's sigmoid shape breaks (e.g. L5 cost drops below L4),
   CI balance-shape test fails — fix or explicitly waive.
5. Update this doc's tables (§6.2 totals) if the curve changes.

## 11. Technical anchors

The design rests on these technical guarantees:

- **Deterministic sim** — every raid is a `{seed, inputs}` replay, so
  server can re-run the client's claim authoritatively
  (`shared/src/sim/step.ts`).
- **Fixed-point math** — Q16.16 `Fixed` throughout the sim; no floats,
  no `Math.random`, no `Date.now()` inside sim.
- **Integer stat percents** — the LEVEL_STAT_PERCENT table is integer
  percents by construction, so sim math stays determinism-safe.
- **Server-authoritative costs** — cost formulas live on the API;
  clients never compute cost locally.

See [`GLOSSARY.md`](./GLOSSARY.md) for vocabulary and tag conventions.
