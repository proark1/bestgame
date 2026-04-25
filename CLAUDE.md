# Claude Code — Project Guide

## Quick Start

**Branch:** `main` (production)
**Dev branches:** Feature branches off `main` (prefixed `claude/`)
**Tech stack:** Phaser 3 (game), Fastify (API), TypeScript, Vitest

---

## Critical Documents

### **DESIGN.md** — UI/Brand Design System

**This is the source of truth for all menu UI work.**

When creating or updating:
- Buttons, panels, modals, HUD elements
- Icon frames, badges, UI sprites
- Any `menuUi` prompts in `tools/gemini-art/prompts.json`

**Always check DESIGN.md first** to ensure:
- Colors match the palette (brand-earth, brand-gold, coral, sky)
- Materials are modern/shiny (glass, iridescent, polished — not carved wood)
- Prompt wording reflects the new direction

**Character sprites** (units, queen skins) can stay hand-crafted; the design system focuses on menu UI consistency.

---

## Codebase Structure

### Scenes (Game Logic)

| Scene | Purpose | Key Files |
|---|---|---|
| `BootScene` | Asset loading, placeholder generation | `client/src/scenes/BootScene.ts` |
| `HomeScene` | Home base building & management | `client/src/scenes/HomeScene.ts` |
| `RaidScene` | Attacking another player's base | `client/src/scenes/RaidScene.ts` |
| `ArenaScene` | AI battle simulator | `client/src/scenes/ArenaScene.ts` |
| `LandingScene` | Marketing landing page | `client/src/scenes/LandingScene.ts` |

### UI & Theming

| Module | Responsibility |
|---|---|
| `client/src/ui/theme.ts` | Color palette, typography, spacing tokens |
| `client/src/ui/button.ts` | Button factory + states (primary, secondary, ghost, danger) |
| `client/src/ui/panel.ts` | Panel drawing (cards, shadows, bevels) |
| `client/src/ui/buildingInfoModal.ts` | Building upgrade/info modal |
| `client/src/assets/atlas.ts` | Sprite key registry |
| `client/src/assets/placeholders.ts` | Procedural fallback graphics |

### Asset Generation

| Tool | Input | Output |
|---|---|---|
| `tools/gemini-art/` | `prompts.json` | Sprite PNGs via Gemini |
| `admin/` (UI) | Upload/edit prompts | API stores in DB; hydrates disk |
| `BootScene` | `atlas.ts` keys | Load from disk or draw placeholders |

### Server & API

| Endpoint | Purpose |
|---|---|
| `/api/player/...` | User base, buildings, upgrades |
| `/api/match/...` | Raid matchmaking, results |
| `/admin/api/...` | Sprite upload, prompt editing |

---

## Key Patterns

### Rotation & Wall Orientation

**Walls (LeafWall, ThornHedge) have separate H/V sprites.**

- `building-LeafWall` + `building-LeafWallV` (horizontal & vertical)
- `building-ThornHedge` + `building-ThornHedgeV`
- Renderer in `HomeScene.ts` uses `buildingTextureKey(kind, rotation)` to swap based on rotation parity
- Don't rotate a single sprite; use the texture swap instead

See `client/src/scenes/HomeScene.ts:39–48` for the helper function and constant.

### Color Tokens

Always use `COLOR` from `theme.ts`; never hardcode hex values in scenes.

```typescript
import { COLOR } from '../ui/theme.js';
// Use COLOR.bgPanel, COLOR.textPrimary, etc.
// NOT 0xffffff or '#fff'
```

### Text Rendering

Use the style helper functions from `theme.ts`:

```typescript
displayTextStyle(size, color?, strokeThickness?)  // for titles
bodyTextStyle(size?, color?)                        // for body text
labelTextStyle(size?, color?)                       // for small labels
```

### Building Sprites

Registered in `client/src/assets/atlas.ts`. Fallback placeholders drawn in `placeholders.ts`.

When adding a new building type:
1. Add the kind to the enum in `shared/src/types/base.ts`
2. Register sprite key in `atlas.ts` BUILDING_SPRITE_KEYS
3. Add a prompt in `tools/gemini-art/prompts.json` (buildings bucket)
4. Add a placeholder in `placeholders.ts`

---

## Testing & QA

### Local Dev

```bash
npm run dev:client    # Game client (port 3000)
npm run dev:api       # API server (port 5000)
npm run dev:arena     # Arena service (port 5001)
```

### Running Tests

```bash
npm test              # All tests
npm run typecheck     # Type checking
npm run unit-tests    # Just unit tests
```

### Build & Production

```bash
npm run build         # Build all workspaces
npm start             # Run production stack
```

---

## Common Tasks

### Adding a New Building

1. Add to `BuildingKind` union in `shared/src/types/base.ts`
2. Register sprite key + placeholder graphic
3. Add codex entry in `client/src/codex/codexData.ts`
4. Write prompt in `tools/gemini-art/prompts.json` (buildings bucket)
5. Regenerate sprites in admin UI

### Adding a New Unit

Same steps as buildings, but use the `units` bucket in prompts.json.

**Unit prompts should include:**
- Clear role description (e.g., "FLYING SNIPER", "MELEE TANK")
- Visible weapon/tool specific to that role
- Faction colors and visual identity

See `tools/gemini-art/prompts.json` (units bucket) for examples.

### Updating UI Prompts

1. **Reference DESIGN.md** — check the brand palette and direction
2. **Edit the prompt** in `tools/gemini-art/prompts.json` (menuUi bucket)
3. **Regenerate sprites** via the admin UI or run the Gemini tool
4. **Test** in the game to ensure the new look fits the overall aesthetic

### Changing Colors Globally

**All color changes should:**

1. Update `COLOR` object in `client/src/ui/theme.ts`
2. Update any hardcoded theme colors in other files (search for hex values)
3. Update theme colors in `client/index.html` CSS variables
4. Update DESIGN.md to reflect the new palette
5. Consider updating UI prompts if the aesthetic direction changed

---

## Performance Notes

### Memory

- Destroy unused sprites and graphics objects (Phaser best practice)
- Use `.clear()` on Graphics objects instead of destroying + recreating
- Keep scene loading fast — preload assets in BootScene

### Bundle Size

- Keep game client + landing page separate bundles
- Lazy-load admin UI
- Monitor with `npm run bundle:report`

### Rendering

- Graphics objects (drawPanel, drawPill) are fast but use sparingly
- Tween animations should use reasonable durations (not constantly animating)
- Keep text rendering performant; batch updates when possible

---

## Git Workflow

1. Create a feature branch: `git checkout -b claude/<feature-name>`
2. Make changes, commit locally
3. Push to remote: `git push -u origin claude/<feature-name>`
4. Create a draft PR on GitHub
5. Wait for CI (typecheck, unit-tests, bundle-size, determinism, determinism-browser)
6. When all checks pass, remove draft status and merge to main

**No force-pushing to main.** Destructive operations need explicit permission.

---

## Contacts & References

- **Design System:** See `DESIGN.md` (this directory)
- **Type Definitions:** `shared/src/types/base.ts`, `units.ts`, `pheromone.ts`
- **Game Simulation:** `shared/src/sim/` (deterministic ruleset)
- **Admin Panel:** `client/src/admin/` (sprite generation, settings)

---

**Last updated:** April 2026
