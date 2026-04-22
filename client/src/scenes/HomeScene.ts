import Phaser from 'phaser';
import { Types } from '@hive/shared';
import type { HiveRuntime } from '../main.js';
import { crispText } from '../ui/text.js';
import { openAccountModal } from '../ui/accountModal.js';
import { openTutorial, shouldShowTutorial } from '../ui/tutorialModal.js';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { makeHiveButton, type HiveButton } from '../ui/button.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { COLOR, displayTextStyle, SPACING } from '../ui/theme.js';

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
  private accountChip!: Phaser.GameObjects.Text;
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
    fadeInScene(this);
    this.drawAmbient();

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

    // When the viewport actually changes size (not just during the
    // initial FIT dance), restart the scene so the HUD + footer +
    // board all repaint against the new width. Cheap — reloads the
    // cached player snapshot from runtime, doesn't re-hit the API.
    // Debounced so a user dragging the window edge doesn't restart
    // 60 times per second.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastW = this.scale.width;
    let lastH = this.scale.height;
    this.scale.on('resize', () => {
      if (this.scale.width === lastW && this.scale.height === lastH) return;
      lastW = this.scale.width;
      lastH = this.scale.height;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.scene.restart(), 220);
    });

    // First-visit tutorial. Guarded by a localStorage flag so we
    // don't nag on every boot; can be reopened from the account chip.
    // Delay briefly so the tutorial lands on top of a fully-drawn
    // scene, not a half-painted one mid-fadeIn.
    if (shouldShowTutorial()) {
      this.time.delayedCall(350, () => openTutorial());
    }
  }

  private catalog: Record<
    string,
    { sugar: number; leafBits: number; aphidMilk: number }
  > = {};
  // Per-kind town-builder rules from the server. Empty until
  // loadCatalog() resolves; when present, picker gates slots by
  // current Queen level + per-kind caps + layer restriction.
  private rules: Record<
    string,
    { allowedLayers: number[]; quotaByTier: number[] }
  > = {};

  private async loadCatalog(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const res = await runtime.api.getBuildingCatalog();
      this.catalog = res.placeable;
      if (res.rules) this.rules = res.rules;
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

  // Scene-wide ambient: a soft top-to-bottom gradient behind everything,
  // plus a faint horizon glow so the HUD/footer strips don't read as
  // flat rectangles floating over dead ground. Cheap: 22 stacked bands
  // + a single radial fog ellipse.
  private drawAmbient(): void {
    const g = this.add.graphics().setDepth(-100);
    const top = 0x162317;
    const bot = 0x070d08;
    const BANDS = 22;
    for (let i = 0; i < BANDS; i++) {
      const t = i / (BANDS - 1);
      const r = Math.round(((top >> 16) & 0xff) + (((bot >> 16) & 0xff) - ((top >> 16) & 0xff)) * t);
      const gc = Math.round(((top >> 8) & 0xff) + (((bot >> 8) & 0xff) - ((top >> 8) & 0xff)) * t);
      const b = Math.round((top & 0xff) + ((bot & 0xff) - (top & 0xff)) * t);
      g.fillStyle((r << 16) | (gc << 8) | b, 1);
      g.fillRect(
        0,
        Math.floor((i * this.scale.height) / BANDS),
        this.scale.width,
        Math.ceil(this.scale.height / BANDS) + 1,
      );
    }
    // Subtle warm glow behind the board area so the play field sits in
    // a "pool of light" — reads as intentional rather than a slab of
    // the same dark green as the chrome.
    const glow = this.add.graphics().setDepth(-99);
    glow.fillStyle(0xffd98a, 0.04);
    glow.fillEllipse(this.scale.width / 2, HUD_H + BOARD_H / 2, BOARD_W * 1.1, BOARD_H * 1.15);
  }

  private drawHud(): void {
    // CoC-style HUD plane: deep gradient panel + thick brass accent
    // on the bottom edge + drop-shadow beneath. Gives the top strip
    // real "mass" vs the previous flat band.
    const hud = this.add.graphics();
    hud.fillGradientStyle(
      COLOR.bgPanelHi,
      COLOR.bgPanelHi,
      COLOR.bgPanelLo,
      COLOR.bgPanelLo,
      1,
    );
    hud.fillRect(0, 0, this.scale.width, HUD_H);
    // Top inner highlight — thin brass line along the top edge
    // catches the eye and anchors the panel.
    hud.fillStyle(COLOR.brass, 0.35);
    hud.fillRect(0, 1, this.scale.width, 1);
    // Bottom brass border + drop shadow beneath the panel.
    hud.fillStyle(COLOR.brassDeep, 1);
    hud.fillRect(0, HUD_H - 4, this.scale.width, 1);
    hud.fillStyle(COLOR.brass, 0.7);
    hud.fillRect(0, HUD_H - 3, this.scale.width, 2);
    hud.fillStyle(0x000000, 0.45);
    hud.fillRect(0, HUD_H, this.scale.width, 3);
    hud.fillStyle(0x000000, 0.2);
    hud.fillRect(0, HUD_H + 3, this.scale.width, 3);

    // Stroked display title — dark stroke + warm fill gives us the
    // chunky "title" look games in this genre use.
    crispText(this, 24, HUD_H / 2, 'HIVE WARS', displayTextStyle(20, '#ffe7b0', 4))
      .setOrigin(0, 0.5);

    // Account chip — pill-shaped, same visual language as resource
    // badges. Tappable, opens the register/login modal. Populated
    // with the actual username if the session is user-backed.
    const chipX = 180;
    const chipY = HUD_H / 2;
    const chipPanel = this.add.graphics();
    drawPill(chipPanel, chipX, chipY - 16, 120, 32);
    this.accountChip = crispText(this, chipX + 60, chipY, 'guest ▾', {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '13px',
      color: COLOR.textDim,
      fontStyle: 'bold',
    })
      .setOrigin(0.5, 0.5)
      .setInteractive({ useHandCursor: true });
    // Both the pill and the text should react to pointer — expose
    // the combined click target by making the pill interactive too.
    const chipZone = this.add
      .zone(chipX + 60, chipY, 120, 32)
      .setOrigin(0.5, 0.5)
      .setInteractive({ useHandCursor: true });
    chipZone.on('pointerdown', () => this.openAccountMenu());
    this.accountChip.on('pointerdown', () => this.openAccountMenu());
    const rt = this.registry.get('runtime') as HiveRuntime | undefined;
    if (rt) {
      void rt.auth.fetchMe().then((me) => {
        if (!me || !this.accountChip?.active) return;
        this.accountChip.setText(
          me.isGuest || !me.username ? 'guest ▾' : `@${me.username} ▾`,
        );
        this.accountChip.setColor(me.isGuest ? COLOR.textDim : COLOR.textGold);
      });
    }

    // Resource readouts — big, stroked, gold digits that read like
    // "I have this many coins." Built first so layout code below
    // can measure their widths.
    this.sugarText = crispText(
      this,
      0,
      0,
      this.resources.sugar.toString(),
      displayTextStyle(17, COLOR.textGold, 3),
    ).setOrigin(1, 0.5);
    this.leafText = crispText(
      this,
      0,
      0,
      this.resources.leafBits.toString(),
      displayTextStyle(17, '#c8f2a0', 3),
    ).setOrigin(1, 0.5);
    this.milkText = crispText(
      this,
      0,
      0,
      this.resources.aphidMilk.toString(),
      displayTextStyle(17, '#dfe8ff', 3),
    ).setOrigin(1, 0.5);

    // Resource pills — capsule panel per resource. Right-aligned
    // so the rightmost hugs the screen edge on any viewport.
    const badges: Array<{ icon: string; text: Phaser.GameObjects.Text }> = [
      { icon: 'ui-resource-sugar', text: this.sugarText },
      { icon: 'ui-resource-leaf', text: this.leafText },
      { icon: 'ui-resource-milk', text: this.milkText },
    ];
    const PILL_H = 36;
    const PILL_PAD_X = 12;
    const PILL_ICON_GAP = 6;
    const PILL_GAP = SPACING.sm;
    const ICON_SIZE = 26;
    let x = this.scale.width - SPACING.md;
    for (let i = badges.length - 1; i >= 0; i--) {
      const b = badges[i]!;
      const textW = Math.max(b.text.width, 30);
      const pillW = PILL_PAD_X * 2 + ICON_SIZE + PILL_ICON_GAP + textW;
      const pillX = x - pillW;
      const pillY = HUD_H / 2 - PILL_H / 2;
      const pill = this.add.graphics();
      drawPill(pill, pillX, pillY, pillW, PILL_H);
      const icon = this.add
        .image(pillX + PILL_PAD_X + ICON_SIZE / 2, HUD_H / 2, b.icon)
        .setDisplaySize(ICON_SIZE, ICON_SIZE);
      b.text.setPosition(pillX + pillW - PILL_PAD_X, HUD_H / 2);
      void pill;
      void icon;
      x = pillX - PILL_GAP;
    }
  }

  private drawBoard(): void {
    // Layer-aware palette. Surface = mossy daylight greens; underground
    // = warm cave tones with amber lighting.
    const palette =
      this.layer === 0
        ? {
            baseA: 0x274a21,
            baseB: 0x1d3a1a,
            grid: 0x2c5a23,
            decorA: 0x8bbd62,
            decorB: 0x4a7a2a,
            frame: 0x3d5e2a,
            highlight: 0x8fd273,
          }
        : {
            baseA: 0x35241a,
            baseB: 0x1f150e,
            grid: 0x5a3e23,
            decorA: 0xb88c4a,
            decorB: 0x7a5830,
            frame: 0x5a3a20,
            highlight: 0xd1a060,
          };

    const bg = this.add.graphics();
    // Vertical gradient fake via stacked bands. `fillGradientStyle`
    // would be ideal but Graphics' gradients draw solid on most
    // backends; stacking 18 bands reads as a smooth ramp visually
    // without per-pixel cost.
    const BANDS = 18;
    for (let i = 0; i < BANDS; i++) {
      const t = i / (BANDS - 1);
      const r1 = (palette.baseA >> 16) & 0xff;
      const g1 = (palette.baseA >> 8) & 0xff;
      const b1 = palette.baseA & 0xff;
      const r2 = (palette.baseB >> 16) & 0xff;
      const g2 = (palette.baseB >> 8) & 0xff;
      const b2 = palette.baseB & 0xff;
      const r = Math.round(r1 + (r2 - r1) * t);
      const g = Math.round(g1 + (g2 - g1) * t);
      const b = Math.round(b1 + (b2 - b1) * t);
      bg.fillStyle((r << 16) | (g << 8) | b, 1);
      bg.fillRect(
        0,
        Math.floor((i * BOARD_H) / BANDS),
        BOARD_W,
        Math.ceil(BOARD_H / BANDS) + 1,
      );
    }

    // Corner vignette — darkens the edges so the eye focuses on the
    // center of the base. Four triangular gradients built out of
    // overlapping alpha-rects, cheap and GPU-friendly.
    bg.fillStyle(0x000000, 0.28);
    for (let i = 0; i < 6; i++) {
      const edge = 6 - i;
      bg.fillRect(0, 0, edge, BOARD_H);
      bg.fillRect(BOARD_W - edge, 0, edge, BOARD_H);
      bg.fillRect(0, 0, BOARD_W, edge);
      bg.fillRect(0, BOARD_H - edge, BOARD_W, edge);
    }

    // Deterministic decoration scatter. Seeded off the layer so the
    // pattern is different between surface and underground but stable
    // across redraws (no random flicker when you flip layers).
    const deco = this.add.graphics();
    const seedBase = this.layer === 0 ? 0x12345 : 0x6789a;
    let seed = seedBase;
    const rnd = (): number => {
      // 32-bit xorshift — good enough for pattern placement, avoids
      // pulling in the shared PCG. Self-contained so the decoration
      // never desyncs from anything gameplay-relevant.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) / 0xffffffff);
    };
    for (let i = 0; i < 90; i++) {
      const x = rnd() * BOARD_W;
      const y = rnd() * BOARD_H;
      const r = 1 + rnd() * 2.5;
      const useA = rnd() < 0.55;
      deco.fillStyle(useA ? palette.decorA : palette.decorB, 0.22 + rnd() * 0.18);
      deco.fillCircle(x, y, r);
    }

    // Grid lines, softened.
    const grid = this.add.graphics({
      lineStyle: { width: 1, color: palette.grid, alpha: 0.5 },
    });
    for (let x = 0; x <= GRID_W; x++) {
      grid.lineBetween(x * TILE, 0, x * TILE, BOARD_H);
    }
    for (let y = 0; y <= GRID_H; y++) {
      grid.lineBetween(0, y * TILE, BOARD_W, y * TILE);
    }

    // Thick CoC-style wooden frame around the playable area. Two-
    // ring stroke + a thin brass inner highlight + a drop shadow
    // below. Makes the board read as a discrete, raised object
    // against the scene ambient.
    const frame = this.add.graphics();
    // Outer drop shadow
    frame.fillStyle(0x000000, 0.35);
    frame.fillRoundedRect(-3, -1, BOARD_W + 6, BOARD_H + 8, 12);
    // Outer ring (thick dark brown)
    frame.lineStyle(6, 0x3a2512, 1);
    frame.strokeRoundedRect(1, 1, BOARD_W - 2, BOARD_H - 2, 10);
    // Middle ring (warm brown)
    frame.lineStyle(3, 0x6b4420, 0.9);
    frame.strokeRoundedRect(3, 3, BOARD_W - 6, BOARD_H - 6, 8);
    // Inner brass highlight
    frame.lineStyle(1, COLOR.brass, 0.55);
    frame.strokeRoundedRect(5, 5, BOARD_W - 10, BOARD_H - 10, 6);

    this.boardContainer.add([bg, deco, grid, frame]);
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
        // 1.4× tile scaling: building sprites are 128×128 source, so a
        // 1-tile building renders at 67 px — a cleaner 0.52 ratio than
        // the previous 1.2× (57 px / 0.45 ratio). Bigger + closer to
        // an integer-multiple downscale means less blur.
        spr.setDisplaySize(tiles * TILE * 1.4, tiles * TILE * 1.4);
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
      spr.setDisplaySize(112, 112);
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

  // Single-row footer. Seven buttons evenly distributed across the
  // full game width. Button widths scale with the viewport so a
  // 1920-wide monitor doesn't leave the middle half empty. The layer
  // state rides on the Flip button's label ("Flip → Underground")
  // instead of a separate text widget, which buys back the row.
  private static readonly FOOTER_ROW_Y = HUD_H + BOARD_H + 40;
  private static readonly FOOTER_BTN_H = 44;
  private static readonly FOOTER_MARGIN_X = 20;
  private static readonly FOOTER_GAP = 10;

  private drawFooter(): void {
    const flipLabel = (): string =>
      this.layer === 0 ? 'Flip → Underground' : 'Flip → Surface';

    const buttons: Array<{
      label: () => string;
      variant: 'primary' | 'secondary';
      onPress: () => void;
    }> = [
      {
        label: flipLabel,
        variant: 'secondary',
        onPress: () => {
          this.layer = this.layer === 0 ? 1 : 0;
          // The flip button is always the first container we created.
          const btn = this.footerButtons[0];
          btn?.setLabel(flipLabel());
          this.boardContainer.removeAll(true);
          this.drawBoard();
          this.drawBuildings();
        },
      },
      {
        label: () => '🏆 Ranks',
        variant: 'secondary',
        onPress: () => fadeToScene(this, 'LeaderboardScene'),
      },
      {
        label: () => '📜 Recent',
        variant: 'secondary',
        onPress: () => fadeToScene(this, 'RaidHistoryScene'),
      },
      {
        label: () => '⚙ Upgrades',
        variant: 'secondary',
        onPress: () => fadeToScene(this, 'UpgradeScene'),
      },
      {
        label: () => '👥 Clan',
        variant: 'secondary',
        onPress: () => fadeToScene(this, 'ClanScene'),
      },
      {
        label: () => '⚔ Arena',
        variant: 'secondary',
        onPress: () => fadeToScene(this, 'ArenaScene'),
      },
      {
        label: () => 'Raid a base →',
        variant: 'primary',
        onPress: () => fadeToScene(this, 'RaidScene'),
      },
    ];

    this.footerButtons = buttons.map((b) =>
      this.makeButton(0, 0, b.label(), b.variant, b.onPress),
    );
    this.layoutFooter();
    // layerLabel is legacy — keep the field populated with a noop
    // text so other code paths that touch .setText don't null-deref.
    if (!this.layerLabel) {
      this.layerLabel = crispText(this, -9999, -9999, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '1px',
      });
    }
  }

  // Footer button records so the flip-button label can be refreshed
  // without looking it up by index. Each entry carries a setLabel
  // helper that updates the Text child of the container.
  private footerButtons: HiveButton[] = [];

  private layoutFooter(): void {
    const count = this.footerButtons.length;
    if (count === 0) return;
    const marginX = HomeScene.FOOTER_MARGIN_X;
    const gap = HomeScene.FOOTER_GAP;
    const btnH = HomeScene.FOOTER_BTN_H;

    // Responsive footer. On wide (≥ 900 px) we keep all 7 buttons in
    // one row; on narrow viewports we wrap to 2 rows (4 + 3) so
    // buttons stay big enough to tap on a phone without shrinking
    // to unreadable text. Touch-target min ≈ 44 px stays intact.
    const wide = this.scale.width >= 900;
    const rowY1 = this.scale.height - (wide ? btnH / 2 + 20 : btnH * 2 + 28);
    const rowY2 = this.scale.height - (btnH / 2 + 16);

    if (wide) {
      const available = this.scale.width - marginX * 2 - gap * (count - 1);
      const btnW = Math.min(220, Math.max(110, available / count));
      const totalW = btnW * count + gap * (count - 1);
      const startX = (this.scale.width - totalW) / 2;
      for (let i = 0; i < count; i++) {
        const b = this.footerButtons[i]!;
        b.setSize(btnW, btnH);
        b.setPosition(startX + i * (btnW + gap), rowY1 + btnH / 2);
      }
    } else {
      // Narrow: first 4 buttons on top row, remaining 3 on bottom.
      // 4+3 split keeps the primary "Raid a base →" at the end of
      // row 2 where it's naturally the biggest tap target.
      const row1 = this.footerButtons.slice(0, 4);
      const row2 = this.footerButtons.slice(4);
      const layoutRow = (
        arr: HiveButton[],
        y: number,
        target: number,
      ): void => {
        if (arr.length === 0) return;
        const available = this.scale.width - marginX * 2 - gap * (arr.length - 1);
        const btnW = Math.min(target, available / arr.length);
        const totalW = btnW * arr.length + gap * (arr.length - 1);
        const startX = (this.scale.width - totalW) / 2;
        for (let i = 0; i < arr.length; i++) {
          arr[i]!.setSize(btnW, btnH);
          arr[i]!.setPosition(startX + i * (btnW + gap), y);
        }
      };
      layoutRow(row1, rowY1 + btnH / 2, 170);
      layoutRow(row2, rowY2, 200);
    }
  }

  // Thin adapter over the shared makeHiveButton so footer code stays
  // readable. The shared factory lives in ui/button.ts and is used by
  // RaidScene and ArenaScene too — one visual language everywhere.
  private makeButton(
    x: number,
    y: number,
    label: string,
    variant: 'primary' | 'secondary',
    onPress: () => void,
  ): HiveButton {
    return makeHiveButton(this, {
      x,
      y,
      width: 180,
      height: HomeScene.FOOTER_BTN_H,
      label,
      variant,
      onPress,
    });
  }

  // Vertical budget the footer needs (one or two rows of buttons
   // plus padding). Kept in sync with layoutFooter so handleResize
   // can reserve the space when deciding how big the board can be.
  private footerReservedHeight(): number {
    const narrow = this.scale.width < 900;
    const rowH = HomeScene.FOOTER_BTN_H + 16;
    const rows = narrow ? 2 : 1;
    return rows * rowH + 20;
  }

  private handleResize(): void {
    // Board sizing for mobile. On a 375px phone the 768 px board is
    // twice the viewport — we scale the whole container down so it
    // fits, and leave TILE alone so the sim math is unchanged. Pointer
    // handlers divide by container.scaleX when converting px → tile.
    const availW = this.scale.width - 24;
    const availH = this.scale.height - HUD_H - this.footerReservedHeight() - 16;
    const scale = Math.min(availW / BOARD_W, availH / BOARD_H, 1);
    this.boardContainer.setScale(scale);
    const scaledW = BOARD_W * scale;
    const xOffset = Math.max(8, (this.scale.width - scaledW) / 2);
    const yOffset = HUD_H + Math.max(4, (availH - BOARD_H * scale) / 2);
    this.boardContainer.setPosition(xOffset, yOffset);
    this.boardScale = scale;
  }

  private boardScale = 1;

  // --- Build mode: tap empty tile → picker modal → place --------------------

  // Tap/drag threshold in screen pixels. A pointer that moves further
  // than this between down and up is interpreted as a drag (pan / path
  // draw / accidental scroll) and should NOT open the picker.
  private static readonly TAP_THRESHOLD_PX = 12;
  private tapDownPos: { x: number; y: number } | null = null;

  // True iff the pointerdown that started the current gesture
  // happened while the picker was open. Cleared on the matching
  // pointerup. This latches the "don't open a new picker" decision
  // at down-time so that even if the picker closes between down and
  // up (e.g. user taps the × button, which calls closePicker in its
  // pointerdown handler), the scene-level pointerup won't reopen it.
  //
  // The older guard checked `this.pickerContainer` at pointerup time,
  // which races with the close handler and reopens the picker when
  // the ordering of scene-level vs game-object-level emissions
  // differs across devices/Phaser versions.
  private tapStartedInsidePicker = false;
  // Backstop for the edge case where the pointerdown event is
  // swallowed entirely by a touch jitter / multi-touch glitch and we
  // only see the pointerup. Any pointerup within this window after a
  // picker closes is treated as the tail of the close gesture.
  private pickerClosedAtMs = 0;
  private static readonly PICKER_REOPEN_GRACE_MS = 250;

  private wireBoardTap(): void {
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (this.pickerContainer) {
        this.tapStartedInsidePicker = true;
        this.tapDownPos = null;
        return;
      }
      this.tapStartedInsidePicker = false;
      this.tapDownPos = { x: p.x, y: p.y };
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      // Consume the latched flag exactly once per gesture.
      if (this.tapStartedInsidePicker) {
        this.tapStartedInsidePicker = false;
        return;
      }
      if (this.pickerContainer) return;
      // Grace window after close. Defense-in-depth against any
      // pointerdown we didn't see.
      if (
        Date.now() - this.pickerClosedAtMs <
        HomeScene.PICKER_REOPEN_GRACE_MS
      ) {
        return;
      }
      const down = this.tapDownPos;
      this.tapDownPos = null;
      if (!down) return;
      const dx = p.x - down.x;
      const dy = p.y - down.y;
      if (dx * dx + dy * dy > HomeScene.TAP_THRESHOLD_PX * HomeScene.TAP_THRESHOLD_PX) {
        // Drag, not a tap — e.g. user panning the camera in the future.
        return;
      }
      // Use the container's world bounds + current scale to convert
      // screen pixels to board-local tile coordinates. The board
      // scales down on narrow viewports (see handleResize) so a naive
      // `px / TILE` would land you on the wrong tile on mobile.
      const bounds = this.boardContainer.getBounds();
      if (p.x < bounds.x || p.x > bounds.x + bounds.width) return;
      if (p.y < bounds.y || p.y > bounds.y + bounds.height) return;
      const scale = this.boardScale || 1;
      const localX = (p.x - bounds.x) / scale;
      const localY = (p.y - bounds.y) / scale;
      if (localX < 0 || localX >= BOARD_W || localY < 0 || localY >= BOARD_H) return;
      const tx = Math.floor(localX / TILE);
      const ty = Math.floor(localY / TILE);
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

  // Queen Chamber level determines the tier index into per-kind
  // quotas. Reads from the server-backed base snapshot so a freshly
  // upgraded Queen is reflected on the very next picker open.
  private currentQueenLevel(): number {
    const queen = this.serverBase?.buildings.find(
      (b) => b.kind === 'QueenChamber',
    );
    const lvl = queen?.level ?? 1;
    return Math.max(1, Math.min(5, Math.floor(lvl)));
  }

  // Aggregate count of each building kind in the current base. We
  // include destroyed buildings (hp=0) because they still occupy a
  // slot until the player manually clears them — matches the server's
  // countOfKind() so client gating + server validation don't disagree.
  private countBuildingsByKind(): Record<string, number> {
    const out: Record<string, number> = {};
    if (!this.serverBase) return out;
    for (const b of this.serverBase.buildings) {
      out[b.kind] = (out[b.kind] ?? 0) + 1;
    }
    return out;
  }

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
    // Full-screen interactive zone BEHIND the card that eats any tap
    // the slots don't catch and closes the picker. Two jobs at once:
    // (1) "click outside to dismiss" UX, (2) acts as an input blocker
    // so a tap on the dimmed backdrop can't fall through to the
    // scene-level handlers and open another picker.
    const backdrop = this.add
      .zone(0, 0, this.scale.width, this.scale.height)
      .setOrigin(0, 0)
      .setDepth(200.5)
      .setInteractive({ useHandCursor: false });
    backdrop.on('pointerdown', () => this.closePicker());

    const card = this.add.graphics().setDepth(201);
    card.fillStyle(0x1a2b1a, 0.98);
    card.lineStyle(3, 0xffd98a, 1);
    card.fillRoundedRect(ox, oy, W, H, 14);
    card.strokeRoundedRect(ox, oy, W, H, 14);
    // Also make the card itself swallow pointer events so taps on the
    // card's padding (outside slots) don't bubble to `backdrop` and
    // accidentally close the picker.
    const cardZone = this.add
      .zone(ox, oy, W, H)
      .setOrigin(0, 0)
      .setDepth(201.5)
      .setInteractive();

    const container = this.add.container(0, 0).setDepth(202);
    container.add([bg, backdrop, card, cardZone]);

    const title = crispText(
      this,
      this.scale.width / 2,
      oy + 18,
      `Place building at (${tx}, ${ty}, ${this.layer === 0 ? 'surface' : 'underground'})`,
      {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#ffd98a',
      },
    )
      .setOrigin(0.5, 0)
      .setDepth(203);
    container.add(title);

    // Close button
    const close = crispText(this, ox + W - 14, oy + 14, '×', {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '22px',
      color: '#c3e8b0',
    })
      .setOrigin(1, 0)
      .setDepth(203)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.closePicker());
    container.add(close);

    // Queen level + current counts drive the per-kind quota gate.
    // Computed once per picker open; picker is destroyed on commit so
    // the snapshot staying slightly stale between clicks is fine.
    const qLevel = this.currentQueenLevel();
    const counts = this.countBuildingsByKind();

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

      // Rules gates. If the server didn't send rules (old backend),
      // we fall back to "any layer, unlimited", which matches the old
      // behavior so the client still boots against a mismatched API.
      const kindRules = this.rules[kind];
      const layerOk =
        !kindRules || kindRules.allowedLayers.includes(this.layer);
      const cap = kindRules ? kindRules.quotaByTier[qLevel - 1] ?? 0 : 99;
      const current = counts[kind] ?? 0;
      const capOk = current < cap;
      // Three denial reasons, in priority order — the most actionable
      // one wins so the toast after a tap tells the player exactly
      // what to do next.
      const denyReason: string | null = !capOk
        ? `${kind} cap ${current}/${cap} — upgrade the Queen to unlock more`
        : !layerOk
          ? `${kind} belongs on the ${kindRules!.allowedLayers[0] === 0 ? 'surface' : 'underground'} layer — flip layers and try again`
          : !canAfford
            ? `Need ${cost.sugar} sugar & ${cost.leafBits} leaf — have ${this.resources.sugar}/${this.resources.leafBits}`
            : null;
      const placeable = denyReason === null;

      const slotBg = this.add.graphics().setDepth(203);
      slotBg.fillStyle(placeable ? 0x233d24 : 0x2a1e1e, 1);
      slotBg.lineStyle(2, placeable ? 0x5ba445 : 0xd94c4c, 1);
      slotBg.fillRoundedRect(cx - slotW / 2 + 4, cy - slotH / 2, slotW - 8, slotH - 8, 8);
      slotBg.strokeRoundedRect(cx - slotW / 2 + 4, cy - slotH / 2, slotW - 8, slotH - 8, 8);
      container.add(slotBg);

      const icon = this.add
        .image(cx, cy - 24, `building-${kind}`)
        .setDisplaySize(40, 40)
        .setDepth(204)
        .setAlpha(placeable ? 1 : 0.5);
      container.add(icon);

      const nameText = crispText(
        this,
        cx,
        cy + 4,
        kind.replace(/([A-Z])/g, ' $1').trim(),
        {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '11px',
          color: placeable ? '#e6f5d2' : '#c79090',
        },
      )
        .setOrigin(0.5)
        .setDepth(204);
      container.add(nameText);

      // Count/cap badge shows right next to the name so the player can
      // see the "2/3 turrets" state at a glance.
      const capText = crispText(this, cx, cy + 18, `${current}/${cap}`, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '10px',
        color: capOk ? '#c3e8b0' : '#d98080',
      })
        .setOrigin(0.5)
        .setDepth(204);
      container.add(capText);

      const costText = crispText(
        this,
        cx,
        cy + 34,
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
        .setInteractive({ useHandCursor: placeable });
      hit.on('pointerdown', () => {
        if (!placeable) {
          this.flashToast(denyReason!);
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
      // Stamp the grace window so a pointerup that arrives just after
      // this call can't open a new picker on the closing tap's tile.
      this.pickerClosedAtMs = Date.now();
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

  // Open the DOM-overlay register/login modal. On success we reload
  // /player/me so the HUD reflects whichever player the session now
  // points at — either the same one (guest→user claim) or a different
  // one (login restored a previous account). Cheapest way to get the
  // whole scene back in sync is to restart it.
  private openAccountMenu(): void {
    const rt = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!rt) return;
    openAccountModal({
      auth: rt.auth,
      mode: 'register',
      onSuccess: async () => {
        try {
          rt.player = await rt.api.getPlayerMe();
        } catch {
          // Keep old snapshot; the scene restart below will retry.
        }
        this.scene.restart();
      },
    });
  }

  private toast: Phaser.GameObjects.Text | null = null;
  private flashToast(msg: string): void {
    this.toast?.destroy();
    const t = crispText(this, this.scale.width / 2, this.scale.height - 40, msg, {
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
