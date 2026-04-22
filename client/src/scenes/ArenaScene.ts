import Phaser from 'phaser';
import { Sim, Types } from '@hive/shared';
import type { HiveRuntime } from '../main.js';
import { ArenaClient, type ArenaEvent } from '../net/ArenaClient.js';
import { ANIMATED_UNIT_KINDS } from '../assets/atlas.js';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { makeHiveButton } from '../ui/button.js';
import { COLOR, displayTextStyle } from '../ui/theme.js';

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
  private statusText!: Phaser.GameObjects.Text;
  private started = false;
  private hasError = false;

  // Visuals
  private buildingSprites = new Map<number, Phaser.GameObjects.Image>();
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

  constructor() {
    super('ArenaScene');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0f1b10');
    fadeInScene(this);
    this.started = false;
    this.hasError = false;
    this.buildingSprites.clear();
    this.unitSprites.clear();
    this.animationEnabled = {};
    // Settings is a best-effort non-blocking fetch; we fall back to
    // static sprites if it hasn't resolved by the time units spawn.
    const rt = this.registry.get('runtime') as HiveRuntime | undefined;
    if (rt) {
      void rt.api.getAnimationSettings().then((s) => {
        this.animationEnabled = s;
      });
    }

    this.drawHud();
    this.boardContainer = this.add.container(0, HUD_H);
    this.drawBoard();

    // Responsive scaling — same pattern as RaidScene. Board container
    // shrinks on narrow viewports, pointer math below unscales.
    const applyLayout = (): void => {
      const availW = this.scale.width - 24;
      const availH = this.scale.height - HUD_H - 80;
      const scale = Math.min(availW / BOARD_W, availH / BOARD_H, 1);
      this.boardContainer.setScale(scale);
      const scaledW = BOARD_W * scale;
      const scaledH = BOARD_H * scale;
      const xOffset = Math.max(12, (this.scale.width - scaledW) / 2);
      const yOffset = HUD_H + Math.max(8, (availH - scaledH) / 2);
      this.boardContainer.setPosition(xOffset, yOffset);
    };
    applyLayout();
    this.scale.on('resize', applyLayout);
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
    this.trailGraphics = this.add.graphics().setDepth(10);
    this.boardContainer.add(this.trailGraphics);

    this.statusText = this.add
      .text(this.scale.width / 2, HUD_H + BOARD_H + 36, 'Connecting to arena…', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#c3e8b0',
      })
      .setOrigin(0.5);

    this.wirePointerInput();
    void this.connect();

    this.events.once('shutdown', () => void this.arena?.leave());
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
      onPress: () => {
        void this.arena?.leave();
        fadeToScene(this, 'HomeScene');
      },
    });
    this.add
      .text(this.scale.width / 2, HUD_H / 2, '⚔ Live Arena', displayTextStyle(20, COLOR.textGold, 4))
      .setOrigin(0.5);
  }

  private drawBoard(): void {
    const bg = this.add.graphics();
    bg.fillStyle(0x1d3a1a, 1);
    bg.fillRect(0, 0, BOARD_W, BOARD_H);
    bg.fillStyle(0x244a21, 1);
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        if ((x + y) % 2 === 0) bg.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    }
    const grid = this.add.graphics({
      lineStyle: { width: 1, color: 0x2c5a23, alpha: 0.5 },
    });
    for (let x = 0; x <= GRID_W; x++) grid.lineBetween(x * TILE, 0, x * TILE, BOARD_H);
    for (let y = 0; y <= GRID_H; y++) grid.lineBetween(0, y * TILE, BOARD_W, y * TILE);
    this.boardContainer.add([bg, grid]);
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
      spr.setOrigin(0.5, 0.75);
      spr.setDisplaySize(TILE * Math.max(b.w, 1.85), TILE * Math.max(b.h, 1.85));
      this.boardContainer.add(spr);
      this.buildingSprites.set(b.id, spr);
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

  // spawned from NEUTRAL_MAP so the next drawStartingBuildings pass
  // reflects the real host base the server is using.
  private renderInitialBoard(): void {
    for (const spr of this.buildingSprites.values()) spr.destroy();
    this.buildingSprites.clear();
    this.drawStartingBuildings();
  }

  private wirePointerInput(): void {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (!this.started || this.hasError) return;
      if (p.y < HUD_H || p.y > HUD_H + BOARD_H) return;
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
        unitKind: 'SoldierAnt',
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
        this.statusText.setText(
          `Matched vs ${reservation.opponent.displayName} (${reservation.opponent.trophies}🏆) — connecting…`,
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
        this.statusText.setText('No opponent online — solo arena test');
      }
    } catch (err) {
      // Don't block arena entry on reserve failure — dev paths without
      // a DB connection still want to exercise the Colyseus netcode.
      this.statusText.setText(`Reserve failed (${(err as Error).message}); solo test`);
    }

    this.arena = new ArenaClient();
    this.arena.on((ev) => this.handleArenaEvent(ev));
    await this.arena.joinOrCreate(playerId, arenaToken);
  }

  private handleArenaEvent(ev: ArenaEvent): void {
    if (!this.scene.isActive()) return;
    switch (ev.kind) {
      case 'connecting':
        this.statusText.setText('Connecting to arena…');
        break;
      case 'joined':
        this.statusText.setText('Waiting for opponent…');
        break;
      case 'both-ready':
        this.statusText.setText('Fight!');
        this.started = true;
        break;
      case 'tick':
        this.latestServerTick = ev.data.tick;
        this.applyConfirmedInputs(ev.data);
        if (!this.started) {
          this.started = true;
          this.statusText.setText('Fight!');
        }
        break;
      case 'opponent-left':
        this.statusText.setText('Opponent left — you win by default');
        break;
      case 'error':
        this.reportOffline(ev.error.message);
        break;
      case 'closed':
        if (!this.hasError) this.statusText.setText('Arena closed');
        break;
    }
  }

  // Apply the server's confirmed-input batch for a tick and advance
  // our local sim to match. Hash check catches any client-side drift.
  private applyConfirmedInputs(e: { tick: number; confirmedInputs: Types.SimInput[]; stateHash: string }): void {
    // Run each local tick up to the server's tick, applying confirmed
    // inputs at the exact tick the server applied them.
    const byTick = new Map<number, Types.SimInput[]>();
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
    }
    for (const [id, spr] of this.unitSprites) {
      if (!alive.has(id)) {
        spr.destroy();
        this.unitSprites.delete(id);
      }
    }
    for (const b of this.state.buildings) {
      const spr = this.buildingSprites.get(b.id);
      if (!spr) continue;
      if (b.hp <= 0 && spr.alpha > 0.2) {
        this.tweens.add({ targets: spr, alpha: 0.18, duration: 200 });
      }
    }
  }

  private reportOffline(message: string): void {
    this.hasError = true;
    this.statusText.setText(
      [
        'Live arena unavailable.',
        '',
        message,
        '',
        "Deploy @hive/arena separately (Colyseus on port 2567) and set",
        "VITE_ARENA_URL to its wss:// URL at build time.",
      ].join('\n'),
    );
  }
}
