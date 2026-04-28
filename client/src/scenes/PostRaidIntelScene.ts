import Phaser from 'phaser';
import { Sim, Types } from '@hive/shared';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import { crispText } from '../ui/text.js';
import { makeHiveButton } from '../ui/button.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import {
  COLOR,
  DEPTHS,
  bodyTextStyle,
  displayTextStyle,
  labelTextStyle,
} from '../ui/theme.js';

// Post-raid intel — replays a saved raid against the player's base
// (or any raid in their history) and visualises:
//   1. A heatmap of every attacker pheromone path drawn during the
//      raid, stacked at low alpha so overlap reads as hot spots.
//   2. The first 5 buildings to fall, ranked by tick of death,
//      stamped with order badges so the defender can see which
//      structures the attacker prioritised.
//   3. A short summary header (path count, buildings killed,
//      buildings still standing, raid duration).
//
// Reads `replayContext` from the registry — the same payload
// RaidHistoryScene's "Watch" button stashes for the in-engine replay.
// Lives outside RaidScene so the heavy raid UI (modifier bar, deck,
// coachmarks, save-tactic) doesn't have to be muted; this scene is
// a focused after-action report.

const TICK_HZ = 30;
const RAID_SECONDS = 90;
const HUD_H = 56;
const TILE = 48;
const GRID_W = 16;
const GRID_H = 12;
const BOARD_W = TILE * GRID_W;
const BOARD_H = TILE * GRID_H;
// Per-path alpha. Stacking 5 paths over the same lane should read as
// near-saturated — 0.18 × 5 = 0.9, plenty without saturating instantly.
const PATH_ALPHA = 0.18;
const PATH_LINE_W = 4;

interface ReplayContext {
  id: string;
  seed: number;
  baseSnapshot: Types.Base;
  inputs: Types.SimInput[];
  replayName?: string | null;
  attackerName?: string | null;
  defenderName?: string | null;
}

interface BuildingDeath {
  // Sim assigns its own numeric ids that don't map back to the
  // snapshot's string ids — so we identify the killed building by
  // its grid anchor (unique per base) instead.
  buildingId: number;
  kind: Types.BuildingKind;
  tick: number;
  anchor: { x: number; y: number };
}

export class PostRaidIntelScene extends Phaser.Scene {
  private boardContainer!: Phaser.GameObjects.Container;
  private hintText: Phaser.GameObjects.Text | null = null;

  constructor() {
    super('PostRaidIntelScene');
  }

  create(): void {
    fadeInScene(this);
    installSceneClickDebug(this);
    this.cameras.main.setBackgroundColor('#0f1b10');

    this.drawAmbient();
    this.drawHud();

    const ctx = this.registry.get('replayContext') as ReplayContext | null;
    if (!ctx) {
      this.showError('No replay loaded — open this from the raid history.');
      return;
    }
    // One-shot consumption so a stale replay doesn't bleed into the
    // next intel view (matches the pattern RaidScene uses).
    this.registry.set('replayContext', null);

    this.boardContainer = this.add.container(0, 0).setDepth(DEPTHS.board);

    const replayResult = this.computeIntel(ctx);
    this.drawBoardFrame();
    this.drawBuildings(ctx.baseSnapshot, replayResult.deaths);
    this.drawPathHeatmap(ctx.inputs);
    this.drawDeathBadges(replayResult.deaths);
    this.drawSummary(ctx, replayResult);
    this.layout();
    this.scale.on('resize', () => this.layout());
  }

  // Re-runs the saved sim from baseSnapshot + inputs, recording the
  // tick each building hits hp <= 0. Caller asks for the death
  // ordering and (later) anything else that needs a per-tick
  // sample. Determinism guarantee: same inputs + seed always give
  // the same death sequence — tested in shared determinism gate.
  private computeIntel(ctx: ReplayContext): {
    deaths: BuildingDeath[];
    finalTick: number;
    pathCount: number;
  } {
    const cfg: Sim.SimConfig = {
      tickRate: TICK_HZ,
      maxTicks: TICK_HZ * RAID_SECONDS,
      initialSnapshot: ctx.baseSnapshot,
      seed: ctx.seed,
    };
    let state = Sim.createInitialState(cfg);
    const inputsByTick = new Map<number, Types.SimInput[]>();
    let pathCount = 0;
    for (const input of ctx.inputs) {
      if (input.type === 'deployPath') pathCount++;
      const list = inputsByTick.get(input.tick) ?? [];
      list.push(input);
      inputsByTick.set(input.tick, list);
    }
    // Track death ticks. Sim ids are numeric and disconnected from
    // the snapshot's string ids; we identify dead buildings by
    // their (anchorX, anchorY) coords, which the sim copies through
    // unchanged — see SimBuilding.anchorX/Y in shared/sim/state.ts.
    const deaths: BuildingDeath[] = [];
    const deadIds = new Set<number>();
    let lastTick = state.tick;
    while (state.tick < cfg.maxTicks && state.outcome === 'ongoing') {
      const batch = inputsByTick.get(state.tick + 1) ?? [];
      Sim.step(state, cfg, batch);
      lastTick = state.tick;
      for (const b of state.buildings) {
        if (b.hp > 0) continue;
        if (deadIds.has(b.id)) continue;
        deadIds.add(b.id);
        deaths.push({
          buildingId: b.id,
          kind: b.kind,
          tick: state.tick,
          anchor: { x: b.anchorX, y: b.anchorY },
        });
      }
    }
    deaths.sort((a, b) => a.tick - b.tick);
    return { deaths, finalTick: lastTick, pathCount };
  }

