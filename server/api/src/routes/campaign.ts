import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { requirePlayer } from '../auth/playerAuth.js';
import {
  CAMPAIGN_CHAPTERS,
  chapterById,
  missionById,
  computeCampaignState,
} from '../game/campaign.js';

// Seasonal narrative campaign routes. Player-facing surface:
//   GET  /api/campaign/state    — list chapters + unlocked/progress state
//   POST /api/campaign/mission/:id/complete — mark a mission cleared,
//                                    pay first-clear rewards, bump
//                                    campaign_progress.
//   POST /api/campaign/chapter/:id/claim    — claim chapter completion
//                                    reward (unlocks the skin + pays
//                                    sugar/leaf/milk).
//
// The server stores completed mission ids in the `daily_quests` JSONB
// blob under the `campaignCompleted` key, so we don't add a dedicated
// table for MVP scale. When this needs to scale, migrate to a
// `campaign_progress` table with one row per (player, mission).

export function registerCampaign(app: FastifyInstance): void {
  app.get('/campaign/state', async (req, reply) => {
    const playerId = requirePlayer(req, reply);
    if (!playerId) return;
    const pool = await getPool();
    if (!pool) {
      reply.code(503);
      return { error: 'database not configured' };
    }
    const res = await pool.query<{
      campaign_chapter: number;
      campaign_progress: number;
      daily_quests: unknown;
      queen_skins: string[];
    }>(
      `SELECT campaign_chapter, campaign_progress, daily_quests, queen_skins
         FROM players WHERE id = $1`,
      [playerId],
    );
    if (res.rows.length === 0) {
      reply.code(404);
      return { error: 'player not found' };
    }
    const row = res.rows[0]!;
    const completedMissions = readCompleted(row.daily_quests);
    const claimed = readClaimedChapters(row.daily_quests);
    const state = computeCampaignState(completedMissions, row.campaign_chapter);
    return {
      chapters: CAMPAIGN_CHAPTERS,
      playerState: {
        unlockedChapter: row.campaign_chapter,
        activeChapterId: state.activeChapterId,
        progressInChapter: state.progressInChapter,
        chapterComplete: state.chapterComplete,
        completedMissions,
        claimedChapters: claimed,
        ownedSkins: row.queen_skins,
      },
    };
  });

  app.post<{ Params: { id: string } }>(
    '/campaign/mission/:id/complete',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const id = Number(req.params.id);
      const missionInfo = missionById(id);
      if (!missionInfo) {
        reply.code(404);
        return { error: 'unknown missionId' };
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const row = await client.query<{
          campaign_chapter: number;
          daily_quests: unknown;
          sugar: string;
          leaf_bits: string;
          season_id: string;
          season_xp: number;
        }>(
          `SELECT campaign_chapter, daily_quests, sugar, leaf_bits, season_id, season_xp
             FROM players WHERE id = $1 FOR UPDATE`,
          [playerId],
        );
        if (row.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'player not found' };
        }
        const r = row.rows[0]!;
        const chapter = missionInfo.chapter;
        const mission = missionInfo.mission;
        if (chapter.id > r.campaign_chapter) {
          await client.query('ROLLBACK');
          reply.code(403);
          return { error: 'chapter locked; finish the previous one first' };
        }
        const completed = new Set<number>(readCompleted(r.daily_quests));
        const firstClear = !completed.has(mission.id);
        completed.add(mission.id);
        const jsonBag = writeCompleted(r.daily_quests, completed);
        const progress = chapter.missions.filter((m) => completed.has(m.id)).length;
        const rewardSugar = firstClear ? mission.rewardSugar : 0;
        const rewardLeaf = firstClear ? mission.rewardLeaf : 0;
        const upd = await client.query<{
          sugar: string;
          leaf_bits: string;
          season_xp: number;
        }>(
          `UPDATE players
              SET sugar = sugar + $2,
                  leaf_bits = leaf_bits + $3,
                  campaign_progress = $4,
                  daily_quests = $5::jsonb
            WHERE id = $1
        RETURNING sugar, leaf_bits, season_xp`,
          [playerId, rewardSugar, rewardLeaf, progress, JSON.stringify(jsonBag)],
        );
        await client.query('COMMIT');
        const p = upd.rows[0]!;
        return {
          ok: true,
          firstClear,
          chapterId: chapter.id,
          missionId: mission.id,
          progressInChapter: progress,
          reward: { sugar: rewardSugar, leafBits: rewardLeaf },
          resources: {
            sugar: Number(p.sugar),
            leafBits: Number(p.leaf_bits),
          },
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'campaign/mission/complete failed');
        reply.code(500);
        return { error: 'mission complete failed' };
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/campaign/chapter/:id/claim',
    async (req, reply) => {
      const playerId = requirePlayer(req, reply);
      if (!playerId) return;
      const pool = await getPool();
      if (!pool) {
        reply.code(503);
        return { error: 'database not configured' };
      }
      const chapterIdNum = Number(req.params.id);
      const chapter = chapterById(chapterIdNum);
      if (!chapter) {
        reply.code(404);
        return { error: 'unknown chapterId' };
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const row = await client.query<{
          campaign_chapter: number;
          daily_quests: unknown;
          queen_skins: string[];
        }>(
          `SELECT campaign_chapter, daily_quests, queen_skins
             FROM players WHERE id = $1 FOR UPDATE`,
          [playerId],
        );
        if (row.rows.length === 0) {
          await client.query('ROLLBACK');
          reply.code(404);
          return { error: 'player not found' };
        }
        const r = row.rows[0]!;
        const completed = new Set<number>(readCompleted(r.daily_quests));
        const allCleared = chapter.missions.every((m) => completed.has(m.id));
        if (!allCleared) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: 'chapter not fully cleared' };
        }
        const claimed = new Set<number>(readClaimedChapters(r.daily_quests));
        if (claimed.has(chapter.id)) {
          await client.query('ROLLBACK');
          reply.code(409);
          return { error: 'chapter completion already claimed' };
        }
        claimed.add(chapter.id);
        const jsonBag = writeClaimed(
          writeCompleted(r.daily_quests, completed),
          claimed,
        );

        // Unlock the next chapter + the cosmetic skin (if present).
        const nextChapter = Math.max(r.campaign_chapter, chapter.id + 1);
        const owned = new Set<string>(r.queen_skins);
        if (chapter.unlockSkinId) owned.add(chapter.unlockSkinId);

        const upd = await client.query<{
          sugar: string;
          leaf_bits: string;
          aphid_milk: string;
          queen_skins: string[];
        }>(
          `UPDATE players
              SET sugar = sugar + $2,
                  leaf_bits = leaf_bits + $3,
                  aphid_milk = aphid_milk + $4,
                  campaign_chapter = $5,
                  daily_quests = $6::jsonb,
                  queen_skins = $7::text[]
            WHERE id = $1
        RETURNING sugar, leaf_bits, aphid_milk, queen_skins`,
          [
            playerId,
            chapter.completionSugar,
            chapter.completionLeaf,
            chapter.completionAphidMilk,
            nextChapter,
            JSON.stringify(jsonBag),
            Array.from(owned),
          ],
        );
        await client.query('COMMIT');
        const p = upd.rows[0]!;
        return {
          ok: true,
          chapterId: chapter.id,
          unlockedChapter: nextChapter,
          unlockedSkinId: chapter.unlockSkinId,
          reward: {
            sugar: chapter.completionSugar,
            leafBits: chapter.completionLeaf,
            aphidMilk: chapter.completionAphidMilk,
            skinId: chapter.unlockSkinId,
          },
          resources: {
            sugar: Number(p.sugar),
            leafBits: Number(p.leaf_bits),
            aphidMilk: Number(p.aphid_milk),
          },
          ownedSkins: p.queen_skins,
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        app.log.error({ err }, 'campaign/chapter/claim failed');
        reply.code(500);
        return { error: 'chapter claim failed' };
      } finally {
        client.release();
      }
    },
  );
}

function readCompleted(dq: unknown): number[] {
  const bag = (dq as Record<string, unknown> | null) ?? {};
  const raw = bag.campaignCompleted;
  return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === 'number') : [];
}
function readClaimedChapters(dq: unknown): number[] {
  const bag = (dq as Record<string, unknown> | null) ?? {};
  const raw = bag.campaignClaimedChapters;
  return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === 'number') : [];
}
function writeCompleted(dq: unknown, completed: Set<number>): Record<string, unknown> {
  const bag = ((dq as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  return { ...bag, campaignCompleted: Array.from(completed).sort((a, b) => a - b) };
}
function writeClaimed(dq: unknown, claimed: Set<number>): Record<string, unknown> {
  const bag = ((dq as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  return { ...bag, campaignClaimedChapters: Array.from(claimed).sort((a, b) => a - b) };
}
