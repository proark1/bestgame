# Hive Wars — Design System

## Brand Philosophy

**Hive Wars** is a modern, polished strategy game about insect colonies. The visual direction combines:

- **Modern aesthetic** — clean, bright, contemporary look with premium feel
- **Shiny/polished materials** — mimics iridescent insect carapaces, glass, chrome, and gloss
- **Organic earth theme** — insects, plants, soil, and natural growth, but refined and elegant
- **Vibrant but balanced** — saturated accent colors against soft, breathable neutrals

The UI avoids the dated "carved wood + brass trim" Clash of Clans pastiche. Instead we aim for a sleek, contemporary game that feels modern like *Brawl Stars* or *Supercell's* newer titles.

---

## Color Palette

### Primary Colors

| Token | Hex | RGB | Use | Notes |
|---|---|---|---|---|
| `brand-earth` | `#3d5a2a` | 61, 90, 42 | Primary brand color; earth/soil reference | Deep forest green, warm and organic |
| `brand-gold` | `#d4af37` | 212, 175, 55 | Premium accents; metal trim | Polished gold, high contrast |
| `brand-accent-coral` | `#ff6b9d` | 255, 107, 157 | Call-to-action buttons; warm energy | Vibrant, youthful, friendly |
| `brand-accent-sky` | `#5bc0de` | 91, 192, 222 | Secondary actions; air/flying theme | Clear sky blue, trust + calm |

### Neutral/Background Colors

| Token | Hex | RGB | Use | Notes |
|---|---|---|---|---|
| `surface-bright` | `#f5f5f0` | 245, 245, 240 | Panel backgrounds; main UI surfaces | Off-white with warm undertone |
| `surface-light` | `#e8e8e0` | 232, 232, 224 | Card elevation; subtle separation | Slightly darker for depth |
| `surface-medium` | `#d0d0c8` | 208, 208, 200 | Disabled states; tertiary elements | Lower contrast, resting state |
| `surface-dark` | `#2a2a24` | 42, 42, 36 | Text on light; dark mode base | Almost-black with warmth |

### Text Colors

| Token | Hex | Use |
|---|---|---|
| `text-primary` | `#1a1a14` | Body text, labels, high-contrast needs |
| `text-secondary` | `#4a4a42` | Dimmed text, descriptions, metadata |
| `text-disabled` | `#9a9a92` | Disabled states, hints |
| `text-light` | `#f5f5f0` | Text on dark backgrounds |

### Accent/Status Colors

| Token | Hex | Use |
|---|---|---|
| `accent-success` | `#4caf50` | Positive feedback, "go" state |
| `accent-warning` | `#ff9800` | Caution, pending state |
| `accent-error` | `#f44336` | Destructive actions, errors |
| `accent-info` | `#2196f3` | Information, help text |

---

## Design Direction

### Materials & Textures

**Buttons & Interactive Elements:**
- Polished, glossy surfaces with soft lighting
- Subtle reflective highlights at the top edge (like a light source from above)
- No heavy carved wood; instead: clean, modern bevels
- Iridescent or metallic finishes that suggest premium quality
- Smooth rounded corners (6–12px depending on size)

**Panels & Cards:**
- Clean glass-like appearance with soft drop shadows
- Subtle gradient (darker at bottom for depth)
- Layered feel via shadows, not via thick borders
- No ornate scrollwork; instead: minimal, functional design

**HUD & Overlays:**
- Semi-transparent with soft frosted glass effect
- Minimal visual noise — clean, scannable layouts
- Accent colors used sparingly to draw attention

**Icons & Frames:**
- Iridescent/holographic borders instead of brass
- Gem-like quality (faceted, shiny)
- Integrated with the card surface, not raised or ornate

### Color Usage

1. **`brand-earth`** — Primary UI chrome, borders, and accents. The anchor color.
2. **`brand-gold`** — Highlights, premium badges, rare/legendary states.
3. **`brand-accent-coral`** — Primary CTAs ("Raid Base", "Upgrade", "Attack").
4. **`brand-accent-sky`** — Secondary actions ("Info", "Settings", "Back").
5. **Neutral surfaces** — Panels, cards, modals. Let content breathe.
6. **Text on light** → `text-primary` (dark navy).
7. **Text on dark** → `text-light` (off-white).

### Typography

- **Display (headers, titles):** Bold, modern sans-serif. No serifs.
- **Body (descriptive text, UI labels):** Clean, readable sans-serif. Generous line-height for clarity.
- **Monospace (debug, code):** Only for technical/developer output.

### Spacing & Elevation

- **Minimal padding/margins** — clean and modern, not spacious.
- **Soft shadows** — depth without drama. Use subtle layering via shadows, not thick borders.
- **Rounded corners** — 6px for small elements, 10–12px for panels, 16px for large modals.

---

## Component Guidelines

