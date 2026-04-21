import Phaser from 'phaser';

// HomeScene — the dual-layer base editor (surface + underground). Week-1
// scaffold: just shows the two layers as grids and a toggle button. The
// place/upgrade/delete flow lands in week 2.

const TILE = 48; // px per tile
const GRID_W = 16;
const GRID_H = 12;

export class HomeScene extends Phaser.Scene {
  private layer: 0 | 1 = 0;
  private label?: Phaser.GameObjects.Text;

  constructor() {
    super('HomeScene');
  }

  create(): void {
    this.cameras.main.setBackgroundColor(this.layer === 0 ? '#1d3a1a' : '#2a1e15');
    this.drawGrid();

    // Simple layer toggle button. Real UI follows in week 2.
    const btn = this.add
      .text(16, 16, '[Toggle layer]', {
        fontFamily: 'system-ui',
        fontSize: '20px',
        color: '#c3e8b0',
        backgroundColor: '#0f1b10',
        padding: { left: 10, right: 10, top: 6, bottom: 6 },
      })
      .setInteractive({ useHandCursor: true });
    btn.on('pointerdown', () => this.toggleLayer());

    this.label = this.add.text(16, 60, this.layerLabel(), {
      fontFamily: 'system-ui',
      fontSize: '16px',
      color: '#e6f5d2',
    });

    this.add
      .text(16, this.scale.height - 44, '[Raid a bot base →]', {
        fontFamily: 'system-ui',
        fontSize: '20px',
        color: '#ffd98a',
        backgroundColor: '#0f1b10',
        padding: { left: 10, right: 10, top: 6, bottom: 6 },
      })
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.scene.start('RaidScene'));
  }

  private drawGrid(): void {
    const gfx = this.add.graphics({ lineStyle: { width: 1, color: 0x2c5a23 } });
    for (let x = 0; x <= GRID_W; x++) {
      gfx.lineBetween(x * TILE, 0, x * TILE, GRID_H * TILE);
    }
    for (let y = 0; y <= GRID_H; y++) {
      gfx.lineBetween(0, y * TILE, GRID_W * TILE, y * TILE);
    }
  }

  private toggleLayer(): void {
    this.layer = this.layer === 0 ? 1 : 0;
    this.cameras.main.setBackgroundColor(this.layer === 0 ? '#1d3a1a' : '#2a1e15');
    this.label?.setText(this.layerLabel());
  }

  private layerLabel(): string {
    return this.layer === 0 ? 'Layer: SURFACE' : 'Layer: UNDERGROUND';
  }
}
