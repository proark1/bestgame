import Phaser from 'phaser';
import type { HiveRuntime } from '../main.js';
import type { ReplayFeedEntry } from '../net/Api.js';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { tacticFromReplayInputs, stashTactic } from '../codex/tacticFromReplay.js';
import {
  drawSceneAmbient,
  drawSceneHud,
  makeScrollBody,
} from '../ui/sceneFrame.js';
import { makeHiveButton } from '../ui/button.js';
import { crispText } from '../ui/text.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { drawEmptyState } from '../ui/emptyState.js';
import {
  COLOR,
  bodyTextStyle,
  displayTextStyle,
  labelTextStyle,
} from '../ui/theme.js';

// ReplayFeedScene — "Top Raids of the Day" passive engagement loop.
// Shows a list of 3-star raids; tapping a row loads the replay and
// transitions to RaidScene in replay mode. Every 3 replays watched
// in a day pays out a small bonus.

export class ReplayFeedScene extends Phaser.Scene {
  private entries: ReplayFeedEntry[] = [];
  private body: {
    container: Phaser.GameObjects.Container;
    setContentHeight(h: number): void;
  } | null = null;

  constructor() { super('ReplayFeedScene'); }

  create(): void {
    fadeInScene(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    drawSceneAmbient(this);
    drawSceneHud(this, 'Top Raids', 'HomeScene');
    this.body = makeScrollBody(this);
    const loading = crispText(
      this,
      this.scale.width / 2,
      140,
      'Loading the feed...',
      bodyTextStyle(14, COLOR.textDim),
    ).setOrigin(0.5);
    void this.loadData(loading);
  }

  private async loadData(loading: Phaser.GameObjects.Text): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) { loading.setText('Offline'); return; }
    try {
      const res = await runtime.api.replayFeed(undefined, 30);
      if (!this.scene.isActive()) return;
      loading.destroy();
      this.entries = res.entries;
      this.renderFeed(runtime);
    } catch (err) {
      if (!this.scene.isActive()) return;
      loading.setText(`Error: ${(err as Error).message}`);
    }
  }

  private renderFeed(runtime: HiveRuntime): void {
    if (!this.body) return;
    this.body.container.removeAll(true);
    const maxW = Math.min(680, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    let y = 0;

    this.body.container.add(
      crispText(this, originX, y,
        'Every 3 replays watched — bonus sugar. Upvote the plays you want to see more of.',
        bodyTextStyle(12, COLOR.textDim),
      ).setWordWrapWidth(maxW, true),
    );
    y += 40;

    if (this.entries.length === 0) {
      const handle = drawEmptyState({
        scene: this, x: originX, y, width: maxW,
        glyph: '⭐',
        title: 'No featured raids yet',
        body: 'Pull off a 3-star raid and your replay lands here for the clan to watch.',
      });
      this.body.container.add(handle.container);
      this.body.setContentHeight(y + handle.height + 16);
      return;
    }

    for (const e of this.entries) {
      y = this.renderEntry(originX, maxW, y, e, runtime);
    }
    this.body.setContentHeight(y);
  }

  private renderEntry(
    originX: number,
    maxW: number,
    y: number,
    e: ReplayFeedEntry,
    runtime: HiveRuntime,
  ): number {
    const h = 96;
    const bg = this.add.graphics();
    drawPanel(bg, originX, y, maxW, h, {
      topColor: COLOR.bgCard,
      botColor: COLOR.bgInset,
      stroke: COLOR.outline,
      strokeWidth: 1,
      highlight: COLOR.greenHi,
      highlightAlpha: 0.08,
      radius: 12,
      shadowOffset: 3,
      shadowAlpha: 0.22,
    });
    if (!this.body) return y;
    this.body.container.add(bg);

    // Stars pill
    const pill = this.add.graphics();
    drawPill(pill, originX + 14, y + 14, 60, 24, { brass: e.stars >= 3 });
    this.body.container.add(pill);
    this.body.container.add(
      crispText(
        this, originX + 44, y + 26,
        `${'★'.repeat(e.stars)}${'☆'.repeat(3 - e.stars)}`,
        labelTextStyle(11, COLOR.textGold),
      ).setOrigin(0.5, 0.5),
    );

    this.body.container.add(
      crispText(this, originX + 86, y + 10,
        e.replayName,
        displayTextStyle(15, COLOR.textGold, 3),
      ).setOrigin(0, 0),
    );
    this.body.container.add(
      crispText(this, originX + 86, y + 34,
        `${e.attackerName} vs ${e.defenderName}`,
        bodyTextStyle(11, COLOR.textDim),
      ),
    );
    this.body.container.add(
      crispText(this, originX + 86, y + 52,
        `🏆 ${e.attackerTrophies}   🍬 ${e.sugarLooted}`,
        bodyTextStyle(11, COLOR.textMuted),
      ),
    );

    // Upvote button
    const upBtn = makeHiveButton(this, {
      x: originX + maxW - 246,
      y: y + h / 2,
      width: 92,
      height: 32,
      label: `${e.hasMyUpvote ? '♥' : '♡'} ${e.upvoteCount}`,
      variant: e.hasMyUpvote ? 'primary' : 'ghost',
      fontSize: 12,
      onPress: () => { void this.toggleUpvote(e, runtime); },
    });
    this.body.container.add(upBtn.container);
    // Steal — copies the attacker's first-deploy path into the local
    // tactic library. Turns "watching cool plays" into "running cool
    // plays" with one tap. Available regardless of upvote state so a
    // player can steal without endorsing.
    const stealBtn = makeHiveButton(this, {
      x: originX + maxW - 142,
      y: y + h / 2,
      width: 96,
      height: 32,
      label: '⚙ Steal',
      variant: 'ghost',
      fontSize: 12,
      onPress: () => { void this.stealTactic(e, runtime); },
    });
    this.body.container.add(stealBtn.container);
    // Watch button
    const wBtn = makeHiveButton(this, {
      x: originX + maxW - 40,
      y: y + h / 2,
      width: 80,
      height: 32,
      label: 'Watch',
      variant: 'secondary',
      fontSize: 12,
      onPress: () => { void this.watch(e, runtime); },
    });
    this.body.container.add(wBtn.container);

    // Footer line — view count + comment count side-by-side. Comment
    // count is optional (older servers omit it); render the 💬 badge
    // only when positive so we don't show a misleading "💬 0" on a
    // backend that doesn't support comments yet.
    const viewLabel = `${e.viewCount} views`;
    const footer = (e.commentCount ?? 0) > 0
      ? `${viewLabel}   💬 ${e.commentCount}`
      : viewLabel;
    this.body.container.add(
      crispText(this, originX + 14, y + h - 14,
        footer,
        bodyTextStyle(10, COLOR.textMuted),
      ),
    );
    return y + h + 8;
  }

  private async toggleUpvote(e: ReplayFeedEntry, runtime: HiveRuntime): Promise<void> {
    try {
      const r = await runtime.api.replayUpvote(e.id);
      e.hasMyUpvote = r.hasMyUpvote;
      e.upvoteCount = r.upvoteCount;
      this.renderFeed(runtime);
    } catch (err) {
      console.warn('upvote failed', err);
    }
  }

  private async stealTactic(e: ReplayFeedEntry, runtime: HiveRuntime): Promise<void> {
    try {
      const full = await runtime.api.replay(e.id);
      const tactic = tacticFromReplayInputs(
        full.replay.inputs as Parameters<typeof tacticFromReplayInputs>[0],
        full.replay.attackerName ?? e.attackerName,
      );
      if (!tactic) {
        this.flashToast('No path to steal — attacker never deployed.');
        return;
      }
      const ok = stashTactic(tactic);
      this.flashToast(
        ok
          ? `Stolen! ${tactic.name} added to your tactic library.`
          : 'Could not save tactic (storage full?).',
      );
    } catch {
      this.flashToast('Could not load replay.');
    }
  }

  // Lightweight inline toast — same idea as transitions but local to
  // this scene since the feed is the only caller. 1.6s lifespan,
  // bottom-anchored so it doesn't cover replay rows.
  private flashToast(message: string): void {
    const t = this.add
      .text(this.scale.width / 2, this.scale.height - 64, message, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#fff8ec',
        backgroundColor: '#1f2148e8',
        padding: { x: 14, y: 8 },
      })
      .setOrigin(0.5)
      .setDepth(900)
      .setAlpha(0);
    this.tweens.add({
      targets: t,
      alpha: 1,
      duration: 140,
      onComplete: () => {
        this.tweens.add({
          targets: t,
          alpha: 0,
          delay: 1300,
          duration: 240,
          onComplete: () => t.destroy(),
        });
      },
    });
  }

  private async watch(e: ReplayFeedEntry, runtime: HiveRuntime): Promise<void> {
    try {
      // Log the view + pay any pending reward.
      await runtime.api.replayView(e.id);
    } catch {
      // swallow; view tracking is best-effort
    }
    // Hand off to RaidScene in replay mode via registry payload.
    const full = await runtime.api.replay(e.id);
    this.registry.set('replayContext', {
      id: full.replay.id,
      seed: full.replay.seed,
      baseSnapshot: full.replay.baseSnapshot,
      inputs: full.replay.inputs,
      replayName: full.replay.replayName,
      attackerName: full.replay.attackerName,
      defenderName: full.replay.defenderName,
    });
    fadeToScene(this, 'RaidScene');
  }
}
