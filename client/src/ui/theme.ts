// Centralized visual theme. One source of truth for colors, gradient
// builders, typography + spacing so button, panel, HUD, and modal
// callers stay in sync. Extend this module when a new design token
// is needed — don't inline hex literals in scenes.
//
// Palette direction: "vibrant pastel". Modern mobile-game aesthetic
// inspired by Royal Match / Sky CotL — bright cream scene, pastel
// mint board, white card panels with soft tints, saturated coral/
// sky/lavender accents on buttons, deep navy text for crisp legibility.
// Replaces the earlier "warm cartoon colony" brown/forest direction.

export const COLOR = {
  // Scene chrome — light cream/pastel cards, modern airy aesthetic
  bgDeep: 0xf7f0e3,        // warm cream scene base
  bgPanel: 0xffffff,       // crisp white card
  bgPanelHi: 0xfff4f6,     // soft pink-cream gradient top
  bgPanelLo: 0xede4f7,     // soft lavender gradient bottom
  bgCard: 0xfdf8f0,        // cream card body
  bgInset: 0xece2e7,       // muted dust-pink inset

  // Board — bright pastel mint surface with peachy under-layer
  boardSurface: 0xb6e6c0,
  boardSurfaceLo: 0x8edaa1,
  boardUnder: 0xeacca8,
  boardUnderLo: 0xd1ad88,

  // Text — deep navy/charcoal on light surfaces gives high contrast
  // without the heavy black-stroke "old cartoon" feel of the previous
  // theme. Contrasts vs bgDeep (#f7f0e3): primary 13:1, dim 7.2:1,
  // muted 5.6:1, label 8.4:1 — all pass WCAG AA.
  textPrimary: '#1f2148',
  textDim: '#4a4d72',
  textMuted: '#6e7196',
  textLabel: '#3a3d65',
  textGold: '#e8884d',     // warm coral (legacy "brass-y" highlights)
  textDark: '#0c0e22',
  textError: '#e25a7c',
  // Cool cream legible on the dark-green HUD banners + RaidScene
  // overlays. Several scenes hardcoded `#e6f5d2` for this; promoting
  // it to a token keeps a future palette swap to one line.
  textOnDark: '#e6f5d2',
  // CSS-string form of the warm gold that's been hardcoded as
  // `#ffd98a` across most scene HUD/highlight text. Lifted to a
  // token so a future palette swap is one line; existing literals
  // are migrated incrementally as scenes get touched.
  goldCss: '#ffd98a',
  // Coral CSS string used for opponent-side stars / "danger" highlights.
  redCss: '#ff9a80',
  // Soft warm green used for sub-labels/captions on dim backgrounds —
  // see ClanScene clan description, ClanWarsScene status hints.
  mossLight: '#9cb98a',
  // Deep maroon banner background, used for danger/war banners that
  // need to stand apart from the standard green/cream palette.
  dangerBg: 0x2a1e1e,

  // Accents — saturated pastels
  brass: 0xfdcd6a,         // butter yellow (legacy "brass")
  brassDeep: 0xc99b3a,
  gold: 0xffd97a,
  goldHi: 0xfff2b8,
  goldLo: 0xc8943a,
  red: 0xff7a92,           // pastel coral
  green: 0x6cd47e,         // vibrant mint
  greenHi: 0x9be0a8,
  greenLo: 0x3fa257,
  cyan: 0x9cdaef,          // sky blue

  // Outlines / strokes
  strokeDark: 0x1f2148,    // deep navy
  strokeLight: 0xfff8ec,
  outline: 0x4d9b5c,       // mint stroke

  // Grass field — used as the scene-wide ambient on map-based scenes
  // (Home / Raid / Arena) so the area outside the bordered playfield
  // reads as continuous grass rather than a separate-colored backdrop.
  // grassTop/grassBot drive the gradient; grassFill matches the
  // on-board fill so the playfield blends with the surround.
  grassTop: 0x7fcb7c,
  grassFill: 0x6cbf6a,
  grassBot: 0x549c54,
  grassFillCss: '#6cbf6a', // CSS string form for camera.setBackgroundColor
  // Per-tile grid stroke painted on top of the grass underlay in
  // RaidScene/ArenaScene. Slightly darker than grassBot so it reads
  // as "lines on grass" rather than a separate band.
  gridLine: 0x2d5e2a,
  // Spawn-zone tint in RaidScene — soft mint that overlays without
  // tinting the grass beneath. `spawnZoneCss` is the same value in
  // CSS form for chevron text styles.
  spawnZone: 0xc3e8b0,
  spawnZoneCss: '#c3e8b0',
  // Mossy shadow used as a bottom-of-viewport vignette behind the
  // footer button row so the buttons keep contrast against the grass.
  mossDark: 0x2a4a26,
  // Warm cream highlight used for "pool of light" glows + ambient
  // motes drifting over the grass. Brighter than greenHi so the
  // accent reads as sun, not foliage.
  warmGlow: 0xfff4d6,
} as const;

