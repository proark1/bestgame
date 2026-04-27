// Storage cap derivation. Pure, deterministic, no float math at the
// boundaries — every input is an integer level, every output is an
// integer cap. Used by:
//   - server/api/src/routes/player.ts to clamp offline trickle writes
//     and refuse production-credit past cap
//   - client HUD pills to render "5800 / 7300" headroom text
//
// See docs/GAME_DESIGN.md §6.8 for the design rationale. Loot bypasses
// the cap (raids should never be a wasted action), but production +
// offline trickle clamp.

import type { Base } from '../types/base.js';

export interface StorageCaps {
  sugar: number;
  leafBits: number;
  // Milk cap is opt-in — null means "uncapped" (legacy behaviour
  // for players who haven't built a MilkPot yet). When the base
  // contains at least one alive MilkPot, the cap activates and
  // takes the same production-clamp path as sugar / leaf.
  aphidMilk: number | null;
}

// Hand-tuned constants. Calibrated against §6.10 anchors so a Q3 base
// holds ~3 mid-tier upgrades and a maxed Q5 base needs to drain at least
// once per offline cycle.
const BASE_SUGAR_CAP = 1000;
const BASE_LEAF_CAP = 500;
const PER_VAULT_LEVEL_SUGAR = 1500;
const PER_DEW_LEVEL_SUGAR = 200;
const PER_NURSERY_LEVEL_LEAF = 800;
// LeafSilo is a pure-storage building (no production side-effect)
// so its per-level contribution is double a LarvaNursery's. Lets
// dedicated-storage builds pull ahead of production-heavy ones.
const PER_LEAFSILO_LEVEL_LEAF = 1600;
// MilkPot — once at least one alive pot exists, milk has a cap.
// Base 500 + 800 / level mirrors leaf cap shape.
const BASE_MILK_CAP = 500;
const PER_MILKPOT_LEVEL_MILK = 800;

export function storageCaps(base: Base): StorageCaps {
  let vaultSum = 0;
  let dewSum = 0;
  let nurserySum = 0;
  let leafSiloSum = 0;
  let milkPotSum = 0;
  for (const b of base.buildings) {
    // Destroyed (hp <= 0) buildings still occupy their slot but don't
    // contribute to cap — same rule as production. Encourages players
    // to repair / re-place before stockpiling further.
    if (b.hp <= 0) continue;
    const lvl = Math.max(1, b.level | 0);
    if (b.kind === 'SugarVault') vaultSum += lvl;
    else if (b.kind === 'DewCollector') dewSum += lvl;
    else if (b.kind === 'LarvaNursery') nurserySum += lvl;
    else if (b.kind === 'LeafSilo') leafSiloSum += lvl;
    else if (b.kind === 'MilkPot') milkPotSum += lvl;
  }
  return {
    sugar: BASE_SUGAR_CAP + PER_VAULT_LEVEL_SUGAR * vaultSum + PER_DEW_LEVEL_SUGAR * dewSum,
    leafBits: BASE_LEAF_CAP + PER_NURSERY_LEVEL_LEAF * nurserySum + PER_LEAFSILO_LEVEL_LEAF * leafSiloSum,
    // Opt-in milk cap: only active once the player has built at
    // least one MilkPot. Until then milk stays uncapped, matching
    // the pre-MilkPot behaviour so existing wallets aren't
    // suddenly clamped after deploy.
    aphidMilk: milkPotSum > 0 ? BASE_MILK_CAP + PER_MILKPOT_LEVEL_MILK * milkPotSum : null,
  };
}

// Clamp a wallet to the cap. Returns the clamped value plus the amount
// that overflowed — callers can use the overflow to surface a "storage
// full" warning without another read.
export function clampToCap(
  amount: number,
  cap: number,
): { value: number; overflow: number } {
  if (amount <= cap) return { value: amount, overflow: 0 };
  return { value: cap, overflow: amount - cap };
}
