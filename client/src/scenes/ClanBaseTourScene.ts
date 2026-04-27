import Phaser from 'phaser';
import { Types } from '@hive/shared';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import {
  drawSceneAmbient,
  drawSceneHud,
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
import type { HiveRuntime } from '../main.js';

// ClanBaseTourScene — read-only "visit a clanmate's base" view.
// Foundation slice of the audit's "shared underground tunnels"
// feature (step 8): tour today, sim integration on top later.
//
// Renders the clanmate's full base snapshot on a 16×12 grid, with a
// surface/underground layer toggle and a back button. No
// interaction with the underlying buildings — view only. Sprites
// reuse the same `building-${kind}` texture keys HomeScene paints
// from, so this scene is asset-free.

const TILE = 48;
const GRID_W = 16;
const GRID_H = 12;
const BOARD_W = TILE * GRID_W;
const BOARD_H = TILE * GRID_H;
const HUD_H = 56;

// Subset of HomeScene's wall-with-vertical-variant set. Re-listed
// here (rather than imported) because that constant lives in a
// 3kLOC scene file we don't want to drag into our dependency
// graph just to render a tour.
const KINDS_WITH_V_VARIANTS: ReadonlySet<Types.BuildingKind> = new Set<Types.BuildingKind>([
  'LeafWall',
  'ThornHedge',
]);

function buildingTextureKey(
  kind: Types.BuildingKind,
  rotation: 0 | 1 | 2 | 3 = 0,
): string {
  if (KINDS_WITH_V_VARIANTS.has(kind) && rotation % 2 === 1) {
    return `building-${kind}V`;
  }
  return `building-${kind}`;
}

export class ClanBaseTourScene extends Phaser.Scene {
  private boardContainer!: Phaser.GameObjects.Container;
  private layer: Types.Layer = 0;
  private base: Types.Base | null = null;
  private displayName = '';
  private trophies = 0;
  private layerToggleLabel: Phaser.GameObjects.Text | null = null;
  private statusText: Phaser.GameObjects.Text | null = null;

  constructor() { super('ClanBaseTourScene'); }

  create(): void {
    fadeInScene(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    drawSceneAmbient(this);
    drawSceneHud(this, 'Visit Clanmate', 'ClanScene');

    this.boardContainer = this.add.container(0, HUD_H + 70);
    this.statusText = crispText(
      this,
      this.scale.width / 2,
      HUD_H + 100,
      'Loading clanmate\'s base…',
      bodyTextStyle(13, COLOR.textDim),
    ).setOrigin(0.5, 0.5);

    void this.loadAndRender();
    this.scale.on('resize', this.layout, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.layout, this));
  }

  private async loadAndRender(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    const targetId = this.registry.get('clanBaseTourTargetId') as string | undefined;
    // One-shot consumption so re-entry doesn't reload the same
    // target if the player navigates back.
    this.registry.set('clanBaseTourTargetId', null);
    if (!runtime || !targetId) {
      this.statusText?.setText('No clanmate selected.');
      return;
    }
    try {
      const res = await runtime.api.getClanmateBase(targetId);
      if (!this.scene.isActive()) return;
      this.base = res.base;
      this.displayName = res.displayName;
      this.trophies = res.trophies;
      this.statusText?.destroy();
      this.statusText = null;
      this.drawHeader();
      this.drawBoard();
      this.drawBuildings();
      this.drawLayerToggle();
      this.layout();
    } catch (err) {
      this.statusText?.setText(`Couldn't load: ${(err as Error).message}`);
    }
  }

  private drawHeader(): void {
    const w = Math.min(640, this.scale.width - 32);
    const x = (this.scale.width - w) / 2;
    const y = HUD_H + 8;
    const card = this.add.graphics();
    drawPanel(card, x, y, w, 56, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      stroke: COLOR.brassDeep,
      strokeWidth: 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.14,
      radius: 12,
      shadowOffset: 4,
      shadowAlpha: 0.28,
    });
    const pill = this.add.graphics();
    drawPill(pill, x + 14, y + 10, 80, 22, { brass: true });
    crispText(this, x + 54, y + 21, 'CLANMATE',
      labelTextStyle(10, COLOR.textGold)).setOrigin(0.5, 0.5);
    crispText(this, x + 110, y + 12, this.displayName,
      displayTextStyle(15, COLOR.textGold, 3));
    crispText(this, x + 110, y + 32,
      `🏆 ${this.trophies} trophies`,
      bodyTextStyle(12, COLOR.textPrimary));
  }

  private drawBoard(): void {
    // Tile-grid backdrop — same dimensions HomeScene/RaidScene use,
    // so building anchor coords land where the player remembers
    // them from their own base.
    const bg = this.add.graphics();
    bg.fillStyle(0x162216, 1);
    bg.fillRect(0, 0, BOARD_W, BOARD_H);
    bg.lineStyle(1, COLOR.brassDeep, 0.35);
    for (let i = 0; i <= GRID_W; i++) {
      bg.beginPath();
      bg.moveTo(i * TILE, 0);
      bg.lineTo(i * TILE, BOARD_H);
      bg.strokePath();
    }
    for (let j = 0; j <= GRID_H; j++) {
      bg.beginPath();
      bg.moveTo(0, j * TILE);
      bg.lineTo(BOARD_W, j * TILE);
      bg.strokePath();
    }
    this.boardContainer.add(bg);
  }

  private drawBuildings(): void {
    if (!this.base) return;
    // Wipe sprites except the backdrop (index 0) before re-painting.
    while (this.boardContainer.length > 1) {
      const last = this.boardContainer.getAt(this.boardContainer.length - 1) as Phaser.GameObjects.GameObject;
      last.destroy();
    }
    for (const b of this.base.buildings) {
      const spans = b.spans ?? null;
      const spansBoth = spans !== null && spans.length > 1;
      const onLayer = (spansBoth && spans!.includes(this.layer)) ||
        b.anchor.layer === this.layer;
      if (!onLayer) continue;
      const x = b.anchor.x * TILE + (b.footprint.w * TILE) / 2;
      const y = b.anchor.y * TILE + (b.footprint.h * TILE) / 2;
      const rot = (b.rotation ?? 0) as 0 | 1 | 2 | 3;
      const key = buildingTextureKey(b.kind, rot);
      const spr = this.textures.exists(key)
        ? this.add.image(x, y, key)
        : (() => {
            // Fallback: solid rectangle keyed off the kind so a
            // missing sprite still hints at the layout. Zero asset
            // dependency on the tour; the BootScene texture set is
            // expected but not required.
            const g = this.add.graphics();
            g.fillStyle(0x556b3d, 1);
            g.fillRoundedRect(
              x - (b.footprint.w * TILE) / 2,
              y - (b.footprint.h * TILE) / 2,
              b.footprint.w * TILE,
              b.footprint.h * TILE,
              6,
            );
            return g;
          })();
      if (spr instanceof Phaser.GameObjects.Image) {
        spr.setOrigin(0.5, 0.5) /* center sprite within footprint cell so it never bleeds above the grid */;
        const tiles = Math.max(b.footprint.w, b.footprint.h);
        spr.setDisplaySize(tiles * TILE * 1.4, tiles * TILE * 1.4);
        // Cross-layer building on the inactive layer renders
        // ghosted, mirroring HomeScene's convention.
        if (spansBoth && b.anchor.layer !== this.layer) {
          spr.setAlpha(0.55);
        }
      }
      this.boardContainer.add(spr);
    }
  }

  private drawLayerToggle(): void {
    const toggle = makeHiveButton(this, {
      x: this.scale.width / 2,
      y: HUD_H + 100,
      width: 220,
      height: 36,
      label: this.layerLabel(),
      variant: 'primary',
      fontSize: 13,
      onPress: () => this.flipLayer(),
    });
    this.layerToggleLabel = toggle.container.list.find((c) => c instanceof Phaser.GameObjects.Text) as Phaser.GameObjects.Text;
  }

  private layerLabel(): string {
    return this.layer === 0 ? '↓ Underground' : '↑ Surface';
  }

  private flipLayer(): void {
    this.layer = this.layer === 0 ? 1 : 0;
    this.layerToggleLabel?.setText(this.layerLabel());
    this.drawBuildings();
  }

  private layout(): void {
    if (!this.base) return;
    // Center the board horizontally; vertical placement is fixed
    // below the header + toggle.
    const availW = this.scale.width - 24;
    const scale = Math.min(1, availW / BOARD_W);
    this.boardContainer.setScale(scale);
    const xOffset = (this.scale.width - BOARD_W * scale) / 2;
    this.boardContainer.setPosition(xOffset, HUD_H + 150);
  }

  // Helper for callers — the typical pattern is:
  //   ClanBaseTourScene.openFor(this, playerId)
  // which stamps the registry and starts the scene.
  static openFor(scene: Phaser.Scene, targetPlayerId: string): void {
    scene.registry.set('clanBaseTourTargetId', targetPlayerId);
    fadeToScene(scene, 'ClanBaseTourScene');
  }
}
