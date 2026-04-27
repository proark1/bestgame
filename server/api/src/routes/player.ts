import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Types } from '@hive/shared';
const { HERO_CATALOG, HERO_PRICE_LADDER, MAX_EQUIPPED_HEROES } = Types;
type HeroKind = Types.HeroKind;
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';
import {
  BUILDING_DEFAULTS,
  BUILDING_PLACEMENT_COSTS,
  MAX_BUILDINGS_PER_BASE,
  isPlayerPlaceable,
} from '../game/buildingCosts.js';
import {
  MAX_QUEEN_LEVEL,
  MIN_QUEEN_LEVEL,
  QUEEN_UPGRADE_COST,
  buildingRulesPayload,
  countOfKind,
  isLayerAllowed,
  queenLevel,
  quotaFor,
} from '../game/buildingRules.js';
import {
  isUpgradeableUnit,
  upgradeCatalog,
  upgradeCost,
  MAX_UNIT_LEVEL,
} from '../game/upgradeCosts.js';
import { upgradeCostMult, levelStatPercent, LEVEL_COST_MULT } from '../game/progression.js';
import {
  storageCaps,
  buildTimeMs,
  remainingMsAt,
  skipCostMilk,
  colonyRankFromInvested,
  lootCapForRank,
} from '@hive/shared/sim';
import { applyPlacementProgress, refreshIfStale } from '../game/quests.js';
import { normalizeBaseLayers } from '../game/migrateLayers.js';
import { resolveStreak, rewardForDay, STREAK_REWARDS, COMEBACK_REWARD } from '../game/streaks.js';
import { QUEEN_SKINS, skinById, scanUnlockedSkins } from '../game/queenSkins.js';
import {
  MAX_RULES_PER_BUILDING,
  RULES_UNLOCK_QUEEN_LEVEL,
  aiRuleCatalog,
  baseRuleQuota,
  countRulesInBase,
  validateRule,
} from '../game/aiRules.js';
import type { Types as HiveTypes } from '@hive/shared';

// Resource columns are BIGINT, so DB values come back as strings. JS
// Number loses precision past 2^53 (~9 quadrillion); once a long-lived
// economy crosses that, the wire shape will have to switch to string
// or BigInt end-to-end.
//
// We wrap the conversion in this helper so the precision ceiling is
// surfaced in logs the moment a real economy approaches it, without
// silently truncating or crashing today's gameplay. Change the wire
// format in a focused PR the first time this warning fires.
function safeBigintToNumber(value: string, column: string, logger?: { warn: (obj: object, msg: string) => void }): number {
  const n = Number(value);
  if (n > Number.MAX_SAFE_INTEGER) {
    logger?.warn({ value, column }, 'resource value exceeds MAX_SAFE_INTEGER — wire format needs upgrade');
  }
  return n;
}

// /api/player/me — returns the authenticated player + their base, with
// offline income trickled forward based on elapsed time since
// last_seen_at. The client uses this as the source of truth on boot.
//
// /api/player/base — PUT the full base snapshot. Used by the home scene
// (place/upgrade flow — even without it, the snapshot is updated any
// time the client makes a local change and syncs.)

// Offline income per producer building per second. Kept in sync with
// client/src/scenes/HomeScene.ts's INCOME_PER_SECOND. Small enough that
// raiding always matters more than AFK idling.
const INCOME_PER_SECOND: Partial<
  Record<Types.BuildingKind, { sugar: number; leafBits: number; aphidMilk: number }>
> = {
  DewCollector: { sugar: 8, leafBits: 0, aphidMilk: 0 },
  LarvaNursery: { sugar: 0, leafBits: 3, aphidMilk: 0 },
  SugarVault: { sugar: 2, leafBits: 0, aphidMilk: 0 },
  // AphidFarm: slow milk producer. 1 milk every 5 sec at L1 → 0.2/sec
  // baseline. Linear scale with level matches the other producers.
  // At Q5 with 2 farms at L10, that's 4 milk/sec — about 8 hours of
  // idle for a 100-milk skip-token at the planned monetization scale.
  AphidFarm: { sugar: 0, leafBits: 0, aphidMilk: 0.2 },
};
// Cap offline earnings at 8h so leaving the game tab open for weeks
// doesn't flood the economy.
const MAX_OFFLINE_SECONDS = 60 * 60 * 8;

interface PlayerRow {
  id: string;
  display_name: string;
  faction: string;
  trophies: number;
  sugar: string; // bigint comes back as string from pg
  leaf_bits: string;
  aphid_milk: string;
  unit_levels: Record<string, number>;
  last_seen_at: Date;
  created_at: Date;
  // Fractional milk that hasn't yet rolled over into a whole credit.
  // See migrations/0015. Always read + written together with aphid_milk
  // so frequent /me polling can't flush sub-integer progress.
  aphid_milk_residual: number;
  // Running sum of every sugar+leaf the player has spent on upgrades
  // and placements. Drives the Colony Rank meta-progression curve
  // (see migrations/0016 + shared/src/sim/colonyRank.ts).
  total_invested: string; // BIGINT comes back as string from pg
  // Retention-loop columns (migrations/0011). `shield_expires_at` is
  // nullable; the rest default on the DB side so existing players
  // backfill without a data migration.
  shield_expires_at: Date | null;
  season_id: string;
  season_xp: number;
  season_milestones_claimed: number[];
  // Stickiness features (migrations/0013).
  streak_count: number;
  streak_last_day: string;
  streak_last_claim: number;
  comeback_pending: boolean;
  nemesis_player_id: string | null;
  nemesis_stars: number | null;
  nemesis_set_at: Date | null;
  nemesis_avenged: boolean;
  queen_skins: string[];
  queen_skin_id: string;
  tutorial_stage: number;
  campaign_chapter: number;
  campaign_progress: number;
  // Bank of clanmate-donated units waiting for the player's next
  // raid. Map of unit kind → count. Credited by /clan/donate;
  // cleared by /raid/submit on success. See migrations/0018.
  donation_inventory: Record<string, number>;
  // Hero ownership + equip state (migrations/0023). owned is a
  // presence map keyed by HeroKind; equipped is an ordered array
  // of HeroKind capped at MAX_EQUIPPED_HEROES; chest_claimed gates
  // the free first-hero chest CTA.
  hero_ownership: Record<string, true>;
  hero_equipped: string[];
  hero_chest_claimed: boolean;
}

interface BaseRow {
  player_id: string;
  faction: string;
  snapshot: Types.Base;
  updated_at: Date;
}

function incomePerSecond(base: Types.Base): { sugar: number; leafBits: number; aphidMilk: number } {
  let sugar = 0, leafBits = 0, aphidMilk = 0;
  for (const b of base.buildings) {
    if (b.hp <= 0) continue;
    const rate = incomePerSecondForBuilding(b);
    sugar += rate.sugar;
    leafBits += rate.leafBits;
    aphidMilk += rate.aphidMilk;
  }
  return { sugar, leafBits, aphidMilk };
}

// Per-building production rate. Used by both the aggregate
// incomePerSecond (HUD "+X/sec" hint) and the per-building
// pendingHarvest accumulator (CoC-style tap-to-harvest).
function incomePerSecondForBuilding(
  b: Types.Building,
): { sugar: number; leafBits: number; aphidMilk: number } {
  if (b.hp <= 0) return { sugar: 0, leafBits: 0, aphidMilk: 0 };
  const inc = INCOME_PER_SECOND[b.kind];
  if (!inc) return { sugar: 0, leafBits: 0, aphidMilk: 0 };
  const mult = Math.max(1, b.level | 0);
  return {
    sugar: inc.sugar * mult,
    leafBits: inc.leafBits * mult,
    aphidMilk: inc.aphidMilk * mult,
  };
}

// Accumulate a producer's offline harvest from `lastMs` (its
// lastHarvestAt or the player's last_seen_at fallback) to `nowMs`.
// Capped at MAX_OFFLINE_SECONDS so a tab left open for weeks can't
// flood the bucket. Returns integer values — the harvest endpoint
// floors when committing to the wallet, and the timestamp itself is
// the authoritative residual (no separate fractional column).
function computeBuildingPending(
  b: Types.Building,
  lastMs: number,
  nowMs: number,
): { sugar: number; leafBits: number; aphidMilk: number } {
  const elapsedSec = Math.max(
    0,
    Math.min(MAX_OFFLINE_SECONDS, Math.floor((nowMs - lastMs) / 1000)),
  );
  if (elapsedSec === 0) return { sugar: 0, leafBits: 0, aphidMilk: 0 };
  const rate = incomePerSecondForBuilding(b);
  return {
    sugar: Math.floor(rate.sugar * elapsedSec),
    leafBits: Math.floor(rate.leafBits * elapsedSec),
    aphidMilk: Math.floor(rate.aphidMilk * elapsedSec),
  };
}

// Promote a single building's pending upgrade in place. Mutates the
// passed building object (sets level / hpMax / hp; clears pending
// fields) and returns true if anything actually changed. Reused by:
//  - /player/me lazy finalize (every elapsed pending is auto-promoted)
//  - /player/builder/skip immediate finalize (after milk debit)
//
// HP re-scale uses the same proportional-damage rule as the previous
// instant upgrades: a perfect-HP building stays perfect; a damaged
// building keeps the same absolute damage taken (capped at 1 HP min).
function finalizePendingUpgrade(b: Types.Building): boolean {
  if (!b.pendingCompletesAt || !b.pendingToLevel) return false;
  const oldLevel = b.level ?? 1;
  const newLevel = b.pendingToLevel;
  if (newLevel <= oldLevel) {
    // Defensive: pending pointed below current. Clear without touching
    // level so a corrupt state doesn't make the building weaker.
    delete b.pendingCompletesAt;
    delete b.pendingToLevel;
    return true;
  }
  const oldPct = levelStatPercent(oldLevel) / 100;
  const newPct = levelStatPercent(newLevel) / 100;
  const oldHpMax = b.hpMax ?? b.hp;
  const baseMax = oldHpMax / oldPct;
  const newHpMax = Math.round(baseMax * newPct);
  const damageTaken = oldHpMax - b.hp;
  b.level = newLevel;
  b.hpMax = newHpMax;
  b.hp = Math.max(1, newHpMax - damageTaken);
  delete b.pendingCompletesAt;
  delete b.pendingToLevel;
  return true;
}

