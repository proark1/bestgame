import Phaser from 'phaser';
import type { HiveRuntime } from '../main.js';
import type { RaidHistoryEntry } from '../net/Api.js';

// Recent raids involving the player — attacker wins + defeats (when
// someone raided YOU). Taps a revenge button (TODO) and shows star
// counts + trophy deltas + loot.

const HUD_H = 56;

export class RaidHistoryScene extends Phaser.Scene {
  private rowContainer!: Phaser.GameObjects.Container;
  private loadingText!: Phaser.GameObjects.Text;

  constructor() {
    super('RaidHistoryScene');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0f1b10');
    this.drawHud();
    this.rowContainer = this.add.container(0, HUD_H + 24);
    this.loadingText = this.add
      .text(this.scale.width / 2, HUD_H + 80, 'Loading recent raids…', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#c3e8b0',
      })
      .setOrigin(0.5);
    void this.fetchData();
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
    this.add
      .text(this.scale.width / 2, HUD_H / 2, '📜 Recent Raids', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '18px',
        color: '#ffd98a',
      })
      .setOrigin(0.5);
  }

  private async fetchData(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) {
      this.loadingText.setText('Offline — no history');
      return;
    }
    try {
      const raids = await runtime.api.getRaidHistory(30);
      this.loadingText.destroy();
      if (raids.length === 0) {
        this.rowContainer.add(
          this.add
            .text(
              this.scale.width / 2,
              40,
              'No raids yet — smash the Raid button on the home screen.',
              {
                fontFamily: 'ui-monospace, monospace',
                fontSize: '13px',
                color: '#9cb98a',
              },
            )
            .setOrigin(0.5),
        );
        return;
      }
      this.renderRows(raids);
    } catch (err) {
      this.loadingText.setText(`Error: ${(err as Error).message}`);
    }
  }

  private renderRows(raids: RaidHistoryEntry[]): void {
    const maxW = Math.min(560, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    const rowH = 56;

    raids.forEach((r, i) => {
      const y = i * (rowH + 4);
      const outcome: 'win' | 'loss' | 'draw' =
        r.stars > 0 ? 'win' : 'loss';
      const isAttacker = r.role === 'attacker';
      const bg = this.add.graphics();
      bg.fillStyle(
        outcome === 'win'
          ? (isAttacker ? 0x2a3d21 : 0x3d2222)
          : (isAttacker ? 0x2a1e1e : 0x1d2a1d),
        0.9,
      );
      bg.lineStyle(1, 0x2c5a23, 1);
      bg.fillRoundedRect(originX, y, maxW, rowH, 8);
      bg.strokeRoundedRect(originX, y, maxW, rowH, 8);
      this.rowContainer.add(bg);

      const stars = '★'.repeat(r.stars) + '☆'.repeat(3 - r.stars);
      this.rowContainer.add(
        this.text(
          originX + 14,
          y + 14,
          `${isAttacker ? 'vs' : 'raided by'} ${r.opponentName}`,
          '#e6f5d2',
          13,
          0,
          0,
        ),
      );
      this.rowContainer.add(
        this.text(
          originX + 14,
          y + 34,
          `${stars}  ${r.sugarLooted}🍬  ${r.leafLooted}🍃`,
          outcome === 'win' ? '#ffd98a' : '#9cb98a',
          12,
          0,
          0,
        ),
      );
      const deltaColor =
        r.trophyDelta > 0 ? '#5ba445' : r.trophyDelta < 0 ? '#d94c4c' : '#9cb98a';
      const deltaSign = r.trophyDelta > 0 ? '+' : '';
      this.rowContainer.add(
        this.text(
          originX + maxW - 14,
          y + 20,
          `${deltaSign}${r.trophyDelta} 🏆`,
          deltaColor,
          16,
          1,
          0.5,
        ),
      );
      const when = formatRelative(r.createdAt);
      this.rowContainer.add(
        this.text(originX + maxW - 14, y + rowH - 10, when, '#9cb98a', 10, 1, 1),
      );
    });
  }

  private text(
    x: number,
    y: number,
    s: string,
    color: string,
    size: number,
    ox: number,
    oy: number,
  ): Phaser.GameObjects.Text {
    return this.add
      .text(x, y, s, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: `${size}px`,
        color,
      })
      .setOrigin(ox, oy);
  }
}

function formatRelative(isoTs: string): string {
  const t = new Date(isoTs).getTime();
  const deltaSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (deltaSec < 60) return 'just now';
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}
