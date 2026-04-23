import type { FastifyInstance } from 'fastify';
import { Sim } from '@hive/shared';
import type { Types } from '@hive/shared';
import { validateReplay } from '../replay/validator.js';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';
import { trophyDelta } from '../game/progression.js';
import { isUnitUnlocked, queenLevel } from '../game/buildingRules.js';
import { shieldHoursForStars } from '../game/shield.js';
import {
  applyRaidProgress,
  refreshIfStale,
  type RaidProgressSignals,
} from '../game/quests.js';
import { CURRENT_SEASON_ID, xpForRaid } from '../game/season.js';

// Raid submission. The client sends the matchToken it received from
// /api/match plus its input timeline and the computed result hash.
// The server looks up the AUTHORITATIVE (defenderId, seed, baseSnapshot)
// tuple by token and runs the sim against those — never against a
// client-supplied base. This closes the spoofed-base-snapshot attack.

interface RaidSubmissionBody {
  matchToken: string;
  inputs: Types.SimInput[];
  clientResultHash: string;
}

// Trophy ladder uses ELO with a trophy-tiered K-factor — see
// server/api/src/game/progression.ts::trophyDelta() and
// docs/GAME_DESIGN.md §6.5 for the design rationale. Gains scale with
// opponent strength AND with the attacker's current bracket: a new
// player at 100 trophies gains ~24 per 3★ win; a veteran at 3500+
// gains ~4. That's the self-flattening ladder.

