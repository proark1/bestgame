import Phaser from 'phaser';
import { Sim, Types } from '@hive/shared';
import type { HiveRuntime } from '../main.js';
import { ArenaClient, type ArenaEvent } from '../net/ArenaClient.js';
import { ANIMATED_UNIT_KINDS } from '../assets/atlas.js';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import { makeHiveButton } from '../ui/button.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { showCoachmark, type CoachmarkHandle } from '../ui/coachmark.js';
import { attachAmbientMotes } from '../ui/ambientMotes.js';
import { setSceneTrack, resumeMusic } from '../ui/music.js';
import { crispText } from '../ui/text.js';
import { COLOR, DEPTHS, bodyTextStyle, displayTextStyle, labelTextStyle } from '../ui/theme.js';
import { BUILDING_CODEX } from '../codex/codexData.js';

// Live arena — 2-player Colyseus match on a neutral mirror base.
//
// The server (server/arena/src/rooms/PicnicRoom.ts) is the source of
// truth. This scene:
//   1. Joins the 'picnic' room and sends `ready`
//   2. Waits for tickConfirm events to arrive (server has started the
//      30 Hz loop once both players ready'd)
//   3. Runs a local @hive/shared sim against the same base + seed,
//      applying only the inputs the server confirmed. This keeps the
//      visual representation in lockstep with authoritative state.
//   4. On `drawPheromoneTrail`, sends drawPath with intendedTick =
//      serverTick + 3 so the opponent has time to render the input
//      before it resolves.
//
// This scene is network-gated. If the arena server is unreachable (no
// VITE_ARENA_URL, no same-host /arena proxy, or offline), we show a
// friendly message explaining the configuration and fall back to
// HomeScene navigation.

const TILE = 48;
const GRID_W = 16;
const GRID_H = 12;
const BOARD_W = TILE * GRID_W;
const BOARD_H = TILE * GRID_H;
const HUD_H = 56;
const TICK_HZ = 30;
const MATCH_SECONDS = 120;
const INPUT_DELAY_TICKS = 3;

// Neutral mirror base — both players play against the same layout.
// Kept in sync with server/arena/src/rooms/PicnicRoom.ts NEUTRAL_MAP.
// (If they drift, the client sim would hash-diff from the server sim
// and the arena would fall out of lockstep.)
const NEUTRAL_MAP: Types.Base = {
  baseId: 'picnic-neutral',
  ownerId: 'server',
  faction: 'Ants',
  gridSize: { w: GRID_W, h: GRID_H },
  resources: { sugar: 0, leafBits: 0, aphidMilk: 0 },
  trophies: 0,
  version: 1,
  tunnels: [],
  buildings: [
    {
      id: 'b-queen',
      kind: 'QueenChamber',
      anchor: { x: 7, y: 5, layer: 0 },
      footprint: { w: 2, h: 2 },
      spans: [0, 1],
      level: 1,
      hp: 800,
      hpMax: 800,
    },
  ],
};

export class ArenaScene extends Phaser.Scene {
  private arena: ArenaClient | null = null;
  private cfg!: Sim.SimConfig;
  private state!: Sim.SimState;
  private boardContainer!: Phaser.GameObjects.Container;
  private boardFrame!: Phaser.GameObjects.Graphics;
  private statusCard!: Phaser.GameObjects.Container;
  private statusText!: Phaser.GameObjects.Text;
  private statusHint!: Phaser.GameObjects.Text;
  private started = false;
  private hasError = false;

  // Visuals
  private buildingSprites = new Map<number, Phaser.GameObjects.Image>();
  private buildingRoleLabels = new Map<number, Phaser.GameObjects.Text>();
  private statusCardWidth = 560;
  private unitLastPos = new Map<number, { x: number; y: number }>();
  private unitSprites = new Map<
    number,
    Phaser.GameObjects.Image | Phaser.GameObjects.Sprite
  >();
  private animationEnabled: Record<string, boolean> = {};
  private trailGraphics!: Phaser.GameObjects.Graphics;

  // Server tick marker — used to compute intendedTick for draws.
  private latestServerTick = 0;

