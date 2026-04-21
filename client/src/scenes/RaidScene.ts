import Phaser from 'phaser';
import { Sim, Types } from '@hive/shared';
import { bakeTrailDot } from '../assets/placeholders.js';
import { ANIMATED_UNIT_KINDS } from '../assets/atlas.js';
import type { HiveRuntime } from '../main.js';
import type { MatchResponse } from '../net/Api.js';

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
  // Sprites can be either a static Image or an animated Sprite (walk
  // cycle) depending on the kind + admin toggle. Both share the same
  // x/y/alpha/setDisplaySize surface we touch each tick, so the Map
  // stores the common base type.
  private unitSprites = new Map<
    number,
    Phaser.GameObjects.Image | Phaser.GameObjects.Sprite
  >();
  // Populated from GET /api/settings/animation at scene create.
  // A kind is "animated" iff (it's in ANIMATED_UNIT_KINDS) AND
  // (this Record has it set to true) AND (the walk texture loaded).
  private animationEnabled: Record<string, boolean> = {};
  private trailEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;

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
  // Captured from the match response so raid/submit can round-trip
  // against the same defender + seed + base snapshot that was used
  // to run the sim.
  private matchContext: MatchResponse | null = null;
  private raidInputs: Types.SimInput[] = [];
  private submitted = false;

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
    this.animationEnabled = {};
    // Fetch admin toggles without blocking scene start. By the time the
    // first unit spawns (usually a couple of ticks in), the settings
    // have resolved and animated kinds get walk-cycle sprites; before
    // that, everyone's static, which is the safe fallback anyway.
    const rt = this.registry.get('runtime') as HiveRuntime | undefined;
    if (rt) {
      void rt.api.getAnimationSettings().then((s) => {
        this.animationEnabled = s;
      });
    }
    this.pendingInputs = [];
    this.raidInputs = [];
    this.simTickElapsed = 0;
    this.resultShown = false;
    this.started = false;
    this.submitted = false;
    this.selectedDeckIdx = 0;
    this.drawingPoints = [];
    this.isDrawing = false;
    this.matchContext = null;

    // Start the scene synchronously against the hard-coded bot so there's
    // never a white flash; if a matchmaking response arrives shortly
    // after, it replaces the state and re-renders.
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    const attackerUnitLevels = (runtime?.player?.player.unitLevels ?? undefined) as
      | Record<string, number>
      | undefined;
    this.cfg = {
      tickRate: 30,
      maxTicks: TICK_HZ * RAID_SECONDS,
      initialSnapshot: BOT_BASE,
      seed: 0xc0ffee,
      ...(attackerUnitLevels ? { attackerUnitLevels } : {}),
    };
    this.state = Sim.createInitialState(this.cfg);
    void this.fetchMatchFromServer();

    this.drawHud();
    this.boardContainer = this.add.container(0, HUD_H);
    this.drawBoard();
    this.drawBuildingsFromState();
    this.trailGraphics = this.add.graphics().setDepth(10);
    this.boardContainer.add(this.trailGraphics);
    this.drawDeck();

    this.wirePointerInput();

    const trailKey = bakeTrailDot(this);

    // Particle trail that follows every unit. One shared emitter is far
    // cheaper than per-unit emitters; we just move its position each frame
    // when rendering to whichever unit needs a puff this tick.
    this.trailEmitter = this.add.particles(0, 0, trailKey, {
      lifespan: 340,
      speed: { min: 0, max: 10 },
      scale: { start: 0.9, end: 0 },
      alpha: { start: 0.6, end: 0 },
      blendMode: 'ADD',
      frequency: -1, // manual emit — explode() when we want a puff
      quantity: 1,
    });
    this.trailEmitter.setDepth(5);
    this.boardContainer.add(this.trailEmitter);

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

      const input: Types.SimInput = {
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
      };
      this.pendingInputs.push(input);
      // Replay timeline for server submission — every deploy the player
      // commits is recorded. Defeat/timeout endings submit this list
      // via /api/raid/submit, where the shared sim re-runs it to verify
      // the outcome before awarding trophies/loot.
      this.raidInputs.push(input);

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

  // Spawn the right visual for a unit. Three conditions must all be
  // true to render the walk-cycle animation:
  //
  //   1. The kind is in the hand-curated animated list (only 3 ship today).
  //   2. The admin hasn't disabled it via /admin/api/settings/animation.
  //   3. The walk spritesheet actually loaded (Gemini may not have
  //      generated it yet, or the asset might be missing on disk).
  //
  // Any miss → fall back to the static `unit-${kind}` image. The
  // fallback path is the one every non-animated unit uses today, so
  // there's zero behavioral change for Beetle / Spider / DirtDigger /
  // etc. — the feature is purely additive.
  private makeUnitSprite(
    kind: Types.UnitKind,
    x: number,
    y: number,
  ): Phaser.GameObjects.Image | Phaser.GameObjects.Sprite {
    const isAnimatedKind = (ANIMATED_UNIT_KINDS as readonly string[]).includes(kind);
    const enabled = this.animationEnabled[kind] !== false;
    const sheetKey = `unit-${kind}-walk`;
    const animKey = `walk-${kind}`;
    if (
      isAnimatedKind &&
      enabled &&
      this.textures.exists(sheetKey) &&
      this.anims.exists(animKey)
    ) {
      const spr = this.add
        .sprite(x, y, sheetKey)
        .setDisplaySize(28, 28)
        .setOrigin(0.5, 0.7);
      spr.play(animKey);
      return spr;
    }
    return this.add
      .image(x, y, `unit-${kind}`)
      .setDisplaySize(28, 28)
      .setOrigin(0.5, 0.7);
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

    // Units: sync sprites to sim positions; puff the shared trail emitter.
    const alive = new Set<number>();
    for (const u of this.state.units) {
      alive.add(u.id);
      let spr = this.unitSprites.get(u.id);
      const x = Sim.toFloat(u.x) * TILE;
      const y = Sim.toFloat(u.y) * TILE;
      if (!spr) {
        spr = this.makeUnitSprite(u.kind, x, y);
        this.boardContainer.add(spr);
        this.unitSprites.set(u.id, spr);
      } else {
        spr.setPosition(x, y);
      }
      const hpFrac = Math.max(0, Math.min(1, u.hp / u.hpMax));
      spr.setAlpha(0.35 + 0.65 * hpFrac);
      // Emit one tiny pheromone puff at the unit's feet every ~5 frames.
      // Rate-limited implicitly by the alternating (id % 5 === tick % 5)
      // check so we don't drown in particles with a full swarm.
      if ((u.id + this.state.tick) % 5 === 0) {
        this.trailEmitter.emitParticle(1, x, y + 4);
      }
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

  // Pulls a real opponent from /api/match. If the attacker has no
  // authenticated session or the API 503s, we quietly stay on the bot
  // base the scene already booted with — raid still plays.
  private async fetchMatchFromServer(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const match = await runtime.api.requestMatch(
        runtime.player?.player.trophies ?? 100,
      );
      // Race guard: if the player already started committing inputs
      // against the fallback bot base before this response arrived,
      // swapping the sim state mid-raid would corrupt the replay
      // (matchToken would point at one base, inputs collected against
      // another). Keep the bot fight and let the raid run its course
      // — the only cost is the match token becomes an unused
      // pending_matches row that expires in 15 min.
      if (this.raidInputs.length > 0 || this.isDrawing || this.submitted) {
        return;
      }
      this.matchContext = match;
      // Rebuild sim against the real opponent's snapshot. Carry the
      // attacker unit-level table forward so the client sim produces
      // the same hash the server will when it re-runs.
      const attackerUnitLevels = (runtime?.player?.player.unitLevels ?? undefined) as
        | Record<string, number>
        | undefined;
      this.cfg = {
        tickRate: 30,
        maxTicks: TICK_HZ * RAID_SECONDS,
        initialSnapshot: match.baseSnapshot,
        seed: match.seed,
        ...(attackerUnitLevels ? { attackerUnitLevels } : {}),
      };
      this.state = Sim.createInitialState(this.cfg);
      // Re-render buildings from the new state. Wipe the board of the
      // stale bot sprites first.
      for (const spr of this.buildingSprites.values()) spr.destroy();
      this.buildingSprites.clear();
      for (const bar of this.buildingHpBars.values()) bar.destroy();
      this.buildingHpBars.clear();
      this.drawBuildingsFromState();
      this.add
        .text(this.scale.width / 2, 4, `vs ${match.opponent.displayName}`, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '12px',
          color: match.opponent.isBot ? '#c3e8b0' : '#ffd98a',
        })
        .setOrigin(0.5, 0)
        .setDepth(50);
    } catch (err) {
      // Non-fatal — keep the hard-coded bot.
      console.warn('match fetch failed, staying on bot:', err);
    }
  }

  // Submit the full raid replay to the server. Server re-runs the sim
  // authoritatively, persists to the `raids` table, and returns the
  // player's new resource totals. We patch those into runtime.player so
  // HomeScene shows the updated numbers when the scene re-enters.
  private async submitToServer(): Promise<void> {
    if (this.submitted) return;
    this.submitted = true;
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime || !this.matchContext) return;
    try {
      const res = await runtime.api.submitRaid({
        matchToken: this.matchContext.matchToken,
        inputs: this.raidInputs,
        clientResultHash: Sim.hashToHex(Sim.hashSimState(this.state)),
      });
      if (runtime.player) {
        runtime.player.player.trophies = res.player.trophies;
        runtime.player.player.sugar = res.player.sugar;
        runtime.player.player.leafBits = res.player.leafBits;
        runtime.player.player.aphidMilk = res.player.aphidMilk;
      }
    } catch (err) {
      // Showing an error would steal focus from the result screen;
      // log and move on — the local result is already displayed.
      console.warn('raid submit failed:', err);
    }
  }

  private showResult(): void {
    if (this.resultShown) return;
    this.resultShown = true;
    // Fire-and-forget the server submission. The result card renders
    // immediately; loot/trophies in the HUD will reflect on return
    // to HomeScene either way.
    void this.submitToServer();

    const stars = this.currentStars();
    const overlay = this.add.graphics().setDepth(100);
    overlay.fillStyle(0x000000, 0.7);
    overlay.fillRect(0, 0, this.scale.width, this.scale.height);

    // Card is a bit taller on wins to accommodate the Share button.
    const isWin = this.state.outcome === 'attackerWin' && stars > 0;
    const cardW = 360;
    const cardH = isWin ? 270 : 220;
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

    const actionsY = isWin ? cy + 220 : cy + 170;

    const backBtn = this.add
      .text(
        isWin ? this.scale.width / 2 - 80 : this.scale.width / 2,
        actionsY,
        'Back to home',
        {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '16px',
          color: '#ffffff',
          backgroundColor: '#3a7f3a',
          padding: { left: 18, right: 18, top: 10, bottom: 10 },
        },
      )
      .setOrigin(0.5)
      .setDepth(102)
      .setInteractive({ useHandCursor: true });
    backBtn.on('pointerdown', () => this.scene.start('HomeScene'));

    if (isWin) {
      const shareBtn = this.add
        .text(this.scale.width / 2 + 80, actionsY, '📣 Share', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '16px',
          color: '#0f1b10',
          backgroundColor: '#ffd98a',
          padding: { left: 18, right: 18, top: 10, bottom: 10 },
        })
        .setOrigin(0.5)
        .setDepth(102)
        .setInteractive({ useHandCursor: true });
      shareBtn.on('pointerdown', () => void this.shareOutcome(stars));
    }
  }

  // Fire-and-forget share. Uses the bridge's cascading fallback:
  // FB Instant → Web Share API → clipboard. On clipboard copy we flash
  // a tiny toast so the user knows something happened (vs the share
  // sheet, which is its own confirmation).
  private async shareOutcome(stars: 0 | 1 | 2 | 3): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    const opponent = this.matchContext?.opponent.displayName ?? 'a rival hive';
    const text =
      `${'★'.repeat(stars)} Raided ${opponent} in Hive Wars! ` +
      `${this.state.attackerSugarLooted} sugar + ${this.state.attackerLeafBitsLooted} leaf looted.`;
    try {
      const mode = await runtime.fb.shareRaidResult({ text });
      // User may have tapped Back-to-home while the share sheet was up;
      // touching a torn-down scene would throw.
      if (!this.scene.isActive()) return;
      if (mode === 'clipboard') this.flashShareToast('Copied to clipboard');
      else if (mode === 'unavailable')
        this.flashShareToast('Share unavailable here');
    } catch (err) {
      console.warn('share failed', err);
      if (this.scene.isActive()) this.flashShareToast('Share failed');
    }
  }

  private flashShareToast(msg: string): void {
    const t = this.add
      .text(this.scale.width / 2, this.scale.height - 40, msg, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#0f1b10',
        backgroundColor: '#ffd98a',
        padding: { left: 10, right: 10, top: 6, bottom: 6 },
      })
      .setOrigin(0.5)
      .setDepth(500);
    this.tweens.add({
      targets: t,
      alpha: { from: 1, to: 0 },
      delay: 1600,
      duration: 400,
      onComplete: () => t.destroy(),
    });
  }

  private layout(): void {
    const xOffset = Math.max(0, (this.scale.width - BOARD_W) / 2);
    this.boardContainer.setX(xOffset);
    this.starsText.setX(this.scale.width - 16);
    this.lootText.setX(this.scale.width - 16);
    this.timerText.setX(this.scale.width / 2);
  }
}