export function registerRaid(app: FastifyInstance): void {
  app.post<{ Body: RaidSubmissionBody }>('/raid/submit', async (req, reply) => {
    const attackerId = requirePlayer(req, reply);
    if (!attackerId) return;
    const body = req.body;
    if (
      !body ||
      typeof body.matchToken !== 'string' ||
      body.matchToken.length < 16 ||
      !Array.isArray(body.inputs) ||
      typeof body.clientResultHash !== 'string'
    ) {
      reply.code(400);
      return { error: 'bad request' };
    }

    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured — set DATABASE_URL (see GET /health/db for the exact setup)' };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Pop the pending match (atomic consumption — a token is valid
      // exactly once so a replay can't be re-submitted to farm loot
      // twice).
      const popped = await client.query<{
        defender_id: string | null;
        seed: string;
        base_snapshot: Types.Base;
      }>(
        `DELETE FROM pending_matches
          WHERE token = $1 AND attacker_id = $2 AND expires_at > NOW()
          RETURNING defender_id, seed, base_snapshot`,
        [body.matchToken, attackerId],
      );
      if (popped.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'unknown, expired, or already-used match token' };
      }
      const row = popped.rows[0]!;
      const defenderId = row.defender_id;
      const seed = Number(row.seed);
      const baseSnapshot = row.base_snapshot;

      // Fetch the attacker's unit levels + trophies + base snapshot in
      // one round-trip. unit_levels feeds the sim's stat-scaling;
      // trophies feeds the ELO math below; the base snapshot's queen
      // level feeds the unit-unlock gate. LEFT JOIN so a player with
      // no row in `bases` (edge case: account created but base not yet
      // provisioned) still flows through as queen level 1.
      const lv = await client.query<{
        unit_levels: Record<string, number>;
        trophies: number;
        attacker_base: Types.Base | null;
        daily_quests: unknown;
        season_id: string;
        season_xp: number;
      }>(
        `SELECT p.unit_levels, p.trophies, b.snapshot AS attacker_base,
                p.daily_quests, p.season_id, p.season_xp
           FROM players p
           LEFT JOIN bases b ON b.player_id = p.id
          WHERE p.id = $1`,
        [attackerId],
      );
      const attackerUnitLevels = lv.rows[0]?.unit_levels ?? {};
      const attackerTrophies = lv.rows[0]?.trophies ?? 0;

      // Gate unit kinds against the attacker's own queen level. A
      // player can't deploy a unit they haven't unlocked — this is the
      // server half of the progression gate, complementing the
      // client's deck picker.
      const attackerBase = lv.rows[0]?.attacker_base ?? null;
      const attackerQueenLevel = attackerBase ? queenLevel(attackerBase) : 1;
      for (const inp of body.inputs) {
        if (inp.type !== 'deployPath') continue;
        const kind = inp.path?.unitKind;
        if (!kind || !isUnitUnlocked(kind, attackerQueenLevel)) {
          await client.query('ROLLBACK');
          reply.code(403);
          return {
            error: `unit ${String(kind)} is locked at queen level ${attackerQueenLevel}`,
          };
        }
      }

      // Authoritative replay validation runs against the server-owned
      // snapshot. A malicious client can't spoof defenses away because
      // it never gets to submit the snapshot in the first place.
      const { ok, serverHash, result } = validateReplay({
        seed,
        baseSnapshot,
        inputs: body.inputs,
        clientHash: body.clientResultHash,
        attackerUnitLevels,
      });
      if (!ok) {
        await client.query('ROLLBACK');
        reply.code(409);
        return { error: 'replay hash mismatch', serverHash };
      }

      const stars = result.stars as 0 | 1 | 2 | 3;
      // Defender trophies come from the authoritative baseSnapshot, which
      // matchmaking.ts stamps with the defender's live count at /match
      // time (bots use a fixed 80). That's close enough for ELO — the
      // small race between match and submit is within sampling noise.
      const defenderTrophies = Number(baseSnapshot.trophies ?? 0);
      const delta = trophyDelta({ stars, attackerTrophies, defenderTrophies });
      const sugarLooted = Math.max(0, result.sugarLooted);
      const leafLooted = Math.max(0, result.leafBitsLooted);

      // Retention-loop book-keeping computed from the raid result +
      // input timeline. The sim is single-source-of-truth; we only
      // _read_ from it here.
      const seasonXpGain =
        lv.rows[0]?.season_id === CURRENT_SEASON_ID ? xpForRaid(stars) : xpForRaid(stars);
      // When the season rolls over (`season_id` mismatch), the UPDATE
      // below resets the count and stamps the new id. `seasonXpGain`
      // is applied on top of that reset value.
      let unitsDeployed = 0;
      const deployedKinds = new Set<Types.UnitKind>();
      for (const inp of body.inputs) {
        if (inp.type !== 'deployPath') continue;
        unitsDeployed += inp.path?.count ?? 0;
        if (inp.path?.unitKind) deployedKinds.add(inp.path.unitKind);
      }
      const signals: RaidProgressSignals = {
        stars,
        sugarLooted,
        leafLooted,
        turretsDestroyed: result.turretsDestroyed,
        queenKilled: result.queenKilled,
        unitsDeployed,
        deployedKinds: Array.from(deployedKinds),
      };
      const freshDaily = refreshIfStale(lv.rows[0]?.daily_quests, attackerId);
      const updatedDaily = applyRaidProgress(freshDaily, signals);

      const attUpdate = await client.query<{
        trophies: number;
        sugar: string;
        leaf_bits: string;
        aphid_milk: string;
        season_xp: number;
      }>(
        `UPDATE players
            SET trophies       = GREATEST(0, trophies + $2),
                sugar          = sugar + $3,
                leaf_bits      = leaf_bits + $4,
                last_seen_at   = NOW(),
                daily_quests   = $5::jsonb,
                season_id      = $6,
                season_xp      = CASE
                                   WHEN season_id = $6 THEN season_xp + $7
                                   ELSE $7
                                 END,
                season_milestones_claimed = CASE
                                   WHEN season_id = $6 THEN season_milestones_claimed
                                   ELSE '{}'::int[]
                                 END
          WHERE id = $1
      RETURNING trophies, sugar, leaf_bits, aphid_milk, season_xp`,
        [
          attackerId,
          delta.att,
          sugarLooted,
          leafLooted,
          JSON.stringify(updatedDaily),
          CURRENT_SEASON_ID,
          seasonXpGain,
        ],
      );
      if (attUpdate.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(404);
        return { error: 'attacker not found' };
      }

      if (defenderId) {
        // Defender update with shield grant (if loss was 2+ stars).
        // shieldHours is NULL for 0/1-star raids; the CASE avoids
        // overwriting an existing longer shield with a shorter one
        // — always take the max of current + new shield end times.
        const shieldHours = shieldHoursForStars(stars);
        await client.query(
          `UPDATE players
              SET trophies  = GREATEST(0, trophies + $2),
                  sugar     = GREATEST(0, sugar - $3),
                  leaf_bits = GREATEST(0, leaf_bits - $4),
                  shield_expires_at = CASE
                    WHEN $5::int IS NULL THEN shield_expires_at
                    ELSE GREATEST(
                      COALESCE(shield_expires_at, NOW()),
                      NOW() + ($5 || ' hours')::INTERVAL
                    )
                  END
            WHERE id = $1`,
          [defenderId, delta.def, sugarLooted, leafLooted, shieldHours],
        );
      }

      // Stringify array-typed JSONB params (inputs, result). pg-node
      // auto-JSONs objects but serializes arrays as Postgres arrays,
      // which the ::jsonb cast rejects.
      const raidInsert = await client.query<{ id: string }>(
        `INSERT INTO raids
          (attacker_id, defender_id, seed, base_snapshot, inputs, result,
           stars, sugar_looted, leaf_looted,
           attacker_trophies_delta, defender_trophies_delta)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb,
                 $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          attackerId,
          defenderId,
          seed,
          JSON.stringify(baseSnapshot),
          JSON.stringify(body.inputs),
          JSON.stringify(result),
          stars,
          sugarLooted,
          leafLooted,
          delta.att,
          defenderId ? delta.def : 0,
        ],
      );

      await client.query('COMMIT');

      const att = attUpdate.rows[0]!;
      return {
        ok: true,
        replayId: raidInsert.rows[0]!.id,
        result,
        player: {
          trophies: att.trophies,
          // BIGINT-from-DB → Number narrowing. Safe for the first ~9
          // quadrillion sugar; we'll need to upgrade the wire format
          // before that matters. Logged warning in player.ts handles
          // the early-warning case.
          sugar: Number(att.sugar),
          leafBits: Number(att.leaf_bits),
          aphidMilk: Number(att.aphid_milk),
          seasonXp: att.season_xp,
          seasonXpGained: seasonXpGain,
        },
        dailyQuests: updatedDaily,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      app.log.error({ err }, 'raid/submit failed');
      reply.code(500);
      return { error: 'raid submit failed' };
    } finally {
      client.release();
    }
  });

  void Sim;
}
