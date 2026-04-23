// Centralized visual theme. One source of truth for colors, gradient
// builders, typography + spacing so button, panel, HUD, and modal
// callers stay in sync. Extend this module when a new design token
// is needed — don't inline hex literals in scenes.
//
// Palette direction: "warm cartoon colony". Earth greens for the
// play field, brass/gold for primary accents (resource counts,
// legendary buttons), deep brown shadows, off-white text on dark
// surfaces.

export const COLOR = {
  // Dark chrome (HUD panels, modal backgrounds, button presses)
  bgDeep: 0x08100d,
  bgPanel: 0x16261b,
  bgPanelHi: 0x2a3f2d,
  bgPanelLo: 0x09100a,
  bgCard: 0x203224,
  bgInset: 0x101910,

  // Board
  boardSurface: 0x305829,
  boardSurfaceLo: 0x1d3b1a,
  boardUnder: 0x3a271b,
  boardUnderLo: 0x21140d,

  // Text
  textPrimary: '#f7edd0',
  textDim: '#bad3a3',
  textMuted: '#86a676',
  textGold: '#ffd98a',
  textDark: '#0f1b10',
  textError: '#ffb0a0',

  // Accents
  brass: 0xffd98a,
  brassDeep: 0x5c4020,
  gold: 0xffc44d,
  goldHi: 0xfff2a8,
  goldLo: 0xb97e1c,
  red: 0xd94c4c,
  green: 0x5ba445,
  greenHi: 0x83c76b,
  greenLo: 0x2c4724,
  cyan: 0x8fd3c4,

  // Outlines / strokes
  strokeDark: 0x0a120c,
  strokeLight: 0xffe7b0,
  outline: 0x2c5a23,
} as const;

export const FONT = {
  display: "'Arial Black', 'Trebuchet MS', sans-serif",
  body: "'Trebuchet MS', Verdana, sans-serif",
  accent: "Georgia, 'Times New Roman', serif",
} as const;

// Stroked text style helper. CoC-style UI uses thick dark strokes
// around light text for punchy readability over variable backdrops.
// Callers pass the base style and the helper injects the stroke.
export function displayTextStyle(
  size: number,
  color: string = COLOR.textPrimary,
  strokeThickness: number = 4,
): Phaser.Types.GameObjects.Text.TextStyle {
  return {
    fontFamily: FONT.display,
    fontSize: `${size}px`,
    color,
    stroke: '#0a120c',
    strokeThickness,
    fontStyle: 'bold',
    shadow: {
      offsetX: 0,
      offsetY: 3,
      color: '#000000',
      blur: 6,
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
  // The primary CTA — big, bold, brass. "Raid a base →".
  primary: {
    fillTop: 0xffd98a,
    fillBot: 0xd8a848,
    fillTopHover: 0xfff2a8,
    fillBotHover: 0xffd98a,
    fillTopPress: 0xb97e1c,
    fillBotPress: 0xffd98a,
    stroke: 0x5c4020,
    strokeWidth: 3,
    textColor: '#2a1a08',
    textStroke: '#fff2a8',
    textStrokeThickness: 2,
  },
  // Secondary nav — mossy green. Everyday buttons.
  secondary: {
    fillTop: 0x3d7a2c,
    fillBot: 0x2a4f1e,
    fillTopHover: 0x5ba145,
    fillBotHover: 0x3d7a2c,
    fillTopPress: 0x1e3b16,
    fillBotPress: 0x3d7a2c,
    stroke: 0x0e2008,
    strokeWidth: 3,
    textColor: '#ecf7d4',
    textStroke: '#0a1208',
    textStrokeThickness: 2,
  },
  // Neutral — darker chrome, for utility actions (close, back, cancel).
  ghost: {
    fillTop: 0x243824,
    fillBot: 0x162317,
    fillTopHover: 0x3a4d37,
    fillBotHover: 0x243824,
    fillTopPress: 0x0e1a0e,
    fillBotPress: 0x243824,
    stroke: 0x2c5a23,
    strokeWidth: 2,
    textColor: '#c3e8b0',
    textStroke: '#0a1208',
    textStrokeThickness: 2,
  },
  // Danger — red. For destructive ops (leave clan, demolish).
  danger: {
    fillTop: 0xd94c4c,
    fillBot: 0x9a2a2a,
    fillTopHover: 0xf27070,
    fillBotHover: 0xc73c3c,
    fillTopPress: 0x731e1e,
    fillBotPress: 0xb03535,
    stroke: 0x3a0e0e,
    strokeWidth: 3,
    textColor: '#fff2d2',
    textStroke: '#2a0404',
    textStrokeThickness: 2,
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
