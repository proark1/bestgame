import Phaser from 'phaser';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import type { HiveRuntime } from '../main.js';
import type { RaidHistoryEntry } from '../net/Api.js';
import { crispText } from '../ui/text.js';
import { makeHiveButton } from '../ui/button.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { drawEmptyState } from '../ui/emptyState.js';
import { COLOR, DEPTHS, bodyTextStyle, displayTextStyle, labelTextStyle } from '../ui/theme.js';

const HUD_H = 56;

export class RaidHistoryScene extends Phaser.Scene {
  private rowContainer!: Phaser.GameObjects.Container;
  private loadingText!: Phaser.GameObjects.Text;
  private contentHeight = 0;
  private viewportTop = HUD_H + 24;
  private scrollOffset = 0;
  private scrolling = false;
  private scrollStartY = 0;
  private scrollStartOffset = 0;

  constructor() {
    super('RaidHistoryScene');
  }

  create(): void {
    fadeInScene(this);
    installSceneClickDebug(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    this.drawAmbient();
    this.drawHud();
    this.rowContainer = this.add.container(0, this.viewportTop);
    this.loadingText = crispText(
      this,
      this.scale.width / 2,
      HUD_H + 88,
      'Loading recent raids...',
      bodyTextStyle(14, COLOR.textDim),
    ).setOrigin(0.5);
    this.wireScroll();
    void this.fetchData();
  }

  private drawAmbient(): void {
    const g = this.add.graphics().setDepth(DEPTHS.background);
    const top = 0x203224;
    const bot = 0x070d08;
    const bands = 18;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      const r = Math.round(((top >> 16) & 0xff) + (((bot >> 16) & 0xff) - ((top >> 16) & 0xff)) * t);
      const gc = Math.round(((top >> 8) & 0xff) + (((bot >> 8) & 0xff) - ((top >> 8) & 0xff)) * t);
      const b = Math.round((top & 0xff) + ((bot & 0xff) - (top & 0xff)) * t);
      g.fillStyle((r << 16) | (gc << 8) | b, 1);
      g.fillRect(
        0,
        Math.floor((i * this.scale.height) / bands),
        this.scale.width,
        Math.ceil(this.scale.height / bands) + 1,
      );
    }
    const glow = this.add.graphics().setDepth(DEPTHS.ambient);
    glow.fillStyle(COLOR.brass, 0.05);
    glow.fillEllipse(this.scale.width / 2, HUD_H + 140, Math.min(860, this.scale.width * 0.9), 220);
  }

