import Phaser from 'phaser';
import { Types } from '@hive/shared';
import type { HiveRuntime } from '../main.js';

// HomeScene — the player's own colony. Shows a dual-layer backyard
// with the Queen Chamber plus a scatter of starter buildings. Player
// taps through to the raid. Place/upgrade flow lands next iteration;
// the week-2 delivery is visual polish + wiring to a playable raid.
//
// When runtime.player is present (auth + persistence succeeded at
// boot), HomeScene renders from the server's base snapshot and the
// server's resource numbers. Otherwise it falls back to the hardcoded
// starter base so the game is still playable guest-local.

const TILE = 48;
const GRID_W = 16;
const GRID_H = 12;
const BOARD_W = TILE * GRID_W;
const BOARD_H = TILE * GRID_H;
const HUD_H = 56;

// A fixed starter base. Each building is a tuple: [kind, x, y, layer].
const STARTER_BUILDINGS: Array<{
  kind: Types.BuildingKind;
  x: number;
  y: number;
  layer: Types.Layer;
}> = [
  { kind: 'QueenChamber', x: 7, y: 5, layer: 0 }, // spans both layers
  { kind: 'MushroomTurret', x: 3, y: 3, layer: 0 },
  { kind: 'MushroomTurret', x: 11, y: 3, layer: 0 },
  { kind: 'DewCollector', x: 2, y: 8, layer: 0 },
  { kind: 'LeafWall', x: 5, y: 4, layer: 0 },
  { kind: 'LeafWall', x: 10, y: 4, layer: 0 },
  { kind: 'PebbleBunker', x: 13, y: 8, layer: 0 },
  { kind: 'LarvaNursery', x: 4, y: 7, layer: 1 },
  { kind: 'SugarVault', x: 10, y: 8, layer: 1 },
  { kind: 'TunnelJunction', x: 7, y: 9, layer: 1 },
];

// Per-second income by building kind. Trickles into the HUD resource
// counters while the player is on the home scene — gives the colony a
// sense of liveness even without a raid in progress.
const INCOME_PER_SECOND: Partial<Record<Types.BuildingKind, { sugar: number; leafBits: number }>> = {
  DewCollector: { sugar: 8, leafBits: 0 },
  LarvaNursery: { sugar: 0, leafBits: 3 },
  SugarVault: { sugar: 2, leafBits: 0 },
};

export class HomeScene extends Phaser.Scene {
  private layer: 0 | 1 = 0;
  private boardContainer!: Phaser.GameObjects.Container;
  private layerLabel!: Phaser.GameObjects.Text;
  private resources = { sugar: 1240, leafBits: 380, aphidMilk: 0 };
  private sugarText!: Phaser.GameObjects.Text;
  private leafText!: Phaser.GameObjects.Text;
  private milkText!: Phaser.GameObjects.Text;
  private incomeAccumulator = 0;
  // If the server handed back a real base snapshot, render that — it
  // may differ from the STARTER_BUILDINGS fallback (e.g. a player who
  // has already completed a place/upgrade action). Otherwise null.
  private serverBase: Types.Base | null = null;

  constructor() {
    super('HomeScene');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0f1b10');

    // Hydrate from runtime — scene is re-entered after each raid, so this
    // re-reads the latest player state (which RaidScene patches after a
    // successful /raid/submit).
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (runtime?.player) {
      this.serverBase = runtime.player.base;
      this.resources = {
        sugar: runtime.player.player.sugar,
        leafBits: runtime.player.player.leafBits,
        aphidMilk: runtime.player.player.aphidMilk,
      };
    }

    // Layout: HUD on top, board below.
    this.drawHud();
    this.boardContainer = this.add.container(0, HUD_H);
    this.drawBoard();
    this.drawBuildings();
    this.drawFooter();
    this.wireBoardTap();
    // Kick off catalog fetch (non-blocking) — it's cached per scene
    // enter. If it fails, the picker shows a network error.
    void this.loadCatalog();

    this.scale.on('resize', this.handleResize, this);
    this.handleResize();
  }

  private catalog: Record<
    string,
    { sugar: number; leafBits: number; aphidMilk: number }
  > = {};

