import type pg from 'pg';

// game_settings table: single-row-per-key JSONB store for feature
// flags and runtime config. Callers are expected to know the shape of
// value for each key — this layer stays shape-agnostic so a new flag
// never needs a migration.
//
// First consumer: 'unit_animation' → Record<UnitKind, boolean>.

export async function getSetting<T>(
  pool: pg.Pool,
  key: string,
): Promise<T | null> {
  const res = await pool.query<{ value: T }>(
    'SELECT value FROM game_settings WHERE key = $1',
    [key],
  );
  if (res.rows.length === 0) return null;
  return res.rows[0]!.value;
}

export async function putSetting<T>(
  pool: pg.Pool,
  key: string,
  value: T,
): Promise<void> {
  await pool.query(
    `INSERT INTO game_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}

// Well-known keys used in multiple places — keep the constants here so
// a typo at a callsite fails at compile time, not at runtime with a
// silent empty record.
export const SETTING_UNIT_ANIMATION = 'unit_animation';

// Which unit kinds ship walk-cycle spritesheets. Keep synced with the
// tools/gemini-art/prompts.json `walkCycles` bucket and with the
// animated-kind list on the client. A kind absent from this list is
// always rendered as a static image regardless of the toggle.
export const ANIMATED_UNIT_KINDS = ['WorkerAnt', 'SoldierAnt', 'Wasp'] as const;
export type AnimatedUnitKind = (typeof ANIMATED_UNIT_KINDS)[number];

export type UnitAnimationSettings = Partial<Record<AnimatedUnitKind, boolean>>;

// Default: everything on. Used as the fallback when game_settings is
// unreachable (DB down) or empty (migration seed missed somehow).
export const DEFAULT_UNIT_ANIMATION: UnitAnimationSettings = {
  WorkerAnt: true,
  SoldierAnt: true,
  Wasp: true,
};

// ─── UI-image overrides ─────────────────────────────────────────
// The game's UI chrome (buttons, panels, HUD, banners, board tiles)
// renders as Graphics/CSS by default. An admin can generate bespoke
// images for each of these slots via the Menu UI bucket in the
// sprite admin; when the image is on disk AND the per-key flag
// below is true, the shared button/panel factories switch to
// rendering that image (9-slice-scaled) instead of the Graphics
// fallback. Absent / disabled flags keep today's Graphics-only
// rendering so nothing regresses by default.
export const SETTING_UI_OVERRIDES = 'ui_overrides';

export const UI_OVERRIDE_KEYS = [
  'ui-button-primary-bg',
  'ui-button-secondary-bg',
  'ui-panel-bg',
  'ui-hud-bg',
  'ui-title-banner',
  'ui-board-tile-surface',
] as const;
export type UiOverrideKey = (typeof UI_OVERRIDE_KEYS)[number];

export type UiOverrideSettings = Partial<Record<UiOverrideKey, boolean>>;

// All overrides start disabled — the Graphics fallback is battle-
// tested, and the generated images may not exist yet on a fresh
// deploy. Admin toggles them on once they're happy with the art.
export const DEFAULT_UI_OVERRIDES: UiOverrideSettings = {};
