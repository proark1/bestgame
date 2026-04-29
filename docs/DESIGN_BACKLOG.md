# Design + Economy Backlog

Working backlog of the next high-impact design and economy moves, written
after the April 2026 audit of `claude/game-design-review-tTqUq`.

The original 10-rec list (raid feel, onboarding, defender depth, etc.)
has largely shipped — see `CLAUDE.md` and the scenes for current state.
This doc captures the *next* 10, with a deliberate split between design
ideas and economy levers.

Status legend: 🆕 not started · 🌱 scaffolded · 🟡 partial · ✅ shipped

---

## Top 10 (next iteration)

### 1. Wire the unit-ability scaffold to real combat 🌱
The `UnitAbilityKind` type and `triggerAbility` SimInput slot are now in
place (deterministic-safe no-op today). Pick one ability per signature
unit and wire it through combat:

| Unit | Ability | Effect |
|---|---|---|
| BombBeetle | `detonate` | Burst splash, kills self |
| WebSetter | `webThrow` | Roots target tile for N ticks |
| FireAnt | `igniteRing` | Lays a burn pool on current tile |
| Jumper | `leap` | Skip past one wall tile |

Adds the tactical depth heroes already have to the rank-and-file. UI
is a long-press on a deployed unit chip.

### 2. Faction-asymmetric mechanics (not just paint) 🆕
Bee MVP units are in (`HoneyBee`, `HiveDrone`). Make faction tags
*matter*: Bees default to flight + cannot dig; Beetles get +25% vs
walls; Spiders get +damage-on-first-hit; Ants stay the all-rounder
baseline. Wire via `UNIT_BEHAVIOR` — no new sim systems needed.

### 3. Defender rewards beyond trophy preservation 🆕
Today the defender's only reward is *not* losing trophies. Add:

- Daily **defender chest** that fills 10% per successful defense
  (capped at 100% / 24h, claimed for sugar + leafBits).
- "Best defense of the day" clan leaderboard, top 3 get a milk drop.

This finally gives base-design optimization an active payoff loop.

### 4. Weekly seasons with rotating rewards 🆕
The 18-tier trophy ladder is static. Layer a 7-day season on top:

- Soft trophy reset on Sunday night (top 25%, mid 50%, low 25%
  decay rates so new players keep ranks).
- Season rewards = fixed milk + a cosmetic queen-skin slot.
- Season MMR keeps competitive integrity across resets (CoC clan-war
  CWL pattern).

### 5. Hero gacha pity timer 🆕
`HeroesScene` exists with chest gifts. Add a guaranteed-hero pity
counter: every 50 chests opened without a new hero, the next chest
*must* contain one. Reduces variance anxiety, retains whales without
preying on them.

### 6. Resource-conversion bay 🆕
Add a small in-Hive building or store entry: spend `aphidMilk` to
trade `sugar`↔`leafBits` at a 1.2× rate. Solves the common stall
where the player has 50k sugar but waits hours for leafBits. Also
gives milk a non-time-skip sink, which is healthier monetization.

### 7. Capacity-aware HUD ("your collectors are wasted") 🆕
When the sugar vault is full, dim the Dew Collector pill and surface a
nudge: *"Vaults full — raid now or upgrade SugarVault."* Same for
leafBits / nurseries. Players currently lose hours of income because
the cap is silent.

### 8. Trophy decay buffer at high tiers 🆕
At Hive Lord I+ the decay anxiety becomes the meta. Add: any day
with ≥3 raid attempts shields trophies from decay for 24h. Keeps the
top of the ladder competitive without punishing real life.

### 9. Anti-sandbagger matchmaking weight 🆕
Today matchmaking pairs by trophies. Add a base-power score (sum of
defense building levels weighted by HP/DPS). Sandbaggers (deliberately
weak base + high attack roster) get matched with similarly low-trophy
*and* low-power opponents only. Protects new player retention.

### 10. Friendly clan battles 🆕
Stake-free arena matches between two clanmates. No trophy/loot
movement — pure practice. Requires no new netcode (PicnicRoom
already supports neutral maps); just a clan-side button and a
`mode: 'friendly'` flag on the reservation.

---

## Honorable mentions (not in the 10, but tracked)

- **Battle pass with cosmetic + currency tracks.** Heavy ops; reserve
  for after a stable PvP base.
- **Wall-placement defense score preview** at placement time.
- **Replay voice/text annotations** for social sharing.
- **Risk-toggle raids** ("double-or-nothing" 3-star bonus).
- **Spectate clanmate live raids** (huge social hook; needs Colyseus
  spectator slot).

---

## Determinism / sim-side notes

Anything that touches `shared/src/sim/*` must:

1. Stay synchronous + Q16.16 fixed-point.
2. Add new fields as `optional` so legacy replays still deserialise.
3. Add new SimInput / state fields with explicit no-op handling first
   (see `triggerAbility` in `step.ts` for the pattern).

Items 1, 2 above need sim work. Items 3-10 are economy / UI / API only.