export const FONT = {
  display: "'Arial Black', 'Trebuchet MS', sans-serif",
  body: "'Trebuchet MS', Verdana, sans-serif",
  accent: "Georgia, 'Times New Roman', serif",
} as const;

// Display text style. Modern mobile-game text — crisp navy with a
// soft cream halo so it stays readable over both light cards and
// pastel game-board surfaces. Stroke is much thinner than the old
// "CoC chunky stroke" look (4px → 2px default) so the type reads
// cleaner / more modern.
export function displayTextStyle(
  size: number,
  color: string = COLOR.textPrimary,
  strokeThickness: number = 2,
): Phaser.Types.GameObjects.Text.TextStyle {
  // Lighter strokes look better on dark text against a light bg
  // (cream halo) and on light text against a dark bg (navy halo).
  const isLightText = color.startsWith('#f') || color.startsWith('#ff') ||
                       color === COLOR.textGold;
  return {
    fontFamily: FONT.display,
    fontSize: `${size}px`,
    color,
    stroke: isLightText ? '#1f2148' : '#fff8ec',
    strokeThickness,
    fontStyle: 'bold',
    shadow: {
      offsetX: 0,
      offsetY: 2,
      color: 'rgba(31,33,72,0.18)',
      blur: 4,
      stroke: false,
      fill: true,
    },
  };
}

// Body text style — unstyled compared to display (no heavy stroke).
// Used for secondary info, tooltips, modal body copy.
export function bodyTextStyle(
  size: number = 13,
  color: string = COLOR.textPrimary,
): Phaser.Types.GameObjects.Text.TextStyle {
  return {
    fontFamily: FONT.body,
    fontSize: `${size}px`,
    color,
  };
}

export function labelTextStyle(
  size: number = 11,
  color: string = COLOR.textMuted,
): Phaser.Types.GameObjects.Text.TextStyle {
  return {
    fontFamily: FONT.body,
    fontSize: `${size}px`,
    color,
    fontStyle: 'bold',
  };
}

// Button palette by variant. Each variant has the full state set so
// the button factory doesn't have to branch.
export interface ButtonPalette {
  fillTop: number;
  fillBot: number;
  fillTopHover: number;
  fillBotHover: number;
  fillTopPress: number;
  fillBotPress: number;
  stroke: number;
  strokeWidth: number;
  textColor: string;
  textStroke: string;
  textStrokeThickness: number;
}

