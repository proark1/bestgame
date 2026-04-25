# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Quick Commands

```bash
# Install & verify determinism
corepack enable
pnpm install
pnpm test  # Run determinism gate (should pass in <1s)

# Development servers (run in separate terminals)
pnpm dev:client   # Vite @ http://localhost:5173
pnpm dev:api      # Fastify @ http://localhost:8787
pnpm dev:arena    # Colyseus @ ws://localhost:2567

# Testing & quality
pnpm typecheck    # TypeScript check all workspaces
pnpm test         # Determinism test suite
pnpm --filter @hive/shared test:determinism  # Just shared sim tests
pnpm lint         # Linter (if configured)

# Build & analysis
pnpm build                                # Build all workspaces
pnpm --filter @hive/client bundle:report  # Analyze bundle size
```

### Database Setup

**Required for persistence** (raids, base saves, matchmaking):

```bash
# Option 1: Docker Compose (local dev)
docker-compose up postgres
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/hive
pnpm dev:api

# Option 2: Railway (production)
# Add Postgres plugin, set DATABASE_URL environment variable, redeploy
```

Without a database, API boots but persistence routes return 503 "database not configured".

---

## Codebase Architecture

### High-Level Overview

**Hive Wars** is a Clash-of-Clans-style strategy game with two novel mechanics:

1. **Dual-Layer Bases** — Every base has a surface grid (turrets, walls, resources) and an underground tunnel grid (spawners, traps, storage). Attackers choose which layer to invade; some units can dig between layers mid-raid.

2. **Pheromone Paths** — Instead of point-and-forget troop deployment, players draw the route their swarm will follow. The sim routes units along the drawn path.

### Workspace Structure

```
shared/              Deterministic game simulation (Q16.16 fixed-point math)
  src/sim/           Turn-by-turn engine: combat, path-finding, AI rules
  src/types/         Type definitions (Base, Building, Unit, SimState)
  tests/             Determinism test suite + hash validation

client/              Phaser 3 game client (Vite)
  src/scenes/        BootScene, HomeScene, RaidScene, ArenaScene, LandingScene
  src/ui/            Buttons, panels, modals, text styles, theming
  src/codex/         Building/unit stats and descriptions
  src/assets/        Sprite atlas registry, procedural placeholders
  src/admin/         Sprite generation UI, settings
  tests/             Unit tests (vitest)

server/api/          Fastify REST API
  src/routes/        /health, /player/*, /match, /raid/submit, /admin/*
  src/db/            Postgres migrations, schema, sprite persistence
  tests/             Route + simulation tests

server/arena/        Colyseus multiplayer arena
  src/rooms/         PicnicRoom (input-delay-lockstep netcode)

tools/gemini-art/    Sprite generation via Gemini API
  prompts.json       Stable Diffusion-style prompts for all sprites
  admin/main.ts      Upload/edit UI
```

### Key Design Patterns

#### 1. **Determinism & Sim Split**

- **Shared sim** (`shared/src/sim/`) is 100% deterministic — fixed-point math, seeded RNG, no floating-point.
- **Client** renders the sim's output; never modifies sim state directly.
- **Server** re-runs the sim to validate raid submissions (replay + hash check).
- **Tests** run both Node and jsdom with identical results (CI gate).

When modifying sim logic, all changes must maintain determinism (no Date, Math.random, async, etc.).

#### 2. **Phaser Scene Composition**

Each scene manages its own lifecycle (create → update → render):

| Scene | Role | Key Features |
|---|---|---|
| **BootScene** | Asset loading, placeholder generation | Loads sprites from disk or draws fallbacks |
| **HomeScene** | Home base editing | Building placement/rotation, move mode, layer switching |
| **RaidScene** | Attack another base | Deck UI, pheromone path drawing, unit deployment |
| **ArenaScene** | AI battle sim (spectate) | Synchronized netcode, deterministic replay, deckless |
| **LandingScene** | Marketing page | Landing page UI (outside Phaser game loop) |

#### 3. **Dual-Layer Board**

Every base has two grids (surface + underground). Buildings can span both or be layer-specific:

- **Surface** (layer 0): Visible, contains turrets, walls, traps
- **Underground** (layer 1): Tunnels, storage, spawners; accessed via TunnelJunction

When raiding, players pick a layer → units spawn on that layer → can dig to switch layers mid-raid (if unit has that ability).

Code reference: `Types.Layer = 0 | 1` in `shared/src/types/base.ts`.