  // Pheromone trail drawing (same shape as RaidScene).
  private drawingPoints: Array<{ x: number; y: number }> = [];
  private isDrawing = false;
  // Scratch map reused on every applyConfirmedInputs call so the
  // tickConfirm hot path doesn't allocate a fresh Map per server
  // message (~once a tick at 30 Hz). cleared at the top of each call.
  private byTickScratch: Map<number, Types.SimInput[]> = new Map();
  // Deck rail (added in batch 3) — picker for which unit kind the next
  // drawn pheromone path will deploy. Defaults to SoldierAnt to
  // preserve the pre-rail behaviour. Each card is the kind icon at
  // the bottom of the screen, above the status card.
  private selectedUnitKind: Types.UnitKind = 'SoldierAnt';
  private deckRail!: Phaser.GameObjects.Container;
  private deckCards: Array<{
    kind: Types.UnitKind;
    container: Phaser.GameObjects.Container;
    bg: Phaser.GameObjects.Graphics;
  }> = [];
  // First-entry coachmark for the deck rail. Single-shot, persisted
  // in localStorage; bumping the key replays for everyone.
  // Bump the version suffix when the deck rail / coachmark copy
  // changes so returning players see the updated guidance instead of
  // their stale "already seen v1" flag suppressing it.
  private static readonly ARENA_COACHMARK_KEY = 'hive:coachmarks:arena:v2';
  private arenaCoach: CoachmarkHandle | null = null;