export const BUTTON_VARIANT: Record<string, ButtonPalette> = {
  // Primary CTA — vibrant pastel coral/pink. "Raid a base →".
  primary: {
    fillTop: 0xff90a8,
    fillBot: 0xee5e7c,
    fillTopHover: 0xffb0c2,
    fillBotHover: 0xff7a96,
    fillTopPress: 0xc73f5e,
    fillBotPress: 0xee5e7c,
    stroke: 0xb13455,
    strokeWidth: 2,
    textColor: '#fff8ec',
    textStroke: '#9a2a4a',
    textStrokeThickness: 1,
  },
  // Secondary nav — soft sky blue. Everyday buttons.
  secondary: {
    fillTop: 0xa6dcf2,
    fillBot: 0x6cb0e0,
    fillTopHover: 0xc4e8f8,
    fillBotHover: 0x8fc7ec,
    fillTopPress: 0x4a91c0,
    fillBotPress: 0x6cb0e0,
    stroke: 0x3878a8,
    strokeWidth: 2,
    textColor: '#0e1f3a',
    textStroke: '#e8f4fc',
    textStrokeThickness: 1,
  },
  // Neutral — soft cream chrome, for utility actions (close, back, cancel).
  ghost: {
    fillTop: 0xfff8ec,
    fillBot: 0xeadfcd,
    fillTopHover: 0xfffaf2,
    fillBotHover: 0xf0e6d4,
    fillTopPress: 0xd3c5ad,
    fillBotPress: 0xeadfcd,
    stroke: 0xb8a285,
    strokeWidth: 2,
    textColor: '#1f2148',
    textStroke: '#fff8ec',
    textStrokeThickness: 1,
  },
  // Danger — deeper coral for destructive ops (leave clan, demolish).
  danger: {
    fillTop: 0xff6585,
    fillBot: 0xd03e5e,
    fillTopHover: 0xff85a0,
    fillBotHover: 0xe25478,
    fillTopPress: 0xa92a48,
    fillBotPress: 0xd03e5e,
    stroke: 0x80213a,
    strokeWidth: 2,
    textColor: '#fff8ec',
    textStroke: '#80213a',
    textStrokeThickness: 1,
  },
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANT;

// Corner radii / spacing constants — keeps layout proportions
// consistent between scenes.
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 20,
  xl: 32,
  // Hub-level radii.
  radiusSm: 6,
  radiusMd: 10,
  radiusLg: 16,
} as const;

// Centralized z-index / depth registry. Every scene that stacks UI
// above the board should pick a slot from here rather than picking
// its own magic number — that way cross-scene overlays (result card,
// burger drawer, click-debug, confirm) stay consistently ordered.
// Higher number = renders on top.
export const DEPTHS = {
  background: -100,
  ambient: -99,
  ambientParticles: -98,
  boardUnder: -5,
  board: 0,
  trail: 5,
  boardOverlay: 15,
  hudChrome: 1,
  hud: 8,
  deckTray: 30,
  raidHudLabel: 40,
  raidHudValue: 50,
  resultBackdrop: 100,
  resultCard: 101,
  resultContent: 102,
  drawerBackdrop: 200,
  drawer: 220,
  // Build-menu picker stack. Spans 200..206 so callers don't need
  // magic numbers when wiring up the modal. The slot hit zone must
  // sit ABOVE pickerStripScroll so taps reach commitPlacement and
  // not the strip's drag handler — that depth gap was the bug
  // behind PR #143.
  pickerBackdrop: 200,
  pickerBackdropHit: 200.5,
  pickerCard: 201,
  pickerCardHit: 201.5,
  pickerContainer: 202,
  pickerStripScroll: 203,
  pickerStripContent: 204,
  pickerSlotHit: 205,
  pickerSlotControl: 206,
  // Generic full-screen modal (e.g. DefenderAIScene rule editor). Sits
  // above the drawer + picker stack but below toasts so a transient
  // "saved" notification still renders on top.
  modal: 400,
  toast: 500,
  clickDebug: 9999,
} as const;

// Responsive breakpoints. Keep in sync with the three-tier HUD layout
// and the mobile burger drawer trigger. Shared here so every scene
// tests against the same thresholds rather than scattering 500/700/760
// literals through the code.
//
//   phone  : tiny portrait phones (iPhone SE / 320–499 px)
//   tablet : big phones / small tablets / narrow laptop windows
//   desktop: full-width footer fits in one row
export const BREAKPOINTS = {
  phone: 500,
  tablet: 700,
  desktop: 760,
} as const;
