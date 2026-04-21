import type { SimState } from '../state.js';

// Outcome system — resolves the match-end conditions:
//  - Attacker wins if at least one of: >= 50% buildings destroyed, or Queen
//    Chamber destroyed (auto-3-star).
//  - Defender wins if all attacker units dead AND no deploy capacity left.
//  - Draw if timer expires with no clear winner.
//
// Latches the outcome on the tick it's first reached; further ticks don't
// override it.

export function outcomeSystem(state: SimState, tickLimit: number): void {
  if (state.outcome !== 'ongoing') return;

  let totalBuildings = 0;
  let destroyedBuildings = 0;
  let queenDead = false;
  for (let i = 0; i < state.buildings.length; i++) {
    const b = state.buildings[i]!;
    totalBuildings++;
    if (b.hp <= 0) {
      destroyedBuildings++;
      if (b.kind === 'QueenChamber') queenDead = true;
    }
  }

  if (queenDead || destroyedBuildings * 2 >= totalBuildings) {
    state.outcome = 'attackerWin';
    return;
  }

  // Defender win: no live attacker units and no deploy budget left.
  let liveAttackers = 0;
  for (let i = 0; i < state.units.length; i++) {
    const u = state.units[i]!;
    if (u.hp > 0 && u.owner === 0) liveAttackers++;
  }
  if (liveAttackers === 0 && state.deployCapRemaining[0] === 0) {
    state.outcome = 'defenderWin';
    return;
  }

  if (state.tick >= tickLimit) {
    // Timer expired — attacker gets partial credit if they destroyed
    // anything; otherwise defender wins.
    state.outcome = destroyedBuildings > 0 ? 'attackerWin' : 'defenderWin';
  }
}