#### 4. **Building Rotation & Wall Variants**

Walls (LeafWall, ThornHedge) have separate H/V sprite variants, not rotated sprites:

- `KINDS_WITH_V_VARIANTS` constant in HomeScene (line ~35) lists which kinds have V variants
- Even rotation values (0, 2) → horizontal sprite; odd (1, 3) → vertical sprite
- `buildingTextureKey(kind, rotation)` returns the correct texture key

This ensures wall weave bands stay perpendicular to the long axis (no sideways-text effect).

#### 5. **Color Tokens & Theming**

**Never hardcode colors.** Always use `COLOR` from `client/src/ui/theme.ts`:

```typescript
import { COLOR } from '../ui/theme.js';
// Use: COLOR.bgPanel, COLOR.textPrimary, etc.
// NOT: 0xffffff or '#fff'
```

All UI prompts in `tools/gemini-art/prompts.json` reference the **DESIGN.md** color palette to maintain consistency.

#### 6. **Sprite Generation Pipeline**

1. **Prompts** — Write/edit prompts in `tools/gemini-art/prompts.json` (units, buildings, UI)
2. **Register sprite key** — Add to `client/src/assets/atlas.ts` BUILDING_SPRITE_KEYS or UNIT_SPRITE_KEYS
3. **Fallback graphic** — Draw placeholder in `client/src/assets/placeholders.ts` (shown before real art lands)
4. **Regenerate** — Via admin UI (sprite upload) or Gemini tool
5. **BootScene loads** — Tries disk/DB sprites first, falls back to placeholders

#### 7. **Input & Pointer Events**

**RaidScene** has strict input validation:

- **Spawn zone** — Only left edge (2 tiles) allows unit deployment start
- **Pointerdown** → validate, highlight spawn zone
- **Pointermove** → draw pheromone trail (distance threshold: 14px, max 32 points)
- **Pointerup** → commit path, decrement unit count, auto-select next unit

**ArenaScene** has no spawn zone (always allows deployment).

#### 8. **Unit Count & Deck System**

**RaidScene** has a full deck UI at the bottom:

- Each card shows: unit type, remaining count (×10), role label
- Depleted cards dim to 55% alpha + turn red
- Selecting a card makes it "active" — next drag deploys that unit type
- Count decrements by burst size (1–5 units)

**ArenaScene** currently has NO deck system (hardcoded SoldierAnt ×5).

#### 9. **Pheromone Path Routing**

When a player draws a path (RaidScene):

1. Path is an array of tile coords (sampled from screen-space drag)
2. `SimInput` sent to server: `{ type: 'deployPath', unitKind, path, burstSize }`
3. Sim spawns units at the first path tile
4. Pathfinding logic routes each unit along the drawn path (see `shared/src/sim/systems/pathfinding.ts`)
5. If a unit reaches the end of the path, it switches to attacking/exploring

---

## Critical Documents

### DESIGN.md
**Source of truth for all UI/brand decisions.** When creating or updating menu UI (buttons, panels, HUD, icons), check DESIGN.md first for:
- Color palette (brand-earth, gold, coral, sky, neutrals)
- Material direction (modern, shiny, polished — NOT dark wood)
- Component guidelines
- Typography scale

**Always reference DESIGN.md when:**
- Writing new UI sprite prompts in `tools/gemini-art/prompts.json`
- Changing colors in `client/src/ui/theme.ts`
- Creating new buttons, modals, or HUD elements

---

## Common Tasks

### Adding a New Building Type

1. Add kind to `BuildingKind` union in `shared/src/types/base.ts`
2. Register sprite key in `client/src/assets/atlas.ts` BUILDING_SPRITE_KEYS
3. Add placeholder graphic in `client/src/assets/placeholders.ts`
4. Add prompt in `tools/gemini-art/prompts.json` (buildings bucket)
5. Add codex entry in `client/src/codex/codexData.ts` (stats, name, role, story)
6. Update DESIGN.md if UI changes

### Adding a New Unit Type

Same steps as buildings, but use `units` bucket in prompts.json.

**Unit prompts must include:**
- Clear role description (e.g., "FLYING SNIPER", "MELEE TANK")
- Visible weapon/tool specific to that role
- Faction colors and visual identity

### Updating a Scene