  constructor() {
    super('ArenaScene');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0f1b10');
    fadeInScene(this);
    installSceneClickDebug(this);
    this.started = false;
    this.hasError = false;
    this.buildingSprites.clear();
    this.buildingRoleLabels.clear();
    this.unitSprites.clear();
    this.unitLastPos.clear();
    this.animationEnabled = {};
    // Settings is a best-effort non-blocking fetch; we fall back to
    // static sprites if it hasn't resolved by the time units spawn.
    const rt = this.registry.get('runtime') as HiveRuntime | undefined;
    if (rt) {
      void rt.api.getAnimationSettings().then((s) => {
        this.animationEnabled = s;
      });
    }

    this.drawAmbient();
    attachAmbientMotes(this);
    setSceneTrack('arena');
    this.input.once('pointerdown', () => resumeMusic());
    // Full-screen layout (Clash-of-Clans style): boardContainer first
    // so HUD elements (added in drawHud) render above with explicit
    // DEPTHS.hud. Board fills the viewport; HUD chips overlay.
    this.boardContainer = this.add.container(0, 0).setDepth(DEPTHS.board);
    this.drawHud();
    this.drawBoardFrame();
    this.drawBoard();
    this.drawStatusCard();
    this.drawDeckRail();

    // Responsive scaling — same pattern as RaidScene. Board container
    // shrinks on narrow viewports, pointer math below unscales. The
    // 80 px bottom reserve is for the status card; no top reserve
    // because the HUD floats overlaid.
    const applyLayout = (): void => {
      const availW = this.scale.width - 24;
      const availH = this.scale.height - 80;
      // Fit-to-viewport zoom (capped at 2.4x); mirrors HomeScene +
      // RaidScene so the board feels equally fullscreen on each.
      const fit = Math.min(availW / BOARD_W, availH / BOARD_H);
      const scale = Math.min(2.4, fit);
      this.boardContainer.setScale(scale);
      const scaledW = BOARD_W * scale;
      const scaledH = BOARD_H * scale;
      const xOffset = Math.max(12, (this.scale.width - scaledW) / 2);
      const yOffset = Math.max(8, (availH - scaledH) / 2);
      this.boardContainer.setPosition(xOffset, yOffset);
      this.layoutBoardFrame(xOffset, yOffset, scaledW, scaledH);
      this.layoutStatusCard(yOffset + scaledH);
      this.layoutDeckRail(yOffset + scaledH);
    };
    applyLayout();
    this.scale.on('resize', applyLayout);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off('resize', applyLayout);
    });
    // Slight delay so the deck rail's getBounds() returns the
    // post-layout values, not the (0, 0, 0, 0) zone the rail
    // starts in. 120 ms is enough for one resize tick.
    this.time.delayedCall(120, () => this.maybeShowFirstRunCoachmark());
    // Initial sim state must be constructed BEFORE drawStartingBuildings
    // tries to iterate this.state.buildings. The reserve flow in
    // connect() may later replace this.state with the host-snapshot
    // version; renderInitialBoard() will redraw then. For now this
    // gives us valid state for the very first frame.
    this.cfg = {
      tickRate: TICK_HZ,
      maxTicks: TICK_HZ * MATCH_SECONDS,
      initialSnapshot: NEUTRAL_MAP,
      seed: 0x7770,
    };
    this.state = Sim.createInitialState(this.cfg);

    this.drawStartingBuildings();
    this.trailGraphics = this.add.graphics().setDepth(DEPTHS.trail);
    this.boardContainer.add(this.trailGraphics);

    this.setStatus('Connecting to arena...', 'Matchmaking and sync checks are in progress.');

    this.wirePointerInput();
    void this.connect();

    this.events.once('shutdown', () => void this.arena?.leave());
  }

  private drawAmbient(): void {
    const bg = this.add.graphics().setDepth(-120);
    // Grass-green gradient using shared theme tokens so HomeScene,
    // RaidScene and ArenaScene render an identical field tone — the
    // arena sits in a larger green field, not a separately-tinted
    // backdrop. Two bands (top → bot) match HomeScene's drawAmbient.
    const top = COLOR.grassTop;
    const bot = COLOR.grassBot;
    const bands = 20;
    for (let i = 0; i < bands; i++) {
      const t = i / Math.max(1, bands - 1);
      const r = Math.round(((top >> 16) & 0xff) + (((bot >> 16) & 0xff) - ((top >> 16) & 0xff)) * t);
      const g = Math.round(((top >> 8) & 0xff) + (((bot >> 8) & 0xff) - ((top >> 8) & 0xff)) * t);
      const b = Math.round((top & 0xff) + ((bot & 0xff) - (top & 0xff)) * t);
      bg.fillStyle((r << 16) | (g << 8) | b, 1);
      bg.fillRect(
        0,
        Math.floor((i * this.scale.height) / bands),
        this.scale.width,
        Math.ceil(this.scale.height / bands) + 1,
      );
    }
  }

  private drawHud(): void {
    // Clash-of-Clans-style overlay HUD: the chrome panel/shadow strip
    // is gone; only the floating chips (PvP pill, Home button, Live
    // Arena title) remain, each pinned at DEPTHS.hud so they render
    // above the board.
    const w = this.scale.width;

    const pill = this.add.graphics().setDepth(DEPTHS.hud);
    drawPill(pill, w / 2 - 184, 18, 74, 20, { brass: true });
    crispText(this, w / 2 - 147, 28, 'PvP', labelTextStyle(10, COLOR.textGold))
      .setOrigin(0.5, 0.5)
      .setDepth(DEPTHS.hud);

    makeHiveButton(this, {
      x: 72,
      y: HUD_H / 2,
      width: 120,
      height: 36,
      label: 'Home',
      variant: 'ghost',
      fontSize: 13,
      onPress: () => {
        void this.arena?.leave();
        fadeToScene(this, 'HomeScene');
      },
    }).container.setDepth(DEPTHS.hud);
    crispText(this, w / 2, HUD_H / 2, 'Live Arena', displayTextStyle(20, COLOR.textGold, 4))
      .setOrigin(0.5)
      .setDepth(DEPTHS.hud);
  }

  private drawBoardFrame(): void {
    this.boardFrame = this.add.graphics().setDepth(-5);
  }

  private layoutBoardFrame(x: number, y: number, w: number, h: number): void {
    this.boardFrame.clear();
    drawPanel(this.boardFrame, x - 12, y - 12, w + 24, h + 24, {
      topColor: COLOR.boardUnder,
      botColor: COLOR.boardUnderLo,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.18,
      radius: 18,
      shadowOffset: 6,
      shadowAlpha: 0.34,
    });
    this.boardFrame.fillStyle(0xffffff, 0.05);
    this.boardFrame.fillRoundedRect(x - 4, y - 4, w + 8, 16, 12);
  }

  private drawStatusCard(): void {
    const width = Math.min(560, this.scale.width - 28);
    this.statusCardWidth = width;
    const g = this.add.graphics();
    drawPanel(g, 0, 0, width, 74, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.14,
      radius: 16,
      shadowOffset: 5,
      shadowAlpha: 0.3,
    });

    const pill = this.add.graphics();
    drawPill(pill, 14, 14, 112, 20, { brass: true });
    const label = crispText(this, 70, 24, 'Arena flow', labelTextStyle(10, COLOR.textGold)).setOrigin(0.5, 0.5);
    this.statusText = crispText(this, width / 2, 40, '', displayTextStyle(15, COLOR.textPrimary, 3)).setOrigin(
      0.5,
      0.5,
    );
    this.statusHint = crispText(this, width / 2, 59, '', bodyTextStyle(11, COLOR.textDim)).setOrigin(0.5, 0.5);

    this.statusCard = this.add.container(0, 0, [g, pill, label, this.statusText, this.statusHint]);
  }

  private layoutStatusCard(boardBottom: number): void {
    if (!this.statusCard) return;
    const targetY = Math.min(this.scale.height - 86, boardBottom + 18);
    const targetX = Math.round((this.scale.width - this.statusCardWidth) / 2);
    this.statusCard.setPosition(targetX, targetY);
    this.statusHint.setWordWrapWidth(this.statusCardWidth - 40);
  }

  // Mini unit-picker rail. Lives above the status card; each card is
  // a 56×56 sprite tile that switches `selectedUnitKind`. Pre-rail,
  // ArenaScene was hardcoded to SoldierAnt — see sendDrawPath. The
  // roster is intentionally small (5 kinds covering the major roles)
  // so the rail fits comfortably even on a phone-narrow viewport.
  // RaidScene's full deck has count limits, role text, and modifier
  // marker logic; ArenaScene doesn't need any of that — both arena
  // players can deploy any roster unit any number of times.
  private static readonly DECK_KINDS: ReadonlyArray<Types.UnitKind> = [
    'SoldierAnt',
    'WorkerAnt',
    'FireAnt',
    'Wasp',
    'Termite',
  ];
  // Short label under each deck icon so the player sees the unit
  // name without having to memorise the silhouette. Kept terse so a
  // 56-px-wide card doesn't truncate.
  private static readonly DECK_LABELS: Partial<Record<Types.UnitKind, string>> = {
    SoldierAnt: 'Soldier',
    WorkerAnt: 'Worker',
    FireAnt: 'Fire',
    Wasp: 'Wasp',
    Termite: 'Termite',
  };

  private drawDeckRail(): void {
    // Card height grew from 56 to 70 to fit a label band under the
    // icon — matches RaidScene's deck card information density so
    // the multiplayer rail doesn't read as half-finished.
    const CARD_W = 60;
    const CARD_H = 70;
    const GAP = 8;
    this.deckRail = this.add.container(0, 0).setDepth(DEPTHS.hud);
    this.deckCards = [];
    const kinds = ArenaScene.DECK_KINDS;
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i]!;
      const card = this.add.container(i * (CARD_W + GAP), 0);
      const bg = this.add.graphics();
      const icon = this.add
        .image(CARD_W / 2, (CARD_H - 14) / 2, `unit-${kind}`)
        .setDisplaySize(CARD_W - 14, CARD_H - 28);
      const label = this.add
        .text(
          CARD_W / 2,
          CARD_H - 12,
          ArenaScene.DECK_LABELS[kind] ?? kind,
          labelTextStyle(9, '#fff8ec'),
        )
        .setOrigin(0.5, 0.5);
      card.add([bg, icon, label]);
      card.setSize(CARD_W, CARD_H);
      card.setInteractive(
        new Phaser.Geom.Rectangle(0, 0, CARD_W, CARD_H),
        Phaser.Geom.Rectangle.Contains,
      );
      card.on('pointerdown', () => this.selectUnitKind(kind));
      this.deckRail.add(card);
      this.deckCards.push({ kind, container: card, bg });
    }
    this.refreshDeckSelection();
  }

  private selectUnitKind(kind: Types.UnitKind): void {
    this.selectedUnitKind = kind;
    this.refreshDeckSelection();
    // Acknowledge the first-run coachmark on the player's first
    // explicit pick — they've now demonstrated they understand the
    // rail.
    if (this.arenaCoach) {
      this.arenaCoach.acknowledge();
      this.arenaCoach = null;
      try {
        localStorage.setItem(ArenaScene.ARENA_COACHMARK_KEY, '1');
      } catch {
        /* private mode: skip persistence */
      }
    }
  }

  private maybeShowFirstRunCoachmark(): void {
    let seen = false;
    try {
      seen = localStorage.getItem(ArenaScene.ARENA_COACHMARK_KEY) === '1';
    } catch {
      seen = true; // private mode: don't nag
    }
    if (seen) return;
    if (this.deckCards.length === 0) return;
    const firstCard = this.deckCards[0]!.container;
    const r = firstCard.getBounds();
    this.arenaCoach = showCoachmark({
      scene: this,
      target: { x: r.x, y: r.y, w: r.width, h: r.height },
      prefer: 'above',
      title: 'Pick what to deploy',
      body:
        'Tap a unit on this rail, then drag a path on the board. Both arena players share the same neutral base.',
    });
  }

  private refreshDeckSelection(): void {
    const CARD_W = 60;
    const CARD_H = 70;
    for (const card of this.deckCards) {
      card.bg.clear();
      const selected = card.kind === this.selectedUnitKind;
      // Selected card pops with a brassy gold tint + glow band; idle
      // cards stay green-on-green so the picked unit reads instantly
      // even when the player's eyes are on the board.
      card.bg.fillStyle(selected ? 0x4d8a3f : 0x1f3320, 1);
      card.bg.fillRoundedRect(0, 0, CARD_W, CARD_H, 10);
      // Label band along the bottom edge so the kind name has a
      // legible plate behind it.
      card.bg.fillStyle(selected ? 0x2d5a2a : 0x122014, 1);
      card.bg.fillRoundedRect(2, CARD_H - 22, CARD_W - 4, 20, 6);
      card.bg.lineStyle(selected ? 3 : 2, selected ? 0xffd98a : 0x2c5a23, 1);
      card.bg.strokeRoundedRect(0, 0, CARD_W, CARD_H, 10);
      // Subtle scale up on selection so the picked card "lifts".
      card.container.setScale(selected ? 1.06 : 1);
    }
  }

  private layoutDeckRail(boardBottom: number): void {
    if (!this.deckRail) return;
    const CARD_W = 60;
    const GAP = 8;
    const railW =
      ArenaScene.DECK_KINDS.length * CARD_W +
      (ArenaScene.DECK_KINDS.length - 1) * GAP;
    const x = Math.round((this.scale.width - railW) / 2);
    // Sits 8 px above the status card. If the viewport is too short
    // we tuck the rail right under the board edge.
    const y = Math.min(this.scale.height - 168, boardBottom - 80);
    this.deckRail.setPosition(x, y);
  }

  private setStatus(message: string, hint: string, tone: 'normal' | 'warn' | 'error' = 'normal'): void {
    const color =
      tone === 'error' ? COLOR.textError : tone === 'warn' ? COLOR.textGold : COLOR.textPrimary;
    this.statusText.setStyle(displayTextStyle(15, color, 3));
    this.statusText.setText(message);
    this.statusHint.setText(hint);
  }

  private drawBoard(): void {
    // Solid grass underlay — same clean treatment HomeScene/RaidScene
    // use. No board-background sprite so the painterly brown patches
    // can't bleed through behind the grid.
    const grass = this.add.graphics();
    grass.setDepth(DEPTHS.boardUnder);
    grass.fillStyle(0x6cbf6a, 1);
    grass.fillRect(0, 0, BOARD_W, BOARD_H);

    // Per-tile grid box outlines. Mirrors RaidScene/HomeScene so the
    // grid reads as the same structural element across all three play
    // surfaces.
    const grid = this.add.graphics();
    grid.lineStyle(1, 0x2d5e2a, 0.45);
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        grid.strokeRect(x * TILE + 0.5, y * TILE + 0.5, TILE - 1, TILE - 1);
      }
    }

    const edge = this.add.graphics();
    edge.fillStyle(COLOR.brass, 0.18);
    edge.fillRect(0, 0, 8, BOARD_H);
    edge.fillStyle(COLOR.brass, 0.34);
    edge.fillRect(8, 0, 3, BOARD_H);

    this.boardContainer.add([grass, grid, edge]);
  }

  private drawStartingBuildings(): void {
    // Defensive: connect() might re-enter after a fast scene reload
    // and call this before state hydration. Returning silently is
    // safer than crashing — renderInitialBoard() will retry once the
    // reserved snapshot arrives.
    if (!this.state || !this.state.buildings) return;
    for (const b of this.state.buildings) {
      if (this.buildingSprites.has(b.id)) continue;
      const x = b.anchorX * TILE + (b.w * TILE) / 2;
      const y = b.anchorY * TILE + (b.h * TILE) / 2;
      const spr = this.add.image(x, y, `building-${b.kind}`);
      spr.setOrigin(0.5, 0.5) /* center sprite within footprint cell so it never bleeds above the grid */;
      // Render at exact grid footprint, matching RaidScene/HomeScene.
      spr.setDisplaySize(b.w * TILE, b.h * TILE);
      this.boardContainer.add(spr);
      this.buildingSprites.set(b.id, spr);

      const codex = BUILDING_CODEX[b.kind];
      if (codex) {
        const labelY = b.anchorY * TILE - 6;
        const roleLabel = this.add
          .text(x, labelY, codex.role, {
            fontSize: '10px',
            fontFamily: 'ui-monospace, monospace',
            color: COLOR.textGold,
            backgroundColor: '#09100acc',
            padding: { x: 4, y: 2 },
          })
          .setOrigin(0.5, 1)
          .setDepth(6);
        this.boardContainer.add(roleLabel);
        this.buildingRoleLabels.set(b.id, roleLabel);
      }
    }
  }

  // Called after reserveArena() swaps the sim config to the reserved
  // snapshot + seed. Wipes the placeholder building sprites that were
  // Mirror of RaidScene.makeUnitSprite — the three conditions to get
  // the walk-cycle animation are identical (kind is animated + admin
  // toggle on + spritesheet actually loaded), and the fallback is the
  // same static Image as before.
  private makeUnitSprite(
    kind: Types.UnitKind,
    x: number,
    y: number,
  ): Phaser.GameObjects.Image | Phaser.GameObjects.Sprite {
    const isAnimatedKind = (ANIMATED_UNIT_KINDS as readonly string[]).includes(kind);
    const enabled = this.animationEnabled[kind] !== false;
    const sheetKey = `unit-${kind}-walk`;
    const animKey = `walk-${kind}`;
    // 32×32 to match RaidScene — keeps unit visual scale consistent.
    const UNIT_SIZE = 32;
    if (
      isAnimatedKind &&
      enabled &&
      this.textures.exists(sheetKey) &&
      this.anims.exists(animKey)
    ) {
      const spr = this.add
        .sprite(x, y, sheetKey)
        .setDisplaySize(UNIT_SIZE, UNIT_SIZE)
        .setOrigin(0.5, 0.7);
      spr.play(animKey);
      return spr;
    }
    return this.add
      .image(x, y, `unit-${kind}`)
      .setDisplaySize(UNIT_SIZE, UNIT_SIZE)
      .setOrigin(0.5, 0.7);
  }

  // spawned from NEUTRAL_MAP so the next drawStartingBuildings pass
  // reflects the real host base the server is using.
  private renderInitialBoard(): void {
    for (const spr of this.buildingSprites.values()) spr.destroy();
    this.buildingSprites.clear();
    for (const lbl of this.buildingRoleLabels.values()) lbl.destroy();
    this.buildingRoleLabels.clear();
    this.drawStartingBuildings();
  }

  private wirePointerInput(): void {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (!this.started || this.hasError) return;
      // Reject pointerdowns outside the actual board rectangle. The
      // board is now centered (and may be scaled) inside a full-screen
      // viewport, so we read its live bounds rather than assuming the
      // old fixed (HUD_H..HUD_H+BOARD_H) y range.
      const bounds = this.boardContainer.getBounds();
      if (
        p.x < bounds.x ||
        p.x > bounds.x + bounds.width ||
        p.y < bounds.y ||
        p.y > bounds.y + bounds.height
      ) {
        return;
      }
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
      const origin = this.boardContainer.getBounds();
      const scale = this.boardContainer.scaleX || 1;
      const tilePoints: Types.PheromonePoint[] = this.drawingPoints.map((p) => {
        const tx = (p.x - origin.x) / scale / TILE;
        const ty = (p.y - origin.y) / scale / TILE;
        return { x: Sim.fromFloat(tx), y: Sim.fromFloat(ty) };
      });
      this.arena?.sendDrawPath({
        polyline: tilePoints,
        unitKind: this.selectedUnitKind,
        count: 5,
        spawnLayer: 0,
        intendedTick: this.latestServerTick + INPUT_DELAY_TICKS,
      });
      this.tweens.add({
        targets: this.trailGraphics,
        alpha: { from: 1, to: 0 },
        duration: 500,
        onComplete: () => {
          this.trailGraphics.clear();
          this.trailGraphics.setAlpha(1);
        },
      });
    });
    void runtime;
  }

  private renderTrailPreview(): void {
    // Container-local coords: subtract world origin, divide by
    // scale. Matches the board's own scaled transform so the drawn
    // trail tracks the cursor at any viewport size.
    const origin = this.boardContainer.getBounds();
    const scale = this.boardContainer.scaleX || 1;
    this.trailGraphics.clear();
    this.trailGraphics.lineStyle(6, 0xffd98a, 0.85);
    this.trailGraphics.beginPath();
    for (let i = 0; i < this.drawingPoints.length; i++) {
      const p = this.drawingPoints[i]!;
      const x = (p.x - origin.x) / scale;
      const y = (p.y - origin.y) / scale;
      if (i === 0) this.trailGraphics.moveTo(x, y);
      else this.trailGraphics.lineTo(x, y);
    }
    this.trailGraphics.strokePath();
  }

  private async connect(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) {
      this.reportOffline('Runtime not ready');
      return;
    }
    const playerId = runtime.auth.playerId ?? 'guest';

    // Ask the API to pair us with an opponent first. The reserve call
    // is idempotent, so both clients independently arrive at the same
    // arenaToken and end up in the same Colyseus room. A null result
    // means no opponent online — fall back to the neutral-map flow so
    // the scene is still reachable for solo testing.
    let arenaToken: string | undefined;
    try {
      const reservation = await runtime.api.reserveArena();
      if (reservation) {
        arenaToken = reservation.arenaToken;
        this.setStatus(
          `Matched vs ${reservation.opponent.displayName} (${reservation.opponent.trophies} trophies)`,
          'Syncing the shared base snapshot before the first draw command lands.',
        );
        // Replace the placeholder sim with the same snapshot+seed the
        // server seeds PicnicRoom with. Without this the client hashes
        // drift immediately on the first tick: server runs authoritative
        // ticks on the host's real base while the local sim still
        // chugs along on NEUTRAL_MAP at seed 0x7770, producing wrong
        // buildings and wrong outcomes. The reservation carries both
        // fields precisely so both sides can agree on init state
        // without a second handshake.
        this.cfg = {
          tickRate: TICK_HZ,
          maxTicks: TICK_HZ * MATCH_SECONDS,
          initialSnapshot: reservation.hostSnapshot,
          seed: reservation.seed,
        };
        this.state = Sim.createInitialState(this.cfg);
        // Re-render the board with the new building set so the player
        // doesn't see a flash of the wrong map before the first
        // tickConfirm arrives.
        this.renderInitialBoard();
      } else {
        this.setStatus('No opponent online', 'Solo arena mode is active so you can still test the flow.', 'warn');
      }
    } catch (err) {
      // Don't block arena entry on reserve failure — dev paths without
      // a DB connection still want to exercise the Colyseus netcode.
      this.setStatus(
        'Reserve failed - solo arena test',
        (err as Error).message,
        'warn',
      );
    }

    this.arena = new ArenaClient();
    this.arena.on((ev) => this.handleArenaEvent(ev));
    await this.arena.joinOrCreate(playerId, arenaToken);
  }

  private handleArenaEvent(ev: ArenaEvent): void {
    if (!this.scene.isActive()) return;
    switch (ev.kind) {
      case 'connecting':
        this.setStatus('Connecting to arena...', 'Opening the realtime room and waiting for handshake.');
        break;
      case 'joined':
        this.setStatus('Waiting for opponent...', 'The match starts automatically once both players are ready.');
        break;
      case 'both-ready':
        this.setStatus('Fight!', 'Drag from the left edge across the board to send soldiers along a pheromone trail. Destroy the Queen Chamber to win.');
        this.started = true;
        break;
      case 'tick':
        this.latestServerTick = ev.data.tick;
        this.applyConfirmedInputs(ev.data);
        if (!this.started) {
          this.started = true;
          this.setStatus('Fight!', 'Drag from the left edge across the board to send soldiers along a pheromone trail. Destroy the Queen Chamber to win.');
        }
        break;
      case 'opponent-left':
        this.setStatus('Opponent left', 'The arena awarded you the win by default.', 'warn');
        break;
      case 'error':
        this.reportOffline(ev.error.message);
        break;
      case 'closed':
        if (!this.hasError) this.setStatus('Arena closed', 'Return home to queue another live match.', 'warn');
        break;
    }
  }

  // Apply the server's confirmed-input batch for a tick and advance
  // our local sim to match. Hash check catches any client-side drift.
  // Sanity threshold on the per-message confirmed-input batch. Arena
  // lockstep expects ~one input per tick; a server message carrying
  // thousands would be either a long catch-up after a network hiccup
  // or a buggy server. We log it (so production telemetry surfaces
  // the anomaly) but still apply — the server is authoritative in
  // this architecture, and dropping the batch would leave the client
  // permanently behind the server's tick counter and break the rest
  // of the match.
  private static readonly OVERSIZE_BATCH_WARN = 512;

  private applyConfirmedInputs(e: { tick: number; confirmedInputs: Types.SimInput[]; stateHash: string }): void {
    if (e.confirmedInputs.length > ArenaScene.OVERSIZE_BATCH_WARN) {
      console.warn(
        `[arena] oversized tickConfirm batch (${e.confirmedInputs.length} inputs); applying anyway to avoid desync`,
      );
    }
    // Run each local tick up to the server's tick, applying confirmed
    // inputs at the exact tick the server applied them.
    const byTick = this.byTickScratch;
    byTick.clear();
    for (const inp of e.confirmedInputs) {
      const list = byTick.get(inp.tick) ?? [];
      list.push(inp);
      byTick.set(inp.tick, list);
    }
    while (this.state.tick < e.tick && this.state.outcome === 'ongoing') {
      const next = this.state.tick + 1;
      const batch = byTick.get(next) ?? [];
      Sim.step(this.state, this.cfg, batch);
    }
    this.renderFrame();
    // Hash reconciliation — if we drift, log and re-trust the server
    // on the next tickConfirm (a full-state resync would be nicer but
    // is out of scope here).
    const ours = Sim.hashToHex(Sim.hashSimState(this.state));
    if (ours !== e.stateHash) {
      console.warn(`[arena] state hash drift tick=${e.tick} ours=${ours} theirs=${e.stateHash}`);
    }
  }

  private renderFrame(): void {
    const alive = new Set<number>();
    for (const u of this.state.units) {
      alive.add(u.id);
      let spr = this.unitSprites.get(u.id);
      const x = Sim.toFloat(u.x) * TILE;
      const y = Sim.toFloat(u.y) * TILE;
      if (!spr) {
        spr = this.makeUnitSprite(u.kind, x, y);
        spr.setTint(u.owner === 0 ? 0xffffff : 0xffc0c0);
        this.boardContainer.add(spr);
        this.unitSprites.set(u.id, spr);
      } else {
        spr.setPosition(x, y);
      }
      // Same movement-gated anim as RaidScene — pause the walk cycle
      // while the unit is stationary so idles don't jog in place.
      // Only Sprite-backed units are tracked, and the per-unit
      // position record is mutated in place instead of re-allocated
      // each frame to keep per-frame GC pressure at zero.
      if (spr instanceof Phaser.GameObjects.Sprite) {
        const prev = this.unitLastPos.get(u.id);
        const MOVE_EPSILON = 0.15;
        const moving =
          !prev ||
          Math.abs(x - prev.x) > MOVE_EPSILON ||
          Math.abs(y - prev.y) > MOVE_EPSILON;
        if (moving) {
          if (!spr.anims.isPlaying) {
            const animKey = `walk-${u.kind}`;
            if (this.anims.exists(animKey)) spr.play(animKey);
          }
        } else if (spr.anims.isPlaying) {
          spr.anims.pause();
          spr.setFrame(0);
        }
        if (prev) {
          prev.x = x;
          prev.y = y;
        } else {
          this.unitLastPos.set(u.id, { x, y });
        }
      }
    }
    for (const [id, spr] of this.unitSprites) {
      if (!alive.has(id)) {
        spr.destroy();
        this.unitSprites.delete(id);
        this.unitLastPos.delete(id);
      }
    }
    for (const b of this.state.buildings) {
      const spr = this.buildingSprites.get(b.id);
      if (!spr) continue;
      if (b.hp <= 0 && spr.alpha > 0.2) {
        const label = this.buildingRoleLabels.get(b.id);
        const tweenTargets = label ? [spr, label] : [spr];
        this.tweens.add({ targets: tweenTargets, alpha: 0.18, duration: 200 });
      }
    }
  }

  private reportOffline(message: string): void {
    this.hasError = true;
    this.setStatus(
      'Live arena unavailable',
      `${message}  Deploy @hive/arena separately (Colyseus on port 2567) and set VITE_ARENA_URL to its wss URL at build time.`,
      'error',
    );
  }
}
