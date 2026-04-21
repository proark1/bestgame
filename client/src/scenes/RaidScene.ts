import Phaser from 'phaser';
import { Sim, Types } from '@hive/shared';
import { bakeTrailDot } from '../assets/placeholders.js';

// RaidScene — the first end-to-end playable loop.
// The player attacks a hard-coded bot base. They pick a unit from the
// bottom deck, drag a pheromone path from the spawn edge into the base,
// and release to deploy. The shared deterministic sim steps at 30 Hz,
// and this scene renders it: units walk the path, turrets fire, HP bars
// drop, buildings crumble, loot ticks up, stars award at the end.

const TILE = 48;
const GRID_W = 16;
const GRID_H = 12;
const BOARD_W = TILE * GRID_W;
const BOARD_H = TILE * GRID_H;
const HUD_H = 56;
const DECK_H = 96;
const TICK_HZ = 30;
const RAID_SECONDS = 90;

interface DeckEntry {
  kind: Types.UnitKind;
  count: number;
  icon: string;
  label: string;
}

const DECK: DeckEntry[] = [
  { kind: 'SoldierAnt', count: 10, icon: 'unit-SoldierAnt', label: 'Soldier' },
  { kind: 'WorkerAnt', count: 8, icon: 'unit-WorkerAnt', label: 'Worker' },
  { kind: 'DirtDigger', count: 4, icon: 'unit-DirtDigger', label: 'Digger' },
  { kind: 'Wasp', count: 4, icon: 'unit-Wasp', label: 'Wasp' },
];

