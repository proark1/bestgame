import Phaser from 'phaser';
import type { HiveRuntime } from '../main.js';
import type { BuilderEntry, BuilderQueueResponse } from '../net/Api.js';
import { fadeInScene } from '../ui/transitions.js';
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

// BuilderQueueScene — time-gated upgrades with a daily free skip +
// Aphid Milk skip. This is the "check-in-in-4-hours" lever: upgrades
// queue here with a countdown, and the player can finish them instantly
// once per day (free) or any time (milk).

export class BuilderQueueScene extends Phaser.Scene {
  private body: {
    container: Phaser.GameObjects.Container;
    setContentHeight(h: number): void;
  } | null = null;
  private queueData: BuilderQueueResponse | null = null;
  private tickTimer: Phaser.Time.TimerEvent | null = null;
  private timerLabels: Array<{ text: Phaser.GameObjects.Text; endsAt: number }> = [];

  constructor() { super('BuilderQueueScene'); }

  create(): void {
    fadeInScene(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    drawSceneAmbient(this);
    drawSceneHud(this, 'Builders', 'HomeScene');
    this.body = makeScrollBody(this);
    const loading = crispText(
      this,
      this.scale.width / 2,
      140,
      'Waking up the builders...',
      bodyTextStyle(14, COLOR.textDim),
    ).setOrigin(0.5);
    void this.loadData(loading);

    this.tickTimer = this.time.addEvent({
      delay: 1000,
      loop: true,
      callback: () => this.updateTimers(),
    });
    this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.tickTimer?.remove();
      this.tickTimer = null;
    });
  }

  private updateTimers(): void {
    for (const entry of this.timerLabels) {
      const remaining = Math.max(0, (entry.endsAt - Date.now()) / 1000);
      entry.text.setText(formatCountdown(remaining));
    }
  }

  private async loadData(loading: Phaser.GameObjects.Text): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) { loading.setText('Offline'); return; }
    try {
      const res = await runtime.api.getBuilder();
      if (!this.scene.isActive()) return;
      loading.destroy();
      this.queueData = res;
      this.render(runtime);
    } catch (err) {
      if (!this.scene.isActive()) return;
      loading.setText(`Error: ${(err as Error).message}`);
    }
  }

  private render(runtime: HiveRuntime): void {
    if (!this.body || !this.queueData) return;
    this.body.container.removeAll(true);
    this.timerLabels = [];
    const maxW = Math.min(680, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    let y = 0;

    // Header card
    {
      const h = 96;
      const bg = this.add.graphics();
      drawPanel(bg, originX, y, maxW, h, {
        topColor: 0x2a3f2d,
        botColor: COLOR.bgPanelLo,
        stroke: COLOR.brassDeep,
        strokeWidth: 3,
        highlight: COLOR.brass,
        highlightAlpha: 0.14,
        radius: 14,
        shadowOffset: 4,
        shadowAlpha: 0.22,
      });
      this.body.container.add(bg);
      this.body.container.add(
        crispText(this, originX + 16, y + 14,
          'Builder slots in use',
          labelTextStyle(11, COLOR.textMuted),
        ),
      );
      this.body.container.add(
        crispText(this, originX + 16, y + 36,
          `${this.queueData.entries.length} / ${this.queueData.slots}`,
          displayTextStyle(22, COLOR.textGold, 3),
        ),
      );
      const freePill = this.add.graphics();
      drawPill(
        freePill,
        originX + maxW - 200,
        y + 18,
        184,
        28,
        { brass: this.queueData.freeSkipAvailable },
      );
      this.body.container.add(freePill);
      this.body.container.add(
        crispText(this, originX + maxW - 108, y + 32,
          this.queueData.freeSkipAvailable
            ? 'Free daily skip ready'
            : 'Free skip used today',
          labelTextStyle(11, this.queueData.freeSkipAvailable ? '#2a1d08' : COLOR.textMuted),
        ).setOrigin(0.5, 0.5),
      );
      this.body.container.add(
        crispText(this, originX + 16, y + h - 24,
          `Aphid Milk: ${this.queueData.aphidMilk}`,
          bodyTextStyle(12, COLOR.textGold),
        ),
      );
      y += h + 14;
    }

    if (this.queueData.entries.length === 0) {
      this.body.container.add(
        crispText(
          this, originX, y,
          'No active upgrades. Start one from the Upgrade screen — early upgrades finish near-instantly.',
          bodyTextStyle(13, COLOR.textDim),
        ).setWordWrapWidth(maxW, true),
      );
      this.body.setContentHeight(y + 60);
      return;
    }

    for (const e of this.queueData.entries) {
      y = this.renderEntry(originX, maxW, y, e, runtime);
    }
    this.body.setContentHeight(y);
  }

  private renderEntry(
    originX: number,
    maxW: number,
    y: number,
    e: BuilderEntry,
    runtime: HiveRuntime,
  ): number {
    if (!this.body || !this.queueData) return y;
    const h = 100;
    const bg = this.add.graphics();
    drawPanel(bg, originX, y, maxW, h, {
      topColor: COLOR.bgCard,
      botColor: COLOR.bgInset,
      stroke: COLOR.outline,
      strokeWidth: 1,
      highlight: COLOR.greenHi,
      highlightAlpha: 0.06,
      radius: 12,
      shadowOffset: 3,
      shadowAlpha: 0.2,
    });
    this.body.container.add(bg);

    this.body.container.add(
      crispText(this, originX + 14, y + 10,
        `${e.targetKind.toUpperCase()} • ${e.targetId}`,
        labelTextStyle(11, COLOR.textMuted),
      ),
    );
    this.body.container.add(
      crispText(this, originX + 14, y + 28,
        `Level ${e.levelTo - 1} → ${e.levelTo}`,
        displayTextStyle(16, COLOR.textGold, 3),
      ),
    );

    // Countdown ticker: captured in timerLabels so the scene's 1Hz
    // tick can refresh them in place without re-rendering the card.
    const timerText = crispText(
      this, originX + 14, y + 56,
      formatCountdown(e.secondsRemaining),
      bodyTextStyle(13, COLOR.textPrimary),
    );
    this.body.container.add(timerText);
    this.timerLabels.push({
      text: timerText,
      endsAt: new Date(e.endsAt).getTime(),
    });

    const ready = e.secondsRemaining <= 0;
    if (ready) {
      const btn = makeHiveButton(this, {
        x: originX + maxW - 100,
        y: y + h / 2,
        width: 170,
        height: 40,
        label: 'Finish now',
        variant: 'primary',
        fontSize: 14,
        onPress: () => { void this.finish(e, runtime); },
      });
      this.body.container.add(btn.container);
    } else {
      const canFree = this.queueData.freeSkipAvailable;
      const freeBtn = makeHiveButton(this, {
        x: originX + maxW - 180,
        y: y + h / 2,
        width: 150,
        height: 36,
        label: canFree ? 'Skip (free)' : 'Skip used',
        variant: canFree ? 'primary' : 'ghost',
        fontSize: 12,
        onPress: () => {
          if (!canFree) return;
          void this.skip(e, false, runtime);
        },
      });
      this.body.container.add(freeBtn.container);
      const milkBtn = makeHiveButton(this, {
        x: originX + maxW - 56,
        y: y + h / 2,
        width: 100,
        height: 36,
        label: `${e.skipCostAphidMilk}🥛`,
        variant: 'secondary',
        fontSize: 12,
        onPress: () => { void this.skip(e, true, runtime); },
      });
      this.body.container.add(milkBtn.container);
    }

    return y + h + 10;
  }

  private async skip(e: BuilderEntry, useMilk: boolean, runtime: HiveRuntime): Promise<void> {
    try {
      await runtime.api.skipBuild(e.id, useMilk);
      this.queueData = await runtime.api.getBuilder();
      this.render(runtime);
    } catch (err) {
      console.warn('skip failed', err);
    }
  }

  private async finish(e: BuilderEntry, runtime: HiveRuntime): Promise<void> {
    try {
      await runtime.api.finishBuild(e.id);
      this.queueData = await runtime.api.getBuilder();
      this.render(runtime);
    } catch (err) {
      console.warn('finish failed', err);
    }
  }
}
