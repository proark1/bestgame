import { Rng } from './rng.js';
import { applyDeploy } from './systems/deploy.js';
import { pheromoneFollowSystem } from './systems/pheromone_follow.js';
import { combatSystem } from './systems/combat.js';
import { outcomeSystem } from './systems/outcome.js';
import { aiRulesSystem } from './ai_rules.js';
import type { SimConfig, SimState } from './state.js';
import type { SimInput } from '../types/pheromone.js';

// The single deterministic step reducer. Same inputs produce the same
// SimState on every engine. This module is imported UNCHANGED by:
//   - client (for local simulation during raid replay and arena prediction)
//   - api server (for replay validation / anti-cheat)
//   - arena server (for authoritative live sim)
//
// Inputs are sorted ascending by tick. Any input whose tick equals the
// *outgoing* tick (i.e. after increment) is applied at the start of that
// tick. That matches the netcode contract: client submits inputs with
// intendedTick = serverTick + N, server applies them when tick reaches N.

export function step(
  state: SimState,
  cfg: SimConfig,
  inputsThisTick: SimInput[],
): void {
  // Re-hydrate RNG from snapshot so it's reproducible across process boundaries.
  const rng = Rng.restore(state.rngState);

  state.tick++;

  // 1. Apply inputs. They were pre-filtered to this tick by the caller.
  for (let i = 0; i < inputsThisTick.length; i++) {
    const inp = inputsThisTick[i]!;
    if (inp.type === 'deployPath') {
      applyDeploy(state, inp.ownerSlot, inp.path, cfg.attackerUnitLevels);
    } else if (inp.type === 'surrender') {
      state.outcome = inp.ownerSlot === 0 ? 'defenderWin' : 'attackerWin';
    }
  }

  if (state.outcome === 'ongoing') {
    // 2. Units advance along their pheromone paths.
    pheromoneFollowSystem(state);
    // 2b. Player-authored defender AI rules. Runs BEFORE combat so
    // any freshly-applied boost / range extension / reveal takes
    // effect in the same tick's combat pass. Ticking cooldowns
    // down and reading pre-combat state (e.g. "any enemy in range")
    // is what makes rules predictable to both sides.
    state.buildingsDestroyedThisTick = 0;
    aiRulesSystem(state);
    // 3. Combat resolution (unit<->building). Level multipliers are
    // threaded in so attacker damage scales with upgrades.
    combatSystem(state, cfg.attackerUnitLevels);
    // 4. Cull dead — but preserve id-sorted invariant. Since we only delete
    //    entries, and they were sorted by id, the remaining slice stays sorted.
    let w = 0;
    for (let r = 0; r < state.units.length; r++) {
      const u = state.units[r]!;
      if (u.hp > 0) {
        state.units[w++] = u;
      }
    }
    state.units.length = w;
  }

  // 5. Outcome check.
  outcomeSystem(state, cfg.maxTicks);

  // Persist RNG state back (even if no draws happened this tick, a future
  // system might use it; we want the snapshot to always be fresh).
  state.rngState = rng.snapshot();
}

// Run a full sequence of inputs against a starting state. Used by the
// server to re-simulate a replay for hash validation.
export function runReplay(
  initial: SimState,
  cfg: SimConfig,
  inputs: SimInput[],
): SimState {
  // Clone only enough to not mutate caller's array. Deep clone not needed
  // because step() mutates arrays in place and we expect caller to discard
  // the original.
  const state = initial;
  // Group inputs by tick for efficient per-tick slicing.
  const sorted = [...inputs].sort((a, b) => a.tick - b.tick);
  let idx = 0;

  while (state.outcome === 'ongoing' && state.tick < cfg.maxTicks) {
    const nextTick = state.tick + 1;
    const batch: SimInput[] = [];
    while (idx < sorted.length && sorted[idx]!.tick <= nextTick) {
      batch.push(sorted[idx]!);
      idx++;
    }
    step(state, cfg, batch);
  }
  return state;
}