  private wireScroll(): void {
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.y < this.viewportTop) return;
      this.scrolling = true;
      this.scrollStartY = p.y;
      this.scrollStartOffset = this.scrollOffset;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.scrolling || !p.isDown) return;
      this.setScroll(this.scrollStartOffset + (p.y - this.scrollStartY));
    });
    this.input.on('pointerup', () => {
      this.scrolling = false;
    });
    this.input.on(
      'wheel',
      (_p: Phaser.Input.Pointer, _obj: unknown[], _dx: number, dy: number) => {
        this.setScroll(this.scrollOffset - dy);
      },
    );
  }

  private setScroll(raw: number): void {
    const viewportH = this.scale.height - this.viewportTop - 16;
    const minOffset = Math.min(0, viewportH - this.contentHeight);
    const clamped = Math.max(minOffset, Math.min(0, raw));
    this.scrollOffset = clamped;
    this.rowContainer.setY(this.viewportTop + clamped);
  }

  private drawHud(): void {
    const w = this.scale.width;
    const hud = this.add.graphics();
    drawPanel(hud, 0, 0, w, HUD_H, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      strokeWidth: 0,
      highlight: COLOR.brass,
      highlightAlpha: 0.12,
      radius: 0,
      shadowOffset: 0,
      shadowAlpha: 0,
    });
    hud.fillStyle(0x000000, 0.4);
    hud.fillRect(0, HUD_H, w, 3);

    makeHiveButton(this, {
      x: 72,
      y: HUD_H / 2,
      width: 120,
      height: 36,
      label: 'Home',
      variant: 'ghost',
      fontSize: 13,
      onPress: () => fadeToScene(this, 'HomeScene'),
    });
    crispText(
      this,
      this.scale.width / 2,
      HUD_H / 2,
      'Recent Raids',
      displayTextStyle(20, COLOR.textGold, 4),
    ).setOrigin(0.5);
  }

  private async fetchData(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) {
      this.loadingText.setText('Offline - no history');
      return;
    }
    try {
      const raids = await runtime.api.getRaidHistory(30);
      if (!this.scene.isActive()) return;
      this.loadingText.destroy();
      if (raids.length === 0) {
        this.renderEmptyState();
        return;
      }
      this.renderRows(raids, runtime);
    } catch (err) {
      if (!this.scene.isActive()) return;
      this.loadingText.setText(`Error: ${(err as Error).message}`);
    }
  }

  private renderEmptyState(): void {
    const w = Math.min(560, this.scale.width - 32);
    const x = (this.scale.width - w) / 2;
    const handle = drawEmptyState({
      scene: this,
      x,
      y: 0,
      width: w,
      glyph: '📜',
      title: 'No raids yet',
      body: 'Launch your first attack from the home screen — every raid lands here for replay.',
    });
    this.rowContainer.add(handle.container);
    this.contentHeight = handle.height + 16;
  }

  private renderRows(raids: RaidHistoryEntry[], runtime: HiveRuntime): void {
    this.rowContainer.removeAll(true);
    const maxW = Math.min(620, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    let y = 0;

    y = this.renderOverviewCard(originX, maxW, y, raids.length);
    y += 16;

    raids.forEach((r, i) => {
      y = this.renderRaidRow(originX, maxW, y, r, i, runtime);
    });
    this.contentHeight = y + 16;
  }

  private renderOverviewCard(originX: number, maxW: number, y: number, count: number): number {
    const h = 84;
    const card = this.add.graphics();
    drawPanel(card, originX, y, maxW, h, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.14,
      radius: 16,
      shadowOffset: 5,
      shadowAlpha: 0.32,
    });
    this.rowContainer.add(card);

    const pill = this.add.graphics();
    drawPill(pill, originX + 16, y + 14, 92, 20, { brass: true });
    this.rowContainer.add(pill);
    this.rowContainer.add(
      crispText(this, originX + 62, y + 24, 'Battle log', labelTextStyle(10, COLOR.textGold)).setOrigin(0.5, 0.5),
    );
    this.rowContainer.add(
      crispText(this, originX + 18, y + 42, 'Track your wins, losses, and loot swings.', displayTextStyle(15, COLOR.textGold, 3))
        .setOrigin(0, 0),
    );
    this.rowContainer.add(
      crispText(this, originX + 18, y + 62, `Showing your latest ${count} raid outcomes from both attack and defense.`, bodyTextStyle(12, COLOR.textPrimary))
        .setOrigin(0, 0),
    );
    return y + h;
  }

  private renderRaidRow(
    originX: number,
    maxW: number,
    y: number,
    r: RaidHistoryEntry,
    i: number,
    runtime: HiveRuntime,
  ): number {
    // Defender-role rows where the opponent is a real player (non-null
    // opponentId) get the revenge button. Bot defeats are dropped; the
    // bot doesn't exist as a player record so the matchmaker would
    // fall through to a fresh random match anyway.
    const isAttacker = r.role === 'attacker';
    const canRevenge = !isAttacker && typeof r.opponentId === 'string' && r.opponentId.length > 0;
    // Watch button always — the replay is stored regardless of role.
    const rowH = 110;
    const isWin = isAttacker ? r.stars > 0 : r.stars === 0;
    const bg = this.add.graphics();
    drawPanel(bg, originX, y, maxW, rowH, {
      topColor: isWin
        ? isAttacker ? 0x263922 : 0x213324
        : isAttacker ? 0x362120 : 0x3b2525,
      botColor: i % 2 === 0 ? COLOR.bgInset : 0x0c120d,
      stroke: isWin ? COLOR.greenHi : COLOR.red,
      strokeWidth: 2,
      highlight: isWin ? COLOR.brass : 0xffa0a0,
      highlightAlpha: 0.08,
      radius: 12,
      shadowOffset: 3,
      shadowAlpha: 0.2,
    });
    this.rowContainer.add(bg);

    const outcomePill = this.add.graphics();
    drawPill(outcomePill, originX + 14, y + 14, 86, 22, { brass: isWin });
    this.rowContainer.add(outcomePill);
    this.rowContainer.add(
      crispText(
        this,
        originX + 57,
        y + 25,
        isWin ? 'Success' : 'Setback',
        isWin ? labelTextStyle(11, COLOR.textGold) : labelTextStyle(11, COLOR.textPrimary),
      ).setOrigin(0.5, 0.5),
    );

    this.rowContainer.add(
      crispText(
        this,
        originX + 112,
        y + 13,
        `${isAttacker ? 'Against' : 'Defended vs'} ${r.opponentName}`,
        bodyTextStyle(14, COLOR.textPrimary),
      ).setOrigin(0, 0),
    );

    const stars = `${r.stars}/3 stars`;
    const deltaColor =
      r.trophyDelta > 0 ? '#83c76b' : r.trophyDelta < 0 ? '#ff9f9f' : COLOR.textDim;
    const deltaSign = r.trophyDelta > 0 ? '+' : '';
    this.rowContainer.add(
      crispText(
        this,
        originX + 112,
        y + 37,
        `${stars}  |  Sugar ${r.sugarLooted}  |  Leaf ${r.leafLooted}`,
        bodyTextStyle(12, isWin ? COLOR.textGold : COLOR.textDim),
      ).setOrigin(0, 0),
    );
    this.rowContainer.add(
      crispText(
        this,
        originX + maxW - 18,
        y + 22,
        `${deltaSign}${r.trophyDelta}`,
        displayTextStyle(16, deltaColor, 3),
      ).setOrigin(1, 0.5),
    );
    this.rowContainer.add(
      crispText(
        this,
        originX + maxW - 18,
        y + 50,
        formatRelative(r.createdAt),
        labelTextStyle(10, COLOR.textMuted),
      ).setOrigin(1, 0.5),
    );

    // Action row — Watch + (defender only) Revenge. Anchored bottom
    // edge of the card so the textual info above is undisturbed.
    const btnY = y + rowH - 26;
    const watchBtn = makeHiveButton(this, {
      x: originX + 112 + 50,
      y: btnY,
      width: 96,
      height: 30,
      label: '▶ Watch',
      variant: 'secondary',
      fontSize: 12,
      onPress: () => { void this.watchReplay(r, runtime); },
    });
    this.rowContainer.add(watchBtn.container);
    // Intel — defender-only quick view. Skips the in-engine replay
    // and opens an after-action card with a path heatmap + first-
    // killed buildings ranked. Attackers don't need this; they
    // already saw their own raid live.
    if (!isAttacker) {
      const intelBtn = makeHiveButton(this, {
        x: originX + 112 + 50 + 96 + 12,
        y: btnY,
        width: 96,
        height: 30,
        label: '🔍 Intel',
        variant: 'secondary',
        fontSize: 12,
        onPress: () => { void this.openIntel(r, runtime); },
      });
      this.rowContainer.add(intelBtn.container);
    }
    if (canRevenge) {
      // Push revenge further right when intel is also present so
      // the three buttons don't overlap.
      const revengeX = originX + 112 + 50 + 96 + 12 + (isAttacker ? 0 : 96 + 12);
      const revengeBtn = makeHiveButton(this, {
        x: revengeX,
        y: btnY,
        width: 110,
        height: 30,
        label: '⚔ Revenge',
        variant: 'primary',
        fontSize: 12,
        onPress: () => { this.startRevenge(r); },
      });
      this.rowContainer.add(revengeBtn.container);
    }
    return y + rowH + 8;
  }

  // Defender-only: fetch the same /replay/:id payload the Watch
  // button uses, then jump into PostRaidIntelScene instead of
  // RaidScene. The intel scene re-runs the sim against the saved
  // baseSnapshot + inputs to recover the building destruction
  // order, then renders a path heatmap on top of the surviving
  // base layout.
  private async openIntel(
    r: RaidHistoryEntry,
    runtime: HiveRuntime,
  ): Promise<void> {
    try {
      const full = await runtime.api.replay(r.id);
      this.registry.set('replayContext', {
        id: full.replay.id,
        seed: full.replay.seed,
        baseSnapshot: full.replay.baseSnapshot,
        inputs: full.replay.inputs,
        replayName: full.replay.replayName,
        attackerName: full.replay.attackerName,
        defenderName: full.replay.defenderName,
      });
      fadeToScene(this, 'PostRaidIntelScene');
    } catch (err) {
      this.loadingText?.setText?.(`Intel unavailable: ${(err as Error).message}`);
    }
  }

  // Hand off the row's raid id to /replay/:id, then jump into RaidScene
  // in replay mode. Mirrors ReplayFeedScene.watch — kept inline here so
  // a single-purpose import doesn't drag in the whole feed scene.
  private async watchReplay(
    r: RaidHistoryEntry,
    runtime: HiveRuntime,
  ): Promise<void> {
    try {
      // View tracking is best-effort — the scene transition happens
      // even if the bookkeeping call fails.
      await runtime.api.replayView(r.id);
    } catch {
      /* swallow */
    }
    try {
      const full = await runtime.api.replay(r.id);
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
    } catch (err) {
      this.loadingText?.setText?.(`Replay unavailable: ${(err as Error).message}`);
    }
  }

  // Pin the matchmaker on the player who attacked us. The /match
  // server endpoint validates the target and falls through to random
  // matchmaking if the defender is now shielded / missing — so this
  // path is always a non-empty fight.
  private startRevenge(r: RaidHistoryEntry): void {
    if (typeof r.opponentId !== 'string' || r.opponentId.length === 0) return;
    this.registry.set('revengeContext', { defenderId: r.opponentId });
    fadeToScene(this, 'RaidScene');
  }
}

function formatRelative(isoTs: string): string {
  const t = new Date(isoTs).getTime();
  const deltaSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (deltaSec < 60) return 'just now';
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}
