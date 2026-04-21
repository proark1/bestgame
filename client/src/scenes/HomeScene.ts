import Phaser from 'phaser';
import { Types } from '@hive/shared';

// HomeScene — the player's own colony. Shows a dual-layer backyard
// with the Queen Chamber plus a scatter of starter buildings. Player
// taps through to the raid. Place/upgrade flow lands next iteration;
// the week-2 delivery is visual polish + wiring to a playable raid.

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

export class HomeScene extends Phaser.Scene {
  private layer: 0 | 1 = 0;
  private boardContainer!: Phaser.GameObjects.Container;
  private layerLabel!: Phaser.GameObjects.Text;
  private resources = { sugar: 1240, leafBits: 380, aphidMilk: 0 };

  constructor() {
    super('HomeScene');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0f1b10');

    // Layout: HUD on top, board below.
    this.drawHud();
    this.boardContainer = this.add.container(0, HUD_H);
    this.drawBoard();
    this.drawBuildings();
    this.drawFooter();

    this.scale.on('resize', this.handleResize, this);
    this.handleResize();
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

    // Resource badges
    const resources = [
      { icon: 'ui-resource-sugar', value: () => this.resources.sugar.toString() },
      { icon: 'ui-resource-leaf', value: () => this.resources.leafBits.toString() },
      { icon: 'ui-resource-milk', value: () => this.resources.aphidMilk.toString() },
    ];

    let x = this.scale.width - 16;
    for (let i = resources.length - 1; i >= 0; i--) {
      const r = resources[i]!;
      const group = this.add.container(0, HUD_H / 2);
      const label = this.add
        .text(0, 0, r.value(), {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '16px',
          color: '#e6f5d2',
        })
        .setOrigin(1, 0.5);
      const icon = this.add.image(-label.width - 24, 0, r.icon).setDisplaySize(28, 28);
      group.add([icon, label]);
      group.setPosition(x, HUD_H / 2);
      x -= label.width + 44;
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
    for (const b of STARTER_BUILDINGS) {
      const spansBoth = b.kind === 'QueenChamber';
      if (!spansBoth && b.layer !== this.layer) continue;
      const x = b.x * TILE + TILE;
      const y = b.y * TILE + TILE;
      const spr = this.add.image(x, y, `building-${b.kind}`);
      spr.setOrigin(0.5, 0.75); // anchor near feet
      const isCrossLayer = spansBoth;
      spr.setAlpha(
        isCrossLayer && b.layer !== this.layer ? 0.65 : 1,
      );
      spr.setDisplaySize(96, 96);
      // subtle idle breathing for a "living" base
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
}
