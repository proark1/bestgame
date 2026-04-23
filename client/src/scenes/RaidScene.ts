import Phaser from 'phaser';
import { Sim, Types } from '@hive/shared';
import { bakeTrailDot } from '../assets/placeholders.js';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { ANIMATED_UNIT_KINDS } from '../assets/atlas.js';
import { makeHiveButton } from '../ui/button.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { COLOR, bodyTextStyle, displayTextStyle, labelTextStyle } from '../ui/theme.js';
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
const DECK_CARD_H = 96;
const DECK_CARD_W = 108;
const DECK_GRID_GAP = 12;
const TICK_HZ = 30;
const RAID_SECONDS = 90;
const SPAWN_ZONE_W = TILE * 2;

interface DeckEntry {
  kind: Types.UnitKind;
  count: number;
  icon: string;
  label: string;
}

// Full attacker roster with default deck counts. The scene filters
// this down to the kinds the player has unlocked at their current
// Queen Chamber level — unlock thresholds live on the server in
// server/api/src/game/buildingRules.ts::UNIT_UNLOCK_QUEEN_LEVEL and
// are mirrored here for fast client-side gating (the server still
// rejects locked deploys in routes/raid.ts so this is UX, not trust).
const ALL_DECK: Array<DeckEntry & { unlockQueenLevel: number }> = [
  { kind: 'SoldierAnt', count: 10, icon: 'unit-SoldierAnt', label: 'Soldier', unlockQueenLevel: 1 },
  { kind: 'WorkerAnt',  count: 8,  icon: 'unit-WorkerAnt',  label: 'Worker',   unlockQueenLevel: 1 },
  { kind: 'DirtDigger', count: 4,  icon: 'unit-DirtDigger', label: 'Digger',   unlockQueenLevel: 1 },
  { kind: 'Wasp',       count: 4,  icon: 'unit-Wasp',       label: 'Wasp',     unlockQueenLevel: 1 },
  { kind: 'FireAnt',    count: 6,  icon: 'unit-FireAnt',    label: 'FireAnt',  unlockQueenLevel: 2 },
  { kind: 'Termite',    count: 5,  icon: 'unit-Termite',    label: 'Termite',  unlockQueenLevel: 3 },
  { kind: 'Dragonfly',  count: 4,  icon: 'unit-Dragonfly',  label: 'Dragon',   unlockQueenLevel: 3 },
  { kind: 'Mantis',     count: 3,  icon: 'unit-Mantis',     label: 'Mantis',   unlockQueenLevel: 4 },
  { kind: 'Scarab',     count: 2,  icon: 'unit-Scarab',     label: 'Scarab',   unlockQueenLevel: 5 },
];

function queenLevelFromBase(base: Types.Base | undefined): number {
  if (!base) return 1;
  const queen = base.buildings.find((b) => b.kind === 'QueenChamber');
  const lvl = queen?.level ?? 1;
  return Math.max(1, Math.min(5, Math.floor(lvl)));
}

