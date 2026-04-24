import Phaser from 'phaser';
import type { HiveRuntime } from '../main.js';
import type { ClanWarCurrentResponse, WarTargetResponse } from '../net/Api.js';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import {
  drawSceneAmbient,
  drawSceneHud,
  makeScrollBody,
  formatCountdown,
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

// ClanWarsScene — the synchronous group retention lever.
// Shows the active war (if any), the score, and the "Attack war target"
// primary CTA. Resolves a war opponent from the opposing clan and
// hands the client to RaidScene with a matchToken pointing at that
// base.

export class ClanWarsScene extends Phaser.Scene {
  constructor() { super('ClanWarsScene'); }

  create(): void {
    fadeInScene(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    drawSceneAmbient(this);
    drawSceneHud(this, 'Clan Wars', 'ClanScene');
    const body = makeScrollBody(this);
    const loading = crispText(
      this,
      this.scale.width / 2,
      140,
      'Checking the war room...',
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
      const state = await runtime.api.warCurrent();
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
    state: ClanWarCurrentResponse,
    runtime: HiveRuntime,
  ): void {
    body.container.removeAll(true);
    const maxW = Math.min(680, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    let y = 0;

    if (!state.inClan) {
      body.container.add(
        crispText(this, originX, y,
          'Join a clan first.',
          displayTextStyle(18, COLOR.textGold, 3),
        ),
      );
      y += 36;
      body.container.add(
        crispText(this, originX, y,
          'Clan wars are 24-hour paired battles: both clans attack matching bases, total stars decide the winner. You have to be in a clan to play.',
          bodyTextStyle(13, COLOR.textDim),
        ).setWordWrapWidth(maxW, true),
      );
      y += 72;
      const btn = makeHiveButton(this, {
        x: originX + maxW / 2,
        y: y + 22,
        width: 200,
        height: 44,
        label: 'Find a clan',
        variant: 'primary',
        fontSize: 14,
        onPress: () => fadeToScene(this, 'ClanScene'),
      });
      body.container.add(btn.container);
      body.setContentHeight(y + 80);
      return;
    }

    if (!state.war) {
      body.container.add(
        crispText(this, originX, y,
          'No active war.',
          displayTextStyle(18, COLOR.textGold, 3),
        ),
      );
      y += 36;
      body.container.add(
        crispText(this, originX, y,
          'Your clan leader starts a war against another clan. Every member of both clans has one attack shot, scored in stars. Highest-stars clan wins; ties split a smaller bonus.',
          bodyTextStyle(13, COLOR.textDim),
        ).setWordWrapWidth(maxW, true),
      );
      y += 84;
      body.container.add(
        crispText(this, originX, y,
          'Ask your leader to start one from the Clan screen.',
          bodyTextStyle(12, COLOR.textMuted),
        ),
      );
      body.setContentHeight(y + 40);
      return;
    }

    const war = state.war;
    const secondsLeft = Math.max(0, (new Date(war.endsAt).getTime() - Date.now()) / 1000);
    const myStars = war.myClanSide === 'A' ? war.starsA : war.starsB;
    const oppStars = war.myClanSide === 'A' ? war.starsB : war.starsA;
    const myAttacked = war.attacks.some(
      (a) => a.attackerPlayerId === runtime.player?.player.id,
    );

    // Header card: scoreboard
    {
      const h = 148;
      const bg = this.add.graphics();
      drawPanel(bg, originX, y, maxW, h, {
        topColor: 0x2a3f2d,
        botColor: 0x09100a,
        stroke: COLOR.brassDeep,
        strokeWidth: 3,
        highlight: COLOR.brass,
        highlightAlpha: 0.18,
        radius: 16,
        shadowOffset: 5,
        shadowAlpha: 0.32,
      });
      body.container.add(bg);
      body.container.add(
        crispText(this, originX + 16, y + 16,
          'Clan vs Clan • 24-hour war',
          labelTextStyle(11, COLOR.textMuted),
        ),
      );
      body.container.add(
        crispText(this, originX + 16, y + 40,
          `Time left: ${formatCountdown(secondsLeft)}`,
          bodyTextStyle(13, COLOR.textGold),
        ),
      );
      // Huge score
      body.container.add(
        crispText(this, originX + maxW / 2 - 60, y + 80,
          `${myStars}`,
          displayTextStyle(48, COLOR.textGold, 5),
        ).setOrigin(1, 0.5),
      );
      body.container.add(
        crispText(this, originX + maxW / 2, y + 80,
          'vs',
          bodyTextStyle(14, COLOR.textDim),
        ).setOrigin(0.5, 0.5),
      );
      body.container.add(
        crispText(this, originX + maxW / 2 + 60, y + 80,
          `${oppStars}`,
          displayTextStyle(48, '#ff9a80', 5),
        ).setOrigin(0, 0.5),
      );
      body.container.add(
        crispText(this, originX + 16, y + h - 24,
          myStars > oppStars ? 'Leading — keep pushing.' :
          myStars < oppStars ? 'Behind — find a weak base.' :
          'Tied — every attack counts.',
          bodyTextStyle(12, COLOR.textPrimary),
        ),
      );
      y += h + 12;
    }

    // Attack CTA
    if (myAttacked) {
      body.container.add(
        crispText(this, originX, y, '✓ Your attack is logged. Wait for your clan mates.',
          bodyTextStyle(13, COLOR.textGold),
        ),
      );
      y += 36;
    } else {
      const btn = makeHiveButton(this, {
        x: originX + maxW / 2,
        y: y + 28,
        width: Math.min(320, maxW - 32),
        height: 52,
        label: 'Attack war target',
        variant: 'primary',
        fontSize: 16,
        onPress: () => { void this.startWarAttack(runtime); },
      });
      body.container.add(btn.container);
      y += 80;
    }

    // Attack log
    {
      body.container.add(
        crispText(this, originX, y, 'Attacks logged', labelTextStyle(12, COLOR.textGold)),
      );
      y += 22;
      if (war.attacks.length === 0) {
        body.container.add(
          crispText(this, originX, y, 'No attacks yet.', bodyTextStyle(12, COLOR.textDim)),
        );
        y += 22;
      } else {
        for (const a of war.attacks) {
          const h = 36;
          const bg = this.add.graphics();
          drawPanel(bg, originX, y, maxW, h, {
            topColor: COLOR.bgCard, botColor: COLOR.bgInset,
            stroke: COLOR.outline, strokeWidth: 1,
            highlight: COLOR.greenHi, highlightAlpha: 0.06,
            radius: 8, shadowOffset: 2, shadowAlpha: 0.2,
          });
          body.container.add(bg);
          body.container.add(
            crispText(this, originX + 12, y + h / 2,
              a.attackerPlayerId.slice(0, 8),
              bodyTextStyle(12, COLOR.textPrimary),
            ).setOrigin(0, 0.5),
          );
          const pill = this.add.graphics();
          drawPill(pill, originX + maxW - 80, y + 8, 60, 20, { brass: true });
          body.container.add(pill);
          body.container.add(
            crispText(this, originX + maxW - 50, y + 18,
              `${a.stars}★`,
              labelTextStyle(11, '#2a1d08'),
            ).setOrigin(0.5, 0.5),
          );
          y += h + 6;
        }
      }
    }

    body.setContentHeight(y + 16);
  }

  private async startWarAttack(runtime: HiveRuntime): Promise<void> {
    try {
      const target = await runtime.api.warFindTarget();
      if (!target) { return; }
      // Stamp the war context so RaidScene submits the clan-war attack
      // alongside the normal raid.
      this.registry.set('warContext', {
        warId: target.warId,
        defenderId: target.defenderId,
      });
      // Also stamp a match payload the raid scene can consume directly
      // — matches the shape it expects from /api/match.
      this.registry.set('prefilledMatch', stampMatch(target));
      fadeToScene(this, 'RaidScene');
    } catch (err) {
      console.warn('war target failed', err);
    }
  }
}

function stampMatch(t: WarTargetResponse): unknown {
  return {
    matchToken: t.matchToken,
    defenderId: t.defenderId,
    trophiesSought: t.opponent.trophies,
    seed: t.seed,
    baseSnapshot: t.baseSnapshot,
    opponent: t.opponent,
  };
}
