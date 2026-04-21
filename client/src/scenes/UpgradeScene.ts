import Phaser from 'phaser';
import type { Types } from '@hive/shared';
import type { HiveRuntime } from '../main.js';
import type { UnitUpgradeEntry } from '../net/Api.js';

// Upgrade screen — list every upgradeable unit with its current level,
// the cost of the next level, and a button to commit the upgrade.
// Server owns the cost math; we only render.

const HUD_H = 56;

export class UpgradeScene extends Phaser.Scene {
  private rowContainer!: Phaser.GameObjects.Container;
  private loadingText!: Phaser.GameObjects.Text;
  private resourceBanner!: Phaser.GameObjects.Text;
  private contentHeight = 0;
  private viewportTop = HUD_H + 50;
  private scrollOffset = 0;
  private scrolling = false;
  private scrollStartY = 0;
  private scrollStartOffset = 0;
  private units: UnitUpgradeEntry[] = [];
  private resources = { sugar: 0, leafBits: 0 };

  constructor() {
    super('UpgradeScene');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0f1b10');
    this.drawHud();
    this.resourceBanner = this.add
      .text(this.scale.width / 2, HUD_H + 22, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#c3e8b0',
      })
      .setOrigin(0.5);
    this.rowContainer = this.add.container(0, this.viewportTop);
    this.loadingText = this.add
      .text(this.scale.width / 2, HUD_H + 100, 'Loading upgrade catalog…', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#c3e8b0',
      })
      .setOrigin(0.5);
    this.wireScroll();
    void this.fetchData();
  }

  private wireScroll(): void {
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.y < this.viewportTop) return;
      this.scrolling = true;
      this.scrollStartY = p.y;
      this.scrollStartOffset = this.scrollOffset;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.scrolling || !p.isDown) return;
      this.setScroll(this.scrollStartOffset + (p.y - this.scrollStartY));
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
      .text(this.scale.width / 2, HUD_H / 2, '⚙ Upgrades', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '18px',
        color: '#ffd98a',
      })
      .setOrigin(0.5);
  }

  private async fetchData(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) {
      this.loadingText.setText('Offline — no upgrades');
      return;
    }
    try {
      const res = await runtime.api.getUpgrades();
      if (!this.scene.isActive()) return;
      this.loadingText.destroy();
      this.units = res.units;
      this.resources = res.resources;
      this.render();
    } catch (err) {
      if (!this.scene.isActive()) return;
      this.loadingText.setText(`Error: ${(err as Error).message}`);
    }
  }

  private render(): void {
    this.rowContainer.removeAll(true);
    this.resourceBanner.setText(
      `${this.resources.sugar}🍬  ${this.resources.leafBits}🍃`,
    );

    const maxW = Math.min(560, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    const rowH = 64;

    let finalY = 0;
    this.units.forEach((u, i) => {
      const y = i * (rowH + 4);
      const maxed = u.level >= u.maxLevel || u.nextCost === null;
      const canAfford =
        !maxed &&
        u.nextCost !== null &&
        this.resources.sugar >= u.nextCost.sugar &&
        this.resources.leafBits >= u.nextCost.leafBits;

      const bg = this.add.graphics();
      bg.fillStyle(maxed ? 0x233d24 : canAfford ? 0x1a2b1a : 0x2a1e1e, 1);
      bg.lineStyle(1, canAfford ? 0x5ba445 : 0x2c5a23, 1);
      bg.fillRoundedRect(originX, y, maxW, rowH, 8);
      bg.strokeRoundedRect(originX, y, maxW, rowH, 8);
      this.rowContainer.add(bg);

      // Unit icon
      const icon = this.add
        .image(originX + 36, y + rowH / 2, `unit-${u.kind}`)
        .setDisplaySize(48, 48);
      this.rowContainer.add(icon);

      // Name + level
      this.rowContainer.add(
        this.text(
          originX + 72,
          y + 16,
          prettyName(u.kind),
          '#e6f5d2',
          14,
          0,
          0,
        ),
      );
      this.rowContainer.add(
        this.text(
          originX + 72,
          y + 38,
          `lv ${u.level}${u.level === u.maxLevel ? ' (MAX)' : ` → lv ${u.level + 1}`}`,
          maxed ? '#ffd98a' : '#c3e8b0',
          12,
          0,
          0,
        ),
      );

      if (!maxed && u.nextCost) {
        // Cost
        this.rowContainer.add(
          this.text(
            originX + maxW - 130,
            y + rowH / 2,
            `${u.nextCost.sugar}🍬\n${u.nextCost.leafBits}🍃`,
            canAfford ? '#ffd98a' : '#d98080',
            11,
            1,
            0.5,
          ),
        );

        // Upgrade button
        const btnW = 90;
        const btnH = 36;
        const btnX = originX + maxW - 12 - btnW;
        const btnY = y + (rowH - btnH) / 2;
        const btn = this.add.graphics();
        btn.fillStyle(canAfford ? 0x3a7f3a : 0x2a1e1e, 1);
        btn.lineStyle(2, canAfford ? 0xffd98a : 0x3a3a3a, 1);
        btn.fillRoundedRect(btnX, btnY, btnW, btnH, 6);
        btn.strokeRoundedRect(btnX, btnY, btnW, btnH, 6);
        this.rowContainer.add(btn);
        this.rowContainer.add(
          this.text(
            btnX + btnW / 2,
            btnY + btnH / 2,
            'Upgrade',
            canAfford ? '#ffffff' : '#7a7a7a',
            13,
            0.5,
            0.5,
          ),
        );
        if (canAfford) {
          const hit = this.add
            .zone(btnX + btnW / 2, btnY + btnH / 2, btnW, btnH)
            .setOrigin(0.5)
            .setInteractive({ useHandCursor: true });
          hit.on('pointerdown', () => void this.commit(u.kind));
          this.rowContainer.add(hit);
        }
      } else {
        // maxed-out badge
        this.rowContainer.add(
          this.text(
            originX + maxW - 16,
            y + rowH / 2,
            'MAXED',
            '#ffd98a',
            12,
            1,
            0.5,
          ),
        );
      }

      finalY = y + rowH;
    });
    this.contentHeight = finalY + 16;
  }

  private async commit(kind: Types.UnitKind): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const res = await runtime.api.upgradeUnit(kind);
      if (!this.scene.isActive()) return;
      // Patch runtime so HomeScene + RaidScene see the new levels.
      if (runtime.player) {
        runtime.player.player.sugar = res.resources.sugar;
        runtime.player.player.leafBits = res.resources.leafBits;
        runtime.player.player.unitLevels = res.unitLevels as Partial<
          Record<Types.UnitKind, number>
        >;
      }
      // Refresh locally then re-render.
      this.resources = res.resources;
      const local = this.units.find((u) => u.kind === kind);
      if (local) local.level = res.newLevel;
      this.render();
    } catch (err) {
      // Show an inline error at top of the viewport.
      this.add
        .text(
          this.scale.width / 2,
          this.viewportTop - 16,
          (err as Error).message,
          {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '12px',
            color: '#d94c4c',
          },
        )
        .setOrigin(0.5);
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

function prettyName(kind: string): string {
  return kind.replace(/([A-Z])/g, ' $1').trim();
}
