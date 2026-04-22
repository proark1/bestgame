import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Regression test for the desktop footer "clicks land in the wrong
// button" bug. Root cause was a manual override of the interactive
// Zone's hit area to `Rectangle(-w/2, -h/2, w, h)` — Phaser's
// InputManager.pointWithinHitArea already adds displayOriginX/Y to
// the local pointer before the containment check, so the default
// `Rectangle(0, 0, w, h)` is already aligned with the zone's visual
// bounds. The manual override shifted the effective hit zone up and
// to the left by half a button, so only the top-left quadrant of
// each footer button actually registered clicks — the symptom the
// user saw was "click activates something on the right of my mouse"
// (because the right half of a button fell into the NEXT button's
// shifted hit zone).
//
// This guards the file-level invariant rather than spinning up a
// full Phaser + jsdom renderer: any revived `new Phaser.Geom.Rectangle(
// -w/2, -h/2, ...)` assignment into `input.hitArea` will fail the
// test loudly before it can ship.

const BUTTON_SRC = resolve(__dirname, '../src/ui/button.ts');

describe('ui/button hit-area', () => {
  const source = readFileSync(BUTTON_SRC, 'utf8');

  it('does not manually reassign input.hitArea', () => {
    // Phaser.GameObjects.Zone.setSize already resizes the default
    // input.hitArea in place when customHitArea is false. Any line
    // that assigns `input.hitArea = new Phaser.Geom.Rectangle(...)`
    // bypasses that contract and risks the up-left shift bug.
    expect(source).not.toMatch(/\.hitArea\s*=\s*new\s+Phaser\.Geom\.Rectangle/);
  });

  it('never constructs a centered-origin hit rectangle', () => {
    // Specifically catch the old `(-curW / 2, -curH / 2, curW, curH)`
    // shape. InputManager.pointWithinHitArea does the origin
    // normalization for us; sizing the rect "around" 0,0 double-
    // counts the displayOrigin and shifts the hit zone.
    expect(source).not.toMatch(/-\s*curW\s*\/\s*2[^)]*-\s*curH\s*\/\s*2/);
  });

  it('calls Zone.setSize when the button resizes', () => {
    // Zone.setSize(w, h) is what propagates new dimensions into
    // displayOrigin and the default hit-area rectangle. Without it,
    // resizing the button would leave the hit zone frozen at the
    // initial 180×44 constructor size regardless of layoutFooter's
    // later setSize call.
    expect(source).toMatch(/hit\.setSize\(curW,\s*curH\)/);
  });
});
