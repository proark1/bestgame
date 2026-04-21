import Phaser from 'phaser';
import type { HiveRuntime } from '../main.js';
import type { LeaderboardEntry } from '../net/Api.js';

// Top-trophy standings. Pulled on scene create; falls back to a
// loading indicator if offline. The caller's own rank is highlighted.

const HUD_H = 56;

export class LeaderboardScene extends Phaser.Scene {
  private rowContainer!: Phaser.GameObjects.Container;
  private loadingText!: Phaser.GameObjects.Text;
  private contentHeight = 0;
  private viewportTop = HUD_H + 24;
  private scrollOffset = 0;
  private scrolling = false;
  private scrollStartY = 0;
  private scrollStartOffset = 0;

  constructor() {
    super('LeaderboardScene');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0f1b10');

    this.drawHud();
    this.rowContainer = this.add.container(0, this.viewportTop);
    this.loadingText = this.add
      .text(this.scale.width / 2, HUD_H + 80, 'Loading standings…', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#c3e8b0',
      })
      .setOrigin(0.5);

    this.wireScroll();
    void this.fetchData();
  }

  // Simple drag-to-scroll on the list area. Works with mouse + touch.
  // Wheel also scrolls for desktop convenience. Clamped so the last
  // row is always visible.
  private wireScroll(): void {
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.y < this.viewportTop) return;
      this.scrolling = true;
      this.scrollStartY = p.y;
      this.scrollStartOffset = this.scrollOffset;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.scrolling || !p.isDown) return;
      const dy = p.y - this.scrollStartY;
      this.setScroll(this.scrollStartOffset + dy);
    });
    this.input.on('pointerup', () => {
      this.scrolling = false;
    });
    this.input.on(
      'wheel',
      (_p: Phaser.Input.Pointer, _obj: unknown[], _dx: number, dy: number) => {
        this.setScroll(this.scrollOffset - dy);
      },
    );
  }

  private setScroll(raw: number): void {
    const viewportH = this.scale.height - this.viewportTop - 16;
    const minOffset = Math.min(0, viewportH - this.contentHeight);
    const clamped = Math.max(minOffset, Math.min(0, raw));
    this.scrollOffset = clamped;
    this.rowContainer.setY(this.viewportTop + clamped);
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
      // The user may have navigated away while we were awaiting the
      // response; writing to a dead scene is a guaranteed null deref.
      if (!this.scene.isActive()) return;
      this.loadingText.destroy();
      this.renderRows(res.top, res.me?.playerId ?? null, res.me);
    } catch (err) {
      if (!this.scene.isActive()) return;
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

    let finalY = rowH;
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
      finalY = y + rowH;
    });

    // If the caller isn't in the top list, append a divider + their row
    // at the bottom. Same cells as the top rows (faction icon + name)
    // so formatting is identical.
    if (me && !rows.some((r) => r.playerId === mePlayerId)) {
      const y = (rows.length + 1) * rowH + 20;
      this.rowContainer.add(
        this.text(this.scale.width / 2, y - 10, '···', '#9cb98a', 14, 0.5, 0.5),
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
          `${me.displayName} (you) · ${factionIcon(me.faction)}${me.faction}`,
          '#ffd98a',
          14,
          0,
          0.5,
        ),
      );
      this.rowContainer.add(
        this.text(originX + maxW - 20, y + rowH / 2, `🏆 ${me.trophies}`, '#ffd98a', 14, 1, 0.5),
      );
      finalY = y + rowH;
    }

    // Track content height so the scroll handler knows when to stop
    // letting the user drag upward.
    this.contentHeight = finalY + 16;
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
