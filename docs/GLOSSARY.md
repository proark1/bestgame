# Hive Wars — Glossary & Code Ontology

**Purpose.** A canonical naming reference so code — whether written by humans
or AI — uses consistent identifiers and vocabulary. Every concept defined
here has exactly one spelling and one source file of truth. When you see a
word in capital-italic form (e.g. *UnitKind*) inside code or docs, it refers
to the entry with that name here.

**Who reads this.** Anyone writing code in this repo — especially
AI-assisted coding (Claude Code, Cursor, Copilot). Keep it alphabetized
inside each section, and update in the same PR as any addition to the
vocabulary.

---

## 1. Core nouns

| Term | Meaning | Source of truth |
|------|---------|-----------------|
| *Attacker* | Player initiating a raid. OwnerSlot 0 in the sim. | `shared/src/sim/state.ts` |
| *Base* | A player's owned grid + buildings + resources + trophies. | `shared/src/types/base.ts` |
| *Building* | A placed, static entity on the *Base* grid. | `shared/src/types/base.ts` |
| *Defender* | Player being raided. OwnerSlot 1 in the sim. | `shared/src/sim/state.ts` |
| *Faction* | Cosmetic identity (`Ants`, `Beetles`, `Wasps`). | `shared/src/types/base.ts` |
| *Layer* | 0 = surface, 1 = underground. Buildings live on a layer; *Unit*s traverse one. | `shared/src/types/base.ts` |
| *Loot* | Resources taken from defender on raid success. | `server/api/src/routes/raid.ts` |
| *Match* | A pending (attacker, defender, seed, baseSnapshot) tuple. | `server/api/src/routes/matchmaking.ts` |
| *PheromonePath* | Ordered waypoints along which deployed units walk. | `shared/src/types/pheromone.ts` |
| *Raid* | One 2700-tick sim against a defender's *Base*. | `server/api/src/routes/raid.ts` |
| *Replay* | `{seed, inputs}` pair that deterministically reproduces a sim. | `shared/src/types/replay.ts` |
| *Seed* | 32-bit integer fed into PCG32 *Rng*. Same seed → same sim. | `shared/src/sim/rng.ts` |
| *Snapshot* | JSONB-serialized *Base* at a point in time. | `server/api/src/db` / `shared/src/types/base.ts` |
| *Star* | 0/1/2/3 raid success rating. Drives *Trophy*, *Loot*. | `shared/src/sim/systems/outcome.ts` |
| *Tick* | One 1/30 s sim step. 2700 ticks = 90 s raid. | `shared/src/sim/step.ts` |
| *Trophy* | ELO-style ladder rank. Drives matchmaking band. | `server/api/src/game/progression.ts` |
| *Unit* | A moving combatant spawned by a *PheromonePath*. | `shared/src/types/units.ts` |

## 2. Tags & code conventions

Short lowercase noun tags that appear as field names, argument names,
log attributes, or `// <tag>:` comments. Use these spellings exactly.

### 2.1 Sim-layer tags

| Tag | Meaning |
|-----|---------|
| `anchor` | Top-left grid cell of a multi-tile building. `{x, y, layer}`. |
| `attackerUnitLevels` | Sim input: attacker's per-UnitKind level (drives stat scaling). |
| `baseSnapshot` | The defender's base fed into the sim (server-owned). |
| `deployCap` | Max units an owner can deploy in a single raid. |
| `footprint` | `{w, h}` grid cells a building occupies. |
| `hpMax` | Full HP after level scaling. Reset cap for `hp`. |
| `inputs` | Ordered *SimInput* events that drive a *Replay*. |
| `ownerSlot` | 0 = attacker, 1 = defender. Never use any other numeric owner identity inside the sim. |
| `spans` | Array of *Layer* values a multi-layer building occupies (e.g. `[0, 1]` for QueenChamber). |
| `tick` | Integer sim-step counter. Monotonic per raid. |
| `tickRate` | Logical tick Hz. Always 30. |

### 2.2 Economy / progression tags

| Tag | Meaning |
|-----|---------|
| `aphidMilk` | Premium *Resource*. Reserved for monetization; always 0 in MVP. |
| `baseCost` | Level-1 cost for an upgrade; multiplied by `LEVEL_COST_MULT[L]`. |
| `baseSugar` / `baseLeafBits` | Per-*UnitKind* level-1 sugar/leafBits cost. |
| `colonyRank` | Aggregate player tier (future). Derived from total invested resources. |
| `costMult` | The `mult[L]` value from the *Golden Fibonacci* cost curve. |
| `expected` | ELO expected-win-rate between attacker and defender trophies. |
| `K` | ELO K-factor (bracketed by trophy count). |
| `leafBits` | Secondary *Resource*. Produced by LarvaNursery; spent on upgrades. |
| `levelPercent` / `statPercent` | Integer stat multiplier for a level (e.g. 117 = 1.17×). |
| `nextCost` | Cost for `currentLevel → currentLevel + 1`. |
| `sugar` | Primary *Resource*. Produced by DewCollector / SugarVault; spent on upgrades. |
| `trophiesSought` | Mid-point trophy value used to find a *Match*. |
| `trophyDelta` | `{ att, def }` trophy change for a given raid result. |

