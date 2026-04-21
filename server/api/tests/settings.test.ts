import { describe, expect, it } from 'vitest';
import {
  ANIMATED_UNIT_KINDS,
  DEFAULT_UNIT_ANIMATION,
  SETTING_UNIT_ANIMATION,
  type UnitAnimationSettings,
} from '../src/db/settings.js';

// Pure-constant invariants for the settings layer. These guard the
// three shape rules that route logic depends on:
//
//   1. The animated-kind allowlist is exactly the three units with
//      walk-cycle prompts; adding a kind requires a matching entry in
//      tools/gemini-art/prompts.json walkCycles + client/src/assets/
//      atlas.ts ANIMATED_UNIT_KINDS. If this test fails, the other
//      two files need to be synced too.
//
//   2. Defaults enable every kind. The boot fallback relies on this
//      so a brand-new deploy (no seeded row) still renders animated
//      sprites when the files are present.
//
//   3. The setting key is the constant that both the admin route and
//      the public route use. A typo would silently split storage and
//      reads across two keys.

describe('animation settings constants', () => {
  it('ANIMATED_UNIT_KINDS contains exactly the three walk-cycle units', () => {
    expect([...ANIMATED_UNIT_KINDS].sort()).toEqual(
      ['SoldierAnt', 'Wasp', 'WorkerAnt'].sort(),
    );
  });

  it('DEFAULT_UNIT_ANIMATION enables every kind in the allowlist', () => {
    for (const kind of ANIMATED_UNIT_KINDS) {
      const enabled = DEFAULT_UNIT_ANIMATION[kind];
      expect(enabled, `default for ${kind}`).toBe(true);
    }
  });

  it('DEFAULT_UNIT_ANIMATION has no extra keys beyond the allowlist', () => {
    const defaultKeys = Object.keys(DEFAULT_UNIT_ANIMATION).sort();
    expect(defaultKeys).toEqual([...ANIMATED_UNIT_KINDS].sort());
  });

  it('SETTING_UNIT_ANIMATION is a stable non-empty string key', () => {
    expect(SETTING_UNIT_ANIMATION).toBe('unit_animation');
  });

  it('UnitAnimationSettings accepts and narrows a partial kind map', () => {
    // Type-only exercise: unknown kinds should not compile. Keep this
    // test here so a future refactor that widens the type surfaces in
    // the test diff, not at a runtime route boundary.
    const sample: UnitAnimationSettings = {
      WorkerAnt: true,
      SoldierAnt: false,
    };
    expect(sample.WorkerAnt).toBe(true);
    expect(sample.SoldierAnt).toBe(false);
  });
});