### Buttons

**Primary Button** (e.g., "Raid a Base", "Upgrade Building")
- Background: `brand-accent-coral` (#ff6b9d)
- Text: `text-light` (white/off-white)
- Hover: Slightly lighter coral, subtle scale up
- Active/Press: Slightly darker coral, inset shadow for depth
- Style: Smooth, modern, polished appearance

**Secondary Button** (e.g., "Info", "Settings", "Cancel")
- Background: `brand-accent-sky` (#5bc0de)
- Text: `text-primary` (dark)
- Hover: Slightly lighter sky blue
- Active/Press: Slightly darker
- Style: Matches primary in polish but different color

**Ghost Button** (e.g., "Close", "Dismiss", "Back")
- Background: `surface-light` or transparent
- Text: `text-primary`
- Border: 1–2px `brand-earth`
- Hover: Slight background fill
- Active: Subtle inset
- Style: Minimal, clean

**Danger Button** (e.g., "Demolish", "Leave Clan")
- Background: `accent-error` (#f44336)
- Text: `text-light`
- Hover: Lighter red
- Active: Darker red + inset shadow
- Style: Same polish as primary, but clear warning intent

### Panels & Cards

- **Background:** `surface-bright` or `surface-light`
- **Border:** None, or 1px `brand-earth` @ low alpha (0.2)
- **Shadow:** Soft drop shadow below (offset 2–4px, blur 8–12px, dark @ 0.1–0.2 alpha)
- **Gradient (optional):** Subtle top-to-bottom (surface-light → surface-medium) for depth
- **Corner radius:** 10–12px

### HUD & Top Bars

- **Background:** `brand-earth` (#3d5a2a) with slight gradient to darker
- **Text:** `text-light` on dark background
- **Accent highlights:** `brand-gold` for resources or important counts
- **Transparency (optional):** Slight frosted glass effect (80–90% opaque) if over game board

### Icon Frames

- **Background:** Subtle gradient (surface-bright → surface-medium)
- **Border:** 2–3px iridescent or `brand-gold`, no ornate scrollwork
- **Shadow:** Soft drop shadow
- **Corner radius:** 50% for circular; 8px for square/rounded-square
- **Inner glow (optional):** Soft, subtle, only for rare/special units

### Badges & Status

- **Victory Badge:** Golden, shiny, celebratory. Use `brand-gold` as primary color with soft glow.
- **Defeat Badge:** Muted earth tones with a somber, clean design. No ornate stones; instead: modern, minimalist.
- **Level/Tier Badges:** Use gradients of `brand-earth` and `brand-gold` for a polished gem-like appearance.

---

## Typography Scale

| Use | Size | Weight | Line Height |
|---|---|---|---|
| Display (page titles) | 32–36px | Bold | 1.2 |
| Heading (section titles) | 20–24px | Bold | 1.3 |
| Subheading (labels) | 14–16px | Bold | 1.4 |
| Body (descriptions) | 13–14px | Regular | 1.5 |
| Caption (hints, meta) | 11–12px | Regular | 1.4 |
| Monospace (debug) | 12px | Regular | 1.5 |

---

## Dos & Don'ts

### DO

✅ Use `brand-earth` and `brand-gold` as primary accents
✅ Keep UI surfaces clean and minimal
✅ Use soft shadows for depth (not thick borders)
✅ Apply iridescent/glass effects to frames and interactive elements
✅ Reference this design MD when creating new UI prompts
✅ Maintain high contrast for accessibility (WCAG AA minimum)
✅ Use rounded corners (6–12px) throughout

### DON'T

❌ Add ornate scrollwork, carved wood, or dated decorative elements
❌ Use dark wood, heavy brass trim, or CoC-style ornamentation
❌ Create hard-edged geometric UI — aim for soft, modern curves
❌ Overuse accent colors; let neutrals breathe
❌ Add visual noise (too many gradients, textures, shadows)
❌ Use serif fonts for UI (except body copy in rare cases)
❌ Create elements without a clear purpose

---

## When Adding New UI

1. **Check this document first.** Does the new element fit the palette and direction?
2. **Use established components.** Button, panel, card, badge — pick the closest match.
3. **Respect the palette.** Limit colors to the defined set.
4. **Update the prompt.** If a sprite is needed, write the prompt referencing this design system.
5. **Test on device.** Especially on mobile — shadows and colors behave differently at small scales.
6. **A/B test if unsure.** Modern, shiny, and clean-lined is the goal.

---

## Resources

- **Main theme colors:** See `client/src/ui/theme.ts` (COLOR object)
- **Component implementations:** See `client/src/ui/button.ts`, `client/src/ui/panel.ts`
- **Sprite prompts:** See `tools/gemini-art/prompts.json` (menuUi bucket)

---

**Last updated:** April 2026
**Status:** Foundation; update as new components ship
