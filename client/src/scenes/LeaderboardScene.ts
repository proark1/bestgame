import Phaser from 'phaser';
import type { HiveRuntime } from '../main.js';
import type { LeaderboardEntry } from '../net/Api.js';

// Top-trophy standings. Pulled on scene create; falls back to a
// loading indicator if offline. The caller's own rank is highlighted.

const HUD_H = 56;

export class LeaderboardScene extends Phaser.Scene {
  private rowContainer!: Phaser.GameObjects.Container;
  private loadingText!: Phaser.GameObjects.Text;

  constructor() {
    super('LeaderboardScene');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0f1b10');

    this.drawHud();
    this.rowContainer = this.add.container(0, HUD_H + 24);
    this.loadingText = this.add
      .text(this.scale.width / 2, HUD_H + 80, 'Loading standings…', {
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
      .text(this.scale.width / 2, HUD_H / 2, '🏆 Leaderboard', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '18px',
        color: '#ffd98a',
      })
      .setOrigin(0.5);
  }

  private async fetchData(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) {
      this.loadingText.setText('Offline — no standings');
      return;
    }
    try {
      const res = await runtime.api.getLeaderboard(50);
      this.loadingText.destroy();
      this.renderRows(res.top, res.me?.playerId ?? null, res.me);
    } catch (err) {
      this.loadingText.setText(`Error: ${(err as Error).message}`);
    }
  }

  private renderRows(
    rows: LeaderboardEntry[],
    mePlayerId: string | null,
    me: LeaderboardEntry | null,
  ): void {
    const maxW = Math.min(560, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    const rowH = 40;

    // Header
    const header = this.add.graphics();
    header.fillStyle(0x1a2b1a, 1);
    header.fillRoundedRect(originX, 0, maxW, rowH - 4, 8);
    this.rowContainer.add(header);
    const headerRow = this.add.container(0, 0);
    headerRow.add(
      this.text(originX + 14, rowH / 2, 'rank', '#ffd98a', 12, 0, 0.5),
    );
    headerRow.add(
      this.text(originX + 80, rowH / 2, 'name', '#ffd98a', 12, 0, 0.5),
    );
    headerRow.add(
      this.text(originX + maxW - 100, rowH / 2, 'trophies', '#ffd98a', 12, 0, 0.5),
    );
    this.rowContainer.add(headerRow);

    // Rows
    rows.forEach((r, i) => {
      const y = (i + 1) * rowH;
      const isMe = r.playerId === mePlayerId;
      const rowBg = this.add.graphics();
      rowBg.fillStyle(isMe ? 0x2a3d21 : (i % 2 === 0 ? 0x141f11 : 0x0f1b10), 0.85);
      rowBg.fillRoundedRect(originX, y, maxW, rowH - 4, 6);
      if (isMe) {
        rowBg.lineStyle(2, 0xffd98a, 1);
        rowBg.strokeRoundedRect(originX, y, maxW, rowH - 4, 6);
      }
      this.rowContainer.add(rowBg);
      this.rowContainer.add(
        this.text(
          originX + 14,
          y + rowH / 2,
          `#${r.rank}`,
          r.rank <= 3 ? '#ffd98a' : '#e6f5d2',
          14,
          0,
          0.5,
        ),
      );
      this.rowContainer.add(
        this.text(
          originX + 80,
          y + rowH / 2,
          `${r.displayName} · ${factionIcon(r.faction)}${r.faction}`,
          isMe ? '#ffd98a' : '#e6f5d2',
          14,
          0,
          0.5,
        ),
      );
      this.rowContainer.add(
        this.text(
          originX + maxW - 20,
          y + rowH / 2,
          `🏆 ${r.trophies}`,
          '#ffd98a',
          14,
          1,
          0.5,
        ),
      );
    });

    // If the caller isn't in the top list, append a divider + their row
    // at the bottom.
    if (me && !rows.some((r) => r.playerId === mePlayerId)) {
      const y = (rows.length + 1) * rowH + 20;
      this.rowContainer.add(
        this.text(
          this.scale.width / 2,
          y - 10,
          '···',
          '#9cb98a',
          14,
          0.5,
          0.5,
        ),
      );
      const myBg = this.add.graphics();
      myBg.fillStyle(0x2a3d21, 0.85);
      myBg.lineStyle(2, 0xffd98a, 1);
      myBg.fillRoundedRect(originX, y, maxW, rowH - 4, 6);
      myBg.strokeRoundedRect(originX, y, maxW, rowH - 4, 6);
      this.rowContainer.add(myBg);
      this.rowContainer.add(
        this.text(originX + 14, y + rowH / 2, `#${me.rank}`, '#ffd98a', 14, 0, 0.5),
      );
      this.rowContainer.add(
        this.text(
          originX + 80,
          y + rowH / 2,
          `${me.displayName} (you)`,
          '#ffd98a',
          14,
          0,
          0.5,
        ),
      );
      this.rowContainer.add(
        this.text(originX + maxW - 20, y + rowH / 2, `🏆 ${me.trophies}`, '#ffd98a', 14, 1, 0.5),
      );
    }
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

function factionIcon(faction: string): string {
  switch (faction) {
    case 'Ants':
      return '🐜';
    case 'Bees':
      return '🐝';
    case 'Beetles':
      return '🪲';
    case 'Spiders':
      return '🕷️';
    default:
      return '❔';
  }
}