export function registerPlayer(app: FastifyInstance): void {
  app.get('/player/me', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pRes = await client.query<PlayerRow>(
        'SELECT * FROM players WHERE id = $1',
        [playerId],
      );
      if (pRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'player not found' };
      }
      // FOR UPDATE on the base row — /me does a read-modify-write on
      // bases.snapshot when a pending upgrade has elapsed (lazy
      // finalize below). Without the lock, a concurrent /me or
      // /upgrade-building from the same player could overwrite our
      // changes (or vice versa). The TX commits at the end of the
      // handler so the lock duration is bounded.
      const bRes = await client.query<BaseRow>(
        'SELECT * FROM bases WHERE player_id = $1 FOR UPDATE',
        [playerId],
      );
      if (bRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(500);
        return { error: 'player has no base (corrupt state)' };
      }
      const player = pRes.rows[0]!;
      const base = bRes.rows[0]!;

      // Lazy builder-gate finalization. Walk the snapshot for any
      // building whose pendingCompletesAt has elapsed and promote it
      // to the queued level — clearing the pending fields. The HP /
      // hpMax re-scale uses the same proportional-damage rule as
      // pre-time-gate immediate upgrades. Snapshot is mutated in place
      // here; the persisted UPDATE downstream picks up the change.
      const nowMs = Date.now();
      let snapshotMutated = false;
      for (const b of base.snapshot.buildings) {
        if (!b.pendingCompletesAt || !b.pendingToLevel) continue;
        if (Date.parse(b.pendingCompletesAt) > nowMs) continue;
        if (finalizePendingUpgrade(b)) snapshotMutated = true;
      }
      // Lazy ALLOWED_LAYERS migration. The layer roster shifted (e.g.
      // traps moved underground-only); any base saved before the
      // shift may have buildings on a now-illegal layer. Walk + fix
      // here so the next save is in compliance. Idempotent —
      // already-clean bases skip the UPDATE entirely.
      const layerNorm = normalizeBaseLayers(base.snapshot);
      if (layerNorm.mutated) {
        base.snapshot = layerNorm.base;
        snapshotMutated = true;
        app.log.info(
          { playerId, events: layerNorm.events },
          'normalized base layers (relocated/demolished buildings to match new ALLOWED_LAYERS)',
        );
      }
      if (snapshotMutated) {
        base.snapshot = {
          ...base.snapshot,
          version: (base.snapshot.version ?? 0) + 1,
        };
        await client.query(
          `UPDATE bases SET snapshot = $2::jsonb, version = version + 1, updated_at = NOW()
            WHERE player_id = $1`,
          [playerId, JSON.stringify(base.snapshot)],
        );
      }

      // CoC-style tap-to-harvest: instead of auto-crediting offline
      // production into the wallet, we accumulate it per-producer
      // building. The player taps the producer (or "Collect All") to
      // claim — the harvest endpoint applies the storage cap there.
      // Each producer has its own `lastHarvestAt`; pre-existing
      // buildings without one fall back to the player's last_seen_at
      // so a player who upgrades through this PR sees ONE pending
      // bucket reflecting their last absence (not zero).
      const lastSeenMs = player.last_seen_at.getTime();
      const elapsedSec = Math.max(
        0,
        Math.min(
          MAX_OFFLINE_SECONDS,
          Math.floor((nowMs - lastSeenMs) / 1000),
        ),
      );
      let pendingHarvestMutated = false;
      for (const b of base.snapshot.buildings) {
        const rate = incomePerSecondForBuilding(b);
        if (rate.sugar === 0 && rate.leafBits === 0 && rate.aphidMilk === 0) {
          // Non-producer (turret, wall, etc.) or destroyed — clear any
          // stale pendingHarvest so a sniped DewCollector stops showing
          // a coin chip after the player rebuilds it.
          if (b.pendingHarvest || b.lastHarvestAt) {
            delete b.pendingHarvest;
            delete b.lastHarvestAt;
            pendingHarvestMutated = true;
          }
          continue;
        }
        const lastMs = b.lastHarvestAt
          ? Date.parse(b.lastHarvestAt)
          : lastSeenMs;
        // Defensive: a malformed timestamp ⇒ treat as "now" so we
        // don't credit a giant retroactive bucket.
        const safeLastMs = Number.isFinite(lastMs) ? lastMs : nowMs;
        const pending = computeBuildingPending(b, safeLastMs, nowMs);
        // Always set lastHarvestAt to its known timestamp (or now() on
        // first visit) so subsequent /me calls compute against a stable
        // anchor. Snapshot mutation is gated below to avoid a no-op
        // version bump every single /me roundtrip.
        const desiredLast = b.lastHarvestAt
          ? b.lastHarvestAt
          : new Date(nowMs).toISOString();
        const desiredPending =
          pending.sugar + pending.leafBits + pending.aphidMilk > 0
            ? pending
            : undefined;
        const before = JSON.stringify({
          a: b.lastHarvestAt,
          b: b.pendingHarvest,
        });
        b.lastHarvestAt = desiredLast;
        if (desiredPending) {
          b.pendingHarvest = desiredPending;
        } else if (b.pendingHarvest) {
          delete b.pendingHarvest;
        }
        const after = JSON.stringify({
          a: b.lastHarvestAt,
          b: b.pendingHarvest,
        });
        if (before !== after) pendingHarvestMutated = true;
      }
      if (pendingHarvestMutated) {
        // The earlier snapshot-persist block (~line 302) ran BEFORE
        // we computed harvest, so flip that flag for the response
        // payload and persist the harvest tracking on its own write.
        snapshotMutated = true;
        base.snapshot = {
          ...base.snapshot,
          version: (base.snapshot.version ?? 0) + 1,
        };
        await client.query(
          `UPDATE bases SET snapshot = $2::jsonb, version = version + 1, updated_at = NOW()
            WHERE player_id = $1`,
          [playerId, JSON.stringify(base.snapshot)],
        );
      }

      // Wallet doesn't change here anymore — production-style credit
      // moved to POST /player/harvest. We keep these constants at zero
      // so the response shape (offlineTrickle echo) stays stable for
      // older clients that read it; new clients ignore the echo and
      // compute pending from base.buildings[i].pendingHarvest instead.
      const gainedSugar = 0;
      const gainedLeaf = 0;
      const gainedMilk = 0;
      const newMilkResidual = player.aphid_milk_residual ?? 0;
      const newSugar = BigInt(player.sugar);
      const newLeaf = BigInt(player.leaf_bits);
      const newMilk = BigInt(player.aphid_milk);
      const tick = incomePerSecond(base.snapshot);
      const caps = storageCaps(base.snapshot);

      // Login streak resolution. Runs on the /me path so every client
      // session goes through it once on boot. `resolveStreak` is pure:
      // decides whether today counts as a fresh credit, a no-op, or a
      // broken streak (with a comeback flag if the gap was >= 3 days).
      const resolved = resolveStreak(
        player.streak_count,
        player.streak_last_day,
        player.comeback_pending,
      );
      // Auto-unlock queen skins that the player's current state qualifies
      // for. Additive only — existing owned skins stick. Using a Set
      // avoids duplicate ids from a re-scan.
      const ownedSet = new Set<string>(player.queen_skins ?? ['default']);
      const candidates = scanUnlockedSkins({
        trophies: player.trophies,
        streakCount: resolved.streakCount,
        seasonXp: player.season_xp,
        campaignChapter: player.campaign_chapter,
      });
      for (const id of candidates) ownedSet.add(id);
      const ownedList = Array.from(ownedSet);
      const skinsChanged = ownedList.length !== (player.queen_skins?.length ?? 0);

      if (
        gainedSugar + gainedLeaf + gainedMilk > 0 ||
        elapsedSec > 0 ||
        resolved.creditedToday ||
        skinsChanged
      ) {
        await client.query(
          `UPDATE players
             SET sugar = $2,
                 leaf_bits = $3,
                 aphid_milk = $4,
                 aphid_milk_residual = $9,
                 last_seen_at = NOW(),
                 streak_count = $5,
                 streak_last_day = $6,
                 comeback_pending = $7,
                 queen_skins = $8::text[]
           WHERE id = $1`,
          [
            playerId,
            newSugar.toString(),
            newLeaf.toString(),
            newMilk.toString(),
            resolved.streakCount,
            resolved.lastDay,
            resolved.comebackPending,
            ownedList,
            newMilkResidual,
          ],
        );
      }
      await client.query('COMMIT');

      return {
        player: {
          id: player.id,
          displayName: player.display_name,
          faction: player.faction,
          trophies: player.trophies,
          sugar: safeBigintToNumber(newSugar.toString(), 'sugar', app.log),
          leafBits: safeBigintToNumber(newLeaf.toString(), 'leaf_bits', app.log),
          aphidMilk: safeBigintToNumber(newMilk.toString(), 'aphid_milk', app.log),
          unitLevels: player.unit_levels ?? {},
          createdAt: player.created_at.toISOString(),
          // Retention-loop surface area on /me so the client can
          // decorate HomeScene without a second round-trip on boot.
          shieldExpiresAt: player.shield_expires_at
            ? player.shield_expires_at.toISOString()
            : null,
          seasonId: player.season_id,
          seasonXp: player.season_xp,
          seasonMilestonesClaimed: player.season_milestones_claimed ?? [],
          // Stickiness features. Additive: client treats any missing
          // field as a safe default so older servers stay compatible.
          streak: {
            count: resolved.streakCount,
            lastDay: resolved.lastDay,
            lastClaim: player.streak_last_claim,
            creditedToday: resolved.creditedToday,
            comebackPending: resolved.comebackPending,
            nextReward: rewardForDay(resolved.streakCount),
            rewards: STREAK_REWARDS,
            comebackReward: COMEBACK_REWARD,
          },
          nemesis: player.nemesis_player_id
            ? {
                playerId: player.nemesis_player_id,
                stars: player.nemesis_stars ?? 0,
                setAt: player.nemesis_set_at
                  ? player.nemesis_set_at.toISOString()
                  : null,
                avenged: player.nemesis_avenged,
              }
            : null,
          queenSkin: {
            equipped: player.queen_skin_id,
            owned: ownedList,
          },
          tutorialStage: player.tutorial_stage,
          campaign: {
            chapter: player.campaign_chapter,
            progress: player.campaign_progress,
          },
          // Storage caps (§6.8 of GDD) — derived from base economy
          // buildings so the HUD can render `current / cap` headroom
          // text without re-deriving the formula client-side.
          storage: {
            sugarCap: caps.sugar,
            leafCap: caps.leafBits,
            // Opt-in milk cap: null until the player has at least
            // one alive MilkPot. The HUD renders "1.2k / 8k" when
            // a number lands here and a raw "1.2k" otherwise.
            milkCap: caps.aphidMilk,
          },
          // Per-second production from active producer buildings, so
          // the HUD can render "+X/sec" pills without needing to walk
          // the base.snapshot itself or duplicate INCOME_PER_SECOND.
          incomePerSecond: tick,
          // Colony Rank (§6.7) — meta progression. Surfaced so the
          // client can render the rank badge + per-raid loot cap hint
          // before the player commits to a target. Compute rank once
          // and reuse — the formula is pure but the BigInt parse +
          // log2 call is still wasted work on every /me roundtrip.
          colony: (() => {
            const totalInvestedRaw = player.total_invested ?? '0';
            const rank = colonyRankFromInvested(totalInvestedRaw);
            return {
              totalInvested: safeBigintToNumber(totalInvestedRaw, 'total_invested', app.log),
              rank,
              lootCap: lootCapForRank(rank),
            };
          })(),
          // Clanmate-donated units waiting to be deployed in the next
          // raid. RaidScene merges these into the deck on raid start;
          // /raid/submit zeroes them on success (war-army-style:
          // refilled per raid, expire whether-or-not used).
          donationInventory: player.donation_inventory ?? {},
          // Hero ownership echoed on /me so RaidScene can build the
          // hero deck slots without an extra round-trip on raid open.
          heroes: {
            owned: player.hero_ownership ?? {},
            equipped: player.hero_equipped ?? [],
            chestClaimed: !!player.hero_chest_claimed,
          },
        },
        base: base.snapshot,
        offlineTrickle: {
          secondsElapsed: elapsedSec,
          sugarGained: gainedSugar,
          leafGained: gainedLeaf,
          milkGained: gainedMilk,
        },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'player/me failed');
      reply.code(500);
      return { error: 'lookup failed' };
    } finally {
      client.release();
    }
  });

  // POST /player/harvest — claim every producer's pending bucket at
  // once. CoC-style "Collect All" tap. The wallet credit is clamped
  // to the storage cap (sugar + leaf), milk is uncapped, and each
  // claimed producer's `lastHarvestAt` resets to NOW so its bucket
  // restarts from zero. Returns the new wallet + base snapshot so
  // the client can swap state without a follow-up /me.
  app.post('/player/harvest', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pRes = await client.query<PlayerRow>(
        'SELECT * FROM players WHERE id = $1',
        [playerId],
      );
      if (pRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'player not found' };
      }
      const bRes = await client.query<BaseRow>(
        'SELECT * FROM bases WHERE player_id = $1 FOR UPDATE',
        [playerId],
      );
      if (bRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'base not found' };
      }
      const player = pRes.rows[0]!;
      const base = bRes.rows[0]!;

      // Walk producers, sum buckets, drain them.
      let sumSugar = 0;
      let sumLeaf = 0;
      let sumMilk = 0;
      const nowIso = new Date().toISOString();
      let touched = 0;
      for (const b of base.snapshot.buildings) {
        const pending = b.pendingHarvest;
        if (!pending) continue;
        sumSugar += pending.sugar;
        sumLeaf += pending.leafBits;
        sumMilk += pending.aphidMilk;
        delete b.pendingHarvest;
        b.lastHarvestAt = nowIso;
        touched += 1;
      }

      // Storage cap clamp on every harvested resource. Sugar + leaf
      // always have caps; milk's cap is opt-in via MilkPot and stays
      // null when the base has no pots (existing behaviour). Loot
      // bypass is unrelated to harvest so we don't touch raid loot.
      const caps = storageCaps(base.snapshot);
      const sugarCapBig = BigInt(caps.sugar);
      const leafCapBig = BigInt(caps.leafBits);
      const existingSugar = BigInt(player.sugar);
      const existingLeaf = BigInt(player.leaf_bits);
      const existingMilk = BigInt(player.aphid_milk);
      const sugarRoom = sugarCapBig > existingSugar ? sugarCapBig - existingSugar : 0n;
      const leafRoom = leafCapBig > existingLeaf ? leafCapBig - existingLeaf : 0n;
      const sugarCredit = BigInt(sumSugar) > sugarRoom ? sugarRoom : BigInt(sumSugar);
      const leafCredit = BigInt(sumLeaf) > leafRoom ? leafRoom : BigInt(sumLeaf);
      let milkCredit = BigInt(sumMilk);
      if (caps.aphidMilk !== null) {
        const milkCapBig = BigInt(caps.aphidMilk);
        const milkRoom = milkCapBig > existingMilk ? milkCapBig - existingMilk : 0n;
        if (milkCredit > milkRoom) milkCredit = milkRoom;
      }

      const newSugar = existingSugar + sugarCredit;
      const newLeaf = existingLeaf + leafCredit;
      const newMilk = BigInt(player.aphid_milk) + milkCredit;

      // Persist wallet + base snapshot. Empty harvests still bump the
      // snapshot's lastHarvestAt anchors so a player who keeps tapping
      // "Collect All" with nothing pending doesn't desync the bucket
      // math — but we skip the UPDATE entirely if nothing actually
      // changed to avoid version bumps on no-op taps.
      if (touched > 0) {
        base.snapshot = {
          ...base.snapshot,
          version: (base.snapshot.version ?? 0) + 1,
        };
        await client.query(
          `UPDATE bases SET snapshot = $2::jsonb, version = version + 1, updated_at = NOW()
            WHERE player_id = $1`,
          [playerId, JSON.stringify(base.snapshot)],
        );
        await client.query(
          `UPDATE players SET sugar = $2, leaf_bits = $3, aphid_milk = $4 WHERE id = $1`,
          [playerId, newSugar.toString(), newLeaf.toString(), newMilk.toString()],
        );
      }
      await client.query('COMMIT');

      return {
        player: {
          sugar: safeBigintToNumber(newSugar.toString(), 'sugar', app.log),
          leafBits: safeBigintToNumber(newLeaf.toString(), 'leaf_bits', app.log),
          aphidMilk: safeBigintToNumber(newMilk.toString(), 'aphid_milk', app.log),
        },
        base: base.snapshot,
        harvested: {
          sugar: Number(sugarCredit),
          leafBits: Number(leafCredit),
          aphidMilk: Number(milkCredit),
        },
        // The DELTA between what was banked and what was clamped —
        // lets the client surface a "storage full" toast without
        // re-deriving the math.
        overflow: {
          sugar: sumSugar - Number(sugarCredit),
          leafBits: sumLeaf - Number(leafCredit),
          aphidMilk: sumMilk - Number(milkCredit),
        },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'player/harvest failed');
      reply.code(500);
      return { error: 'harvest failed' };
    } finally {
      client.release();
    }
  });

  // Recent raids involving the player (attacker OR defender). Used by
  // HomeScene to show a revenge button / recent activity feed.
  app.get('/player/raids', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const limit = Math.max(1, Math.min(50, Number((req.query as { limit?: string } | null)?.limit) || 20));

    const res = await pool.query<{
      id: string;
      attacker_id: string;
      defender_id: string | null;
      attacker_name: string | null;
      defender_name: string | null;
      stars: number;
      sugar_looted: string;
      leaf_looted: string;
      attacker_trophies_delta: number;
      defender_trophies_delta: number;
      created_at: Date;
    }>(
      `SELECT r.id, r.attacker_id, r.defender_id,
              ap.display_name AS attacker_name,
              dp.display_name AS defender_name,
              r.stars, r.sugar_looted, r.leaf_looted,
              r.attacker_trophies_delta, r.defender_trophies_delta,
              r.created_at
         FROM raids r
         LEFT JOIN players ap ON ap.id = r.attacker_id
         LEFT JOIN players dp ON dp.id = r.defender_id
        WHERE r.attacker_id = $1 OR r.defender_id = $1
        ORDER BY r.created_at DESC
        LIMIT $2`,
      [playerId, limit],
    );

    return {
      raids: res.rows.map((r) => ({
        id: r.id,
        role: r.attacker_id === playerId ? ('attacker' as const) : ('defender' as const),
        opponentId: r.attacker_id === playerId ? r.defender_id : r.attacker_id,
        opponentName:
          (r.attacker_id === playerId ? r.defender_name : r.attacker_name) ??
          (r.defender_id === null ? 'Beetle Outpost (bot)' : 'Unknown'),
        stars: r.stars,
        sugarLooted: safeBigintToNumber(r.sugar_looted, 'sugar_looted', app.log),
        leafLooted: safeBigintToNumber(r.leaf_looted, 'leaf_looted', app.log),
        trophyDelta:
          r.attacker_id === playerId
            ? r.attacker_trophies_delta
            : r.defender_trophies_delta,
        createdAt: r.created_at.toISOString(),
      })),
    };
  });

  interface PutBaseBody {
    base: Types.Base;
  }
  app.put<{ Body: PutBaseBody }>('/player/base', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const body = req.body;
    if (!body || !body.base || typeof body.base !== 'object') {
      reply.code(400);
      return { error: 'base payload required' };
    }
    // Cheap sanity checks. Full structural validation lives in @hive/shared
    // types (compile-time) — at runtime we guard against obvious tampering.
    const base = body.base;
    if (
      !Array.isArray(base.buildings) ||
      base.buildings.length > MAX_BUILDINGS_PER_BASE ||
      !base.gridSize ||
      typeof base.gridSize.w !== 'number' ||
      typeof base.gridSize.h !== 'number' ||
      base.gridSize.w > 24 ||
      base.gridSize.h > 20
    ) {
      reply.code(400);
      return { error: 'invalid base shape' };
    }

    const res = await pool.query(
      `UPDATE bases
         SET snapshot = $2,
             faction = $3,
             version = version + 1,
             updated_at = NOW()
       WHERE player_id = $1`,
      [playerId, base, base.faction],
    );
    if (res.rowCount === 0) {
      reply.code(404);
      return { error: 'base not found for player' };
    }
    return { ok: true, version: 'incremented' };
  });

  // POST /api/player/building — place a new building.
  // Body: { kind, anchor: { x, y, layer } }
  // Server owns the id, footprint, HP, cost validation, resource debit.
  // All in a single transaction so a crash mid-flight never leaves a
  // half-placed building or silently-debited player.
  interface PlaceBuildingBody {
    kind: Types.BuildingKind;
    anchor: { x: number; y: number; layer: Types.Layer };
  }
  app.post<{ Body: PlaceBuildingBody }>('/player/building', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const body = req.body;
    if (
      !body || !body.kind || !body.anchor ||
      typeof body.anchor.x !== 'number' ||
      typeof body.anchor.y !== 'number' ||
      (body.anchor.layer !== 0 && body.anchor.layer !== 1)
    ) {
      reply.code(400);
      return { error: 'kind + anchor{x,y,layer} required' };
    }
    if (!isPlayerPlaceable(body.kind)) {
      reply.code(400);
      return { error: `${body.kind} is not player-placeable` };
    }
    const defaults = BUILDING_DEFAULTS[body.kind];
    const cost = BUILDING_PLACEMENT_COSTS[body.kind];
    if (!defaults || !cost) {
      reply.code(400);
      return { error: 'unknown building kind' };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const baseRes = await client.query<{ snapshot: Types.Base }>(
        'SELECT snapshot FROM bases WHERE player_id = $1 FOR UPDATE',
        [playerId],
      );
      if (baseRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'base not found' };
      }
      const base = baseRes.rows[0]!.snapshot;

      // Town-builder layer rule: defensive buildings (turrets, walls,
      // bunkers, dew collectors) live on the surface; the nursery and
      // vault are safe underground; tunnels and traps span both.
      if (!isLayerAllowed(body.kind, body.anchor.layer)) {
        await client.query('ROLLBACK');
        reply.code(400);
        return {
          error: `${body.kind} can't be placed on the ${body.anchor.layer === 0 ? 'surface' : 'underground'} layer`,
        };
      }

      // Town-builder quota rule: each kind has a per-Queen-level cap.
      // Until the Queen upgrades, extra slots stay locked. This is
      // the core "town hall tier" gating knob borrowed from every
      // PvP town-builder of the last decade.
      const qLevel = queenLevel(base);
      const cap = quotaFor(body.kind, qLevel);
      const existingOfKind = countOfKind(base, body.kind);
      if (existingOfKind >= cap) {
        await client.query('ROLLBACK');
        reply.code(409);
        return {
          error: `${body.kind} cap reached (${existingOfKind}/${cap}) at Queen level ${qLevel}. Upgrade the Queen to unlock more slots.`,
          cap,
          currentCount: existingOfKind,
          queenLevel: qLevel,
        };
      }

      // Bounds check inside the base grid.
      if (
        body.anchor.x < 0 ||
        body.anchor.y < 0 ||
        body.anchor.x + defaults.w > base.gridSize.w ||
        body.anchor.y + defaults.h > base.gridSize.h
      ) {
        await client.query('ROLLBACK');
        reply.code(400);
        return { error: 'building extends outside grid' };
      }

      // Collision check. The candidate building occupies every layer in
      // its `spans` (or just its anchor layer for single-layer buildings
      // like the current player-placeable set); an existing building
      // blocks every layer in ITS spans. Walk every candidate layer and
      // bail on the first overlap so forward-compatibility with future
      // multi-layer placeable kinds is built in.
      const candidateLayers = new Set<Types.Layer>(
        defaults.spans ?? [body.anchor.layer],
      );
      for (const existing of base.buildings) {
        const existingLayers = new Set<Types.Layer>(
          existing.spans ?? [existing.anchor.layer],
        );
        // Quick reject if the layer sets don't intersect.
        let layersIntersect = false;
        for (const layer of candidateLayers) {
          if (existingLayers.has(layer)) {
            layersIntersect = true;
            break;
          }
        }
        if (!layersIntersect) continue;
        const ex = existing.anchor.x;
        const ey = existing.anchor.y;
        const ew = existing.footprint.w;
        const eh = existing.footprint.h;
        const overlaps =
          body.anchor.x < ex + ew &&
          body.anchor.x + defaults.w > ex &&
          body.anchor.y < ey + eh &&
          body.anchor.y + defaults.h > ey;
        if (overlaps) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: 'tile occupied' };
        }
      }
      if (base.buildings.length >= MAX_BUILDINGS_PER_BASE) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: `base at building cap (${MAX_BUILDINGS_PER_BASE})` };
      }

      // Debit resources first (fails atomically if insufficient).
      const debitRes = await client.query<{
        trophies: number;
        sugar: string;
        leaf_bits: string;
        aphid_milk: string;
      }>(
        `UPDATE players
            SET sugar          = sugar - $2,
                leaf_bits      = leaf_bits - $3,
                aphid_milk     = aphid_milk - $4,
                total_invested = total_invested + ($2 + $3),
                last_seen_at   = NOW()
          WHERE id = $1
            AND sugar >= $2
            AND leaf_bits >= $3
            AND aphid_milk >= $4
      RETURNING trophies, sugar, leaf_bits, aphid_milk`,
        [playerId, cost.sugar, cost.leafBits, cost.aphidMilk],
      );
      if (debitRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(402); // Payment Required
        return { error: 'insufficient resources', cost };
      }

      // Build the Types.Building row, mutate the snapshot, persist.
      const id = `b-${randomBytes(6).toString('hex')}`;
      const newBuilding: Types.Building = {
        id,
        kind: body.kind,
        anchor: body.anchor,
        footprint: { w: defaults.w, h: defaults.h },
        level: 1,
        hp: defaults.hp,
        hpMax: defaults.hp,
        ...(defaults.spans ? { spans: defaults.spans } : {}),
      };
      const updatedBase: Types.Base = {
        ...base,
        buildings: [...base.buildings, newBuilding],
        version: (base.version ?? 0) + 1,
      };
      await client.query(
        `UPDATE bases
            SET snapshot = $2::jsonb,
                version = version + 1,
                updated_at = NOW()
          WHERE player_id = $1`,
        [playerId, JSON.stringify(updatedBase)],
      );

      // Daily-quest progress: "place a building" flips to complete on
      // the first placement of the day. Cheap — read+refresh the
      // JSONB column, apply the transition, write back. Failure here
      // shouldn't undo a successful placement, so the query is
      // best-effort and doesn't gate COMMIT.
      try {
        const qRes = await client.query<{ daily_quests: unknown }>(
          'SELECT daily_quests FROM players WHERE id = $1 FOR UPDATE',
          [playerId],
        );
        if (qRes.rows.length > 0) {
          const fresh = refreshIfStale(qRes.rows[0]!.daily_quests, playerId);
          const updated = applyPlacementProgress(fresh);
          await client.query(
            'UPDATE players SET daily_quests = $2::jsonb WHERE id = $1',
            [playerId, JSON.stringify(updated)],
          );
        }
      } catch (err) {
        app.log.warn({ err }, 'placement quest progress update failed (non-fatal)');
      }

      await client.query('COMMIT');
      const debited = debitRes.rows[0]!;
      return {
        ok: true,
        building: newBuilding,
        base: updatedBase,
        player: {
          trophies: debited.trophies,
          sugar: safeBigintToNumber(debited.sugar, 'sugar', app.log),
          leafBits: safeBigintToNumber(debited.leaf_bits, 'leaf_bits', app.log),
          aphidMilk: safeBigintToNumber(debited.aphid_milk, 'aphid_milk', app.log),
        },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'player/building POST failed');
      reply.code(500);
      return { error: 'placement failed' };
    } finally {
      client.release();
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/player/building/:id',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
      }
      // sanity check id shape — server-generated ids are b-<12 hex>
      const id = req.params.id;
      if (!/^[a-z0-9][a-z0-9-_]{1,63}$/i.test(id)) {
        reply.code(400);
        return { error: 'invalid building id' };
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const baseRes = await client.query<{ snapshot: Types.Base }>(
          'SELECT snapshot FROM bases WHERE player_id = $1 FOR UPDATE',
          [playerId],
        );
        if (baseRes.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'base not found' };
        }
        const base = baseRes.rows[0]!.snapshot;
        const before = base.buildings.length;
        // Protect the QueenChamber — deleting it would brick the base.
        const target = base.buildings.find((b) => b.id === id);
        if (!target) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'building not found' };
        }
        if (target.kind === 'QueenChamber') {
          await client.query('ROLLBACK');
          reply.code(400);
          return { error: 'cannot delete the Queen Chamber' };
        }
        const updated: Types.Base = {
          ...base,
          buildings: base.buildings.filter((b) => b.id !== id),
          version: (base.version ?? 0) + 1,
        };
        await client.query(
          `UPDATE bases
              SET snapshot = $2::jsonb,
                  version = version + 1,
                  updated_at = NOW()
            WHERE player_id = $1`,
          [playerId, JSON.stringify(updated)],
        );
        await client.query('COMMIT');
        return { ok: true, base: updated, removed: before - updated.buildings.length };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'player/building DELETE failed');
        reply.code(500);
        return { error: 'delete failed' };
      } finally {
        client.release();
      }
    },
  );

  // POST /api/player/building/:id/move — relocate a building to a new
  // anchor on the same base. Free of charge (matches the standard
  // town-builder UX where moving is always free; only placement and
  // upgrades cost resources). Runs the same bounds + collision + layer
  // checks the placement route uses, minus the cost debit and the
  // per-kind quota check (the building is already counted toward its
  // quota — we're just changing coordinates).
  interface MoveBuildingBody {
    anchor: { x: number; y: number; layer: Types.Layer };
  }
  app.post<{ Params: { id: string }; Body: MoveBuildingBody }>(
    '/player/building/:id/move',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const body = req.body;
      if (
        !body || !body.anchor ||
        typeof body.anchor.x !== 'number' ||
        typeof body.anchor.y !== 'number' ||
        (body.anchor.layer !== 0 && body.anchor.layer !== 1)
      ) {
        reply.code(400);
        return { error: 'anchor{x,y,layer} required' };
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const baseRes = await client.query<{ snapshot: Types.Base }>(
          'SELECT snapshot FROM bases WHERE player_id = $1 FOR UPDATE',
          [playerId],
        );
        if (baseRes.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'base not found' };
        }
        const base = baseRes.rows[0]!.snapshot;
        const target = base.buildings.find((b) => b.id === req.params.id);
        if (!target) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'building not found' };
        }
        // Multi-layer buildings (the Queen Chamber spans both) can't
        // change their anchor layer — the sim relies on the Queen
        // living on both layers simultaneously. Allow x/y moves but
        // reject a layer swap that would break the multi-layer model.
        if (
          target.spans &&
          target.spans.length > 1 &&
          !target.spans.includes(body.anchor.layer)
        ) {
          await client.query('ROLLBACK');
          reply.code(400);
          return { error: 'this building cannot change layer' };
        }
        if (!isLayerAllowed(target.kind, body.anchor.layer)) {
          await client.query('ROLLBACK');
          reply.code(400);
          return {
            error: `${target.kind} can't be placed on the ${body.anchor.layer === 0 ? 'surface' : 'underground'} layer`,
          };
        }

        // Bounds check against the grid.
        if (
          body.anchor.x < 0 ||
          body.anchor.y < 0 ||
          body.anchor.x + target.footprint.w > base.gridSize.w ||
          body.anchor.y + target.footprint.h > base.gridSize.h
        ) {
          await client.query('ROLLBACK');
          reply.code(400);
          return { error: 'new location extends outside the grid' };
        }

        // Collision check. The candidate rectangle is the target's
        // existing footprint moved to the new anchor. Skip the target
        // itself — the new location may legitimately overlap the
        // building's current tile if it's a 1-tile shift.
        //
        // Multi-layer buildings (Queen Chamber) keep their spans;
        // single-layer buildings adopt the requested anchor layer.
        const candidateLayers = new Set<Types.Layer>(
          target.spans && target.spans.length > 1
            ? target.spans
            : [body.anchor.layer],
        );
        for (const existing of base.buildings) {
          if (existing.id === target.id) continue;
          const existingLayers = new Set<Types.Layer>(
            existing.spans ?? [existing.anchor.layer],
          );
          let intersect = false;
          for (const layer of candidateLayers) {
            if (existingLayers.has(layer)) {
              intersect = true;
              break;
            }
          }
          if (!intersect) continue;
          const ex = existing.anchor.x;
          const ey = existing.anchor.y;
          const ew = existing.footprint.w;
          const eh = existing.footprint.h;
          const overlaps =
            body.anchor.x < ex + ew &&
            body.anchor.x + target.footprint.w > ex &&
            body.anchor.y < ey + eh &&
            body.anchor.y + target.footprint.h > ey;
          if (overlaps) {
            await client.query('ROLLBACK');
            reply.code(409);
            return { error: 'tile occupied' };
          }
        }

        const updated: Types.Base = {
          ...base,
          buildings: base.buildings.map((b) =>
            b.id === target.id
              ? {
                  ...b,
                  anchor: {
                    x: body.anchor.x,
                    y: body.anchor.y,
                    // Preserve the spans anchor layer on multi-layer
                    // buildings so we never flip a spans[0] = 0 into a
                    // spans[0] = 1 state. Single-layer buildings adopt
                    // the requested layer.
                    layer: b.spans && b.spans.length > 1
                      ? b.anchor.layer
                      : body.anchor.layer,
                  },
                }
              : b,
          ),
          version: (base.version ?? 0) + 1,
        };
        await client.query(
          `UPDATE bases
              SET snapshot = $2::jsonb,
                  version = version + 1,
                  updated_at = NOW()
            WHERE player_id = $1`,
          [playerId, JSON.stringify(updated)],
        );
        await client.query('COMMIT');
        return {
          ok: true,
          base: updated,
          building: updated.buildings.find((b) => b.id === target.id),
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'player/building move failed');
        reply.code(500);
        return { error: 'move failed' };
      } finally {
        client.release();
      }
    },
  );

  // POST /api/player/building/:id/rotate — spin a building in 90-degree
  // steps. Purely cosmetic: rotation is stored on the building and
  // used by the client renderer to tilt the sprite. The sim ignores
  // it (collision boxes stay axis-aligned, which matches the
  // "walls are a grid" feel of the genre).
  //
  // Request body is optional. Without a body we just cycle +90°;
  // with `{ rotation: 0|1|2|3 }` we set an explicit orientation —
  // useful for an admin UI that paints arrow buttons around the
  // sprite and wants deterministic values.
  interface RotateBuildingBody { rotation?: 0 | 1 | 2 | 3 }
  app.post<{ Params: { id: string }; Body: RotateBuildingBody | null }>(
    '/player/building/:id/rotate',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const body = req.body ?? {};
      const explicit = body.rotation;
      if (
        explicit !== undefined &&
        explicit !== 0 && explicit !== 1 && explicit !== 2 && explicit !== 3
      ) {
        reply.code(400);
        return { error: 'rotation must be 0, 1, 2 or 3' };
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const baseRes = await client.query<{ snapshot: Types.Base }>(
          'SELECT snapshot FROM bases WHERE player_id = $1 FOR UPDATE',
          [playerId],
        );
        if (baseRes.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'base not found' };
        }
        const base = baseRes.rows[0]!.snapshot;
        const target = base.buildings.find((b) => b.id === req.params.id);
        if (!target) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'building not found' };
        }
        // Queen chamber stays axis-aligned — its combined surface +
        // underground silhouette doesn't read well rotated.
        if (target.kind === 'QueenChamber') {
          await client.query('ROLLBACK');
          reply.code(400);
          return { error: 'the Queen Chamber cannot be rotated' };
        }
        const current: 0 | 1 | 2 | 3 = (target.rotation ?? 0) as 0 | 1 | 2 | 3;
        const next: 0 | 1 | 2 | 3 =
          explicit !== undefined
            ? explicit
            : (((current + 1) % 4) as 0 | 1 | 2 | 3);
        const updated: Types.Base = {
          ...base,
          buildings: base.buildings.map((b) =>
            b.id === target.id ? { ...b, rotation: next } : b,
          ),
          version: (base.version ?? 0) + 1,
        };
        await client.query(
          `UPDATE bases
              SET snapshot = $2::jsonb,
                  version = version + 1,
                  updated_at = NOW()
            WHERE player_id = $1`,
          [playerId, JSON.stringify(updated)],
        );
        await client.query('COMMIT');
        return {
          ok: true,
          base: updated,
          building: updated.buildings.find((b) => b.id === target.id),
          rotation: next,
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'player/building rotate failed');
        reply.code(500);
        return { error: 'rotate failed' };
      } finally {
        client.release();
      }
    },
  );

  // PUT /api/player/building/:id/ai — replace the full rule list on a
  // single building. Keeping it as a REPLACE (not append) makes the
  // client editor trivial: build the new list locally, send it, done.
  //
  // Validates each rule against the shape + per-kind + per-combo
  // whitelist. Also enforces the per-base rule quota that scales with
  // Queen level (rules are a mid-game unlock at queen L3).
  interface SetRulesBody {
    rules: Types.BuildingAIRule[];
  }
  app.put<{ Params: { id: string }; Body: SetRulesBody }>(
    '/player/building/:id/ai',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const body = req.body;
      if (!body || !Array.isArray(body.rules)) {
        reply.code(400);
        return { error: 'rules array required' };
      }
      if (body.rules.length > MAX_RULES_PER_BUILDING) {
        reply.code(400);
        return { error: `too many rules (max ${MAX_RULES_PER_BUILDING} per building)` };
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const baseRes = await client.query<{ snapshot: Types.Base }>(
          'SELECT snapshot FROM bases WHERE player_id = $1 FOR UPDATE',
          [playerId],
        );
        if (baseRes.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'base not found' };
        }
        const base = baseRes.rows[0]!.snapshot;
        const qLevel = queenLevel(base);
        if (qLevel < RULES_UNLOCK_QUEEN_LEVEL) {
          await client.query('ROLLBACK');
          reply.code(403);
          return {
            error: `Defender AI unlocks at Queen level ${RULES_UNLOCK_QUEEN_LEVEL}`,
          };
        }
        const building = base.buildings.find((b) => b.id === req.params.id);
        if (!building) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'building not found' };
        }

        // Per-rule validation.
        for (const r of body.rules) {
          const err = validateRule(r, building.kind);
          if (err) {
            await client.query('ROLLBACK');
            reply.code(400);
            return { error: err.message, code: err.code };
          }
        }

        // Base-wide quota: cap on total rules across all buildings,
        // scales with Queen level.
        const quota = baseRuleQuota(qLevel);
        const priorOnThisBuilding = building.aiRules?.length ?? 0;
        const totalNow = countRulesInBase(base);
        const totalAfter = totalNow - priorOnThisBuilding + body.rules.length;
        if (totalAfter > quota) {
          await client.query('ROLLBACK');
          reply.code(409);
          return {
            error: `Base rule quota reached (${totalAfter}/${quota}) — upgrade Queen for more`,
            quota,
          };
        }

        // Assign stable ids to any rule the client sent without one,
        // matching the ID pattern the rest of the codebase uses.
        const assigned = body.rules.map((r, i) => ({
          ...r,
          id: r.id && typeof r.id === 'string' && r.id.length > 0
            ? r.id
            : `${req.params.id}-r${Date.now()}-${i}`,
        }));

        const updated: Types.Base = {
          ...base,
          buildings: base.buildings.map((b) =>
            b.id === req.params.id
              ? { ...b, aiRules: assigned }
              : b,
          ),
          version: (base.version ?? 0) + 1,
        };
        await client.query(
          `UPDATE bases
              SET snapshot = $2::jsonb,
                  version = version + 1,
                  updated_at = NOW()
            WHERE player_id = $1`,
          [playerId, JSON.stringify(updated)],
        );
        await client.query('COMMIT');
        return {
          ok: true,
          base: updated,
          building: updated.buildings.find((b) => b.id === req.params.id),
          quota,
          rulesUsed: totalAfter,
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'building/ai PUT failed');
        reply.code(500);
        return { error: 'update failed' };
      } finally {
        client.release();
      }
    },
  );

  // GET /api/player/ai-rules/catalog — enumerates every legal trigger,
  // effect, their params, and the allowed (trigger, effect) combos.
  // The client rule editor renders dropdowns off this so balance
  // changes don't need a client redeploy.
  app.get('/player/ai-rules/catalog', async () => {
    return aiRuleCatalog();
  });

  // Costs + catalog for the client picker. Keeps the source of truth
  // on the server — clients never compute cost or quotas locally.
  // `rules` carries the per-kind layer + quota-by-tier table so the
  // picker can disable slots (wrong layer / over cap) with a clear
  // inline explanation, rather than round-tripping to the placement
  // route only to bounce with a 400.
  app.get('/player/building/catalog', async () => {
    return {
      placeable: Object.fromEntries(
        Object.entries(BUILDING_PLACEMENT_COSTS).filter(([k]) =>
          isPlayerPlaceable(k as Types.BuildingKind),
        ),
      ),
      rules: buildingRulesPayload(),
      maxQueenLevel: MAX_QUEEN_LEVEL,
      // Full upgrade cost-curve table (base-cost multipliers per
      // pre-upgrade level, L1→L2 first) + per-kind income/sec so the
      // client-side building info modal can render accurate preview
      // costs and production stats without duplicating the tables.
      levelCostMult: LEVEL_COST_MULT,
      // ALL upgradeable building kinds, not just player-placeable,
      // because the Queen Chamber + pre-placed starter buildings also
      // need upgrade previews. Server still ignores a request to
      // upgrade a non-upgradeable kind.
      baseCost: BUILDING_PLACEMENT_COSTS,
      incomePerSecond: INCOME_PER_SECOND,
      // Queen upgrade cost curve, one entry per L→L+1 step. The
      // modal uses this to render an affordability preview for the
      // Queen Chamber the same way it does for regular buildings —
      // server is still authoritative on the debit at submit time.
      queenUpgradeCost: QUEEN_UPGRADE_COST,
    };
  });

  // Queen upgrade — the core town-hall-tier loop. Advancing the Queen
  // raises the per-kind caps in QUOTA_BY_TIER and unlocks kinds that
  // had zero slots at the previous tier. Costs scale by level.
  app.post('/player/upgrade-queen', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const baseRes = await client.query<{ snapshot: Types.Base }>(
        'SELECT snapshot FROM bases WHERE player_id = $1 FOR UPDATE',
        [playerId],
      );
      if (baseRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'base not found' };
      }
      const base = baseRes.rows[0]!.snapshot;
      const currentLevel = queenLevel(base);
      if (currentLevel >= MAX_QUEEN_LEVEL) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: `Queen already at max level (${MAX_QUEEN_LEVEL})` };
      }
      const cost = QUEEN_UPGRADE_COST[currentLevel - 1];
      if (!cost) {
        await client.query('ROLLBACK');
        reply.code(500);
        return { error: 'queen upgrade cost lookup failed' };
      }

      // Atomic debit + snapshot mutation. Same pattern as upgrade-unit.
      const debitRes = await client.query<{
        sugar: string;
        leaf_bits: string;
        aphid_milk: string;
        trophies: number;
      }>(
        `UPDATE players
            SET sugar          = sugar - $2,
                leaf_bits      = leaf_bits - $3,
                aphid_milk     = aphid_milk - $4,
                total_invested = total_invested + ($2 + $3),
                last_seen_at   = NOW()
          WHERE id = $1
            AND sugar >= $2
            AND leaf_bits >= $3
            AND aphid_milk >= $4
      RETURNING sugar, leaf_bits, aphid_milk, trophies`,
        [playerId, cost.sugar, cost.leafBits, cost.aphidMilk],
      );
      if (debitRes.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(402);
        return { error: 'insufficient resources', cost };
      }

      const updated: Types.Base = {
        ...base,
        buildings: base.buildings.map((b) =>
          b.kind === 'QueenChamber' ? { ...b, level: currentLevel + 1 } : b,
        ),
        version: (base.version ?? 0) + 1,
      };
      await client.query(
        `UPDATE bases
            SET snapshot = $2::jsonb,
                version = version + 1,
                updated_at = NOW()
          WHERE player_id = $1`,
        [playerId, JSON.stringify(updated)],
      );
      await client.query('COMMIT');
      const debited = debitRes.rows[0]!;
      return {
        ok: true,
        newQueenLevel: currentLevel + 1,
        base: updated,
        player: {
          trophies: debited.trophies,
          sugar: safeBigintToNumber(debited.sugar, 'sugar', app.log),
          leafBits: safeBigintToNumber(debited.leaf_bits, 'leaf_bits', app.log),
          aphidMilk: safeBigintToNumber(debited.aphid_milk, 'aphid_milk', app.log),
        },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'upgrade-queen failed');
      reply.code(500);
      return { error: 'queen upgrade failed' };
    } finally {
      client.release();
    }
  });

  void MIN_QUEEN_LEVEL;

  // Unit upgrade catalog + current levels. Clients use this to render
  // the upgrade screen; cost scaling is always re-computed server-side
  // before a debit.
  app.get('/player/upgrades', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const res = await pool.query<{
      unit_levels: Record<string, number>;
      sugar: string;
      leaf_bits: string;
    }>(
      'SELECT unit_levels, sugar, leaf_bits FROM players WHERE id = $1',
      [playerId],
    );
    if (res.rows.length === 0) {
      reply.code(404);
      return { error: 'player not found' };
    }
    const row = res.rows[0]!;
    const levels = row.unit_levels ?? {};
    const catalog = upgradeCatalog();
    // For each kind, compute the "next level cost" so the client can
    // render affordability without re-deriving the ramp.
    const entries = Object.entries(catalog).map(([kind, base]) => {
      const level = levels[kind] ?? 1;
      const next = upgradeCost(kind as Types.UnitKind, level);
      return {
        kind,
        level,
        maxLevel: base.maxLevel,
        nextCost: next,
        // Queen level required to deploy this kind. Upgrade UI greys
        // out cards and surfaces the requirement before the player
        // spends on a unit they can't yet field.
        unlockQueenLevel: base.unlockQueenLevel,
      };
    });
    return {
      units: entries,
      resources: {
        sugar: safeBigintToNumber(row.sugar, 'sugar', app.log),
        leafBits: safeBigintToNumber(row.leaf_bits, 'leaf_bits', app.log),
      },
    };
  });

  // --- Streak claim ---------------------------------------------------------
  //
  // Pay out the reward for the player's CURRENT streak day. Idempotent:
  // if streak_last_claim already matches streak_count, the endpoint
  // 409s. Comeback pack is claimed separately (and clears the flag).
  app.post('/player/streak/claim', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query<{
        streak_count: number;
        streak_last_claim: number;
      }>(
        'SELECT streak_count, streak_last_claim FROM players WHERE id = $1 FOR UPDATE',
        [playerId],
      );
      if (lock.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'player not found' };
      }
      const row = lock.rows[0]!;
      if (row.streak_last_claim >= row.streak_count) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: 'streak reward already claimed for today' };
      }
      const reward = rewardForDay(row.streak_count);
      const upd = await client.query<{
        sugar: string;
        leaf_bits: string;
        aphid_milk: string;
      }>(
        `UPDATE players
            SET sugar        = sugar + $2,
                leaf_bits    = leaf_bits + $3,
                aphid_milk   = aphid_milk + $4,
                streak_last_claim = $5
          WHERE id = $1
      RETURNING sugar, leaf_bits, aphid_milk`,
        [playerId, reward.sugar, reward.leafBits, reward.aphidMilk, row.streak_count],
      );
      await client.query('COMMIT');
      const r = upd.rows[0]!;
      return {
        ok: true,
        streakDay: row.streak_count,
        reward,
        resources: {
          sugar: safeBigintToNumber(r.sugar, 'sugar', app.log),
          leafBits: safeBigintToNumber(r.leaf_bits, 'leaf_bits', app.log),
          aphidMilk: safeBigintToNumber(r.aphid_milk, 'aphid_milk', app.log),
        },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'streak/claim failed');
      reply.code(500);
      return { error: 'streak claim failed' };
    } finally {
      client.release();
    }
  });

  app.post('/player/comeback/claim', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const upd = await pool.query<{
      sugar: string;
      leaf_bits: string;
      aphid_milk: string;
      was_pending: boolean;
    }>(
      `UPDATE players
          SET sugar      = sugar + $2,
              leaf_bits  = leaf_bits + $3,
              aphid_milk = aphid_milk + $4,
              comeback_pending = FALSE
        WHERE id = $1
          AND comeback_pending = TRUE
    RETURNING sugar, leaf_bits, aphid_milk, TRUE AS was_pending`,
      [playerId, COMEBACK_REWARD.sugar, COMEBACK_REWARD.leafBits, COMEBACK_REWARD.aphidMilk],
    );
    if (upd.rows.length === 0) {
      reply.code(409);
      return { error: 'no comeback bonus pending' };
    }
    const r = upd.rows[0]!;
    return {
      ok: true,
      reward: COMEBACK_REWARD,
      resources: {
        sugar: safeBigintToNumber(r.sugar, 'sugar', app.log),
        leafBits: safeBigintToNumber(r.leaf_bits, 'leaf_bits', app.log),
        aphidMilk: safeBigintToNumber(r.aphid_milk, 'aphid_milk', app.log),
      },
    };
  });

  // --- Queen skins ----------------------------------------------------------
  app.get('/player/queen-skins', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const res = await pool.query<{
      queen_skins: string[];
      queen_skin_id: string;
    }>(
      'SELECT queen_skins, queen_skin_id FROM players WHERE id = $1',
      [playerId],
    );
    if (res.rows.length === 0) {
      reply.code(404);
      return { error: 'player not found' };
    }
    return {
      catalog: QUEEN_SKINS,
      owned: res.rows[0]!.queen_skins,
      equipped: res.rows[0]!.queen_skin_id,
    };
  });

  interface EquipQueenBody { skinId: string }
  app.post<{ Body: EquipQueenBody }>(
    '/player/queen-skins/equip',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const body = req.body;
      if (!body || typeof body.skinId !== 'string') {
        reply.code(400);
        return { error: 'skinId required' };
      }
      if (!skinById(body.skinId)) {
        reply.code(400);
        return { error: 'unknown skinId' };
      }
      const res = await pool.query<{
        queen_skins: string[];
        queen_skin_id: string;
      }>(
        `UPDATE players
            SET queen_skin_id = $2
          WHERE id = $1
            AND $2 = ANY(queen_skins)
      RETURNING queen_skins, queen_skin_id`,
        [playerId, body.skinId],
      );
      if (res.rows.length === 0) {
        reply.code(403);
        return { error: 'skin not owned' };
      }
      return {
        ok: true,
        equipped: res.rows[0]!.queen_skin_id,
        owned: res.rows[0]!.queen_skins,
      };
    },
  );

  // --- Heroes ---------------------------------------------------------------
  // GET /player/heroes — full catalog + the player's ownership /
  // equipped state. The client merges these into one screen of
  // cards. Catalog ships from shared/types/heroes.ts so the client
  // can also import HERO_CATALOG directly; sending it on the wire
  // means a future server-side balance change ships without a
  // client redeploy.
  app.get('/player/heroes', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const res = await pool.query<Pick<PlayerRow,
      'hero_ownership' | 'hero_equipped' | 'hero_chest_claimed' | 'sugar' | 'aphid_milk'
    >>(
      `SELECT hero_ownership, hero_equipped, hero_chest_claimed, sugar, aphid_milk
         FROM players WHERE id = $1`,
      [playerId],
    );
    if (res.rows.length === 0) {
      reply.code(404);
      return { error: 'player not found' };
    }
    const row = res.rows[0]!;
    const ownedCount = Object.keys(row.hero_ownership ?? {}).length;
    return {
      catalog: HERO_CATALOG,
      ladder: HERO_PRICE_LADDER,
      maxEquipped: MAX_EQUIPPED_HEROES,
      ownership: {
        owned: row.hero_ownership ?? {},
        equipped: row.hero_equipped ?? [],
        chestClaimed: !!row.hero_chest_claimed,
      },
      // Cost the NEXT buy (not chest) would charge. The chest gift
      // is free, so when chestClaimed = false the client should
      // call /heroes/chest-claim instead of /heroes/buy.
      nextBuyCost: HERO_PRICE_LADDER[
        Math.min(HERO_PRICE_LADDER.length - 1, ownedCount)
      ],
      wallet: {
        sugar: safeBigintToNumber(String(row.sugar), 'sugar', app.log),
        aphidMilk: safeBigintToNumber(String(row.aphid_milk), 'aphid_milk', app.log),
      },
    };
  });

  // POST /player/heroes/chest-claim — first-hero free gift. Body
  // selects which hero to receive; idempotent (a second call after
  // claim returns the existing state).
  interface HeroClaimBody { kind: HeroKind }
  app.post<{ Body: HeroClaimBody }>('/player/heroes/chest-claim', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const body = req.body ?? ({} as HeroClaimBody);
    if (!body.kind || !HERO_CATALOG[body.kind]) {
      reply.code(400);
      return { error: 'unknown hero kind' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<Pick<PlayerRow,
        'hero_ownership' | 'hero_equipped' | 'hero_chest_claimed'
      >>(
        `SELECT hero_ownership, hero_equipped, hero_chest_claimed
           FROM players WHERE id = $1 FOR UPDATE`,
        [playerId],
      );
      if (r.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'player not found' };
      }
      const row = r.rows[0]!;
      if (row.hero_chest_claimed) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: 'chest already claimed' };
      }
      const owned = { ...(row.hero_ownership ?? {}), [body.kind]: true };
      // Auto-equip the new hero so the player isn't asked twice
      // (claim → equip). A first-time claim with no other heroes
      // lands directly in the equipped slot.
      const equipped = Array.isArray(row.hero_equipped) ? [...row.hero_equipped] : [];
      if (equipped.length < MAX_EQUIPPED_HEROES && !equipped.includes(body.kind)) {
        equipped.push(body.kind);
      }
      await client.query(
        `UPDATE players
            SET hero_ownership = $2::jsonb,
                hero_equipped = $3::jsonb,
                hero_chest_claimed = TRUE
          WHERE id = $1`,
        [playerId, JSON.stringify(owned), JSON.stringify(equipped)],
      );
      await client.query('COMMIT');
      return {
        ok: true,
        ownership: { owned, equipped, chestClaimed: true },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'player/heroes/chest-claim failed');
      reply.code(500);
      return { error: 'claim failed' };
    } finally {
      client.release();
    }
  });

  // POST /player/heroes/buy — purchase the Nth hero per the price
  // ladder. The Nth (0-indexed) bought hero pays HERO_PRICE_LADDER[N].
  // Index 0 is the free chest gift, so we start at index 1.
  interface HeroBuyBody { kind: HeroKind }
  app.post<{ Body: HeroBuyBody }>('/player/heroes/buy', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const body = req.body ?? ({} as HeroBuyBody);
    if (!body.kind || !HERO_CATALOG[body.kind]) {
      reply.code(400);
      return { error: 'unknown hero kind' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<Pick<PlayerRow,
        'hero_ownership' | 'hero_equipped' | 'sugar' | 'aphid_milk'
      >>(
        `SELECT hero_ownership, hero_equipped, sugar, aphid_milk
           FROM players WHERE id = $1 FOR UPDATE`,
        [playerId],
      );
      if (r.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'player not found' };
      }
      const row = r.rows[0]!;
      const ownedMap = (row.hero_ownership ?? {}) as Record<string, true>;
      if (ownedMap[body.kind]) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: 'hero already owned' };
      }
      const ownedCount = Object.keys(ownedMap).length;
      // Index 0 = free chest gift slot. The first BUY is at
      // ladder index 1 (assuming chest already claimed). If a player
      // tries to buy without claiming, we still charge from index 1
      // — they're skipping the free reward of their own accord.
      const ladderIdx = Math.max(1, Math.min(HERO_PRICE_LADDER.length - 1, ownedCount));
      const cost = HERO_PRICE_LADDER[ladderIdx]!;
      const sugarHave = BigInt(row.sugar);
      const milkHave = BigInt(row.aphid_milk);
      if (sugarHave < BigInt(cost.sugar) || milkHave < BigInt(cost.aphidMilk)) {
        await client.query('ROLLBACK');
        reply.code(402);
        return {
          error: 'insufficient resources',
          needSugar: cost.sugar,
          needMilk: cost.aphidMilk,
          haveSugar: Number(sugarHave),
          haveMilk: Number(milkHave),
        };
      }
      const newSugar = (sugarHave - BigInt(cost.sugar)).toString();
      const newMilk = (milkHave - BigInt(cost.aphidMilk)).toString();
      const newOwned = { ...ownedMap, [body.kind]: true };
      const equipped = Array.isArray(row.hero_equipped) ? [...row.hero_equipped] : [];
      if (equipped.length < MAX_EQUIPPED_HEROES && !equipped.includes(body.kind)) {
        equipped.push(body.kind);
      }
      await client.query(
        `UPDATE players
            SET hero_ownership = $2::jsonb,
                hero_equipped = $3::jsonb,
                sugar = $4,
                aphid_milk = $5
          WHERE id = $1`,
        [playerId, JSON.stringify(newOwned), JSON.stringify(equipped), newSugar, newMilk],
      );
      await client.query('COMMIT');
      return {
        ok: true,
        ownership: { owned: newOwned, equipped, chestClaimed: true },
        wallet: {
          sugar: safeBigintToNumber(newSugar, 'sugar', app.log),
          aphidMilk: safeBigintToNumber(newMilk, 'aphid_milk', app.log),
        },
        spent: cost,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'player/heroes/buy failed');
      reply.code(500);
      return { error: 'buy failed' };
    } finally {
      client.release();
    }
  });

  // POST /player/heroes/equip — toggle a hero in/out of the
  // equipped slot. Caps at MAX_EQUIPPED_HEROES; equipping a
  // 3rd while two are slotted returns 409.
  interface HeroEquipBody { kind: HeroKind; equipped: boolean }
  app.post<{ Body: HeroEquipBody }>('/player/heroes/equip', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }
    const body = req.body ?? ({} as HeroEquipBody);
    if (!body.kind || !HERO_CATALOG[body.kind]) {
      reply.code(400);
      return { error: 'unknown hero kind' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<Pick<PlayerRow, 'hero_ownership' | 'hero_equipped'>>(
        `SELECT hero_ownership, hero_equipped FROM players WHERE id = $1 FOR UPDATE`,
        [playerId],
      );
      if (r.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'player not found' };
      }
      const row = r.rows[0]!;
      const ownedMap = (row.hero_ownership ?? {}) as Record<string, true>;
      if (!ownedMap[body.kind]) {
        await client.query('ROLLBACK');
        reply.code(403);
        return { error: 'hero not owned' };
      }
      let equipped = Array.isArray(row.hero_equipped) ? [...row.hero_equipped] : [];
      if (body.equipped) {
        if (equipped.includes(body.kind)) {
          // Idempotent — already equipped is a no-op.
        } else if (equipped.length >= MAX_EQUIPPED_HEROES) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: `cannot equip more than ${MAX_EQUIPPED_HEROES} heroes` };
        } else {
          equipped.push(body.kind);
        }
      } else {
        equipped = equipped.filter((k) => k !== body.kind);
      }
      await client.query(
        `UPDATE players SET hero_equipped = $2::jsonb WHERE id = $1`,
        [playerId, JSON.stringify(equipped)],
      );
      await client.query('COMMIT');
      return { ok: true, equipped };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'player/heroes/equip failed');
      reply.code(500);
      return { error: 'equip failed' };
    } finally {
      client.release();
    }
  });

  // --- Tutorial / prologue stage --------------------------------------------
  interface TutorialBody { stage: number }
  app.post<{ Body: TutorialBody }>('/player/tutorial', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const body = req.body;
    if (!body || !Number.isInteger(body.stage)) {
      reply.code(400);
      return { error: 'stage required' };
    }
    const stage = Math.max(0, Math.min(100, body.stage));
    await pool.query(
      `UPDATE players
          SET tutorial_stage = GREATEST(tutorial_stage, $2)
        WHERE id = $1`,
      [playerId, stage],
    );
    return { ok: true, stage };
  });

  // --- Nemesis snapshot -----------------------------------------------------
  //
  // Returns a hydrated view of the player's current nemesis — the rival
  // who most recently hurt us. Computed from the raid log + the stamped
  // nemesis_player_id column. Includes a cheap "online-ish" heuristic
  // based on `last_seen_at` so HomeScene can pulse the revenge badge
  // when the nemesis is plausibly available to raid back.
  app.get('/player/nemesis', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const me = await pool.query<{
      nemesis_player_id: string | null;
      nemesis_stars: number | null;
      nemesis_set_at: Date | null;
      nemesis_avenged: boolean;
    }>(
      `SELECT nemesis_player_id, nemesis_stars, nemesis_set_at, nemesis_avenged
         FROM players WHERE id = $1`,
      [playerId],
    );
    if (me.rows.length === 0 || !me.rows[0]!.nemesis_player_id) {
      return { nemesis: null };
    }
    const n = me.rows[0]!;
    const who = await pool.query<{
      id: string;
      display_name: string;
      trophies: number;
      faction: string;
      queen_skin_id: string;
      last_seen_at: Date;
    }>(
      `SELECT id, display_name, trophies, faction, queen_skin_id, last_seen_at
         FROM players WHERE id = $1`,
      [n.nemesis_player_id],
    );
    if (who.rows.length === 0) {
      // Nemesis account disappeared; clear the stamp.
      await pool.query(
        'UPDATE players SET nemesis_player_id = NULL WHERE id = $1',
        [playerId],
      );
      return { nemesis: null };
    }
    const w = who.rows[0]!;
    const onlineRecent = Date.now() - w.last_seen_at.getTime() < 15 * 60 * 1000;
    return {
      nemesis: {
        playerId: w.id,
        displayName: w.display_name,
        trophies: w.trophies,
        faction: w.faction,
        queenSkinId: w.queen_skin_id,
        stars: n.nemesis_stars ?? 0,
        setAt: n.nemesis_set_at ? n.nemesis_set_at.toISOString() : null,
        avenged: n.nemesis_avenged,
        onlineRecent,
      },
    };
  });

  interface UpgradeUnitBody {
    kind: Types.UnitKind;
  }
  app.post<{ Body: UpgradeUnitBody }>(
    '/player/upgrade-unit',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
      }
      const body = req.body;
      if (!body || typeof body.kind !== 'string') {
        reply.code(400);
        return { error: 'kind required' };
      }
      if (!isUpgradeableUnit(body.kind as HiveTypes.UnitKind)) {
        reply.code(400);
        return { error: `${body.kind} is not upgradeable` };
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const lock = await client.query<{
          unit_levels: Record<string, number>;
          sugar: string;
          leaf_bits: string;
        }>(
          'SELECT unit_levels, sugar, leaf_bits FROM players WHERE id = $1 FOR UPDATE',
          [playerId],
        );
        if (lock.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'player not found' };
        }
        const currentLevels = lock.rows[0]!.unit_levels ?? {};
        const currentLevel = currentLevels[body.kind] ?? 1;
        if (currentLevel >= MAX_UNIT_LEVEL) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: `already at max level (${MAX_UNIT_LEVEL})` };
        }
        const cost = upgradeCost(body.kind as HiveTypes.UnitKind, currentLevel);
        if (!cost) {
          await client.query('ROLLBACK');
          reply.code(400);
          return { error: 'cannot compute cost' };
        }

        // Atomic resource debit + level increment. One round-trip avoids
        // a TOCTOU gap between the SELECT FOR UPDATE above and the
        // update we're about to do. Returns the new resource totals.
        const upd = await client.query<{
          sugar: string;
          leaf_bits: string;
          unit_levels: Record<string, number>;
        }>(
          `UPDATE players
              SET sugar          = sugar - $2,
                  leaf_bits      = leaf_bits - $3,
                  total_invested = total_invested + ($2 + $3),
                  unit_levels = jsonb_set(
                    COALESCE(unit_levels, '{}'::jsonb),
                    ARRAY[$4::text],
                    to_jsonb($5::int),
                    true
                  )
            WHERE id = $1
              AND sugar >= $2
              AND leaf_bits >= $3
          RETURNING sugar, leaf_bits, unit_levels`,
          [playerId, cost.sugar, cost.leafBits, body.kind, currentLevel + 1],
        );
        if (upd.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(402);
          return { error: 'insufficient resources', cost };
        }
        await client.query('COMMIT');
        const r = upd.rows[0]!;
        return {
          ok: true,
          kind: body.kind,
          newLevel: currentLevel + 1,
          unitLevels: r.unit_levels,
          resources: {
            sugar: safeBigintToNumber(r.sugar, 'sugar', app.log),
            leafBits: safeBigintToNumber(r.leaf_bits, 'leaf_bits', app.log),
          },
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'upgrade-unit failed');
        reply.code(500);
        return { error: 'upgrade failed' };
      } finally {
        client.release();
      }
    },
  );

  // POST /api/player/upgrade-building — bump a single building by one
  // level. Reuses the same Fibonacci-ish cost curve as units, scaled
  // by the building's L1 placement cost. Atomic: debit + bump happen
  // in one transaction so an error leaves the base + resources in
  // sync. The QueenChamber upgrade lives on its own route
  // (/player/upgrade-queen) and is rejected here.
  interface UpgradeBuildingBody { buildingId: string }
  app.post<{ Body: UpgradeBuildingBody }>(
    '/player/upgrade-building',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const body = req.body;
      if (!body || typeof body.buildingId !== 'string') {
        reply.code(400);
        return { error: 'buildingId required' };
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const baseRes = await client.query<{ snapshot: Types.Base }>(
          'SELECT snapshot FROM bases WHERE player_id = $1 FOR UPDATE',
          [playerId],
        );
        if (baseRes.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'base not found' };
        }
        const base = baseRes.rows[0]!.snapshot;
        const target = base.buildings.find((b) => b.id === body.buildingId);
        if (!target) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'building not found' };
        }
        if (target.kind === 'QueenChamber') {
          await client.query('ROLLBACK');
          reply.code(400);
          return { error: 'use /player/upgrade-queen for the Queen' };
        }
        const currentLevel = target.level ?? 1;
        if (currentLevel >= MAX_UNIT_LEVEL) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: `already at max level (${MAX_UNIT_LEVEL})` };
        }
        // Reject queueing on a building that's already mid-upgrade —
        // each building has at most one pending job at a time. Player
        // must wait it out (or pay milk to skip) before queuing again.
        if (target.pendingCompletesAt) {
          await client.query('ROLLBACK');
          reply.code(409);
          return {
            error: 'building is already upgrading',
            pendingCompletesAt: target.pendingCompletesAt,
            pendingToLevel: target.pendingToLevel,
          };
        }
        const mult = upgradeCostMult(currentLevel);
        if (mult === null) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: 'building already at max level' };
        }
        const base_cost = BUILDING_PLACEMENT_COSTS[target.kind];
        if (!base_cost) {
          await client.query('ROLLBACK');
          reply.code(400);
          return { error: `${target.kind} can't be upgraded` };
        }
        const cost = {
          sugar: Math.floor(base_cost.sugar * mult),
          leafBits: Math.floor(base_cost.leafBits * mult),
          aphidMilk: 0,
        };

        // Debit resources up-front. Builder gates take cost at queue
        // time (CoC pattern) — refunds on cancel are not yet supported,
        // so once you queue you've spent. The level bump itself is
        // delayed until the timer elapses; /me lazily promotes
        // expired pending jobs on next read.
        const debit = await client.query<{
          sugar: string;
          leaf_bits: string;
          aphid_milk: string;
          trophies: number;
        }>(
          `UPDATE players
              SET sugar          = sugar - $2,
                  leaf_bits      = leaf_bits - $3,
                  total_invested = total_invested + ($2 + $3)
            WHERE id = $1
              AND sugar >= $2
              AND leaf_bits >= $3
        RETURNING sugar, leaf_bits, aphid_milk, trophies`,
          [playerId, cost.sugar, cost.leafBits],
        );
        if (debit.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(402);
          return { error: 'insufficient resources', cost };
        }

        // Stamp the pending fields. completesAt is computed server-
        // side from buildTimeMs(currentLevel) so client-supplied
        // timestamps never make it into authoritative state.
        const targetLevel = currentLevel + 1;
        const completesAt = new Date(Date.now() + buildTimeMs(currentLevel)).toISOString();
        const updatedBuildings = base.buildings.map((b) => {
          if (b.id !== body.buildingId) return b;
          return { ...b, pendingCompletesAt: completesAt, pendingToLevel: targetLevel };
        });
        const updated: Types.Base = {
          ...base,
          buildings: updatedBuildings,
          version: (base.version ?? 0) + 1,
        };
        await client.query(
          `UPDATE bases
              SET snapshot = $2::jsonb,
                  version = version + 1,
                  updated_at = NOW()
            WHERE player_id = $1`,
          [playerId, JSON.stringify(updated)],
        );
        await client.query('COMMIT');
        const r = debit.rows[0]!;
        return {
          ok: true,
          buildingId: body.buildingId,
          // Echo back the QUEUED level (not the current). Client uses
          // this to render the pending state immediately.
          pendingToLevel: targetLevel,
          pendingCompletesAt: completesAt,
          cost,
          base: updated,
          player: {
            trophies: r.trophies,
            sugar: safeBigintToNumber(r.sugar, 'sugar', app.log),
            leafBits: safeBigintToNumber(r.leaf_bits, 'leaf_bits', app.log),
            aphidMilk: safeBigintToNumber(r.aphid_milk, 'aphid_milk', app.log),
          },
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'upgrade-building failed');
        reply.code(500);
        return { error: 'building upgrade failed' };
      } finally {
        client.release();
      }
    },
  );

  // POST /api/player/builder/skip — pay AphidMilk to instantly
  // complete a pending building upgrade. Skip cost is computed from
  // the remaining time via skipCostMilk() — paying when there's only
  // 1 second left costs 1 milk, paying right after queue costs the
  // full skip price. The bump itself runs the same finalization
  // logic as /me's lazy promotion.
  interface BuilderSkipBody { buildingId: string }
  app.post<{ Body: BuilderSkipBody }>(
    '/player/builder/skip',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const body = req.body;
      if (!body || typeof body.buildingId !== 'string') {
        reply.code(400);
        return { error: 'buildingId required' };
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const baseRes = await client.query<{ snapshot: Types.Base }>(
          'SELECT snapshot FROM bases WHERE player_id = $1 FOR UPDATE',
          [playerId],
        );
        if (baseRes.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'base not found' };
        }
        const base = baseRes.rows[0]!.snapshot;
        const target = base.buildings.find((b) => b.id === body.buildingId);
        if (!target) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'building not found' };
        }
        if (!target.pendingCompletesAt || !target.pendingToLevel) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: 'building has no pending upgrade' };
        }
        const remaining = remainingMsAt(target.pendingCompletesAt, Date.now());
        const cost = skipCostMilk(remaining);

        // Debit the milk price atomically.
        const debit = await client.query<{
          aphid_milk: string;
          sugar: string;
          leaf_bits: string;
          trophies: number;
        }>(
          `UPDATE players
              SET aphid_milk = aphid_milk - $2
            WHERE id = $1 AND aphid_milk >= $2
        RETURNING aphid_milk, sugar, leaf_bits, trophies`,
          [playerId, cost],
        );
        if (debit.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(402);
          return { error: 'insufficient aphid milk', cost };
        }

        // Promote the pending bump immediately via the shared helper.
        // We spread the target into a fresh object so the mutation
        // doesn't reach back into the array slot we still hold a
        // reference to via base.buildings — finalizePendingUpgrade
        // mutates in place and the spread keeps the swap-by-id contract
        // below safe.
        const promoted: Types.Building = { ...target };
        finalizePendingUpgrade(promoted);
        const newLevel = promoted.level;
        const updatedBuildings = base.buildings.map((b) =>
          b.id === body.buildingId ? promoted : b,
        );
        const updated: Types.Base = {
          ...base,
          buildings: updatedBuildings,
          version: (base.version ?? 0) + 1,
        };
        await client.query(
          `UPDATE bases
              SET snapshot = $2::jsonb,
                  version = version + 1,
                  updated_at = NOW()
            WHERE player_id = $1`,
          [playerId, JSON.stringify(updated)],
        );
        await client.query('COMMIT');
        const r = debit.rows[0]!;
        return {
          ok: true,
          buildingId: body.buildingId,
          newLevel,
          milkSpent: cost,
          base: updated,
          player: {
            trophies: r.trophies,
            sugar: safeBigintToNumber(r.sugar, 'sugar', app.log),
            leafBits: safeBigintToNumber(r.leaf_bits, 'leaf_bits', app.log),
            aphidMilk: safeBigintToNumber(r.aphid_milk, 'aphid_milk', app.log),
          },
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'builder/skip failed');
        reply.code(500);
        return { error: 'builder skip failed' };
      } finally {
        client.release();
      }
    },
  );
}
