import Phaser from 'phaser';
import type { HiveRuntime } from '../main.js';
import type {
  CampaignChapterDef,
  CampaignStateResponse,
  CampaignMissionDef,
} from '../net/Api.js';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import {
  drawSceneAmbient,
  drawSceneHud,
  makeScrollBody,
} from '../ui/sceneFrame.js';
import { makeHiveButton } from '../ui/button.js';
import { crispText } from '../ui/text.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import {
  COLOR,
  bodyTextStyle,
  displayTextStyle,
  labelTextStyle,
} from '../ui/theme.js';

// Campaign — seasonal narrative. Chapters + missions list + scripted
// raid launcher. Selecting a mission seeds RaidScene with the chapter
// context so it completes the mission on a clear.

export class CampaignScene extends Phaser.Scene {
  constructor() { super('CampaignScene'); }

  create(): void {
    fadeInScene(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    drawSceneAmbient(this);
    drawSceneHud(this, 'Campaign', 'HomeScene');
    const body = makeScrollBody(this);
    const loading = crispText(
      this,
      this.scale.width / 2,
      140,
      'Reading the lore...',
      bodyTextStyle(14, COLOR.textDim),
    ).setOrigin(0.5);
    void this.loadData(body, loading);
  }

  private async loadData(
    body: {
      container: Phaser.GameObjects.Container;
      setContentHeight(h: number): void;
    },
    loading: Phaser.GameObjects.Text,
  ): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) { loading.setText('Offline'); return; }
    try {
      const state = await runtime.api.getCampaignState();
      if (!this.scene.isActive()) return;
      loading.destroy();
      this.render(body, state, runtime);
    } catch (err) {
      if (!this.scene.isActive()) return;
      loading.setText(`Error: ${(err as Error).message}`);
    }
  }

  private render(
    body: {
      container: Phaser.GameObjects.Container;
      setContentHeight(h: number): void;
    },
    state: CampaignStateResponse,
    runtime: HiveRuntime,
  ): void {
    body.container.removeAll(true);
    const maxW = Math.min(680, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    let y = 0;
    const done = new Set(state.playerState.completedMissions);
    const claimed = new Set(state.playerState.claimedChapters);

    // Intro blurb
    body.container.add(
      crispText(
        this,
        originX,
        y,
        'Season One: The Verdant Reawakening',
        displayTextStyle(20, COLOR.textGold, 3),
      ),
    );
    y += 32;
    body.container.add(
      crispText(
        this,
        originX,
        y,
        'Story chapters unlock as you clear them. Every chapter ends with a boss and a lasting reward — sometimes a queen skin.',
        bodyTextStyle(13, COLOR.textDim),
      ).setWordWrapWidth(maxW, true),
    );
    y += 48;

    for (const ch of state.chapters) {
      const locked = ch.id > state.playerState.unlockedChapter;
      y = this.renderChapterHeader(body.container, originX, y, maxW, ch, locked, state.playerState.activeChapterId);
      if (locked) {
        y += 18;
        continue;
      }
      for (const m of ch.missions) {
        y = this.renderMission(body.container, originX, y, maxW, ch, m, done.has(m.id), runtime);
      }

      const allCleared = ch.missions.every((mm) => done.has(mm.id));
      const isClaimed = claimed.has(ch.id);
      if (allCleared && !isClaimed) {
        y += 4;
        const btn = makeHiveButton(this, {
          x: originX + maxW / 2,
          y: y + 22,
          width: Math.min(320, maxW - 32),
          height: 48,
          label: 'Claim chapter reward',
          variant: 'primary',
          fontSize: 15,
          onPress: () => { void this.claimChapter(ch, body, runtime); },
        });
        body.container.add(btn.container);
        y += 72;
      } else if (isClaimed) {
        body.container.add(
          crispText(this, originX, y + 10, '+ chapter reward claimed', labelTextStyle(11, COLOR.textGold)),
        );
        y += 30;
      }
      y += 18;
    }
    body.setContentHeight(y);
  }

  private renderChapterHeader(
    container: Phaser.GameObjects.Container,
    originX: number,
    y: number,
    maxW: number,
    ch: CampaignChapterDef,
    locked: boolean,
    activeId: number,
  ): number {
    const h = 112;
    const bg = this.add.graphics();
    drawPanel(bg, originX, y, maxW, h, {
      topColor: locked ? 0x111811 : ch.id === activeId ? 0x2a3f2d : COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      stroke: locked ? 0x1a1a1a : COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: locked ? 0.04 : 0.14,
      radius: 14,
      shadowOffset: 4,
      shadowAlpha: 0.24,
    });
    container.add(bg);

    const pill = this.add.graphics();
    drawPill(pill, originX + 16, y + 14, 82, 20, { brass: !locked });
    container.add(pill);
    container.add(
      crispText(
        this,
        originX + 57,
        y + 24,
        ch.subtitle,
        labelTextStyle(10, locked ? COLOR.textDim : COLOR.textGold),
      ).setOrigin(0.5, 0.5),
    );
    container.add(
      crispText(
        this,
        originX + 16,
        y + 40,
        ch.title,
        displayTextStyle(18, locked ? COLOR.textDim : COLOR.textGold, 3),
      ),
    );
    container.add(
      crispText(
        this,
        originX + 16,
        y + 70,
        locked ? `Locked — finish chapter ${ch.id - 1} first.` : ch.synopsis,
        bodyTextStyle(12, COLOR.textDim),
      ).setWordWrapWidth(maxW - 32, true),
    );
    return y + h + 10;
  }

  private renderMission(
    container: Phaser.GameObjects.Container,
    originX: number,
    y: number,
    maxW: number,
    ch: CampaignChapterDef,
    m: CampaignMissionDef,
    cleared: boolean,
    runtime: HiveRuntime,
  ): number {
    const h = 76;
    const bg = this.add.graphics();
    drawPanel(bg, originX + 16, y, maxW - 32, h, {
      topColor: cleared ? 0x2a3f2d : COLOR.bgCard,
      botColor: COLOR.bgInset,
      stroke: cleared ? COLOR.brassDeep : COLOR.outline,
      strokeWidth: cleared ? 2 : 1,
      highlight: COLOR.greenHi,
      highlightAlpha: cleared ? 0.1 : 0.06,
      radius: 10,
      shadowOffset: 2,
      shadowAlpha: 0.2,
    });
    container.add(bg);

    container.add(
      crispText(
        this,
        originX + 32,
        y + 12,
        `${cleared ? '✓ ' : ''}${m.title}`,
        labelTextStyle(13, cleared ? COLOR.textGold : COLOR.textPrimary),
      ),
    );
    container.add(
      crispText(
        this,
        originX + 32,
        y + 34,
        m.intro,
        bodyTextStyle(11, COLOR.textDim),
      ).setWordWrapWidth(maxW - 200, true),
    );
    container.add(
      crispText(
        this,
        originX + maxW - 48,
        y + 12,
        m.difficulty.toUpperCase(),
        labelTextStyle(10, difficultyColor(m.difficulty)),
      ).setOrigin(1, 0),
    );
    const btn = makeHiveButton(this, {
      x: originX + maxW - 60,
      y: y + 52,
      width: 100,
      height: 28,
      label: cleared ? 'Replay' : 'Attempt',
      variant: cleared ? 'ghost' : 'primary',
      fontSize: 11,
      onPress: () => {
        // Stamp the mission on the registry so RaidScene can pick it
        // up + call /campaign/mission/:id/complete on a successful
        // run. Data is non-authoritative: the server still validates
        // the clear.
        runtime.api
          .setTutorialStage(100)
          .catch(() => undefined);
        this.registry.set('campaignMission', {
          missionId: m.id,
          chapterId: ch.id,
          title: m.title,
        });
        fadeToScene(this, 'RaidScene');
      },
    });
    container.add(btn.container);
    return y + h + 8;
  }

  private async claimChapter(
    ch: CampaignChapterDef,
    body: {
      container: Phaser.GameObjects.Container;
      setContentHeight(h: number): void;
    },
    runtime: HiveRuntime,
  ): Promise<void> {
    try {
      const r = await runtime.api.claimChapter(ch.id);
      if (runtime.player && runtime.player.player.queenSkin) {
        runtime.player.player.queenSkin = {
          ...runtime.player.player.queenSkin,
          owned: r.ownedSkins,
        };
      }
      const state = await runtime.api.getCampaignState();
      this.render(body, state, runtime);
    } catch (err) {
      console.warn('chapter claim failed', err);
    }
  }
}

function difficultyColor(d: CampaignMissionDef['difficulty']): string {
  switch (d) {
    case 'tutorial': return COLOR.greenHi as unknown as string;
    case 'easy':     return COLOR.cyan as unknown as string;
    case 'medium':   return COLOR.textGold;
    case 'hard':     return COLOR.gold as unknown as string;
    case 'boss':     return '#ff8a80';
  }
}
