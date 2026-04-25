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

### 5.1 Units (17 deployable + 2 hidden)

All stats in `shared/src/sim/stats.ts::UNIT_STATS`. Glossary in
[`GLOSSARY.md`](./GLOSSARY.md#units). Per-kind unlock tier in
`server/api/src/game/buildingRules.ts::UNIT_UNLOCK_QUEEN_LEVEL`.

Role buckets:

| Role      | Units                                | Unlock | Notes |
|-----------|--------------------------------------|--------|-------|
| Chaff     | WorkerAnt, Forager                   | Q1     | Cheap, soak hits, trigger traps |
| Frontline | SoldierAnt, ShieldBeetle, HoneyTank  | Q1     | High HP, engage turrets |
| Burst     | BombBeetle, Roller, Jumper           | Q1     | Break walls / priority targets |
| Ranged    | Wasp, WebSetter                      | Q1     | Pick off turrets from distance |
| Utility   | DirtDigger, Ambusher                 | Q1     | Dig through layers / ambush |
| DoT       | FireAnt                              | Q2     | Lays a 3-second burn on contact |
| Anti-bldg | Termite                              | Q3     | 2× damage vs buildings; can dig |
| Air       | Dragonfly                            | Q3     | Fast flyer, dodges ground defenses |
| Burst     | Mantis                               | Q4     | Single-target finisher (22 dmg) |
| Swarm     | Scarab                               | Q5     | Spawns 2 MiniScarabs on death |

Hidden (spawned by behaviors, never deployable): MiniScarab (Scarab
death-spawn), NestSpider (SpiderNest defender). These are filtered out
of the deck picker and upgrade catalog by `ROSTER_HIDDEN_UNITS`.

Balance target: any 3-role army should reach 1★ on a same-trophy base.
No "solved" comp should reach 3★ without hard counters.

### 5.2 Buildings (14 player-placeable + Queen)

All stats in `shared/src/sim/stats.ts::BUILDING_STATS`.
Placement/costs in `server/api/src/game/buildingCosts.ts`.
Unlock quotas in `server/api/src/game/buildingRules.ts::QUOTA_BY_TIER`.

| Role      | Buildings                             | First unlock |
|-----------|---------------------------------------|--------------|
| Core      | QueenChamber (auto-loss if destroyed) | starter, 1×  |
| Economy   | DewCollector, LarvaNursery, SugarVault | Q1          |
| Defense T1 | MushroomTurret, LeafWall, DungeonTrap | Q1 / Q2 / Q2 |
| Defense T2 | PebbleBunker, AcidSpitter, SporeTower | Q2          |
| Defense T3 | RootSnare, HiddenStinger              | Q3          |
| Defense T4 | SpiderNest, ThornHedge                | Q4          |
| Utility    | TunnelJunction (layer transitions)    | Q2          |

Layer rules (`ALLOWED_LAYERS`):
- **Surface only:** MushroomTurret, LeafWall, PebbleBunker, DewCollector, AcidSpitter, SporeTower, HiddenStinger, ThornHedge.
- **Underground only:** LarvaNursery, SugarVault, SpiderNest.
- **Both layers:** QueenChamber, TunnelJunction, DungeonTrap, RootSnare.

Max buildings per base: 60 (`MAX_BUILDINGS_PER_BASE`).

### 5.3 Resources

The economy uses three currencies. Two are active in MVP (Sugar, LeafBits)
and one is reserved (AphidMilk) for the post-MVP monetization tier.

| Resource   | Visible icon | Active in MVP | Source                                          | Sink                                                |
|------------|--------------|----------|-------------------------------------------------|-----------------------------------------------------|
| Sugar      | gold pill    | yes      | DewCollector (8/sec), SugarVault (2/sec), raid loot | Unit upgrades, building placement, Queen upgrades |
| LeafBits   | green pill   | yes      | LarvaNursery (3/sec), raid loot                 | Unit upgrades, building placement, Queen upgrades   |
| AphidMilk  | silver pill  | reserved | (future) premium producer                       | (future) prestige unlocks, builder time-skip        |

#### 5.3.1 Per-second production

Production is per-building, scales linearly with level, and pauses while
hp ≤ 0 (destroyed buildings don't produce). Canonical table:
`server/api/src/routes/player.ts::INCOME_PER_SECOND` (mirrored to the
client via the `/player/building/catalog` endpoint).

| Building     | Sugar/sec | LeafBits/sec | Layer       |
|--------------|-----------|--------------|-------------|
| DewCollector | 8 × level | —            | surface     |
| LarvaNursery | —         | 3 × level    | underground |
| SugarVault   | 2 × level | —            | underground |

A starter base (1× DewCollector L1, 1× LarvaNursery L1, 1× SugarVault L1)
produces **10 sugar/sec + 3 leaf/sec** — about 36k sugar / 10.8k leaf
per real-time hour. A maxed Q5 base (5/5/3 economy at L10) produces
**51 sugar/sec + 15 leaf/sec** — about 184k sugar / 54k leaf per hour.

#### 5.3.2 Offline trickle

Resources continue accruing while the player is offline, capped at
8 hours (`MAX_OFFLINE_SECONDS = 28800`). Computed lazily on every
`/player/me` call from `last_seen_at` → `now`. A Q5 economy banks the
full 8h cap at **~1.47M sugar + ~430k leaf** per session — comfortably
above the price of one mid-tier upgrade so the daily-return loop always
has something to spend on, but well under a Queen tier so absentees
don't skip progression.

#### 5.3.3 Loot drops (per-building destruction)

Loot is per-destroyed-building, not a percentage of bank. Each kind has
fixed `dropsSugarOnDestroy` + `dropsLeafBitsOnDestroy` constants in
`shared/src/sim/stats.ts::BUILDING_STATS`. Drops accumulate into
`SimState.attackerSugarLooted` / `attackerLeafBitsLooted` and credit the
attacker on raid commit.

| Building       | Sugar drop | LeafBits drop |
|----------------|------------|---------------|
| DewCollector   | 100        | 0             |
| LarvaNursery   | 60         | 0             |
| SugarVault     | 500        | 0             |
| MushroomTurret | 0          | 20            |
| LeafWall       | 0          | 5             |
| PebbleBunker   | 0          | 10            |
| DungeonTrap    | 0          | 5             |
| AcidSpitter    | 0          | 15            |
| SporeTower     | 0          | 12            |
| RootSnare      | 0          | 3             |
| HiddenStinger  | 0          | 18            |
| SpiderNest     | 0          | 20            |
| ThornHedge     | 0          | 12            |
| TunnelJunction | 0          | 0             |
| QueenChamber   | 0          | 0             |

Calibration target: a clean 3★ on a same-tier base should yield
~1 unit-upgrade's worth of resources at the player's current level.
A typical Q3 layout (~12–18 buildings) drops **~1500–2200 sugar + ~150
leaf** when fully wiped — roughly the cost of one L3→L4 SoldierAnt
(480 sugar / 128 leaf) plus change for a building upgrade.

#### 5.3.4 Storage and overflow

MVP keeps the bank uncapped — see §6.8 for the storage-cap formula
shipped alongside this revision and how the UI surfaces it.

### 5.4 Building Catalog (full reference)

Source: `BUILDING_PLACEMENT_COSTS` (`server/api/src/game/buildingCosts.ts`),
`BUILDING_STATS` (`shared/src/sim/stats.ts`),
`QUOTA_BY_TIER` (`server/api/src/game/buildingRules.ts`).

| Kind           | L1 Sugar | L1 Leaf | HP   | DPS              | Drops S/L | First Q | Q1–Q5 quota   |
|----------------|----------|---------|------|------------------|-----------|---------|---------------|
| QueenChamber   | starter  | starter | 800  | —                | 0 / 0     | Q1      | 1·1·1·1·1     |
| DewCollector   | 200      | 40      | 200  | — (8 sugar/s)    | 100 / 0   | Q1      | 1·2·3·4·5     |
| LarvaNursery   | 400      | 120     | 300  | — (3 leaf/s)     | 60 / 0    | Q1      | 1·2·3·4·5     |
| SugarVault     | 600      | 100     | 350  | — (2 sugar/s)    | 500 / 0   | Q1      | 1·1·2·2·3     |
| MushroomTurret | 350      | 80      | 400  | 5 dmg @ 30t, r3  | 0 / 20    | Q1      | 1·2·3·4·5     |
| LeafWall       | 100      | 60      | 600  | —                | 0 / 5     | Q1      | 4·8·12·16·20  |
| PebbleBunker   | 500      | 150     | 900  | —                | 0 / 10    | Q2      | 0·1·2·2·3     |
| DungeonTrap    | 150      | 30      | 100  | 20 dmg, r1, 1-shot | 0 / 5   | Q2      | 0·2·4·6·8     |
| TunnelJunction | 250      | 50      | 250  | —                | 0 / 0     | Q2      | 0·1·2·3·4     |
| AcidSpitter    | 700      | 200     | 350  | 8 dmg @ 90t, r5, splash 1.4 | 0 / 15 | Q2 | 0·1·2·3·4 |
| SporeTower     | 550      | 160     | 280  | 14 dmg @ 36t, r4 (anti-air) | 0 / 12 | Q2 | 0·1·2·3·4 |
| RootSnare      | 180      | 40      | 1    | 12 dmg + 2s root, 1-shot | 0 / 3 | Q3 | 0·0·2·4·6 |
| HiddenStinger  | 900      | 260     | 220  | 10 dmg @ 18t, r2.5 (cloaked) | 0 / 18 | Q3 | 0·0·1·2·3 |
| SpiderNest     | 1200     | 320     | 260  | spawns 3× NestSpider, 4s cd | 0 / 20 | Q4 | 0·0·0·1·2 |
| ThornHedge     | 220      | 110     | 1100 | reflects 1 burn/tick on melee | 0 / 12 | Q4 | 0·0·0·4·8 |

Cooldown notation: `t = ticks @ 30 Hz`. `r = attack range in tiles`.

### 5.5 Unit Catalog (full reference)

Source: `UNIT_STATS` + `UNIT_BEHAVIOR` (`shared/src/sim/stats.ts`),
`BASE_SUGAR` / `BASE_LEAF` (`server/api/src/game/upgradeCosts.ts`),
`UNIT_UNLOCK_QUEEN_LEVEL` (`server/api/src/game/buildingRules.ts`).

| Kind         | L1 Sugar | L1 Leaf | HP  | Speed | Range | Dmg | CD  | Tags          | Unlock |
|--------------|----------|---------|-----|-------|-------|-----|-----|---------------|--------|
| WorkerAnt    | 150      | 30      | 20  | 0.08  | 0.6   | 2   | 18t | chaff         | Q1     |
| SoldierAnt   | 300      | 80      | 40  | 0.07  | 0.8   | 6   | 24t | frontline     | Q1     |
| DirtDigger   | 400      | 120     | 30  | 0.05  | 0.5   | 4   | 30t | dig           | Q1     |
| Forager      | 200      | 60      | 15  | 0.12  | 0.5   | 2   | 20t | flyer/chaff   | Q1     |
| Wasp         | 500      | 150     | 25  | 0.10  | 2.5   | 5   | 30t | flyer/ranged  | Q1     |
| HoneyTank    | 700      | 220     | 80  | 0.04  | 0.8   | 8   | 36t | tank          | Q1     |
| ShieldBeetle | 800      | 250     | 120 | 0.05  | 0.6   | 4   | 30t | tank          | Q1     |
| BombBeetle   | 600      | 180     | 30  | 0.09  | 0.4   | 25  | 1t  | wall-breaker  | Q1     |
| Roller       | 550      | 170     | 50  | 0.11  | 0.7   | 10  | 45t | burst         | Q1     |
| Jumper       | 450      | 130     | 35  | 0.10  | 0.6   | 7   | 22t | mobility      | Q1     |
| WebSetter    | 500      | 160     | 25  | 0.07  | 2.0   | 1   | 40t | utility/ranged| Q1     |
| Ambusher     | 650      | 200     | 30  | 0.09  | 0.7   | 12  | 30t | burst         | Q1     |
| FireAnt      | 450      | 140     | 28  | 0.08  | 0.6   | 3   | 24t | DoT (3s burn) | **Q2** |
| Termite      | 600      | 190     | 35  | 0.07  | 0.5   | 6   | 22t | dig, 2× vs bldg | **Q3** |
| Dragonfly    | 650      | 200     | 22  | 0.13  | 1.6   | 4   | 28t | flyer/burst   | **Q3** |
| Mantis       | 850      | 280     | 55  | 0.08  | 0.9   | 22  | 48t | finisher      | **Q4** |
| Scarab       | 1000     | 330     | 60  | 0.07  | 0.7   | 5   | 30t | swarm (2× MiniScarab) | **Q5** |

Speed in tiles/tick (30 Hz sim). Base stats; level multipliers from
§6.3 apply at deploy time. MiniScarab + NestSpider are spawned by
behaviors and never appear in the deck or upgrade UI.

### 5.6 Queen Chamber Progression

The Queen Chamber is the single progression gate. Level 1 is starter,
level 5 is the cap. Each tier raises per-kind quotas (§5.2) and
unlocks new unit kinds (§5.1 Unlock column).

Source: `QUEEN_UPGRADE_COST` (`server/api/src/game/buildingRules.ts`).

| Q-level upgrade | Sugar  | LeafBits | New buildings unlocked                                        | New units unlocked   |
|-----------------|--------|----------|---------------------------------------------------------------|----------------------|
| Q1 → Q2         | 500    | 200      | PebbleBunker, DungeonTrap, TunnelJunction, AcidSpitter, SporeTower | FireAnt          |
| Q2 → Q3         | 1500   | 600      | RootSnare, HiddenStinger, AI-rules editor (4 rules / base)    | Termite, Dragonfly   |
| Q3 → Q4         | 4000   | 1500     | SpiderNest, ThornHedge (8 AI rules / base)                    | Mantis               |
| Q4 → Q5         | 10000  | 3500     | (cap raised on existing kinds; 12 AI rules / base)            | Scarab               |

Cumulative cost Q1→Q5: **16,000 sugar + 5,800 leaf**. At a Q3 economy
(roughly 22 sugar/sec, 9 leaf/sec) that's ~12 minutes of pure idle
income — but in practice players reach Q5 by mixing raid loot with
production, hitting the cap around the 1–2 week mark on the §6.1
sigmoid curve.

AI-rules system: gated at Q3 (`RULES_UNLOCK_QUEEN_LEVEL = 3`,
`server/api/src/game/aiRules.ts`). Per-base rule budget grows 0/0/4/8/12
at Q1..Q5; per-building cap is 8.

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

### 6.8 Storage caps (active)

The bank has a soft cap derived from the player's storage buildings.
Production stops trickling once the cap is reached, and offline trickle
clamps at the cap. Loot still credits past the cap (raids should never
be a "wasted" action), but the player gets a "storage full" warning
nudging them to spend.

```
sugarCap = 1000 (base)
         + 1500 × Σ(SugarVault levels)
         + 200  × Σ(DewCollector levels)

leafCap  = 500  (base)
         + 800  × Σ(LarvaNursery levels)
```

Worked example — Q3 base with SugarVault L3, DewCollector L3 each ×3,
LarvaNursery L3 each ×3:

- `sugarCap = 1000 + 1500 × 3 + 200 × 9 = 7300` (1 vault, 3 collectors)
- `leafCap  = 500 + 800 × 9 = 7700`

This is enough headroom for ~3 mid-tier upgrades but tight enough that
Long-AFK players need a vault/nursery upgrade or a raid to drain.

Canonical implementation: `shared/src/economy/storage.ts::storageCaps()`,
applied in `server/api/src/routes/player.ts` on every offline-trickle
write.

### 6.9 UI surface for resources, costs, and progression

Every resource-impacting screen shows the relevant numbers, never just
"upgrade" buttons. The intent: a player should never have to leave a
context to find out what they earn or what something costs.

| Surface                           | What it shows |
|-----------------------------------|---------------|
| HomeScene HUD pills               | Sugar, LeafBits, AphidMilk current; +X/sec production rate; storage cap headroom (`5800 / 7300`) |
| BuildingInfoModal — header        | Current level, current HP/DPS/range, production/sec |
| BuildingInfoModal — preview row   | "Next level" stat preview (current → next, color-tagged delta) |
| BuildingInfoModal — Queen Chamber | "Unlocks at Q+1" list of new buildings + units |
| BuilderQueueScene                 | (future) builder slots, time remaining, AphidMilk skip price |
| RaidScene pre-raid header         | Defender lootable (sum of Sugar+Leaf drops across alive buildings) |
| RaidScene result panel            | Resources looted, trophy delta, stars earned |
| UpgradeScene rows                 | Current L → next L, cost, stat-Δ preview ("+HP +6 / +DMG +1") |
| Wallet shortage hints             | "Need 480 more sugar" — already on UpgradeScene + queen modal |

### 6.10 Balance anchors

Concrete calibration targets — change a number above, run the harness,
and verify it still hits all of these. If any anchor moves more than
±20%, audit the ripple before merging.

| Anchor                                                    | Target  |
|-----------------------------------------------------------|---------|
| First raid (Q1 base) loot                                 | ~450 sugar + ~50 leaf (≈ 1.5× a SoldierAnt L1→L2) |
| Q1 → Q2 upgrade                                           | reachable in first 30-min session via 1 idle hour OR 2 raids |
| Q2 → Q3 upgrade                                           | reachable in day-2 session (~1 hour offline + 3 raids) |
| Q3 → Q4 upgrade                                           | reachable end of week-1 |
| Q4 → Q5 upgrade                                           | reachable end of week-3 |
| Median unit at L5, L7 storage maxed                       | week-3 player profile |
| Time to 3-star a same-trophy base (typical raid)          | 60–80 sim-seconds (180–240 of 2700 ticks idle) |
| Sum of `dropsSugarOnDestroy` across an L1 economy base    | ~1500 sugar (1× DewC + 1× Vault + 1× Nursery + walls/turrets) |
| Storage cap at full Q5 economy (5 vaults, 5 collectors @ L10) | ~88,500 sugar / ~40,500 leaf — covers ~3 unit-upgrades headroom |
| Offline cap (8h) at full Q5 economy                       | ~1.47M sugar / ~430k leaf — clamped by storage cap to one drain-cycle |

## 7. Combat model

- 30 Hz deterministic sim. 2700 ticks = 90-second raid.
- Star conditions: 1★ = any damage to QueenChamber OR >50% destruction;
  2★ = >75% destruction; 3★ = QueenChamber destroyed OR 100%
  destruction.
- Loot model (active): per-destroyed-building drops (§5.3.3). Sums
  `dropsSugarOnDestroy` and `dropsLeafBitsOnDestroy` over every
  building reduced to hp ≤ 0 during the raid. The attacker's bank is
  credited at submit; values past the bank's storage cap (§6.8) still
  credit, but the wallet HUD flashes a "storage full" warning until
  the player drains it via a placement, upgrade, or queen tier.
- Loot ceiling (future): `loot = min(defenderStock × 0.15, colonyRankCap)`
  is the planned overlay (§6.7) once Colony Rank ships. MVP keeps the
  per-building model uncapped because the storage cap already throttles
  long-term inflation.
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

## 12. Open gaps & roadmap

The MVP economy is feature-complete for the build → raid → upgrade
loop. Tracked gaps, ordered by player impact:

1. **Builder time gates (§6.6)** — currently upgrades resolve instantly.
   The `buildTime(L)` formula is specified but no `builders` table or
   queue UI exists yet (`BuilderQueueScene` is a placeholder). This is
   also the planned AphidMilk monetization hook (skip-time IAP).
2. **AphidMilk producers** — no source exists in MVP. Currency is
   surfaced in the HUD pill (always visible) so players see the slot;
   the actual income hook lands with builders.
3. **Colony Rank loot cap (§6.7)** — formula specified, not yet on
   `/api/raid/submit`. Storage cap (§6.8) is shipped instead and
   handles the inflation problem from a different angle.
4. **Per-building ownership in sim** — needed for symmetric live PvP.
   See §8.2 for the existing arena workaround (host's-base-only).
5. **Clan war season payouts** — clan scaffolding exists, but the
   resource payout for war wins is not yet wired up.

Each of these is a focused PR, not a refactor. Avoid bundling them.