const BOT_BASE: Types.Base = {
  baseId: 'bot-0',
  ownerId: 'bot-0',
  faction: 'Beetles',
  gridSize: { w: GRID_W, h: GRID_H },
  resources: { sugar: 1600, leafBits: 420, aphidMilk: 0 },
  trophies: 100,
  version: 1,
  tunnels: [],
  buildings: [
    {
      id: 'b-queen',
      kind: 'QueenChamber',
      anchor: { x: 8, y: 6, layer: 0 },
      footprint: { w: 2, h: 2 },
      spans: [0, 1],
      level: 1,
      hp: 800,
      hpMax: 800,
    },
    {
      id: 'b-turret-1',
      kind: 'MushroomTurret',
      anchor: { x: 5, y: 4, layer: 0 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 400,
      hpMax: 400,
    },
    {
      id: 'b-turret-2',
      kind: 'MushroomTurret',
      anchor: { x: 12, y: 4, layer: 0 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 400,
      hpMax: 400,
    },
    {
      id: 'b-wall-1',
      kind: 'LeafWall',
      anchor: { x: 6, y: 6, layer: 0 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 600,
      hpMax: 600,
    },
    {
      id: 'b-wall-2',
      kind: 'LeafWall',
      anchor: { x: 11, y: 6, layer: 0 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 600,
      hpMax: 600,
    },
    {
      id: 'b-bunker',
      kind: 'PebbleBunker',
      anchor: { x: 3, y: 9, layer: 0 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 900,
      hpMax: 900,
    },
    {
      id: 'b-vault-1',
      kind: 'SugarVault',
      anchor: { x: 10, y: 9, layer: 1 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 350,
      hpMax: 350,
    },
    {
      id: 'b-vault-2',
      kind: 'SugarVault',
      anchor: { x: 5, y: 9, layer: 1 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 350,
      hpMax: 350,
    },
  ],
};

export class RaidScene extends Phaser.Scene {
  private cfg!: Sim.SimConfig;
  private state!: Sim.SimState;
  private pendingInputs: Types.SimInput[] = [];

  private boardContainer!: Phaser.GameObjects.Container;
  private buildingSprites = new Map<number, Phaser.GameObjects.Image>();
  private buildingHpBars = new Map<number, Phaser.GameObjects.Graphics>();
  private unitSprites = new Map<number, Phaser.GameObjects.Image>();

  // Trail drawing state.
  private selectedDeckIdx = 0;
  private deckEntries: DeckEntry[] = [];
  private drawingPoints: Array<{ x: number; y: number }> = [];
  private trailGraphics!: Phaser.GameObjects.Graphics;
  private isDrawing = false;

  // UI widgets.
  private timerText!: Phaser.GameObjects.Text;
  private starsText!: Phaser.GameObjects.Text;
  private lootText!: Phaser.GameObjects.Text;
  private deckContainers: Phaser.GameObjects.Container[] = [];
  // Parallel array to deckContainers — avoids monkey-patching the
  // container with a labelText property.
  private deckLabels: Phaser.GameObjects.Text[] = [];

  private simTickElapsed = 0; // fractional tick accumulator
  private started = false;
  private resultShown = false;

  constructor() {
    super('RaidScene');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0f1b10');
    // Reset all per-run state. Scene instances are reused across raids,
    // so previous-run state must be cleared here or it'll leak.
    this.deckEntries = DECK.map((d) => ({ ...d }));
    this.deckContainers = [];
    this.deckLabels = [];
    this.buildingSprites.clear();
    this.buildingHpBars.clear();
    this.unitSprites.clear();
    this.pendingInputs = [];
    this.simTickElapsed = 0;
    this.resultShown = false;
    this.started = false;
    this.selectedDeckIdx = 0;
    this.drawingPoints = [];
    this.isDrawing = false;

    this.cfg = {
      tickRate: 30,
      maxTicks: TICK_HZ * RAID_SECONDS,
      initialSnapshot: BOT_BASE,
      seed: 0xc0ffee,
    };
    this.state = Sim.createInitialState(this.cfg);

    this.drawHud();
    this.boardContainer = this.add.container(0, HUD_H);
    this.drawBoard();
    this.drawBuildingsFromState();
    this.trailGraphics = this.add.graphics().setDepth(10);
    this.boardContainer.add(this.trailGraphics);
    this.drawDeck();

    this.wirePointerInput();

    bakeTrailDot(this);

    this.events.once('shutdown', () => this.scale.off('resize', this.layout, this));
    this.scale.on('resize', this.layout, this);
    this.layout();

    this.started = true;
  }

  override update(_time: number, deltaMs: number): void {
    if (!this.started) return;
    if (this.state.outcome !== 'ongoing' && this.state.tick >= this.cfg.maxTicks)
      return;

    // Step the deterministic sim at 30 Hz regardless of render rate.
    const msPerTick = 1000 / TICK_HZ;
    this.simTickElapsed += deltaMs;
    while (this.simTickElapsed >= msPerTick && this.state.outcome === 'ongoing') {
      this.simTickElapsed -= msPerTick;
      const nextTick = this.state.tick + 1;
      const batch: Types.SimInput[] = [];
      for (let i = this.pendingInputs.length - 1; i >= 0; i--) {
        if (this.pendingInputs[i]!.tick <= nextTick) {
          batch.unshift(this.pendingInputs[i]!);
          this.pendingInputs.splice(i, 1);
        }
      }
      Sim.step(this.state, this.cfg, batch);
    }

    this.renderFrame();

    if (this.state.outcome !== 'ongoing') this.showResult();
  }

  private drawHud(): void {
    const g = this.add.graphics();
    g.fillStyle(0x0a120c, 1);
    g.fillRect(0, 0, this.scale.width, HUD_H);
    g.fillStyle(0x1a2b1a, 1);
    g.fillRect(0, HUD_H - 2, this.scale.width, 2);

    this.add
      .text(16, HUD_H / 2, '← Home', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#c3e8b0',
        backgroundColor: '#1a2b1a',
        padding: { left: 10, right: 10, top: 6, bottom: 6 },
      })
      .setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.scene.start('HomeScene'));

    this.timerText = this.add
      .text(this.scale.width / 2, HUD_H / 2, '1:30', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '20px',
        color: '#ffd98a',
      })
      .setOrigin(0.5);

    this.starsText = this.add
      .text(this.scale.width - 16, HUD_H / 2 - 10, '★ 0', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '16px',
        color: '#ffd98a',
      })
      .setOrigin(1, 0.5);

    this.lootText = this.add
      .text(this.scale.width - 16, HUD_H / 2 + 10, 'loot: 0', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#c3e8b0',
      })
      .setOrigin(1, 0.5);
  }

  private drawBoard(): void {
    const bg = this.add.graphics();
    // gradient-ish tiled ground
    bg.fillStyle(0x1d3a1a, 1);
    bg.fillRect(0, 0, BOARD_W, BOARD_H);
    bg.fillStyle(0x244a21, 1);
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        if ((x + y) % 2 === 0) bg.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }
    // edge vignette
    bg.fillStyle(0x000000, 0.28);
    bg.fillRect(0, 0, BOARD_W, 20);
    bg.fillRect(0, BOARD_H - 20, BOARD_W, 20);

    const grid = this.add.graphics({ lineStyle: { width: 1, color: 0x2c5a23, alpha: 0.5 } });
    for (let x = 0; x <= GRID_W; x++) grid.lineBetween(x * TILE, 0, x * TILE, BOARD_H);
    for (let y = 0; y <= GRID_H; y++) grid.lineBetween(0, y * TILE, BOARD_W, y * TILE);

    this.boardContainer.add([bg, grid]);
  }

  private drawBuildingsFromState(): void {
    for (const b of this.state.buildings) {
      // Cross-layer buildings render once (both copies share id);
      // dedupe by first occurrence.
      if (this.buildingSprites.has(b.id)) continue;
      const x = b.anchorX * TILE + (b.w * TILE) / 2;
      const y = b.anchorY * TILE + (b.h * TILE) / 2;
      const spr = this.add.image(x, y, `building-${b.kind}`);
      spr.setOrigin(0.5, 0.75);
      spr.setDisplaySize(TILE * Math.max(b.w, 1.6), TILE * Math.max(b.h, 1.6));
      this.boardContainer.add(spr);
      this.buildingSprites.set(b.id, spr);

      const bar = this.add.graphics();
      this.boardContainer.add(bar);
      this.buildingHpBars.set(b.id, bar);
    }
  }

  private drawDeck(): void {
    const y = HUD_H + BOARD_H + DECK_H / 2;
    const slotW = 108;
    const totalW = slotW * this.deckEntries.length + 16 * (this.deckEntries.length - 1);
    const startX = (this.scale.width - totalW) / 2 + slotW / 2;

    for (let i = 0; i < this.deckEntries.length; i++) {
      const e = this.deckEntries[i]!;
      const x = startX + i * (slotW + 16);
      const container = this.add.container(x, y);

      const bg = this.add.graphics();
      const redraw = (selected: boolean): void => {
        bg.clear();
        bg.fillStyle(selected ? 0x3a7f3a : 0x1a2b1a, 1);
        bg.lineStyle(3, selected ? 0xffd98a : 0x2c5a23, 1);
        bg.fillRoundedRect(-slotW / 2, -DECK_H / 2 + 6, slotW, DECK_H - 12, 10);
        bg.strokeRoundedRect(-slotW / 2, -DECK_H / 2 + 6, slotW, DECK_H - 12, 10);
      };
      redraw(i === this.selectedDeckIdx);

      const icon = this.add.image(0, -12, e.icon).setDisplaySize(48, 48);
      const label = this.add
        .text(0, 18, `${e.label} ×${e.count}`, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '13px',
          color: '#e6f5d2',
        })
        .setOrigin(0.5);

      container.add([bg, icon, label]);
      container.setSize(slotW, DECK_H);
      container
        .setInteractive(
          new Phaser.Geom.Rectangle(-slotW / 2, -DECK_H / 2, slotW, DECK_H),
          Phaser.Geom.Rectangle.Contains,
        )
        .on('pointerdown', () => {
          this.selectedDeckIdx = i;
          this.deckContainers.forEach((c, j) => {
            const bgObj = c.getAt(0) as Phaser.GameObjects.Graphics;
            bgObj.clear();
            const isSel = j === this.selectedDeckIdx;
            bgObj.fillStyle(isSel ? 0x3a7f3a : 0x1a2b1a, 1);
            bgObj.lineStyle(3, isSel ? 0xffd98a : 0x2c5a23, 1);
            bgObj.fillRoundedRect(-slotW / 2, -DECK_H / 2 + 6, slotW, DECK_H - 12, 10);
            bgObj.strokeRoundedRect(-slotW / 2, -DECK_H / 2 + 6, slotW, DECK_H - 12, 10);
          });
        });

      this.deckContainers.push(container);
      this.deckLabels.push(label);
    }
  }

  private wirePointerInput(): void {
    const withinBoard = (px: number, py: number): boolean => {
      const origin = this.boardContainer.getBounds();
      return (
        px >= origin.x && px <= origin.x + BOARD_W && py >= origin.y && py <= origin.y + BOARD_H
      );
    };
    const toTile = (px: number, py: number): { tx: number; ty: number } => {
      const origin = this.boardContainer.getBounds();
      return { tx: (px - origin.x) / TILE, ty: (py - origin.y) / TILE };
    };

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (!withinBoard(p.x, p.y)) return;
      if (this.state.outcome !== 'ongoing') return;
      if (this.currentDeckEntry().count <= 0) return;
      this.isDrawing = true;
      this.drawingPoints = [{ x: p.x, y: p.y }];
      this.renderTrailPreview();
    });

    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.isDrawing) return;
      const last = this.drawingPoints[this.drawingPoints.length - 1]!;
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      if (dx * dx + dy * dy < 18 * 18) return;
      if (this.drawingPoints.length >= 32) return;
      this.drawingPoints.push({ x: p.x, y: p.y });
      this.renderTrailPreview();
    });

    this.input.on('pointerup', () => {
      if (!this.isDrawing) return;
      this.isDrawing = false;
      if (this.drawingPoints.length < 2) {
        this.trailGraphics.clear();
        return;
      }
      // Commit as a deploy input targeted for the next tick.
      const entry = this.currentDeckEntry();
      const tilePoints: Types.PheromonePoint[] = this.drawingPoints.map((p) => {
        const { tx, ty } = toTile(p.x, p.y);
        return { x: Sim.fromFloat(tx), y: Sim.fromFloat(ty) };
      });
      const burst = Math.min(entry.count, 5);
      entry.count -= burst;
      const label = this.deckLabels[this.selectedDeckIdx]!;
      label.setText(`${entry.label} ×${entry.count}`);

      this.pendingInputs.push({
        type: 'deployPath',
        tick: this.state.tick + 1,
        ownerSlot: 0,
        path: {
          pathId: 0,
          spawnLayer: 0,
          unitKind: entry.kind,
          count: burst,
          points: tilePoints,
        },
      });

      // fade the committed trail
      this.tweens.add({
        targets: this.trailGraphics,
        alpha: { from: 1, to: 0 },
        duration: 600,
        onComplete: () => {
          this.trailGraphics.clear();
          this.trailGraphics.setAlpha(1);
        },
      });
    });
  }

  private currentDeckEntry(): DeckEntry {
    return this.deckEntries[this.selectedDeckIdx]!;
  }

  private renderTrailPreview(): void {
    const origin = this.boardContainer.getBounds();
    this.trailGraphics.clear();
    this.trailGraphics.lineStyle(6, 0xffd98a, 0.85);
    this.trailGraphics.beginPath();
    for (let i = 0; i < this.drawingPoints.length; i++) {
      const p = this.drawingPoints[i]!;
      const x = p.x - origin.x;
      const y = p.y - origin.y;
      if (i === 0) this.trailGraphics.moveTo(x, y);
      else this.trailGraphics.lineTo(x, y);
    }
    this.trailGraphics.strokePath();
    for (const p of this.drawingPoints) {
      this.trailGraphics.fillStyle(0xffd98a, 0.9);
      this.trailGraphics.fillCircle(p.x - origin.x, p.y - origin.y, 4);
    }
  }

  private renderFrame(): void {
    // HUD timer & loot
    const ticksRemaining = Math.max(0, this.cfg.maxTicks - this.state.tick);
    const secondsRemaining = Math.ceil(ticksRemaining / TICK_HZ);
    const mm = Math.floor(secondsRemaining / 60);
    const ss = secondsRemaining % 60;
    this.timerText.setText(`${mm}:${ss.toString().padStart(2, '0')}`);
    const stars = this.currentStars();
    this.starsText.setText('★'.repeat(stars) + '☆'.repeat(3 - stars));
    this.lootText.setText(
      `loot: ${this.state.attackerSugarLooted} sugar · ${this.state.attackerLeafBitsLooted} leaf`,
    );

    // Buildings: update HP bars and fade destroyed ones.
    for (const b of this.state.buildings) {
      const spr = this.buildingSprites.get(b.id);
      const bar = this.buildingHpBars.get(b.id);
      if (!spr || !bar) continue;
      if (b.hp <= 0) {
        if (spr.alpha > 0.2) {
          this.tweens.add({ targets: spr, alpha: 0.18, duration: 200 });
          // quick impact flash
          this.cameras.main.shake(80, 0.002);
        }
        bar.clear();
        continue;
      }
      const hpFrac = Math.max(0, Math.min(1, b.hp / b.hpMax));
      const barX = b.anchorX * TILE + (b.w * TILE) / 2 - 22;
      const barY = b.anchorY * TILE - 10;
      bar.clear();
      bar.fillStyle(0x1a1208, 0.7);
      bar.fillRoundedRect(barX, barY, 44, 6, 2);
      bar.fillStyle(hpFrac > 0.5 ? 0x5ba445 : hpFrac > 0.2 ? 0xf2d06b : 0xd94c4c, 1);
      bar.fillRoundedRect(barX + 1, barY + 1, 42 * hpFrac, 4, 2);
    }

    // Units: sync sprites to sim positions.
    const alive = new Set<number>();
    for (const u of this.state.units) {
      alive.add(u.id);
      let spr = this.unitSprites.get(u.id);
      const x = Sim.toFloat(u.x) * TILE;
      const y = Sim.toFloat(u.y) * TILE;
      if (!spr) {
        spr = this.add.image(x, y, `unit-${u.kind}`).setDisplaySize(28, 28).setOrigin(0.5, 0.7);
        this.boardContainer.add(spr);
        this.unitSprites.set(u.id, spr);
      } else {
        spr.setPosition(x, y);
      }
      const hpFrac = Math.max(0, Math.min(1, u.hp / u.hpMax));
      spr.setAlpha(0.35 + 0.65 * hpFrac);
    }
    for (const [id, spr] of this.unitSprites) {
      if (!alive.has(id)) {
        spr.destroy();
        this.unitSprites.delete(id);
      }
    }
  }

  private currentStars(): 0 | 1 | 2 | 3 {
    let total = 0;
    let destroyed = 0;
    let queenDead = false;
    for (const b of this.state.buildings) {
      total++;
      if (b.hp <= 0) {
        destroyed++;
        if (b.kind === 'QueenChamber') queenDead = true;
      }
    }
    const pct = total === 0 ? 0 : destroyed / total;
    return queenDead && pct >= 0.9 ? 3 : queenDead || pct >= 0.5 ? 2 : pct > 0 ? 1 : 0;
  }

  private showResult(): void {
    if (this.resultShown) return;
    this.resultShown = true;

    const stars = this.currentStars();
    const overlay = this.add.graphics().setDepth(100);
    overlay.fillStyle(0x000000, 0.7);
    overlay.fillRect(0, 0, this.scale.width, this.scale.height);

    const cardW = 360;
    const cardH = 220;
    const card = this.add.graphics().setDepth(101);
    card.fillStyle(0x1a2b1a, 1);
    card.lineStyle(4, 0xffd98a, 1);
    const cx = (this.scale.width - cardW) / 2;
    const cy = (this.scale.height - cardH) / 2;
    card.fillRoundedRect(cx, cy, cardW, cardH, 16);
    card.strokeRoundedRect(cx, cy, cardW, cardH, 16);

    const heading =
      this.state.outcome === 'attackerWin' ? 'Raid successful' : 'Raid failed';
    this.add
      .text(this.scale.width / 2, cy + 30, heading, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '22px',
        color: '#ffd98a',
      })
      .setOrigin(0.5)
      .setDepth(102);

    this.add
      .text(this.scale.width / 2, cy + 70, '★'.repeat(stars) + '☆'.repeat(3 - stars), {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '30px',
        color: '#ffd98a',
      })
      .setOrigin(0.5)
      .setDepth(102);

    this.add
      .text(
        this.scale.width / 2,
        cy + 110,
        `loot: ${this.state.attackerSugarLooted} sugar · ${this.state.attackerLeafBitsLooted} leaf`,
        {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '14px',
          color: '#c3e8b0',
        },
      )
      .setOrigin(0.5)
      .setDepth(102);

    const btn = this.add
      .text(this.scale.width / 2, cy + 170, 'Back to home', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '16px',
        color: '#ffffff',
        backgroundColor: '#3a7f3a',
        padding: { left: 18, right: 18, top: 10, bottom: 10 },
      })
      .setOrigin(0.5)
      .setDepth(102)
      .setInteractive({ useHandCursor: true });
    btn.on('pointerdown', () => this.scene.start('HomeScene'));
  }

  private layout(): void {
    const xOffset = Math.max(0, (this.scale.width - BOARD_W) / 2);
    this.boardContainer.setX(xOffset);
    this.starsText.setX(this.scale.width - 16);
    this.lootText.setX(this.scale.width - 16);
    this.timerText.setX(this.scale.width / 2);
  }
}