function buildDeck(attackerQueenLevel: number): DeckEntry[] {
  return ALL_DECK
    .filter((d) => d.unlockQueenLevel <= attackerQueenLevel)
    .map((d) => {
      // Strip the gate field from the runtime deck entry — RaidScene
      // logic keys off of {kind, count, icon, label} only.
      const { unlockQueenLevel: _unlock, ...rest } = d;
      void _unlock;
      return rest;
    });
}

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
  // Side-maps for the hit-flash and death-burst juice. Kept separate
  // from SimState so the sim stays pure and replayable.
  private buildingLastHp = new Map<number, number>();
  private buildingKillPlayed = new Set<number>();
  private unitLastHp = new Map<number, number>();
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
  private attackerQueenLevel = 1;

  // Trail drawing state.
  private selectedDeckIdx = 0;
  private deckEntries: DeckEntry[] = [];
  // Stored in board-local pixels, not world/screen pixels, so the drawn
  // trail and the committed deploy path stay locked together even when the
  // board is scaled for mobile layouts.
  private drawingPoints: Array<{ x: number; y: number }> = [];
  private trailGraphics!: Phaser.GameObjects.Graphics;
  private isDrawing = false;

  // UI widgets.
  private timerText!: Phaser.GameObjects.Text;
  private starsText!: Phaser.GameObjects.Text;
  private lootText!: Phaser.GameObjects.Text;
  private deckTrayBg!: Phaser.GameObjects.Graphics;
  private deckSelectedIcon!: Phaser.GameObjects.Image;
  private deckSelectedText!: Phaser.GameObjects.Text;
  private deckHintText!: Phaser.GameObjects.Text;
  private deckUnlockText!: Phaser.GameObjects.Text;
  private boardGuide!: Phaser.GameObjects.Container;
  private spawnZoneGraphics!: Phaser.GameObjects.Graphics;
  private spawnZoneLabel!: Phaser.GameObjects.Text;
  private spawnZoneCue!: Phaser.GameObjects.Container;
  private deckContainers: Phaser.GameObjects.Container[] = [];
  // Parallel array to deckContainers — avoids monkey-patching the
  // container with a labelText property.
  private deckLabels: Phaser.GameObjects.Text[] = [];

  private simTickElapsed = 0; // fractional tick accumulator
  private deckCardScale = 1;
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
    fadeInScene(this);
    installSceneClickDebug(this);
    // Reset all per-run state. Scene instances are reused across raids,
    // so previous-run state must be cleared here or it'll leak.
    // Deck is filtered by the attacker's own Queen level — locked
    // kinds aren't shown at all. Matches CoC's barracks-gated card
    // roster and keeps raid UI uncluttered at low tiers.
    const initRuntime = this.registry.get('runtime') as HiveRuntime | undefined;
    this.attackerQueenLevel = queenLevelFromBase(initRuntime?.player?.base);
    this.deckEntries = buildDeck(this.attackerQueenLevel);
    this.deckContainers = [];
    this.deckLabels = [];
    this.buildingSprites.clear();
    this.buildingHpBars.clear();
    this.buildingLastHp.clear();
    this.buildingKillPlayed.clear();
    this.unitSprites.clear();
    this.unitLastHp.clear();
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
    this.drawDeckTray();
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
    g.fillGradientStyle(
      COLOR.bgPanelHi,
      COLOR.bgPanelHi,
      COLOR.bgPanelLo,
      COLOR.bgPanelLo,
      1,
    );
    g.fillRect(0, 0, this.scale.width, HUD_H);
    g.fillStyle(COLOR.brass, 0.35);
    g.fillRect(0, 1, this.scale.width, 1);
    g.fillStyle(COLOR.brassDeep, 1);
    g.fillRect(0, HUD_H - 4, this.scale.width, 1);
    g.fillStyle(COLOR.brass, 0.7);
    g.fillRect(0, HUD_H - 3, this.scale.width, 2);
    g.fillStyle(0x000000, 0.45);
    g.fillRect(0, HUD_H, this.scale.width, 3);

    makeHiveButton(this, {
      x: 80,
      y: HUD_H / 2,
      width: 120,
      height: 36,
      label: '← Home',
      variant: 'ghost',
      fontSize: 13,
      onPress: () => fadeToScene(this, 'HomeScene'),
    });

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

    this.spawnZoneGraphics = this.add.graphics().setDepth(2);
    this.spawnZoneGraphics.fillStyle(0xc3e8b0, 0.09);
    this.spawnZoneGraphics.fillRect(0, 0, SPAWN_ZONE_W, BOARD_H);
    this.spawnZoneGraphics.lineStyle(3, 0xc3e8b0, 0.45);
    this.spawnZoneGraphics.strokeRect(0, 0, SPAWN_ZONE_W, BOARD_H);
    const chevrons = [0, 1, 2].map((i) =>
      this.add
        .text(SPAWN_ZONE_W / 2, 140 + i * 120, '>>>', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '22px',
          color: '#c3e8b0',
        })
        .setOrigin(0.5)
        .setAlpha(0.28),
    );
    this.spawnZoneLabel = this.add
      .text(SPAWN_ZONE_W / 2, BOARD_H / 2, 'SPAWN\nEDGE', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '18px',
        color: '#c3e8b0',
        align: 'center',
      })
      .setOrigin(0.5)
      .setAlpha(0.75)
      .setDepth(3);
    this.spawnZoneCue = this.add.container(0, 0, chevrons);
    this.spawnZoneCue.setDepth(3);
    this.tweens.add({
      targets: chevrons,
      x: `+=10`,
      alpha: { from: 0.18, to: 0.55 },
      duration: 900,
      stagger: 120,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    this.boardContainer.add([
      bg,
      this.spawnZoneGraphics,
      grid,
      this.spawnZoneCue,
      this.spawnZoneLabel,
    ]);
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
      // Bumped the minimum visible footprint from 1.6× tile → 1.85×
      // so buildings read bigger on the board; matches HomeScene's
      // same bump. Source sprites are 128 px, so at 89 px display
      // we're at a cleaner 0.69 downscale (less blur).
      spr.setDisplaySize(TILE * Math.max(b.w, 1.85), TILE * Math.max(b.h, 1.85));
      this.boardContainer.add(spr);
      this.buildingSprites.set(b.id, spr);

      const bar = this.add.graphics();
      this.boardContainer.add(bar);
      this.buildingHpBars.set(b.id, bar);
    }
  }

  private drawDeck(): void {
    for (let i = 0; i < this.deckEntries.length; i++) {
      const e = this.deckEntries[i]!;
      const container = this.add.container(0, 0).setDepth(31);

      const bg = this.add.graphics();
      const icon = this.add.image(0, -12, e.icon).setDisplaySize(48, 48);
      const label = this.add
        .text(0, 18, `${e.label} ×${e.count}`, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '13px',
          color: '#e6f5d2',
        })
        .setOrigin(0.5);

      container.add([bg, icon, label]);
      container.setSize(DECK_CARD_W, DECK_CARD_H);
      container
        .setInteractive(
          new Phaser.Geom.Rectangle(
            -DECK_CARD_W / 2,
            -DECK_CARD_H / 2,
            DECK_CARD_W,
            DECK_CARD_H,
          ),
          Phaser.Geom.Rectangle.Contains,
        )
        .on('pointerdown', () => {
          this.selectDeckIndex(i);
        });

      this.deckContainers.push(container);
      this.deckLabels.push(label);
      this.redrawDeckCard(i);
    }
    this.refreshDeckUi();
  }

  private wirePointerInput(): void {
    // Board can be scaled down on narrow viewports (phone, narrow
    // laptop). Convert world-space pointer coords to board-local
    // tiles by reading boardContainer.(x, y, scaleX) directly.
    //
    // Previously this used boardContainer.getBounds(), but Phaser
    // Graphics children report (0, 0, 0, 0) bounds regardless of
    // what's been drawn into them — so the container's bounds end
    // up dominated by Sprite children (buildings, units), which move
    // and appear/disappear during a raid. That produced a drifting
    // offset between the cursor and the pheromone-trail preview.
    // Direct (.x, .y, .scaleX) reads are deterministic and always
    // reflect the layout() position, no matter what's on the board.
    const withinBoard = (px: number, py: number): boolean => {
      const scale = this.boardContainer.scaleX || 1;
      const x0 = this.boardContainer.x;
      const y0 = this.boardContainer.y;
      const w = BOARD_W * scale;
      const h = BOARD_H * scale;
      return px >= x0 && px <= x0 + w && py >= y0 && py <= y0 + h;
    };
    const toBoardLocal = (px: number, py: number): { x: number; y: number } => {
      const scale = this.boardContainer.scaleX || 1;
      return {
        x: Phaser.Math.Clamp((px - this.boardContainer.x) / scale, 0, BOARD_W),
        y: Phaser.Math.Clamp((py - this.boardContainer.y) / scale, 0, BOARD_H),
      };
    };
    const withinSpawnZone = (px: number, py: number): boolean => {
      const local = toBoardLocal(px, py);
      return local.x <= SPAWN_ZONE_W;
    };

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (!withinBoard(p.x, p.y)) return;
      if (this.state.outcome !== 'ongoing') return;
      if (this.currentDeckEntry().count <= 0) return;
      if (!withinSpawnZone(p.x, p.y)) {
        this.deckHintText.setText('Start your drag from the glowing spawn edge on the left.');
        return;
      }
      const local = toBoardLocal(p.x, p.y);
      this.isDrawing = true;
      this.drawingPoints = [local];
      this.boardGuide.setVisible(false);
      const burst = Math.min(this.currentDeckEntry().count, 5);
      this.deckHintText.setText(`Draw through the base, then release to deploy up to ${burst}.`);
      this.renderTrailPreview();
    });

    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.isDrawing) return;
      const local = toBoardLocal(p.x, p.y);
      const last = this.drawingPoints[this.drawingPoints.length - 1]!;
      const dx = local.x - last.x;
      const dy = local.y - last.y;
      if (dx * dx + dy * dy < 14 * 14) return;
      if (this.drawingPoints.length >= 32) return;
      this.drawingPoints.push(local);
      this.renderTrailPreview();
    });

    this.input.on('pointerup', () => {
      if (!this.isDrawing) return;
      this.isDrawing = false;
      this.deckHintText.setText('Pick a unit, then drag on the battlefield to draw its path.');
      if (this.drawingPoints.length < 2) {
        this.trailGraphics.clear();
        this.boardGuide.setVisible(this.raidInputs.length === 0 && this.currentDeckEntry().count > 0);
        return;
      }
      // Commit as a deploy input targeted for the next tick.
      const entry = this.currentDeckEntry();
      const tilePoints: Types.PheromonePoint[] = this.drawingPoints.map((p) => {
        return {
          x: Sim.fromFloat(p.x / TILE),
          y: Sim.fromFloat(p.y / TILE),
        };
      });
      const burst = Math.min(entry.count, 5);
      entry.count -= burst;
      if (entry.count <= 0) {
        const next = this.deckEntries.findIndex((candidate) => candidate.count > 0);
        if (next >= 0) this.selectedDeckIdx = next;
      }
      this.refreshDeckUi();

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
      const start = this.drawingPoints[0];
      if (start) this.spawnDeployPopup(start.x + 18, start.y - 8, entry.label, burst);

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

  private drawDeckTray(): void {
    this.deckTrayBg = this.add.graphics().setDepth(30);
    this.deckSelectedIcon = this.add
      .image(0, 0, this.deckEntries[0]?.icon ?? 'unit-WorkerAnt')
      .setDisplaySize(34, 34)
      .setDepth(31);
    this.deckSelectedText = this.add
      .text(0, 0, '', displayTextStyle(15, '#ffd98a', 3))
      .setOrigin(0.5, 0)
      .setDepth(31);
    this.deckHintText = this.add
      .text(
        0,
        0,
        'Pick a unit, then drag on the battlefield to draw its path.',
        { ...bodyTextStyle(11, '#c3e8b0'), align: 'center' },
      )
      .setOrigin(0.5, 0)
      .setDepth(31);
    this.deckUnlockText = this.add
      .text(0, 0, '', { ...labelTextStyle(10, '#9fc79a'), align: 'center' })
      .setOrigin(0.5, 0)
      .setDepth(31);
    const guideBg = this.add.graphics();
    drawPanel(guideBg, -118, -22, 236, 44, {
      topColor: 0x172117,
      botColor: 0x0a120b,
      stroke: COLOR.brassDeep,
      strokeWidth: 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.2,
      radius: 14,
      shadowOffset: 3,
      shadowAlpha: 0.35,
    });
    const guideText = this.add
      .text(0, 0, 'Drag a path here to attack', displayTextStyle(13, '#ffd98a', 3))
      .setOrigin(0.5);
    this.boardGuide = this.add.container(BOARD_W / 2, 28, [guideBg, guideText]);
    this.boardGuide.setDepth(15);
    this.boardContainer.add(this.boardGuide);
    this.tweens.add({
      targets: this.boardGuide,
      alpha: { from: 0.55, to: 1 },
      duration: 850,
      yoyo: true,
      repeat: -1,
    });
  }

  private selectDeckIndex(index: number): void {
    this.selectedDeckIdx = Phaser.Math.Clamp(index, 0, this.deckEntries.length - 1);
    const container = this.deckContainers[this.selectedDeckIdx];
    if (container) {
      this.tweens.killTweensOf(container);
      container.setScale(this.deckCardScale);
      this.tweens.add({
        targets: container,
        scaleX: this.deckCardScale * 1.05,
        scaleY: this.deckCardScale * 1.05,
        duration: 110,
        yoyo: true,
      });
    }
    this.refreshDeckUi();
  }

  private redrawDeckCard(index: number): void {
    const container = this.deckContainers[index];
    const bgObj = container?.getAt(0) as Phaser.GameObjects.Graphics | undefined;
    const label = this.deckLabels[index];
    const entry = this.deckEntries[index];
    if (!container || !bgObj || !label || !entry) return;
    const selected = index === this.selectedDeckIdx;
    const depleted = entry.count <= 0;
    bgObj.clear();
    bgObj.fillStyle(
      depleted ? 0x241d1d : selected ? 0x3a7f3a : 0x1a2b1a,
      1,
    );
    bgObj.lineStyle(
      3,
      depleted ? 0x5a4141 : selected ? 0xffd98a : 0x2c5a23,
      1,
    );
    bgObj.fillRoundedRect(
      -DECK_CARD_W / 2,
      -DECK_CARD_H / 2 + 6,
      DECK_CARD_W,
      DECK_CARD_H - 12,
      10,
    );
    bgObj.strokeRoundedRect(
      -DECK_CARD_W / 2,
      -DECK_CARD_H / 2 + 6,
      DECK_CARD_W,
      DECK_CARD_H - 12,
      10,
    );
    bgObj.fillStyle(selected ? 0xffffff : COLOR.brass, selected ? 0.1 : 0.04);
    bgObj.fillRoundedRect(
      -DECK_CARD_W / 2 + 6,
      -DECK_CARD_H / 2 + 12,
      DECK_CARD_W - 12,
      8,
      6,
    );
    label.setText(`${entry.label} ×${entry.count}`);
    label.setColor(depleted ? '#d98080' : '#e6f5d2');
    container.setAlpha(depleted ? 0.55 : 1);
  }

  private refreshDeckUi(): void {
    for (let i = 0; i < this.deckContainers.length; i++) this.redrawDeckCard(i);
    const entry = this.currentDeckEntry();
    if (!entry) return;
    this.deckSelectedIcon.setTexture(entry.icon);
    this.deckSelectedIcon.setAlpha(entry.count > 0 ? 1 : 0.5);
    const status = entry.count > 0 ? `${entry.count} ready` : 'depleted';
    const burst = Math.min(entry.count, 5);
    this.deckSelectedText.setText(
      `Selected: ${entry.label} (${status})${entry.count > 0 ? ` • deploys ${burst} per drag` : ''}`,
    );
    this.deckHintText.setText(
      entry.count > 0
        ? 'Tap a card, then drag across the battlefield to draw its attack path.'
        : 'Selected unit is depleted. Pick another card to keep attacking.',
    );
    const upcoming = ALL_DECK.filter((d) => d.unlockQueenLevel > this.attackerQueenLevel)
      .slice(0, 2)
      .map((d) => `${d.label} L${d.unlockQueenLevel}`);
    this.deckUnlockText.setText(
      upcoming.length > 0
        ? `Next unlocks: ${upcoming.join(' • ')}`
        : 'All attacker units unlocked at your current Queen level.',
    );
    const showOnboarding = !this.isDrawing && this.raidInputs.length === 0 && entry.count > 0;
    this.boardGuide.setVisible(showOnboarding);
    this.spawnZoneCue.setVisible(showOnboarding);
    this.spawnZoneLabel.setVisible(showOnboarding);
  }

  private deckLayoutMetrics(): {
    rows: 1 | 2 | 3;
    cols: number;
    scale: number;
    trayHeight: number;
  } {
    // Minimum scale that keeps a card tap-friendly (48 px physical
    // targets per iOS HIG; DECK_CARD_W * 0.62 ≈ 67 px, comfortable for
    // thumbs and still shows the icon + count). Below this we wrap to
    // another row rather than shrinking cards further.
    const MIN_SCALE = 0.62;
    const WRAP_SCALE = 0.78;

    const count = Math.max(1, this.deckEntries.length);
    const availW = this.scale.width - 24;
    const scaleFor = (cols: number): number =>
      Math.min(
        1,
        (availW - DECK_GRID_GAP * Math.max(0, cols - 1)) / (DECK_CARD_W * cols),
      );

    // Pick the fewest rows that keep cards readable. Previously capped
    // at 2 rows, which on ≤360 px phones packed 5 cards into a row at
    // scale ~0.53 — below the tap-target floor. Now we fall through to
    // 3 rows when 2 would still shrink cards past MIN_SCALE.
    let rows: 1 | 2 | 3 = 1;
    if (scaleFor(count) < WRAP_SCALE) rows = 2;
    if (rows === 2 && scaleFor(Math.ceil(count / 2)) < MIN_SCALE) rows = 3;

    const cols = Math.ceil(count / rows);
    const scale = Math.max(MIN_SCALE, scaleFor(cols));
    const rowHeight = DECK_CARD_H * scale;
    const trayHeight =
      Math.ceil(56 + rows * rowHeight + (rows - 1) * DECK_GRID_GAP + 18);
    return { rows, cols, scale, trayHeight };
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
        .setDisplaySize(36, 36)
        .setOrigin(0.5, 0.7);
      spr.play(animKey);
      return spr;
    }
    return this.add
      .image(x, y, `unit-${kind}`)
      .setDisplaySize(36, 36)
      .setOrigin(0.5, 0.7);
  }

  private renderTrailPreview(): void {
    // drawingPoints already live in board-local coordinates, so the
    // preview can be drawn directly without any world-to-local math.
    this.trailGraphics.clear();
    this.trailGraphics.lineStyle(6, 0xffd98a, 0.85);
    this.trailGraphics.beginPath();
    for (let i = 0; i < this.drawingPoints.length; i++) {
      const p = this.drawingPoints[i]!;
      if (i === 0) this.trailGraphics.moveTo(p.x, p.y);
      else this.trailGraphics.lineTo(p.x, p.y);
    }
    this.trailGraphics.strokePath();
    this.trailGraphics.fillStyle(0xffd98a, 0.9);
    for (const p of this.drawingPoints) {
      this.trailGraphics.fillCircle(p.x, p.y, 4);
    }
    const start = this.drawingPoints[0];
    const end = this.drawingPoints[this.drawingPoints.length - 1];
    if (start) {
      this.trailGraphics.lineStyle(3, 0xc3e8b0, 0.95);
      this.trailGraphics.strokeCircle(start.x, start.y, 10);
      this.trailGraphics.fillStyle(0xc3e8b0, 0.95);
      this.trailGraphics.fillCircle(start.x, start.y, 5);
    }
    if (end) {
      this.trailGraphics.lineStyle(3, 0xffd98a, 1);
      this.trailGraphics.strokeCircle(end.x, end.y, 12);
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
          // Juice: Queen death is the hero moment — camera-punch zoom
          // out + long shake + a wide particle burst. Every other
          // building gets a smaller thud + debris puff. `destroyed`
          // tracks whether we've already played the kill effect on
          // this building so the tween doesn't re-fire every tick of
          // the 200ms fade.
          if (!this.buildingKillPlayed.has(b.id)) {
            this.buildingKillPlayed.add(b.id);
            const centerX = b.anchorX * TILE + (b.w * TILE) / 2;
            const centerY = b.anchorY * TILE + (b.h * TILE) / 2;
            this.spawnDebrisBurst(centerX, centerY, b.kind === 'QueenChamber' ? 24 : 10);
            if (b.kind === 'QueenChamber') {
              this.cameras.main.shake(340, 0.012);
              this.cameras.main.flash(180, 255, 230, 160);
              // Brief zoom punch: scale up the board container then
              // ease back. Uses the existing boardContainer transform
              // (layout() reads .x/.y/.scaleX) so no layout math breaks.
              const baseScale = this.boardContainer.scaleX || 1;
              this.tweens.add({
                targets: this.boardContainer,
                scaleX: baseScale * 1.08,
                scaleY: baseScale * 1.08,
                duration: 160,
                yoyo: true,
                ease: 'Sine.easeOut',
              });
            } else {
              this.cameras.main.shake(120, 0.004);
            }
            // Floating loot text for buildings that drop resources on
            // kill. Pulled from BUILDING_STATS via the sim-side loot
            // accumulators — we read the delta since the last frame.
            const bstats = Sim.BUILDING_STATS[b.kind];
            if (bstats.dropsSugarOnDestroy > 0 || bstats.dropsLeafBitsOnDestroy > 0) {
              this.spawnLootPopup(
                centerX,
                centerY - 16,
                bstats.dropsSugarOnDestroy,
                bstats.dropsLeafBitsOnDestroy,
              );
            }
          }
        }
        bar.clear();
        continue;
      }
      // Hit flash: tint the sprite briefly white-hot the frame a
      // building's hp drops. Compare to the previous tick to catch
      // the transition; store hp in a side Map so we don't leak fields
      // onto sim state.
      const prevHp = this.buildingLastHp.get(b.id) ?? b.hp;
      if (b.hp < prevHp) {
        spr.setTint(0xffe799);
        this.time.delayedCall(70, () => spr.clearTint());
      }
      this.buildingLastHp.set(b.id, b.hp);
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
      // Hit flash for units — same logic as buildings, keyed on a
      // side Map of last-seen hp. Cheap: one Map lookup + one
      // comparison per live unit per frame.
      const prevHp = this.unitLastHp.get(u.id) ?? u.hp;
      if (u.hp < prevHp && u.hp > 0) {
        spr.setTint(0xffe0c0);
        this.time.delayedCall(60, () => {
          // The sprite might be gone by the time the delayed call fires
          // if the unit died within 60ms of the hit; guard before touch.
          if (this.unitSprites.get(u.id) === spr) spr.clearTint();
        });
      }
      this.unitLastHp.set(u.id, u.hp);
      // Emit one tiny pheromone puff at the unit's feet every ~5 frames.
      // Rate-limited implicitly by the alternating (id % 5 === tick % 5)
      // check so we don't drown in particles with a full swarm.
      if ((u.id + this.state.tick) % 5 === 0) {
        this.trailEmitter.emitParticle(1, x, y + 4);
      }
    }
    for (const [id, spr] of this.unitSprites) {
      if (!alive.has(id)) {
        // Unit death burst: small puff at last-known sprite position.
        this.spawnDebrisBurst(spr.x, spr.y, 6);
        spr.destroy();
        this.unitSprites.delete(id);
        this.unitLastHp.delete(id);
      }
    }
  }

  // Small debris / hit-burst emitter. Reuses the trail-dot texture so
  // we don't pay for a second atlas key. Called on kills (unit or
  // building) to give a satisfying pop at the kill site.
  private spawnDebrisBurst(x: number, y: number, quantity: number): void {
    this.trailEmitter.emitParticle(quantity, x, y);
  }

  // Floating "+N sugar / +M leaf" popup at a kill location. Rises,
  // fades, and auto-destroys so repeated kills don't leak DOM/objects.
  private spawnLootPopup(x: number, y: number, sugar: number, leaf: number): void {
    const parts: string[] = [];
    if (sugar > 0) parts.push(`+${sugar}🍬`);
    if (leaf > 0) parts.push(`+${leaf}🍃`);
    if (parts.length === 0) return;
    const text = this.add
      .text(x, y, parts.join(' '), {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#ffd98a',
        stroke: '#1a1208',
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(40);
    this.boardContainer.add(text);
    this.tweens.add({
      targets: text,
      y: y - 36,
      alpha: { from: 1, to: 0 },
      duration: 900,
      ease: 'Sine.easeOut',
      onComplete: () => text.destroy(),
    });
  }

  private spawnDeployPopup(x: number, y: number, label: string, count: number): void {
    const text = this.add
      .text(x, y, `+${count} ${label}`, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#c3e8b0',
        stroke: '#1a1208',
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(40);
    this.boardContainer.add(text);
    this.tweens.add({
      targets: text,
      y: y - 24,
      alpha: { from: 1, to: 0 },
      duration: 700,
      ease: 'Sine.easeOut',
      onComplete: () => text.destroy(),
    });
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
      // Juice-pass side maps share the same per-raid lifecycle.
      this.buildingLastHp.clear();
      this.buildingKillPlayed.clear();
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
    // Width clamps to the viewport (minus a 16 px margin each side) so
    // the card never bleeds off ultra-narrow phones. On normal widths
    // this is a no-op — min(400, viewport-32) is still 400.
    const isWin = this.state.outcome === 'attackerWin' && stars > 0;
    const cardW = Math.min(400, this.scale.width - 32);
    const cardH = isWin ? 290 : 240;
    const card = this.add.graphics().setDepth(101);
    const cx = (this.scale.width - cardW) / 2;
    const cy = (this.scale.height - cardH) / 2;
    // Dim backdrop behind the card so the outcome commands the eye.
    const backdrop = this.add.graphics().setDepth(100);
    backdrop.fillStyle(0x000000, 0.55);
    backdrop.fillRect(0, 0, this.scale.width, this.scale.height);
    // CoC-style card: gradient fill, thick brass stroke, drop shadow.
    card.fillStyle(0x000000, 0.5);
    card.fillRoundedRect(cx + 3, cy + 6, cardW, cardH, 18);
    card.fillGradientStyle(
      COLOR.bgPanelHi,
      COLOR.bgPanelHi,
      COLOR.bgPanelLo,
      COLOR.bgPanelLo,
      1,
    );
    card.fillRoundedRect(cx, cy, cardW, cardH, 18);
    card.lineStyle(5, COLOR.brassDeep, 1);
    card.strokeRoundedRect(cx, cy, cardW, cardH, 18);
    card.lineStyle(1.5, COLOR.brass, 0.85);
    card.strokeRoundedRect(cx + 4, cy + 4, cardW - 8, cardH - 8, 14);

    const heading = isWin ? 'Raid Successful!' : 'Raid Failed';
    this.add
      .text(
        this.scale.width / 2,
        cy + 38,
        heading,
        displayTextStyle(24, isWin ? COLOR.textGold : '#ffb0a0', 4),
      )
      .setOrigin(0.5)
      .setDepth(102);

    this.add
      .text(
        this.scale.width / 2,
        cy + 84,
        '★'.repeat(stars) + '☆'.repeat(3 - stars),
        displayTextStyle(36, COLOR.textGold, 4),
      )
      .setOrigin(0.5)
      .setDepth(102);

    this.add
      .text(
        this.scale.width / 2,
        cy + 130,
        `${this.state.attackerSugarLooted} sugar · ${this.state.attackerLeafBitsLooted} leaf`,
        displayTextStyle(15, COLOR.textDim, 3),
      )
      .setOrigin(0.5)
      .setDepth(102);

    void backdrop;

    const actionsY = isWin ? cy + 220 : cy + 170;

    // Replace the old Text-backed buttons with our shared beveled
    // buttons so the result modal matches the rest of the UI. On a
    // win we render two side-by-side; on a loss the single "back"
    // button centers. Widths scale with the card so the pair stays
    // inside the card rather than overflowing on narrow phones —
    // previously these were hard-wired to 180 px at ±100 from center,
    // which overlapped badly at ≤400 px viewports.
    const innerW = cardW - 32;
    const btnW = isWin ? Math.min(180, Math.floor((innerW - 12) / 2)) : Math.min(220, innerW);
    const split = isWin ? btnW / 2 + 6 : 0;
    makeHiveButton(this, {
      x: this.scale.width / 2 - split,
      y: actionsY,
      width: btnW,
      height: 46,
      label: 'Back to home',
      variant: 'secondary',
      fontSize: 15,
      onPress: () => fadeToScene(this, 'HomeScene'),
    }).container.setDepth(102);

    if (isWin) {
      makeHiveButton(this, {
        x: this.scale.width / 2 + split,
        y: actionsY,
        width: btnW,
        height: 46,
        label: '📣 Share',
        variant: 'primary',
        fontSize: 15,
        onPress: () => void this.shareOutcome(stars),
      }).container.setDepth(102);
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
    // Mobile-aware board sizing. Reserve HUD + deck, scale board to
    // fit the remaining rectangle, center with padding. Everything
    // else (units, buildings, trail graphics) lives inside the
    // container so they scale together; pointer math unscales.
    const deckLayout = this.deckLayoutMetrics();
    const availW = this.scale.width - 24;
    const availH = this.scale.height - HUD_H - deckLayout.trayHeight - 40;
    const scale = Math.min(availW / BOARD_W, availH / BOARD_H, 1);
    this.boardContainer.setScale(scale);
    const scaledW = BOARD_W * scale;
    const scaledH = BOARD_H * scale;
    const xOffset = Math.max(12, (this.scale.width - scaledW) / 2);
    const yOffset = HUD_H + Math.max(8, (availH - scaledH) / 2);
    this.boardContainer.setPosition(xOffset, yOffset);
    this.starsText.setX(this.scale.width - 16);
    this.lootText.setX(this.scale.width - 16);
    this.timerText.setX(this.scale.width / 2);

    const trayTop = this.scale.height - deckLayout.trayHeight - 12;
    this.deckTrayBg.clear();
    drawPanel(this.deckTrayBg, 12, trayTop, this.scale.width - 24, deckLayout.trayHeight, {
      topColor: 0x182319,
      botColor: 0x09120a,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.16,
      radius: 16,
      shadowOffset: 5,
      shadowAlpha: 0.42,
    });
    this.deckTrayBg.fillStyle(COLOR.brass, 0.18);
    this.deckTrayBg.fillRect(28, trayTop + 44, this.scale.width - 56, 2);
    drawPill(
      this.deckTrayBg,
      this.scale.width / 2 - 178,
      trayTop + 10,
      44,
      36,
      { brass: true },
    );

    this.deckSelectedIcon.setPosition(this.scale.width / 2 - 154, trayTop + 28);
    this.deckSelectedText.setPosition(this.scale.width / 2 + 12, trayTop + 10);
    this.deckHintText
      .setWordWrapWidth(this.scale.width - 56)
      .setPosition(this.scale.width / 2, trayTop + 28);
    this.deckUnlockText
      .setWordWrapWidth(this.scale.width - 56)
      .setPosition(this.scale.width / 2, trayTop + 44);

    const rowHeight = DECK_CARD_H * deckLayout.scale;
    this.deckCardScale = deckLayout.scale;
    const rowGap = DECK_GRID_GAP;
    const gridTop = trayTop + 72;
    for (let row = 0; row < deckLayout.rows; row++) {
      const rowStartIndex = row * deckLayout.cols;
      const rowCount = Math.min(
        deckLayout.cols,
        Math.max(0, this.deckEntries.length - rowStartIndex),
      );
      if (rowCount <= 0) continue;
      const rowWidth =
        rowCount * DECK_CARD_W * deckLayout.scale +
        Math.max(0, rowCount - 1) * DECK_GRID_GAP;
      const rowStartX = (this.scale.width - rowWidth) / 2 + (DECK_CARD_W * deckLayout.scale) / 2;
      for (let col = 0; col < rowCount; col++) {
        const index = rowStartIndex + col;
        const container = this.deckContainers[index];
        if (!container) continue;
        container.setScale(deckLayout.scale);
        container.setPosition(
          rowStartX + col * (DECK_CARD_W * deckLayout.scale + DECK_GRID_GAP),
          gridTop + row * (rowHeight + rowGap) + rowHeight / 2,
        );
      }
    }
  }
}