1. Identify which scene (Boot, Home, Raid, Arena, Landing)
2. Check `src/scenes/<SceneName>.ts` for lifecycle hooks (create, update, shutdown)
3. Use `DEPTHS` from theme.ts for z-index (never magic numbers)
4. Use `COLOR` from theme.ts for colors (never hardcoded hex)
5. Test on device — especially mobile for input events

### Testing Determinism

The shared sim must remain 100% deterministic:

```bash
pnpm --filter @hive/shared test  # Runs determinism gate
```

If you modify `shared/src/sim/*`, the test suite will re-run both Node and jsdom and compare hashes. If they diverge, the gate fails.

**Never introduce in sim code:**
- `Date.now()`, `Math.random()` — use `this.rng.next()` instead
- Floating-point math — use Q16.16 fixed-point
- Async/await, setTimeout, Promise — must be synchronous
- Object key iteration order — use sorted array iteration
- JSON.stringify order — JSON field order must be deterministic

---

## Debugging & Development Tips

### Local Database Issues

If you see "database not configured" in the UI:

1. Verify DATABASE_URL is set: `echo $DATABASE_URL`
2. Test connection: `psql $DATABASE_URL -c "SELECT 1"`
3. Check API logs: `pnpm dev:api` should show `[db] migrations up to date`
4. Hit `GET http://localhost:8787/health/db` from a browser for detailed status

### Determinism Failures

If `pnpm test` fails on determinism:

1. Run with more detail: `pnpm --filter @hive/shared test:determinism`
2. Check if you modified `shared/src/sim/*` — that's the culprit
3. Common causes:
   - Using `Math.random()` instead of `this.rng.next()`
   - Floating-point math (use Q16.16 fixed-point: `new Fixed(x)`)
   - Object field iteration order (iterate arrays, not keys)
4. Use Node REPL to test: `node` → `require('@hive/shared')` → test locally

### Pheromone Path Debugging

To visualize drawn paths in RaidScene:

1. Check `drawDeck()` (line ~900) — draws deck cards
2. Check `handlePointerMove()` (line ~694) — accumulates path points
3. Path array stored in `currentPath` (line ~649)
4. When deployed, path is sent as `SimInput` — check server logs for receipt

### Bundle Size Check

After making changes to client:

```bash
pnpm --filter @hive/client build
pnpm --filter @hive/client bundle:report  # Opens interactive UI
```

Target: Keep client bundle < 500KB (current: ~350KB). Report shows per-module breakdown.

---

## Git Workflow

1. Create feature branch: `git checkout -b claude/<feature-name>`
2. Commit with clear message (include design rationale for non-obvious changes)
3. Push: `git push -u origin claude/<feature-name>`
4. Create draft PR on GitHub
5. Wait for CI:
   - `determinism` (Node + jsdom)
   - `typecheck` (TypeScript)
   - `unit-tests` (vitest)
   - `bundle-size` (size budget check)
6. When all checks pass, remove draft status and merge

**Never force-push to main.** Destructive operations need explicit permission.

---

## Architecture Notes for Future Work

### RaidScene Improvements (Top/Bottom Swipe Entry)

Current state: Units spawn on left edge only; deck at bottom. Future: Allow top/bottom entry with smooth animation.

**Known limitations:**
- Spawn zone hardcoded to left edge (2 tiles) — needs expansion for top/bottom
- No unit entry animation (instant appearance) — should slide from edge
- Unit count only on deck cards — should be prominent on board
- ArenaScene has no deck system (hardcoded SoldierAnt ×5)

**For next implementer:** Refactor spawn zone validation + add top/bottom entry points. Extract deck UI to reusable component for ArenaScene.

### AI Rules & Defender Spawning

Buildings can have attached AI rules (see `shared/src/types/base.ts::BuildingAIRule`). These are evaluated each tick by `shared/src/sim/systems/ai_rules.ts`.

Defender spawning (SpiderNest, LarvaNursery) uses these rules. If modifying spawner logic, ensure rules remain deterministic.

---

## Resources

- **Game design docs:** See `README.md` for high-level vision
- **Type definitions:** `shared/src/types/` — Base, Building, Unit, SimState, etc.
- **Sim engine:** `shared/src/sim/` — Combat, pathfinding, AI rules
- **UI theming:** `client/src/ui/theme.ts` — Colors, fonts, spacing, depths
- **Sprite manifests:** `client/src/assets/atlas.ts` — All sprite keys
- **Design system:** `DESIGN.md` — Brand colors, UI guidelines, component specs

---

**Last updated:** April 2026
**Status:** Foundation; update as new scenes/features ship