  private async loadCatalog(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const res = await runtime.api.getBuildingCatalog();
      this.catalog = res.placeable;
    } catch {
      // Picker will show an empty state
    }
  }

  override update(_time: number, deltaMs: number): void {
    // Resource trickle from producer buildings. Integer ticks so the HUD
    // never shows fractional sugar — accumulate fractional income and
    // apply whole units as they cross the threshold.
    this.incomeAccumulator += deltaMs;
    if (this.incomeAccumulator < 1000) return;
    const seconds = Math.floor(this.incomeAccumulator / 1000);
    this.incomeAccumulator -= seconds * 1000;

    let sugar = 0;
    let leaf = 0;
    if (this.serverBase) {
      for (const b of this.serverBase.buildings) {
        if (b.hp <= 0) continue;
        const inc = INCOME_PER_SECOND[b.kind];
        if (!inc) continue;
        sugar += inc.sugar * seconds;
        leaf += inc.leafBits * seconds;
      }
    } else {
      for (const b of STARTER_BUILDINGS) {
        const inc = INCOME_PER_SECOND[b.kind];
        if (!inc) continue;
        sugar += inc.sugar * seconds;
        leaf += inc.leafBits * seconds;
      }
    }
    if (sugar === 0 && leaf === 0) return;
    this.resources.sugar += sugar;
    this.resources.leafBits += leaf;
    this.sugarText.setText(this.resources.sugar.toString());
    this.leafText.setText(this.resources.leafBits.toString());
    this.flashResourceGain();
  }

  private flashResourceGain(): void {
    this.tweens.add({
      targets: [this.sugarText, this.leafText],
      alpha: { from: 0.5, to: 1 },
      duration: 260,
      ease: 'Sine.easeOut',
    });
  }

  private drawHud(): void {
    const hud = this.add.graphics();
    hud.fillStyle(0x0a120c, 1);
    hud.fillRect(0, 0, this.scale.width, HUD_H);
    hud.fillStyle(0x1a2b1a, 1);
    hud.fillRect(0, HUD_H - 2, this.scale.width, 2);

    this.add
      .text(16, HUD_H / 2, 'HIVE WARS', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '18px',
        color: '#ffd98a',
      })
      .setOrigin(0, 0.5);

    // Resource badges (right-aligned). We build the texts first so class
    // fields are populated before the income tick runs.
    this.sugarText = this.add
      .text(0, 0, this.resources.sugar.toString(), {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '16px',
        color: '#e6f5d2',
      })
      .setOrigin(1, 0.5);
    this.leafText = this.add
      .text(0, 0, this.resources.leafBits.toString(), {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '16px',
        color: '#e6f5d2',
      })
      .setOrigin(1, 0.5);
    this.milkText = this.add
      .text(0, 0, this.resources.aphidMilk.toString(), {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '16px',
        color: '#e6f5d2',
      })
      .setOrigin(1, 0.5);

    const badges: Array<{ icon: string; text: Phaser.GameObjects.Text }> = [
      { icon: 'ui-resource-sugar', text: this.sugarText },
      { icon: 'ui-resource-leaf', text: this.leafText },
      { icon: 'ui-resource-milk', text: this.milkText },
    ];
    let x = this.scale.width - 16;
    for (let i = badges.length - 1; i >= 0; i--) {
      const b = badges[i]!;
      b.text.setPosition(x, HUD_H / 2);
      const icon = this.add
        .image(x - b.text.width - 24, HUD_H / 2, b.icon)
        .setDisplaySize(28, 28);
      x -= b.text.width + 60;
      void icon; // ref-hold for GC; image registers itself on the scene
    }
  }

  private drawBoard(): void {
    // Board background with layer-specific tint
    const bg = this.add.graphics();
    const surface = 0x1d3a1a;
    const underground = 0x2a1e15;
    bg.fillStyle(this.layer === 0 ? surface : underground, 1);
    bg.fillRect(0, 0, BOARD_W, BOARD_H);

    // Soft vignette stripes for depth
    bg.fillStyle(0x000000, 0.12);
    for (let y = 0; y < BOARD_H; y += TILE * 2) bg.fillRect(0, y, BOARD_W, 2);

    // Grid
    const grid = this.add.graphics({
      lineStyle: {
        width: 1,
        color: this.layer === 0 ? 0x2c5a23 : 0x442e1c,
        alpha: 0.8,
      },
    });
    for (let x = 0; x <= GRID_W; x++) {
      grid.lineBetween(x * TILE, 0, x * TILE, BOARD_H);
    }
    for (let y = 0; y <= GRID_H; y++) {
      grid.lineBetween(0, y * TILE, BOARD_W, y * TILE);
    }

    this.boardContainer.add([bg, grid]);
  }

  private drawBuildings(): void {
    // Prefer the server's base snapshot. Fall back to the hardcoded
    // starter layout when running guest-local (DB unavailable).
    if (this.serverBase) {
      for (const b of this.serverBase.buildings) {
        const spans = b.spans ?? null;
        const spansBoth = spans && spans.length > 1;
        const onThisLayer =
          (spansBoth && spans?.includes(this.layer)) ||
          b.anchor.layer === this.layer;
        if (!onThisLayer) continue;
        const x = b.anchor.x * TILE + (b.footprint.w * TILE) / 2;
        const y = b.anchor.y * TILE + (b.footprint.h * TILE) / 2;
        const spr = this.add.image(x, y, `building-${b.kind}`);
        spr.setOrigin(0.5, 0.75);
        spr.setAlpha(spansBoth && b.anchor.layer !== this.layer ? 0.65 : 1);
        const tiles = Math.max(b.footprint.w, b.footprint.h);
        spr.setDisplaySize(tiles * TILE * 1.2, tiles * TILE * 1.2);
        this.tweens.add({
          targets: spr,
          scale: { from: spr.scale, to: spr.scale * 1.03 },
          duration: 1400 + Math.random() * 800,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
        this.boardContainer.add(spr);
      }
      return;
    }
    for (const b of STARTER_BUILDINGS) {
      const spansBoth = b.kind === 'QueenChamber';
      if (!spansBoth && b.layer !== this.layer) continue;
      const x = b.x * TILE + TILE;
      const y = b.y * TILE + TILE;
      const spr = this.add.image(x, y, `building-${b.kind}`);
      spr.setOrigin(0.5, 0.75);
      spr.setAlpha(spansBoth && b.layer !== this.layer ? 0.65 : 1);
      spr.setDisplaySize(96, 96);
      this.tweens.add({
        targets: spr,
        scale: { from: spr.scale, to: spr.scale * 1.03 },
        duration: 1400 + Math.random() * 800,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
      this.boardContainer.add(spr);
    }
  }

  private drawFooter(): void {
    const y = HUD_H + BOARD_H + 28;
    const toggleLabel = () =>
      this.layer === 0 ? 'Layer: SURFACE ▲' : 'Layer: UNDERGROUND ▼';

    this.layerLabel = this.add
      .text(16, y, toggleLabel(), {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#c3e8b0',
      })
      .setOrigin(0, 0.5);

    const toggle = this.makeButton(
      160,
      y,
      'Flip layer',
      'ui-button-secondary',
      () => {
        this.layer = this.layer === 0 ? 1 : 0;
        this.layerLabel.setText(toggleLabel());
        this.boardContainer.removeAll(true);
        this.drawBoard();
        this.drawBuildings();
      },
    );

    const raid = this.makeButton(
      this.scale.width - 220,
      y,
      'Raid a base →',
      'ui-button-primary',
      () => this.scene.start('RaidScene'),
    );

    // Anchor to bottom on resize. Phaser.GameObjects.Container exposes `y`
    // directly, so no casts needed.
    this.events.on('prerender', () => {
      const by = HUD_H + BOARD_H + 28;
      this.layerLabel.setY(by);
      toggle.y = by;
      raid.y = by;
    });
  }

  private makeButton(
    x: number,
    y: number,
    label: string,
    bg: string,
    onPress: () => void,
  ): Phaser.GameObjects.Container {
    const container = this.add.container(x, y);
    const bgImg = this.add.image(0, 0, bg).setOrigin(0, 0.5).setDisplaySize(200, 44);
    const text = this.add
      .text(100, 0, label, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '16px',
        color: '#ffffff',
      })
      .setOrigin(0.5, 0.5);
    bgImg.setInteractive({ useHandCursor: true });
    bgImg.on('pointerover', () => bgImg.setTint(0xc3e8b0));
    bgImg.on('pointerout', () => bgImg.clearTint());
    bgImg.on('pointerdown', () => {
      this.tweens.add({
        targets: bgImg,
        scaleY: '*=0.95',
        duration: 60,
        yoyo: true,
      });
      onPress();
    });
    container.add([bgImg, text]);
    return container;
  }

  private handleResize(): void {
    // Center the board container horizontally when the scale allows.
    const xOffset = Math.max(0, (this.scale.width - BOARD_W) / 2);
    this.boardContainer.setX(xOffset);
  }

  // --- Build mode: tap empty tile → picker modal → place --------------------

  // Tap/drag threshold in screen pixels. A pointer that moves further
  // than this between down and up is interpreted as a drag (pan / path
  // draw / accidental scroll) and should NOT open the picker.
  private static readonly TAP_THRESHOLD_PX = 12;
  private tapDownPos: { x: number; y: number } | null = null;

  private wireBoardTap(): void {
    // Record the pointerdown position so pointerup can verify the
    // gesture was a tap (small movement), not a drag.
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.tapDownPos = { x: p.x, y: p.y };
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      const down = this.tapDownPos;
      this.tapDownPos = null;
      if (!down) return;
      const dx = p.x - down.x;
      const dy = p.y - down.y;
      if (dx * dx + dy * dy > HomeScene.TAP_THRESHOLD_PX * HomeScene.TAP_THRESHOLD_PX) {
        // Drag, not a tap — e.g. user panning the camera in the future.
        return;
      }
      // Ignore clicks in the HUD or footer strip.
      if (p.y < HUD_H || p.y > HUD_H + BOARD_H) return;
      const boardBounds = this.boardContainer.getBounds();
      const boardX = p.x - boardBounds.x;
      const boardY = p.y - boardBounds.y;
      if (boardX < 0 || boardX >= BOARD_W || boardY < 0 || boardY >= BOARD_H) return;
      const tx = Math.floor(boardX / TILE);
      const ty = Math.floor(boardY / TILE);
      if (this.isTileOccupied(tx, ty, this.layer)) return;
      this.openPicker(tx, ty);
    });
  }

  private isTileOccupied(tx: number, ty: number, layer: Types.Layer): boolean {
    const buildings = this.serverBase?.buildings ?? [];
    for (const b of buildings) {
      const onLayer =
        b.anchor.layer === layer || b.spans?.includes(layer);
      if (!onLayer) continue;
      if (
        tx >= b.anchor.x &&
        tx < b.anchor.x + b.footprint.w &&
        ty >= b.anchor.y &&
        ty < b.anchor.y + b.footprint.h
      ) {
        return true;
      }
    }
    return false;
  }

  private pickerContainer: Phaser.GameObjects.Container | null = null;

  private openPicker(tx: number, ty: number): void {
    this.closePicker();
    const kinds = Object.keys(this.catalog) as Types.BuildingKind[];
    if (kinds.length === 0) {
      this.flashToast('Loading catalog…');
      return;
    }
    // Size the modal to the content. Grid is cols × rows; height
    // follows the row count so adding new building kinds never spills
    // off the bottom.
    const cols = 4;
    const slotH = 110;
    const rows = Math.ceil(kinds.length / cols);
    const W = Math.min(640, this.scale.width - 32);
    const naturalH = 60 + rows * (slotH + 12) + 32;
    const maxH = this.scale.height - 80;
    const H = Math.min(naturalH, maxH);
    const ox = (this.scale.width - W) / 2;
    const oy = (this.scale.height - H) / 2;

    const bg = this.add.graphics().setDepth(200);
    bg.fillStyle(0x000000, 0.6);
    bg.fillRect(0, 0, this.scale.width, this.scale.height);
    const card = this.add.graphics().setDepth(201);
    card.fillStyle(0x1a2b1a, 0.98);
    card.lineStyle(3, 0xffd98a, 1);
    card.fillRoundedRect(ox, oy, W, H, 14);
    card.strokeRoundedRect(ox, oy, W, H, 14);

    const container = this.add.container(0, 0).setDepth(202);
    container.add([bg, card]);

    const title = this.add
      .text(
        this.scale.width / 2,
        oy + 18,
        `Place building at (${tx}, ${ty}, ${this.layer === 0 ? 'surface' : 'underground'})`,
        {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '14px',
          color: '#ffd98a',
        },
      )
      .setOrigin(0.5, 0).setDepth(203);
    container.add(title);

    // Close button
    const close = this.add
      .text(ox + W - 14, oy + 14, '×', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '22px',
        color: '#c3e8b0',
      })
      .setOrigin(1, 0).setDepth(203).setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.closePicker());
    container.add(close);

    const slotW = (W - 48) / cols;
    kinds.forEach((kind, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = ox + 24 + col * slotW + slotW / 2;
      const cy = oy + 60 + row * (slotH + 12) + slotH / 2;
      const cost = this.catalog[kind]!;
      const canAfford =
        this.resources.sugar >= cost.sugar &&
        this.resources.leafBits >= cost.leafBits &&
        this.resources.aphidMilk >= cost.aphidMilk;

      const slotBg = this.add.graphics().setDepth(203);
      slotBg.fillStyle(canAfford ? 0x233d24 : 0x2a1e1e, 1);
      slotBg.lineStyle(2, canAfford ? 0x5ba445 : 0xd94c4c, 1);
      slotBg.fillRoundedRect(cx - slotW / 2 + 4, cy - slotH / 2, slotW - 8, slotH - 8, 8);
      slotBg.strokeRoundedRect(cx - slotW / 2 + 4, cy - slotH / 2, slotW - 8, slotH - 8, 8);
      container.add(slotBg);

      const icon = this.add
        .image(cx, cy - 22, `building-${kind}`)
        .setDisplaySize(48, 48)
        .setDepth(204);
      container.add(icon);

      const nameText = this.add
        .text(cx, cy + 12, kind.replace(/([A-Z])/g, ' $1').trim(), {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '11px',
          color: canAfford ? '#e6f5d2' : '#c79090',
        })
        .setOrigin(0.5)
        .setDepth(204);
      container.add(nameText);
      const costText = this.add
        .text(
          cx,
          cy + 28,
          `${cost.sugar}🍬 ${cost.leafBits}🍃`,
          {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '10px',
            color: canAfford ? '#c3e8b0' : '#d98080',
          },
        )
        .setOrigin(0.5)
        .setDepth(204);
      container.add(costText);

      const hit = this.add
        .zone(cx, cy, slotW - 8, slotH - 8)
        .setOrigin(0.5)
        .setDepth(205)
        .setInteractive({ useHandCursor: canAfford });
      hit.on('pointerdown', () => {
        if (!canAfford) {
          this.flashToast(
            `Need ${cost.sugar} sugar & ${cost.leafBits} leaf — have ${this.resources.sugar}/${this.resources.leafBits}`,
          );
          return;
        }
        void this.commitPlacement(kind, tx, ty);
      });
      container.add(hit);
    });

    this.pickerContainer = container;
  }

  private closePicker(): void {
    if (this.pickerContainer) {
      this.pickerContainer.destroy(true);
      this.pickerContainer = null;
    }
  }

  private async commitPlacement(
    kind: Types.BuildingKind,
    tx: number,
    ty: number,
  ): Promise<void> {
    this.closePicker();
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) {
      this.flashToast('Offline — cannot place');
      return;
    }
    try {
      const res = await runtime.api.placeBuilding({
        kind,
        anchor: { x: tx, y: ty, layer: this.layer },
      });
      // Patch runtime so the next scene enter sees the new state.
      if (runtime.player) {
        runtime.player.base = res.base;
        runtime.player.player.sugar = res.player.sugar;
        runtime.player.player.leafBits = res.player.leafBits;
        runtime.player.player.aphidMilk = res.player.aphidMilk;
        runtime.player.player.trophies = res.player.trophies;
      }
      this.serverBase = res.base;
      this.resources = {
        sugar: res.player.sugar,
        leafBits: res.player.leafBits,
        aphidMilk: res.player.aphidMilk,
      };
      this.sugarText.setText(this.resources.sugar.toString());
      this.leafText.setText(this.resources.leafBits.toString());
      // Re-render buildings.
      this.boardContainer.removeAll(true);
      this.drawBoard();
      this.drawBuildings();
      this.flashToast(`Placed ${kind}`);
    } catch (err) {
      this.flashToast((err as Error).message);
    }
  }

  private toast: Phaser.GameObjects.Text | null = null;
  private flashToast(msg: string): void {
    this.toast?.destroy();
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
    this.toast = t;
    this.tweens.add({
      targets: t,
      alpha: { from: 1, to: 0 },
      delay: 1800,
      duration: 400,
      onComplete: () => {
        t.destroy();
        if (this.toast === t) this.toast = null;
      },
    });
  }
}
