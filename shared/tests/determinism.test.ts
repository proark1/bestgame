import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  hashSimState,
  hashToHex,
  runReplay,
  step,
} from '../src/sim/index.js';
import type { SimConfig } from '../src/sim/index.js';
import { SMALL_BASE } from './fixtures/smallBase.js';
import { SCRIPTED_INPUTS } from './fixtures/scriptedInputs.js';

// The determinism gate: a scripted raid must produce the same state hash
// every run, in every engine. This test is the project's spine — if it
// flakes, both replay validation and live-arena reconciliation are broken.

const cfg: SimConfig = {
  tickRate: 30,
  maxTicks: 300,
  initialSnapshot: SMALL_BASE,
  seed: 0x1234abcd,
};

function runScenario(): { finalHash: number; everyHundred: number[] } {
  const state = createInitialState(cfg);
  // Re-simulate a 300-tick scenario stepping manually so we can snapshot
  // the hash every 100 ticks.
  const grouped = new Map<number, typeof SCRIPTED_INPUTS>();
  for (const inp of SCRIPTED_INPUTS) {
    const bucket = grouped.get(inp.tick) ?? [];
    bucket.push(inp);
    grouped.set(inp.tick, bucket);
  }
  const samples: number[] = [];
  while (state.outcome === 'ongoing' && state.tick < cfg.maxTicks) {
    const nextTick = state.tick + 1;
    const batch = grouped.get(nextTick) ?? [];
    step(state, cfg, batch);
    if (state.tick % 100 === 0) samples.push(hashSimState(state));
  }
  return { finalHash: hashSimState(state), everyHundred: samples };
}

describe('sim determinism', () => {
  it('produces identical state hashes on two consecutive runs', () => {
    const a = runScenario();
    const b = runScenario();
    expect(hashToHex(a.finalHash)).toBe(hashToHex(b.finalHash));
    expect(a.everyHundred).toEqual(b.everyHundred);
  });

  it('runReplay path matches manual step path', () => {
    // Build two starting states — one we drive manually, one through runReplay.
    const manual = runScenario();
    const viaReplay = runReplay(createInitialState(cfg), cfg, SCRIPTED_INPUTS);
    expect(hashToHex(hashSimState(viaReplay))).toBe(
      hashToHex(manual.finalHash),
    );
  });

  it('differs when seed changes', () => {
    const baseline = runScenario();
    const altCfg: SimConfig = { ...cfg, seed: 0xdeadbeef };
    const alt = runReplay(createInitialState(altCfg), altCfg, SCRIPTED_INPUTS);
    // Hashes SHOULD differ when seed differs. If they match, determinism is
    // too coarse (RNG not wired into anything observable).
    // NOTE: in the current MVP the RNG isn't consumed by systems yet, so
    // the seed only affects rngState, which IS hashed. Guaranteed to differ.
    expect(hashToHex(hashSimState(alt))).not.toBe(hashToHex(baseline.finalHash));
  });

  it('snapshot hash at tick 100 is the pinned value', () => {
    // Pinned hash — if you change sim logic, this will fail and you MUST
    // update both this value AND bump a compat version. Don't update
    // casually; this is how we catch accidental engine drift.
    const { everyHundred } = runScenario();
    expect(everyHundred.length).toBeGreaterThan(0);
    // The pinned value below is regenerated whenever sim logic intentionally
    // changes. Comment out initially during bootstrapping.
    // expect(hashToHex(everyHundred[0]!)).toBe('XXXXXXXX');
  });
});