  private drawAmbient(): void {
    const g = this.add.graphics().setDepth(DEPTHS.background);
    g.fillStyle(0x141d12, 1);
    g.fillRect(0, 0, this.scale.width, this.scale.height);
  }

  private drawHud(): void {
    const w = this.scale.width;
    const hud = this.add.graphics().setDepth(DEPTHS.hud);
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
      label: 'Back',
      variant: 'ghost',
      fontSize: 13,
      onPress: () => fadeToScene(this, 'RaidHistoryScene'),
    });
    crispText(
      this,
      this.scale.width / 2,
      HUD_H / 2,
      'Post-raid intel',
      displayTextStyle(20, COLOR.textGold, 4),
    ).setOrigin(0.5);
  }

  private drawBoardFrame(): void {
    const frame = this.add.graphics();
    frame.lineStyle(2, COLOR.brassDeep, 1);
    frame.strokeRect(-2, -2, BOARD_W + 4, BOARD_H + 4);
    frame.fillStyle(0x1f2c1c, 1);
    frame.fillRect(0, 0, BOARD_W, BOARD_H);
    this.boardContainer.add(frame);
    // Tile grid for visual reference.
    const grid = this.add.graphics();
    grid.lineStyle(1, 0x2c3a25, 0.5);
    for (let x = 0; x <= GRID_W; x++) {
      grid.beginPath();
      grid.moveTo(x * TILE, 0);
      grid.lineTo(x * TILE, BOARD_H);
      grid.strokePath();
    }
    for (let y = 0; y <= GRID_H; y++) {
      grid.beginPath();
      grid.moveTo(0, y * TILE);
      grid.lineTo(BOARD_W, y * TILE);
      grid.strokePath();
    }
    this.boardContainer.add(grid);
  }

  private drawBuildings(
    base: Types.Base,
    deaths: BuildingDeath[],
  ): void {
    // Match snapshot buildings to deaths by anchor (deaths are
    // keyed by sim numeric id which doesn't map back to the
    // snapshot's string id).
    const deadAnchors = new Set(
      deaths.map((d) => `${d.anchor.x},${d.anchor.y}`),
    );
    for (const b of base.buildings) {
      const cx = b.anchor.x * TILE + TILE / 2;
      const cy = b.anchor.y * TILE + TILE / 2;
      const anchorKey = `${b.anchor.x},${b.anchor.y}`;
      const key = `building-${b.kind}`;
      const sprite = this.textures.exists(key)
        ? this.add.image(cx, cy, key).setDisplaySize(TILE * 0.9, TILE * 0.9)
        : (() => {
            const g = this.add.graphics();
            g.fillStyle(0x55603f, 1);
            g.fillRoundedRect(cx - TILE / 2.5, cy - TILE / 2.5, TILE * 0.8, TILE * 0.8, 6);
            return g;
          })();
      // Dim destroyed buildings so the survivors stand out.
      if (deadAnchors.has(anchorKey)) {
        sprite.setAlpha(0.35);
        // X mark for clarity.
        const mark = this.add.graphics();
        mark.lineStyle(3, 0xff6b6b, 0.85);
        mark.beginPath();
        mark.moveTo(cx - TILE / 3, cy - TILE / 3);
        mark.lineTo(cx + TILE / 3, cy + TILE / 3);
        mark.moveTo(cx + TILE / 3, cy - TILE / 3);
        mark.lineTo(cx - TILE / 3, cy + TILE / 3);
        mark.strokePath();
        this.boardContainer.add(mark);
      }
      this.boardContainer.add(sprite);
    }
  }

  private drawPathHeatmap(inputs: Types.SimInput[]): void {
    const heat = this.add.graphics();
    heat.setDepth(1);
    for (const input of inputs) {
      if (input.type !== 'deployPath') continue;
      const points = input.path.points;
      if (points.length < 2) continue;
      heat.lineStyle(PATH_LINE_W, 0xff9a4a, PATH_ALPHA);
      heat.beginPath();
      const first = points[0]!;
      heat.moveTo(Sim.toFloat(first.x) * TILE, Sim.toFloat(first.y) * TILE);
      for (let i = 1; i < points.length; i++) {
        const p = points[i]!;
        heat.lineTo(Sim.toFloat(p.x) * TILE, Sim.toFloat(p.y) * TILE);
      }
      heat.strokePath();
    }
    this.boardContainer.add(heat);
  }

  private drawDeathBadges(deaths: BuildingDeath[]): void {
    // Top 5 first to fall — anything beyond that is noise on the
    // 192-tile board.
    const top = deaths.slice(0, 5);
    for (let i = 0; i < top.length; i++) {
      const d = top[i]!;
      const cx = d.anchor.x * TILE + TILE / 2;
      const cy = d.anchor.y * TILE + TILE / 2;
      const badge = this.add.graphics();
      badge.fillStyle(0xff6b6b, 0.95);
      badge.lineStyle(2, 0x1a1208, 1);
      badge.fillCircle(cx + TILE / 2 - 6, cy - TILE / 2 + 6, 12);
      badge.strokeCircle(cx + TILE / 2 - 6, cy - TILE / 2 + 6, 12);
      this.boardContainer.add(badge);
      this.boardContainer.add(
        crispText(
          this,
          cx + TILE / 2 - 6,
          cy - TILE / 2 + 6,
          `${i + 1}`,
          displayTextStyle(13, '#ffffff', 2),
        ).setOrigin(0.5, 0.5),
      );
    }
  }

  private drawSummary(
    ctx: ReplayContext,
    res: { deaths: BuildingDeath[]; finalTick: number; pathCount: number },
  ): void {
    const totalBuildings = ctx.baseSnapshot.buildings.length;
    const killed = res.deaths.length;
    const standing = totalBuildings - killed;
    const seconds = (res.finalTick / TICK_HZ).toFixed(1);
    const w = Math.min(560, this.scale.width - 28);
    const card = this.add.container(0, 0);
    const bg = this.add.graphics();
    drawPanel(bg, 0, 0, w, 110, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.14,
      radius: 14,
      shadowOffset: 5,
      shadowAlpha: 0.3,
    });
    card.add(bg);
    const pill = this.add.graphics();
    drawPill(pill, 14, 14, 130, 22, { brass: true });
    card.add(pill);
    card.add(
      crispText(this, 79, 25, 'After-action', labelTextStyle(11, COLOR.textGold)).setOrigin(
        0.5,
        0.5,
      ),
    );
    const attacker = ctx.attackerName ?? 'Unknown attacker';
    card.add(
      crispText(
        this,
        14,
        46,
        `Attacker: ${attacker}`,
        displayTextStyle(15, COLOR.textPrimary, 3),
      ).setOrigin(0, 0),
    );
    card.add(
      crispText(
        this,
        14,
        70,
        `Pheromone paths: ${res.pathCount}`,
        bodyTextStyle(12, COLOR.textDim),
      ).setOrigin(0, 0),
    );
    card.add(
      crispText(
        this,
        14,
        86,
        `Buildings destroyed: ${killed} / ${totalBuildings}`,
        bodyTextStyle(12, COLOR.textDim),
      ).setOrigin(0, 0),
    );
    card.add(
      crispText(
        this,
        w - 14,
        46,
        `Standing: ${standing}`,
        displayTextStyle(15, COLOR.textGold, 3),
      ).setOrigin(1, 0),
    );
    card.add(
      crispText(
        this,
        w - 14,
        70,
        `Duration: ${seconds}s`,
        bodyTextStyle(12, COLOR.textDim),
      ).setOrigin(1, 0),
    );
    card.add(
      crispText(
        this,
        w - 14,
        86,
        'Numbered ●  = first to fall',
        bodyTextStyle(11, COLOR.textMuted),
      ).setOrigin(1, 0),
    );
    card.setDepth(DEPTHS.hud);
    this.summaryCard = { container: card, width: w };
  }

  private summaryCard: {
    container: Phaser.GameObjects.Container;
    width: number;
  } | null = null;

  private layout(): void {
    if (!this.boardContainer) return;
    const availW = this.scale.width - 24;
    const availH = this.scale.height - HUD_H - 130;
    const fit = Math.min(availW / BOARD_W, availH / BOARD_H);
    const scale = Math.min(2.0, fit);
    this.boardContainer.setScale(scale);
    const scaledW = BOARD_W * scale;
    const scaledH = BOARD_H * scale;
    const x = Math.max(12, (this.scale.width - scaledW) / 2);
    const y = HUD_H + Math.max(8, (availH - scaledH) / 2);
    this.boardContainer.setPosition(x, y);
    if (this.summaryCard) {
      const cardW = Math.min(560, this.scale.width - 28);
      const cardX = Math.round((this.scale.width - cardW) / 2);
      const cardY = Math.min(this.scale.height - 122, y + scaledH + 12);
      this.summaryCard.container.setPosition(cardX, cardY);
    }
  }

  private showError(message: string): void {
    if (this.hintText) this.hintText.destroy();
    this.hintText = crispText(
      this,
      this.scale.width / 2,
      HUD_H + 80,
      message,
      bodyTextStyle(14, COLOR.textDim),
    ).setOrigin(0.5);
  }
}