### 2.3 Routing / protocol tags

| Tag | Meaning |
|-----|---------|
| `matchToken` | Opaque base64url blob that maps to a `pending_matches` row. One-shot. |
| `playerId` | Server-issued stable ID for an account. |
| `requirePlayer` | Fastify helper that 401s non-authenticated requests. |
| `serverHash` | The server's computed replay hash. Compared to the client's claim. |

## 3. Units

All stats live in `shared/src/sim/stats.ts::UNIT_STATS`. Balance intent
in [`GAME_DESIGN.md §5.1`](./GAME_DESIGN.md#51-units-12).

| UnitKind | Role | Flags | One-liner |
|----------|------|-------|-----------|
| `WorkerAnt`   | Chaff     |               | Cheap fodder; triggers traps, soaks turret fire. |
| `SoldierAnt`  | Frontline |               | Generalist melee; the "default" raid unit. |
| `DirtDigger`  | Utility   | `canDig`      | Traverses between layers via *TunnelJunction*. |
| `Forager`     | Chaff     | `canFly`      | Fast flying scout; low HP, decent DPS. |
| `Wasp`        | Ranged    | `canFly`      | Aerial ranged; ignores walls. |
| `HoneyTank`   | Frontline |               | High HP tank; slow; absorbs turret fire. |
| `ShieldBeetle`| Frontline |               | Highest HP in the game; escort for squishies. |
| `BombBeetle`  | Burst     |               | Suicide unit; huge damage, 1-tick cooldown. |
| `Roller`      | Burst     |               | Fast flanker; good against exposed turrets. |
| `Jumper`      | Burst     |               | Medium burst; less specialized than Roller. |
| `WebSetter`   | Ranged    |               | Very low DPS but long range; utility slows (future). |
| `Ambusher`    | Utility   |               | High burst damage from short range. |

Flags: `canFly` = ignores ground collision; `canDig` = may use
TunnelJunction to switch *Layer*.

## 4. Buildings

All stats in `shared/src/sim/stats.ts::BUILDING_STATS`. Placement costs
in `server/api/src/game/buildingCosts.ts::BUILDING_PLACEMENT_COSTS`.

| BuildingKind     | Role     | Placeable? | One-liner |
|------------------|----------|------------|-----------|
| `QueenChamber`   | Core     | No         | Heart of the base; 2×2; spans both *Layer*s. Destroying it = instant 3★. |
| `DewCollector`   | Economy  | Yes        | Produces sugar over time. |
| `LarvaNursery`   | Economy  | Yes        | Produces leafBits over time. |
| `SugarVault`     | Economy  | Yes        | Stores and slowly generates sugar. |
| `MushroomTurret` | Defense  | Yes        | Ranged single-target turret. |
| `LeafWall`       | Defense  | Yes        | High HP, no attack; redirects pathing. |
| `PebbleBunker`   | Defense  | Yes        | Highest-HP wall variant. |
| `DungeonTrap`    | Defense  | Yes        | One-shot burst damage when triggered. |
| `TunnelJunction` | Utility  | Yes        | Enables `canDig` units to switch *Layer*. |

## 5. Resources

| Resource    | Symbol | Produced by                        | Sinks                         |
|-------------|--------|------------------------------------|-------------------------------|
| `sugar`     | 🍯     | DewCollector, SugarVault, raid loot | Upgrades, building placement  |
| `leafBits`  | 🍃     | LarvaNursery, raid loot             | Upgrades, building placement  |
| `aphidMilk` | 🥛     | (future premium)                    | (future prestige tier)        |

## 6. Systems (sim subsystems)

| System | File | Runs… |
|--------|------|-------|
| `applyDeploy` | `shared/src/sim/systems/deploy.ts` | On a deployPath *SimInput* — spawns units along the first path segment. |
| `combatSystem` | `shared/src/sim/systems/combat.ts` | Every tick — resolves unit↔building and building↔unit hits. |
| `outcomeSystem` | `shared/src/sim/systems/outcome.ts` | Every tick — checks win conditions, stars, loot accumulation. |
| `pheromoneFollow` | `shared/src/sim/systems/pheromone_follow.ts` | Every tick — advances units along stored paths; hands off targets. |
| `step` | `shared/src/sim/step.ts` | Wraps all of the above in canonical order per tick. |

## 7. API routes

| Route | File | Purpose |
|-------|------|---------|
| `GET /health` | `server/api/src/routes/health.ts` | Liveness probe. |
| `POST /match` | `server/api/src/routes/matchmaking.ts` | Pairs attacker with defender; returns *matchToken* + *baseSnapshot*. |
| `POST /raid/submit` | `server/api/src/routes/raid.ts` | Validates replay; applies *trophyDelta* + *Loot*. |
| `GET /player/me` | `server/api/src/routes/player.ts` | Returns player + base + offline trickle. |
| `PUT /player/base` | `server/api/src/routes/player.ts` | Persists full base snapshot. |
| `POST /player/building` | `server/api/src/routes/player.ts` | Places one building; atomic resource debit. |
| `DELETE /player/building/:id` | `server/api/src/routes/player.ts` | Removes one building. |
| `GET /player/building/catalog` | `server/api/src/routes/player.ts` | Placement cost catalog. |
| `GET /player/upgrades` | `server/api/src/routes/player.ts` | Per-kind level + next-upgrade cost. |
| `POST /player/upgrade-unit` | `server/api/src/routes/player.ts` | Bumps a unit's level; atomic debit. |
| `GET /player/raids` | `server/api/src/routes/player.ts` | Recent raid history. |
| `GET /leaderboard` | `server/api/src/routes/leaderboard.ts` | Top players by trophies. |
| `/admin/*` | `server/api/src/routes/admin.ts` | Gemini sprite pipeline; token-gated. |

## 8. Constants (canonical source files)

These files are the **only** place to define or change these numbers.
If you find a duplicate elsewhere, that's a bug — open a PR to collapse.

| Constant family | File |
|-----------------|------|
| Unit base stats | `shared/src/sim/stats.ts::UNIT_STATS` |
| Building base stats | `shared/src/sim/stats.ts::BUILDING_STATS` |
| Level → stat % table | `shared/src/sim/progression.ts::LEVEL_STAT_PERCENT` |
| Level → cost multiplier | `server/api/src/game/progression.ts::LEVEL_COST_MULT` |
| Max unit level | `server/api/src/game/progression.ts::MAX_UNIT_LEVEL` |
| Trophy ELO K-factor brackets | `server/api/src/game/progression.ts::K_FACTOR_BRACKETS` |
| Per-unit base costs | `server/api/src/game/upgradeCosts.ts::BASE_SUGAR` / `BASE_LEAF` |
| Building placement costs | `server/api/src/game/buildingCosts.ts::BUILDING_PLACEMENT_COSTS` |
| Building defaults (w, h, hp) | `server/api/src/game/buildingCosts.ts::BUILDING_DEFAULTS` |
| MAX_BUILDINGS_PER_BASE | `server/api/src/game/buildingCosts.ts` |
| Offline trickle rates | `server/api/src/routes/player.ts::INCOME_PER_SECOND` |
| Max offline seconds | `server/api/src/routes/player.ts::MAX_OFFLINE_SECONDS` |
| Trophy matchmaking band | `server/api/src/routes/matchmaking.ts::TROPHY_BAND` |
| Match TTL | `server/api/src/routes/matchmaking.ts::MATCH_TTL_MINUTES` |

## 9. Determinism-safe coding rules

Anything inside `shared/src/sim/` MUST follow these. A file under `sim/`
that violates any of these is a determinism bug waiting to happen:

1. **No floats in stored state.** All sim state fields use `Fixed` (Q16.16)
   or `number` integers.
2. **No `Math.sin/cos/tan/sqrt/random`.** Use `shared/src/sim/fixed.ts`
   helpers + the PCG32 `Rng`.
3. **No `Date.now()` / `performance.now()`.** Sim has no wall clock.
4. **No `Map`/`Set` iteration.** Lookups are fine; iteration is banned
   (insertion-order dependence breaks across JS engines).
5. **No `WeakMap`/`WeakRef`.** GC-timing dependent.
6. **Integer percentages for scalars.** Multipliers (e.g.
   `LEVEL_STAT_PERCENT`) are always integer %; division by 100 is the
   last op.
7. **Stable sort / iteration.** When you must iterate units or buildings,
   iterate the backing array in index order — never derive iteration
   from a Map/Set.

## 10. Style conventions

- **Filenames:** `lowerCamelCase.ts` for TS modules, `PascalCase.ts`
  for files whose primary export is a class or component (`HomeScene.ts`).
- **Exports:** named; default exports are banned (they break renames
  in AI-assisted refactors).
- **Comments:** explain WHY (hidden constraint, subtle invariant).
  Don't echo WHAT the code does. Don't embed PR numbers or authors.
- **Owner slot:** always `0 | 1` (never `'attacker' | 'defender'` in
  the sim — tag strings are for display only).

## 11. Document index

- [`GAME_DESIGN.md`](./GAME_DESIGN.md) — design intent and the
  progression curve specification.
- `GLOSSARY.md` — this file.
- `README.md` (repo root) — setup, architecture, operations.

When you add a new concept that will be referenced from code, add an
entry here in the **same PR**. A term that isn't in the glossary doesn't
exist yet.
