import Phaser from 'phaser';
import { Types } from '@hive/shared';
import type { HiveRuntime } from '../main.js';
import { crispText } from '../ui/text.js';
import { openAccountModal } from '../ui/accountModal.js';
import { openTutorial, shouldShowTutorial } from '../ui/tutorialModal.js';
import { openBuildingInfoModal } from '../ui/buildingInfoModal.js';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { makeHiveButton, type HiveButton } from '../ui/button.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { isUiOverrideActive } from '../ui/uiOverrides.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import { BREAKPOINTS, COLOR, DEPTHS, bodyTextStyle, displayTextStyle, labelTextStyle, SPACING } from '../ui/theme.js';

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
    installSceneClickDebug(this);
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
    this.drawStickyHooks();
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
    const g = this.add.graphics().setDepth(DEPTHS.background);
    const top = 0x203224;
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
    const glow = this.add.graphics().setDepth(DEPTHS.ambient);
    glow.fillStyle(COLOR.brass, 0.05);
    glow.fillEllipse(
      this.scale.width / 2,
      HUD_H + BOARD_H / 2 - 24,
      BOARD_W * 1.08,
      BOARD_H * 1.08,
    );
    glow.fillStyle(COLOR.greenHi, 0.05);
    glow.fillEllipse(
      this.scale.width / 2,
      this.scale.height - 64,
      Math.min(this.scale.width * 1.1, 980),
      220,
    );

    for (let i = 0; i < 14; i++) {
      const mote = this.add
        .circle(
          40 + (i * (this.scale.width - 80)) / 13,
          HUD_H + 70 + ((i * 47) % Math.max(160, this.scale.height - 220)),
          i % 3 === 0 ? 3 : 2,
          i % 4 === 0 ? COLOR.brass : COLOR.greenHi,
          0.12,
        )
        .setDepth(DEPTHS.ambientParticles);
      this.tweens.add({
        targets: mote,
        y: mote.y - (16 + (i % 5) * 5),
        alpha: { from: 0.06 + (i % 3) * 0.03, to: 0.22 },
        duration: 1800 + i * 140,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
  }

  private drawHud(): void {
    // CoC-style HUD plane: deep gradient panel + thick brass accent
    // on the bottom edge + drop-shadow beneath. When the
    // `ui-hud-bg` override is active and the admin-generated image
    // is on disk, tile that image across the HUD strip instead. The
    // generated asset is designed to tile horizontally at 512x96
    // so the TileSprite reads as one continuous banner at any
    // viewport width.
    const w = this.scale.width;
    // Background-only swap: override replaces the gradient panel with a
    // tiled image; the shadow + pill layout below still run so resource
    // text fields are always initialized.
    //
    // Previous build painted brass accent lines along the HUD edges.
    // They bled above the account/codex chips and read as a stray
    // yellow glow, so they're gone — the HUD strip is dark-only now,
    // with just a soft drop shadow below it to keep the "raised
    // panel" feel.
    if (isUiOverrideActive(this, 'ui-hud-bg')) {
      this.add.tileSprite(0, 0, w, HUD_H, 'ui-hud-bg').setOrigin(0, 0);
    } else {
      const hud = this.add.graphics();
      hud.fillGradientStyle(
        COLOR.bgPanelHi,
        COLOR.bgPanelHi,
        COLOR.bgPanelLo,
        COLOR.bgPanelLo,
        1,
      );
      hud.fillRect(0, 0, w, HUD_H);
    }
    const hudShadow = this.add.graphics();
    hudShadow.fillStyle(0x000000, 0.45);
    hudShadow.fillRect(0, HUD_H, w, 3);
    hudShadow.fillStyle(0x000000, 0.2);
    hudShadow.fillRect(0, HUD_H + 3, w, 3);

    // Responsive HUD layout — three tiers:
    //   wide   (≥ 760 px): full layout. Title + chip + 3 resource pills.
    //   narrow (500..760): title shrinks. Chip becomes a small icon.
    //   phone  (< 500 px): title hidden. 2 pills (sugar + leaf). Chip
    //                       is a 36-px avatar bubble in the corner.
    // Previous HUD let the title + chip collide with the pills on
    // small viewports (e.g. iPhone 375 — "HIVE WAR" visibly clipped
    // INTO the first pill in the user's screenshot). These tiers keep
    // everything visible at any viewport.
    // On mobile layouts (portrait phone or short-height landscape)
    // the burger drawer owns nav and sits at the top-left where the
    // title would normally render. Forcing the HUD tier to 'phone'
    // in those cases keeps the title + chip hidden so the burger
    // doesn't overlap them. A landscape phone at 812×375 would
    // otherwise pick the 'wide' tier and draw the title underneath
    // the burger button.
    const tier: 'wide' | 'narrow' | 'phone' = this.isMobileLayout()
      ? 'phone'
      : w >= BREAKPOINTS.desktop
        ? 'wide'
        : w >= BREAKPOINTS.phone
          ? 'narrow'
          : 'phone';
    const cy = HUD_H / 2;

    // Title — hidden on phone so nothing collides with pills.
    if (tier !== 'phone') {
      crispText(
        this,
        tier === 'wide' ? 24 : 16,
        cy,
        'HIVE WARS',
        displayTextStyle(tier === 'wide' ? 20 : 16, '#ffe7b0', 4),
      ).setOrigin(0, 0.5);
    }

    // Account chip — in wide it's a full pill; on phone it's a
    // compact brass-bordered disc in the top-left corner.
    this.drawAccountChip(tier);

    // Resource readouts — gold sugar, green leaf, silver milk.
    // On phone we hide milk (aphid milk isn't produced yet anyway)
    // to buy back horizontal room for the first two.
    const pillFont = tier === 'phone' ? 15 : 17;
    const pillTextStroke = 3;
    this.sugarText = crispText(
      this,
      0,
      0,
      this.resources.sugar.toString(),
      displayTextStyle(pillFont, COLOR.textGold, pillTextStroke),
    ).setOrigin(1, 0.5);
    this.leafText = crispText(
      this,
      0,
      0,
      this.resources.leafBits.toString(),
      displayTextStyle(pillFont, '#c8f2a0', pillTextStroke),
    ).setOrigin(1, 0.5);
    this.milkText = crispText(
      this,
      0,
      0,
      this.resources.aphidMilk.toString(),
      displayTextStyle(pillFont, '#dfe8ff', pillTextStroke),
    ).setOrigin(1, 0.5);
    if (tier === 'phone') this.milkText.setVisible(false);

    const badges: Array<{ icon: string; text: Phaser.GameObjects.Text }> = [
      { icon: 'ui-resource-sugar', text: this.sugarText },
      { icon: 'ui-resource-leaf', text: this.leafText },
    ];
    if (tier !== 'phone')
      badges.push({ icon: 'ui-resource-milk', text: this.milkText });

    const PILL_H = tier === 'phone' ? 32 : 36;
    const PILL_PAD_X = tier === 'phone' ? 8 : 12;
    const PILL_ICON_GAP = 4;
    const PILL_GAP = tier === 'phone' ? SPACING.xs : SPACING.sm;
    const ICON_SIZE = tier === 'phone' ? 20 : 26;
    let x = this.scale.width - (tier === 'phone' ? SPACING.sm : SPACING.md);
    for (let i = badges.length - 1; i >= 0; i--) {
      const b = badges[i]!;
      const textW = Math.max(b.text.width, 24);
      const pillW = PILL_PAD_X * 2 + ICON_SIZE + PILL_ICON_GAP + textW;
      const pillX = x - pillW;
      const pillY = cy - PILL_H / 2;
      const pill = this.add.graphics();
      drawPill(pill, pillX, pillY, pillW, PILL_H, { brass: false });
      const icon = this.add
        .image(pillX + PILL_PAD_X + ICON_SIZE / 2, cy, b.icon)
        .setDisplaySize(ICON_SIZE, ICON_SIZE);
      b.text.setPosition(pillX + pillW - PILL_PAD_X, cy);
      // Numbers were created BEFORE the pill + icon in drawHud, so
      // they sat UNDER both in the child array and were covered on
      // HUD repaint — that read as "the pills have no numbers". Bump
      // the text's depth so it always draws over the pill chrome.
      b.text.setDepth(DEPTHS.hudChrome);
      void pill;
      void icon;
      x = pillX - PILL_GAP;
    }

    // Codex chip — a compact 📖 disc to the left of the resource
    // pills. Opens the character-card reference screen. Kept as a
    // separate dedicated entry point (not a footer button) because
    // the codex is lookup / lore, not in-loop gameplay, and the
    // footer is already saturated at 7 buttons.
    this.drawCodexChip(x, cy, tier);

    // Mobile burger. Replaces the full-width footer with a slide-in
    // drawer so phone viewports hand back the ~140 px the 2-row
    // footer was eating to the play field. Sits at the far right of
    // the HUD on wide viewports too — on mobile it moves to the far
    // left to avoid crowding the resource pills.
    if (this.isMobileLayout()) {
      this.drawBurgerButton();
    }
  }

  // Any viewport narrower than this collapses the 8-button footer
  // into a burger drawer and lets the board scroll in all directions
  // (pan-the-map). Desktop / tablet keeps the full footer + scale-
  // to-fit board so the whole base is visible at once.
  //
  // Short-viewport landscape phones (e.g. iPhone SE rotated: 812×375)
  // pass the width test but have too little height for a 2-row
  // footer + HUD + a usable board. LANDSCAPE_PHONE_MAX_HEIGHT folds
  // those back into the mobile layout so they also get the burger +
  // floating Raid CTA.
  private static readonly MOBILE_MAX_WIDTH = BREAKPOINTS.tablet;
  private static readonly LANDSCAPE_PHONE_MAX_HEIGHT = 480;

  private isMobileLayout(): boolean {
    if (this.scale.width < HomeScene.MOBILE_MAX_WIDTH) return true;
    // Landscape phones: short + wider-than-tall. The aspect guard
    // avoids triggering on genuinely short desktop windows that a
    // user might legitimately resize for dev tools.
    return (
      this.scale.height < HomeScene.LANDSCAPE_PHONE_MAX_HEIGHT &&
      this.scale.width > this.scale.height
    );
  }

  private burgerDrawer: Phaser.GameObjects.Container | null = null;
  private burgerButton: Phaser.GameObjects.Container | null = null;

  private drawBurgerButton(): void {
    // Compact 44×44 disc at the top-left corner. 44 px is above the
    // iOS HIG minimum tap target, comfortable for a thumb. Glyph is
    // three stacked rounded rects built off Graphics so it scales with
    // the canvas's physical resolution (no emoji rasterization issues
    // on older Androids).
    const size = 40;
    const cx = size / 2 + SPACING.sm;
    const cy = HUD_H / 2;
    const c = this.add.container(cx, cy).setDepth(6);
    const disc = this.add.graphics();
    drawPill(disc, -size / 2, -size / 2, size, size, { brass: true });
    const lines = this.add.graphics();
    lines.fillStyle(0xffe7b0, 1);
    const lineW = 18;
    const lineH = 2.5;
    const radius = 1.25;
    for (let i = -1; i <= 1; i++) {
      lines.fillRoundedRect(-lineW / 2, i * 6 - lineH / 2, lineW, lineH, radius);
    }
    c.add([disc, lines]);
    c.setSize(size, size);
    c.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(-size / 2, -size / 2, size, size),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      useHandCursor: true,
    });
    c.on('pointerdown', (p: Phaser.Input.Pointer, _lx: number, _ly: number, e: Phaser.Types.Input.EventData) => {
      // Stop the scene-level pointerdown from also seeing this tap —
      // otherwise the board-tap handler would treat it as the start
      // of a pan gesture, and the burger-drawer backdrop would close
      // on the same tap that opened it.
      e?.stopPropagation?.();
      this.openBurgerDrawer();
    });
    this.burgerButton = c;
  }

  // Width of the slide-in burger drawer. 82 % of viewport capped at
  // 320 px — wide enough for comfortable 48 px button rows on narrow
  // phones, clamped on tablets so the drawer never spans the full
  // screen. Shared by openBurgerDrawer (creates the panel at +W) and
  // closeBurgerDrawer (tweens it out to -W) so both stay in sync.
  private burgerDrawerWidth(): number {
    return Math.min(320, Math.round(this.scale.width * 0.82));
  }

  private openBurgerDrawer(): void {
    if (this.burgerDrawer) return;
    const W = this.burgerDrawerWidth();
    const H = this.scale.height;
    const container = this.add.container(0, 0).setDepth(DEPTHS.drawer);

    // Full-screen dim backdrop. Tapping outside the panel closes.
    const backdrop = this.add
      .zone(0, 0, this.scale.width, H)
      .setOrigin(0, 0)
      .setInteractive();
    const dim = this.add.graphics();
    dim.fillStyle(0x000000, 0.55);
    dim.fillRect(0, 0, this.scale.width, H);
    backdrop.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, e: Phaser.Types.Input.EventData) => {
      e?.stopPropagation?.();
      this.closeBurgerDrawer();
    });

    // Slide-in panel on the left.
    const panel = this.add.graphics();
    drawPanel(panel, 0, 0, W, H, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.12,
      radius: 0,
      shadowOffset: 0,
      shadowAlpha: 0,
    });
    panel.fillStyle(COLOR.brass, 0.9);
    panel.fillRect(W - 2, 0, 2, H);
    panel.fillStyle(0x000000, 0.35);
    panel.fillRect(W, 0, 4, H);
    const panelZone = this.add
      .zone(0, 0, W, H)
      .setOrigin(0, 0)
      .setInteractive();
    // Swallow taps on the panel so they don't bleed to the backdrop.
    panelZone.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, e: Phaser.Types.Input.EventData) => {
      e?.stopPropagation?.();
    });

    const title = crispText(this, 20, 18, 'HIVE WARS', displayTextStyle(18, COLOR.textGold, 3));
    const subtitle = crispText(
      this,
      20,
      42,
      'Choose your next move',
      labelTextStyle(11, COLOR.textDim),
    );
    const quickPill = this.add.graphics();
    drawPill(quickPill, 20, 58, 112, 22, { brass: true });
    const quickLabel = crispText(
      this,
      76,
      69,
      'Quick access',
      labelTextStyle(10, '#2a1d08'),
    ).setOrigin(0.5, 0.5);
    const tip = crispText(
      this,
      20,
      88,
      'Raid often to keep your colony growing.',
      bodyTextStyle(12, COLOR.textPrimary),
    );

    // Close ×
    const close = crispText(
      this,
      W - 22,
      18,
      'X',
      displayTextStyle(18, '#c3e8b0', 2),
    ).setOrigin(1, 0);
    close.setInteractive({ useHandCursor: true });
    close.on('pointerdown', (_p: Phaser.Input.Pointer, _x: number, _y: number, e: Phaser.Types.Input.EventData) => {
      e?.stopPropagation?.();
      this.closeBurgerDrawer();
    });

    container.add([
      dim,
      backdrop,
      panel,
      panelZone,
      title,
      subtitle,
      quickPill,
      quickLabel,
      tip,
      close,
    ]);

    // Action list. Same set as the desktop footer, plus a Fullscreen
    // toggle and the Codex shortcut so the drawer is a complete nav
    // menu. Each entry is a full-width secondary button — big tap
    // target, one action per line, comfortable for thumb reach.
    type Entry = { label: string; onPress: () => void; variant?: 'primary' | 'secondary' };
    const entries: Entry[] = [
      {
        label: this.layer === 0 ? '↓ Underground' : '↑ Surface',
        onPress: () => {
          this.closeBurgerDrawer();
          // Move mode's overlay lives on boardContainer; flipping the
          // layer destroys it. Exit cleanly first so the banner/sprite
          // alpha also get restored.
          this.exitMoveMode();
          this.layer = this.layer === 0 ? 1 : 0;
          this.boardContainer.removeAll(true);
          this.drawBoard();
          this.drawBuildings();
        },
      },
      { label: '⚔  Raid a base', onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'RaidScene'); } },
      { label: '📖  Campaign', onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'CampaignScene'); } },
      { label: '🏰  Clan wars', onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'ClanWarsScene'); } },
      { label: '🎬  Top raids', onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'ReplayFeedScene'); } },
      { label: '👑  Queen',    onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'QueenSkinScene'); } },
      { label: '⏳  Builders', onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'BuilderQueueScene'); } },
      { label: '🗓  Quests', onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'QuestsScene'); } },
      { label: '🧠  Defender AI', onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'DefenderAIScene'); } },
      { label: '🏆  Ranks', onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'LeaderboardScene'); } },
      { label: '📜  Recent', onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'RaidHistoryScene'); } },
      { label: '⚙  Upgrades', onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'UpgradeScene'); } },
      { label: '👥  Clan', onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'ClanScene'); } },
      { label: '🏟  Arena', onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'ArenaScene'); } },
      { label: '📖  Codex', onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'CodexScene'); } },
      { label: '❓  Help', onPress: () => { this.closeBurgerDrawer(); openTutorial({ force: true }); } },
      {
        label: this.scale.isFullscreen ? '⤡  Exit fullscreen' : '⤢  Fullscreen',
        onPress: () => {
          this.closeBurgerDrawer();
          // iOS Safari refuses this — silent no-op there.
          if (this.scale.isFullscreen) this.scale.stopFullscreen();
          else this.scale.startFullscreen();
        },
      },
    ];
    if (entries[1]) entries[1].variant = 'primary';
    const btnH = 48;
    const btnW = W - 32;
    const startY = 110;
    const gap = 8;
    entries.forEach((e, i) => {
      const y = startY + i * (btnH + gap) + btnH / 2;
      const btn = makeHiveButton(this, {
        x: W / 2,
        y,
        width: btnW,
        height: btnH,
        label: e.label,
        variant: e.variant ?? 'secondary',
        fontSize: 15,
        onPress: e.onPress,
      });
      container.add(btn.container);
    });

    // Slide-in tween. Start off-screen to the left, ease in.
    container.setPosition(-W, 0);
    this.tweens.add({
      targets: container,
      x: 0,
      duration: 200,
      ease: 'Cubic.easeOut',
    });
    // Dim fades in with the slide so the two feel linked.
    dim.alpha = 0;
    this.tweens.add({ targets: dim, alpha: 1, duration: 180 });

    this.burgerDrawer = container;
  }

  private closeBurgerDrawer(): void {
    const c = this.burgerDrawer;
    if (!c) return;
    this.burgerDrawer = null;
    this.tweens.add({
      targets: c,
      x: -this.burgerDrawerWidth(),
      alpha: 0,
      duration: 160,
      ease: 'Cubic.easeIn',
      onComplete: () => c.destroy(true),
    });
    // Stamp the picker grace window too so a pointerup inside the
    // burger's footprint doesn't immediately trigger a new board
    // tap / picker open. Use the scene clock (not Date.now) so a
    // background tab doesn't build up a stale grace debt the player
    // pays when they return.
    this.pickerClosedAtMs = this.time.now;
  }

  private drawCodexChip(
    rightEdgeX: number,
    cy: number,
    tier: 'wide' | 'narrow' | 'phone',
  ): void {
    const pillW = tier === 'phone' ? 34 : tier === 'narrow' ? 70 : 78;
    const pillH = tier === 'phone' ? 34 : 36;
    const left = rightEdgeX - pillW;
    const pill = this.add.graphics();
    drawPill(pill, left, cy - pillH / 2, pillW, pillH, {
      brass: tier !== 'phone',
    });
    const glyph = crispText(
      this,
      left + pillW / 2,
      cy,
      tier === 'phone' ? 'C' : 'CODEX',
      tier === 'phone'
        ? displayTextStyle(14, COLOR.textPrimary, 2)
        : labelTextStyle(11, '#2a1d08'),
    ).setOrigin(0.5, 0.5);
    this.add
      .zone(left + pillW / 2, cy, pillW, pillH)
      .setOrigin(0.5, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => fadeToScene(this, 'CodexScene'));
    void pill;
    void glyph;
  }

  // Tier-aware account chip. On wide viewports it's a named pill
  // ("@myname ▾"). On narrow it shrinks to an icon-only pill so it
  // doesn't crowd the title. On phone it becomes a compact corner
  // disc with a down-chevron — tap target is still ≥ 36 px.
  private drawAccountChip(tier: 'wide' | 'narrow' | 'phone'): void {
    const cy = HUD_H / 2;
    if (tier === 'wide') {
      const chipX = 168;
      const pillW = 136;
      const pillH = 38;
      const pill = this.add.graphics();
      drawPill(pill, chipX, cy - pillH / 2, pillW, pillH, { brass: false });
      const badge = this.add.graphics();
      drawPill(badge, chipX + 8, cy - 15, 52, 14, { brass: true });
      crispText(
        this,
        chipX + 34,
        cy - 8,
        'COLONY',
        labelTextStyle(9, '#2a1d08'),
      ).setOrigin(0.5, 0.5);
      this.accountChip = crispText(
        this,
        chipX + pillW / 2,
        cy + 8,
        'GUEST',
        displayTextStyle(13, COLOR.textDim, 2),
      ).setOrigin(0.5, 0.5);
      this.add
        .zone(chipX + pillW / 2, cy, pillW, pillH)
        .setOrigin(0.5, 0.5)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this.openAccountMenu());
      void badge;
    } else {
      // Icon-only disc. On narrow, it slots in where the title sat;
      // on phone it pins to the top-left, shifted right past the
      // burger button (which owns the very first slot when the
      // mobile layout is active).
      const size = tier === 'phone' ? 36 : 40;
      const burgerSlot = this.isMobileLayout() ? 40 + SPACING.sm : 0;
      const chipX =
        tier === 'narrow' ? 120 : burgerSlot + size / 2 + SPACING.sm;
      const pill = this.add.graphics();
      drawPill(pill, chipX - size / 2, cy - size / 2, size, size, {
        brass: false,
      });
      this.accountChip = crispText(
        this,
        chipX,
        cy,
        '@',
        displayTextStyle(tier === 'phone' ? 15 : 16, COLOR.textDim, 2),
      ).setOrigin(0.5, 0.5);
      this.add
        .zone(chipX, cy, size, size)
        .setOrigin(0.5, 0.5)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this.openAccountMenu());
    }
    const rt = this.registry.get('runtime') as HiveRuntime | undefined;
    if (rt) {
      void rt.auth.fetchMe().then((me) => {
        if (!me || !this.accountChip?.active) return;
        if (tier === 'wide') {
          this.accountChip.setText(
            me.isGuest || !me.username ? 'GUEST' : `@${me.username}`,
          );
        }
        this.accountChip.setColor(me.isGuest ? COLOR.textDim : COLOR.textGold);
      });
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

    // Solid base layer painted UNDER everything else so the playable
    // area always reads as one continuous green surface, even when
    // the generated board-tile art has semi-transparent edges or
    // dark seams where repeats meet. Without this pad, the user
    // sees the board as a 3×2 grid of chunks separated by dark
    // lanes (the scene's ambient showing through tile gaps), not
    // as a single field.
    const basePad = this.add.graphics();
    basePad.fillStyle(palette.baseA, 1);
    basePad.fillRect(0, 0, BOARD_W, BOARD_H);
    this.boardContainer.add(basePad);

    const bg = this.add.graphics();
    // If the admin has turned on the `ui-board-tile-surface` override
    // AND the image is on disk, tile it across the board instead of
    // the gradient-bands path. The image is designed at 128×128
    // tileable, which lines up exactly with the 64-px grid tiles so
    // the seam lands between cells. TileSprite handles the repeat
    // natively and scales linearly — far cheaper than 90 hand-
    // painted decoration circles.
    const boardTileKey = 'ui-board-tile-surface';
    const useTile = isUiOverrideActive(this, boardTileKey);
    if (useTile) {
      const tileSprite = this.add
        .tileSprite(0, 0, BOARD_W, BOARD_H, boardTileKey)
        .setOrigin(0, 0);
      // Add directly — bg (still empty Graphics) stays as a handle so
      // the rest of this function can keep drawing on it (vignette,
      // etc.) without re-ordering. The basePad painted above sits
      // under the tile sprite and fills any transparent pixels in
      // the tile art.
      this.boardContainer.add(tileSprite);
    } else {
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
    // Skipped when the tile override is on — the tile art carries
    // its own painted texture and stacking the scatter on top would
    // just look dirty.
    const deco = this.add.graphics();
    if (!useTile) {
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

    const badge = this.add.graphics();
    drawPill(badge, 18, 16, 184, 28, { brass: true });
    const modeTitle =
      this.layer === 0 ? 'Surface Colony' : 'Underground Warren';
    const modeSubtitle =
      this.layer === 0 ? 'Build, collect, and scout your defenses' : 'Tunnels, stores, and inner chambers';
    const badgeTitle = crispText(
      this,
      30,
      30,
      modeTitle,
      displayTextStyle(13, COLOR.textGold, 3),
    ).setOrigin(0, 0.5);
    const badgeSub = crispText(
      this,
      30,
      48,
      modeSubtitle,
      bodyTextStyle(10, COLOR.textDim),
    ).setOrigin(0, 0.5);

    this.boardContainer.add([bg, deco, grid, frame, badge, badgeTitle, badgeSub]);
  }

  // Index of server-base building sprites keyed by the building's
  // stable `id`. Lets us surgically update / remove a single sprite on
  // an upgrade or demolish without a full board repaint (which causes
  // flicker + churns every sprite's tween timer).
  private homeBuildingSprites: Map<string, Phaser.GameObjects.Image> = new Map();

  private drawBuildings(): void {
    // Prefer the server's base snapshot. Fall back to the hardcoded
    // starter layout when running guest-local (DB unavailable).
    if (this.serverBase) {
      this.homeBuildingSprites.clear();
      for (const b of this.serverBase.buildings) {
        const spr = this.createBuildingSprite(b);
        if (spr) this.homeBuildingSprites.set(b.id, spr);
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

  // Create, size, tween, and wire one building sprite. Returns the
  // sprite (or null if the building isn't visible on the current
  // layer). Used both in bulk by drawBuildings and one-off by
  // upsertBuildingSprite when a single building changes.
  private createBuildingSprite(b: Types.Building): Phaser.GameObjects.Image | null {
    const spans = b.spans ?? null;
    const spansBoth = spans && spans.length > 1;
    const onThisLayer =
      (spansBoth && spans?.includes(this.layer)) ||
      b.anchor.layer === this.layer;
    if (!onThisLayer) return null;
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
    spr.setInteractive({ useHandCursor: true });
    spr.on('pointerup', (p: Phaser.Input.Pointer) => {
      const dragDist = Phaser.Math.Distance.Between(
        p.downX, p.downY, p.upX, p.upY,
      );
      if (dragDist > HomeScene.TAP_THRESHOLD_PX) return;
      this.openBuildingInfo(b);
    });
    this.boardContainer.add(spr);
    return spr;
  }

  // Replace the sprite for a single building. Used after a successful
  // upgrade so the level-visualized sprite refreshes without a full
  // board repaint. The old sprite is destroyed (kills its tween too);
  // a new one is created in its place and re-indexed.
  private upsertBuildingSprite(b: Types.Building): void {
    const existing = this.homeBuildingSprites.get(b.id);
    existing?.destroy();
    this.homeBuildingSprites.delete(b.id);
    const spr = this.createBuildingSprite(b);
    if (spr) this.homeBuildingSprites.set(b.id, spr);
  }

  // Tap handler: open the building info / upgrade modal. On a
  // successful upgrade or demolish we update only the affected sprite
  // (not the whole board), which keeps the scene snappy as bases
  // grow and avoids resetting the idle tweens on every other building.
  private openBuildingInfo(b: Types.Building): void {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    openBuildingInfoModal({
      scene: this,
      runtime,
      building: b,
      onUpdated: (base) => {
        this.serverBase = base;
        const updated = base.buildings.find((x) => x.id === b.id);
        if (updated) this.upsertBuildingSprite(updated);
        this.refreshResourcesHud();
      },
      onDemolish: (base) => {
        this.serverBase = base;
        const spr = this.homeBuildingSprites.get(b.id);
        spr?.destroy();
        this.homeBuildingSprites.delete(b.id);
      },
      onMoveRequest: (building) => this.enterMoveMode(building),
    });
  }

  // --- Move mode -----------------------------------------------------------
  //
  // "Move mode" is entered when the player taps Move on the building
  // info modal. We freeze the building's existing sprite to half alpha,
  // paint a translucent grid over every tile with validity coloring
  // (green = would place here, red = blocked by another building, out
  // of bounds, or wrong layer), and pin a banner + Cancel button above
  // the board. The next qualifying tap on a valid tile commits the
  // move via /building/:id/move; the Cancel button or pressing Escape
  // restores the original state without committing.
  private moveMode: {
    building: Types.Building;
    overlay: Phaser.GameObjects.Container;
    banner: Phaser.GameObjects.Container;
    origSpriteAlpha: number;
    keyListener: (e: KeyboardEvent) => void;
  } | null = null;

  private enterMoveMode(b: Types.Building): void {
    if (this.moveMode) this.exitMoveMode();
    if (!this.serverBase) return;

    // Dim the source sprite so the player sees it's "picked up".
    const spr = this.homeBuildingSprites.get(b.id);
    const origAlpha = spr?.alpha ?? 1;
    if (spr) spr.setAlpha(0.35);

    // Tile validity overlay. Lives inside boardContainer so it scales
    // and pans with the board. A single Graphics is cheaper than one
    // rect per tile and repaints in one pass.
    const overlayContainer = this.add.container(0, 0);
    const overlayGraphics = this.add.graphics();
    overlayContainer.add(overlayGraphics);
    this.boardContainer.add(overlayContainer);
    overlayContainer.setDepth(DEPTHS.boardOverlay);

    const { w: fw, h: fh } = b.footprint;
    // For multi-layer buildings (QueenChamber), the user can only
    // reposition within the layers it already spans. For single-layer
    // buildings, we paint validity on the CURRENT viewed layer only
    // so the player has a clear "where can I put this" answer per
    // layer. Flipping layers terminates move mode (see the Flip
    // handler) because the overlay lives on boardContainer and is
    // destroyed by the flip's full-board redraw.
    const paintOverlay = (): void => {
      overlayGraphics.clear();
      if (!this.serverBase) return;
      for (let y = 0; y <= GRID_H - fh; y++) {
        for (let x = 0; x <= GRID_W - fw; x++) {
          const valid = this.isMoveTargetValid(b, x, y, this.layer);
          const color = valid ? 0x5ba445 : 0xd94c4c;
          overlayGraphics.fillStyle(color, 0.22);
          overlayGraphics.fillRect(x * TILE, y * TILE, fw * TILE, fh * TILE);
          overlayGraphics.lineStyle(1, color, 0.45);
          overlayGraphics.strokeRect(x * TILE, y * TILE, fw * TILE, fh * TILE);
        }
      }
    };
    paintOverlay();

    // Banner + Cancel button at the top of the viewport.
    const bannerW = Math.min(520, this.scale.width - 32);
    const bannerH = 56;
    const bannerX = (this.scale.width - bannerW) / 2;
    const bannerY = HUD_H + 8;
    const banner = this.add.container(0, 0).setDepth(DEPTHS.drawer);
    const bg = this.add.graphics();
    drawPanel(bg, bannerX, bannerY, bannerW, bannerH, {
      topColor: 0x2a3f2d,
      botColor: COLOR.bgPanelLo,
      stroke: COLOR.brassDeep,
      strokeWidth: 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.16,
      radius: 10,
      shadowOffset: 3,
      shadowAlpha: 0.28,
    });
    banner.add(bg);
    banner.add(
      crispText(this, bannerX + 16, bannerY + 10, 'MOVE BUILDING',
        labelTextStyle(10, COLOR.textGold),
      ),
    );
    banner.add(
      crispText(this, bannerX + 16, bannerY + 28,
        'Tap a green tile to move. Red tiles are blocked.',
        bodyTextStyle(12, COLOR.textPrimary),
      ),
    );
    const cancelBtn = makeHiveButton(this, {
      x: bannerX + bannerW - 70,
      y: bannerY + bannerH / 2,
      width: 120,
      height: 36,
      label: 'Cancel',
      variant: 'ghost',
      fontSize: 12,
      onPress: () => this.exitMoveMode(),
    });
    cancelBtn.container.setDepth(DEPTHS.drawer);
    banner.add(cancelBtn.container);

    // Keyboard cancel. Escape is the universal "get me out of this
    // mode" chord on desktop + external-keyboard mobile, and the
    // player has no other way to cancel without touching a specific
    // Cancel button. Stored on the mode record so exitMoveMode can
    // unwire it cleanly whether cancellation is from the button,
    // Escape, or a layer flip.
    const keyListener = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') this.exitMoveMode();
    };
    window.addEventListener('keydown', keyListener);

    this.moveMode = {
      building: b,
      overlay: overlayContainer,
      banner,
      origSpriteAlpha: origAlpha,
      keyListener,
    };
  }

  private exitMoveMode(): void {
    if (!this.moveMode) return;
    const { building, overlay, banner, origSpriteAlpha, keyListener } = this.moveMode;
    overlay.destroy(true);
    banner.destroy(true);
    const spr = this.homeBuildingSprites.get(building.id);
    if (spr) spr.setAlpha(origSpriteAlpha);
    window.removeEventListener('keydown', keyListener);
    this.moveMode = null;
  }

  // Purely geometric — same rules the server enforces, lifted client-
  // side so the overlay colors match what the move endpoint will
  // actually accept. Keep in sync with player.ts move handler.
  private isMoveTargetValid(
    b: Types.Building,
    nx: number,
    ny: number,
    layer: Types.Layer,
  ): boolean {
    if (!this.serverBase) return false;
    // Multi-layer (Queen) buildings stay on their anchor layer.
    if (b.spans && b.spans.length > 1 && !b.spans.includes(layer)) {
      return false;
    }
    if (nx < 0 || ny < 0) return false;
    if (nx + b.footprint.w > this.serverBase.gridSize.w) return false;
    if (ny + b.footprint.h > this.serverBase.gridSize.h) return false;
    // Collision with OTHER buildings. Allow overlap with self.
    for (const other of this.serverBase.buildings) {
      if (other.id === b.id) continue;
      const otherLayers = new Set<Types.Layer>(
        other.spans ?? [other.anchor.layer],
      );
      const myLayers = new Set<Types.Layer>(
        b.spans && b.spans.length > 1 ? b.spans : [layer],
      );
      let intersect = false;
      for (const l of myLayers) {
        if (otherLayers.has(l)) {
          intersect = true;
          break;
        }
      }
      if (!intersect) continue;
      const ex = other.anchor.x;
      const ey = other.anchor.y;
      const ew = other.footprint.w;
      const eh = other.footprint.h;
      const overlaps =
        nx < ex + ew &&
        nx + b.footprint.w > ex &&
        ny < ey + eh &&
        ny + b.footprint.h > ey;
      if (overlaps) return false;
    }
    return true;
  }

  private async commitMove(tx: number, ty: number): Promise<void> {
    const mode = this.moveMode;
    if (!mode) return;
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    const b = mode.building;
    if (!this.isMoveTargetValid(b, tx, ty, this.layer)) {
      this.flashToast('That tile is blocked.');
      return;
    }
    try {
      const r = await runtime.api.moveBuilding({
        buildingId: b.id,
        anchor: {
          x: tx,
          y: ty,
          // Multi-layer buildings keep their own anchor layer; single-
          // layer ones follow the currently-viewed layer. The server
          // re-asserts this invariant so a tampered client can't
          // change a Queen Chamber's layer.
          layer: b.spans && b.spans.length > 1 ? b.anchor.layer : this.layer,
        },
      });
      this.serverBase = r.base;
      if (runtime.player) runtime.player.base = r.base;
      this.exitMoveMode();
      this.upsertBuildingSprite(r.building);
    } catch (err) {
      this.flashToast((err as Error).message);
    }
  }

  // `flashToast` is defined further down with the building picker
  // code — reused here for move-mode error feedback.

  private refreshResourcesHud(): void {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime?.player) return;
    this.resources.sugar = runtime.player.player.sugar;
    this.resources.leafBits = runtime.player.player.leafBits;
    this.resources.aphidMilk = runtime.player.player.aphidMilk;
    this.sugarText.setText(String(this.resources.sugar));
    this.leafText.setText(String(this.resources.leafBits));
    this.milkText.setText(String(this.resources.aphidMilk));
  }

  // Single-row footer. Seven buttons evenly distributed across the
  // full game width. Button widths scale with the viewport so a
  // 1920-wide monitor doesn't leave the middle half empty. The layer
  // state rides on the Flip button's label ("Flip → Underground")
  // instead of a separate text widget, which buys back the row.
  private static readonly FOOTER_ROW_Y = HUD_H + BOARD_H + 40;
  // 56px leaves ~24px of clear green band between the 16px brass
  // caps the NineSlice reserves on the top/bottom, which is enough
  // for a 15px label + emoji icon to sit centered inside the pill
  // without visually clipping its top/bottom. 44px (the previous
  // value) only left a 12px band — the emoji and the text both
  // overflowed the "green" area, which is what the user saw as the
  // icon sitting above/below the pill.
  private static readonly FOOTER_BTN_H = 56;
  private static readonly FOOTER_MARGIN_X = 20;
  private static readonly FOOTER_GAP = 10;

  // Overlay hooks from the stickiness retention system: streak, nemesis
  // ribbon, comeback banner, and a Queen-portrait chip. Everything is
  // optional — surfaces only when the relevant state is present.
  private drawStickyHooks(): void {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    const ps = runtime?.player?.player;
    if (!ps) return;
    let topY = HUD_H + 8;

    // Comeback banner — the strongest signal (away 3+ days). Pushed
    // above everything else.
    if (ps.streak?.comebackPending) {
      topY = this.drawComebackBanner(topY, runtime);
    }

    // Streak banner — shows current streak day + claim button if
    // today's reward isn't claimed yet.
    if (ps.streak && ps.streak.count > 0 && ps.streak.lastClaim < ps.streak.count) {
      topY = this.drawStreakBanner(topY, runtime);
    }

    // Nemesis ribbon — unavenged loss to an identified opponent.
    // Auto-fetches the full nemesis payload (online-status / name).
    if (ps.nemesis && !ps.nemesis.avenged) {
      topY = this.drawNemesisRibbon(topY, runtime);
    }
    void topY;
  }

  private drawComebackBanner(topY: number, runtime: HiveRuntime): number {
    const maxW = Math.min(520, this.scale.width - 24);
    const x = (this.scale.width - maxW) / 2;
    const h = 62;
    const bg = this.add.graphics().setDepth(DEPTHS.boardOverlay);
    drawPanel(bg, x, topY, maxW, h, {
      topColor: 0x5c4020, botColor: 0x2a1d08,
      stroke: COLOR.brass, strokeWidth: 2,
      highlight: COLOR.brass, highlightAlpha: 0.25,
      radius: 12, shadowOffset: 4, shadowAlpha: 0.36,
    });
    crispText(this, x + 14, topY + 10, 'Welcome back',
      labelTextStyle(10, '#2a1d08'),
    ).setDepth(DEPTHS.boardOverlay);
    crispText(this, x + 14, topY + 28,
      'Your colony missed you. Claim a returning-player pack.',
      bodyTextStyle(12, COLOR.textPrimary),
    ).setDepth(DEPTHS.boardOverlay);
    const btn = makeHiveButton(this, {
      x: x + maxW - 70,
      y: topY + h / 2,
      width: 120,
      height: 36,
      label: 'Claim',
      variant: 'primary',
      fontSize: 12,
      onPress: () => { void this.claimComeback(runtime); },
    });
    btn.container.setDepth(DEPTHS.boardOverlay);
    void bg;
    return topY + h + 10;
  }

  private async claimComeback(runtime: HiveRuntime): Promise<void> {
    try {
      const r = await runtime.api.claimComeback();
      this.resources.sugar = r.resources.sugar;
      this.resources.leafBits = r.resources.leafBits;
      this.resources.aphidMilk = r.resources.aphidMilk;
      this.sugarText.setText(String(this.resources.sugar));
      this.leafText.setText(String(this.resources.leafBits));
      this.milkText.setText(String(this.resources.aphidMilk));
      if (runtime.player) {
        if (runtime.player.player.streak) runtime.player.player.streak.comebackPending = false;
      }
      this.scene.restart();
    } catch (err) {
      console.warn('comeback claim failed', err);
    }
  }

  private drawStreakBanner(topY: number, runtime: HiveRuntime): number {
    const ps = runtime.player?.player;
    if (!ps?.streak) return topY;
    const maxW = Math.min(520, this.scale.width - 24);
    const x = (this.scale.width - maxW) / 2;
    const h = 58;
    const bg = this.add.graphics().setDepth(DEPTHS.boardOverlay);
    drawPanel(bg, x, topY, maxW, h, {
      topColor: 0x2a3f2d, botColor: 0x09100a,
      stroke: COLOR.brassDeep, strokeWidth: 2,
      highlight: COLOR.brass, highlightAlpha: 0.14,
      radius: 10, shadowOffset: 3, shadowAlpha: 0.22,
    });
    crispText(this, x + 14, topY + 8,
      `Login streak: day ${ps.streak.count}`,
      labelTextStyle(11, COLOR.textGold),
    ).setDepth(DEPTHS.boardOverlay);
    crispText(this, x + 14, topY + 28,
      ps.streak.nextReward.label,
      bodyTextStyle(12, COLOR.textPrimary),
    ).setDepth(DEPTHS.boardOverlay);
    const btn = makeHiveButton(this, {
      x: x + maxW - 70,
      y: topY + h / 2,
      width: 120,
      height: 34,
      label: 'Claim',
      variant: 'primary',
      fontSize: 12,
      onPress: () => { void this.claimStreak(runtime); },
    });
    btn.container.setDepth(DEPTHS.boardOverlay);
    return topY + h + 8;
  }

  private async claimStreak(runtime: HiveRuntime): Promise<void> {
    try {
      const r = await runtime.api.claimStreak();
      this.resources.sugar = r.resources.sugar;
      this.resources.leafBits = r.resources.leafBits;
      this.resources.aphidMilk = r.resources.aphidMilk;
      this.sugarText.setText(String(this.resources.sugar));
      this.leafText.setText(String(this.resources.leafBits));
      this.milkText.setText(String(this.resources.aphidMilk));
      if (runtime.player?.player.streak) {
        runtime.player.player.streak.lastClaim = r.streakDay;
      }
      this.scene.restart();
    } catch (err) {
      console.warn('streak claim failed', err);
    }
  }

  private drawNemesisRibbon(topY: number, runtime: HiveRuntime): number {
    const ps = runtime.player?.player;
    if (!ps?.nemesis) return topY;
    const maxW = Math.min(520, this.scale.width - 24);
    const x = (this.scale.width - maxW) / 2;
    const h = 52;
    const bg = this.add.graphics().setDepth(DEPTHS.boardOverlay);
    drawPanel(bg, x, topY, maxW, h, {
      topColor: 0x4a1818, botColor: 0x1a0a0a,
      stroke: COLOR.red, strokeWidth: 2,
      highlight: 0xff9a80, highlightAlpha: 0.2,
      radius: 10, shadowOffset: 3, shadowAlpha: 0.26,
    });
    const label = crispText(this, x + 14, topY + 8,
      'NEMESIS',
      labelTextStyle(10, '#ff9a80'),
    ).setDepth(DEPTHS.boardOverlay);
    label.setAlpha(0.7);
    this.tweens.add({ targets: label, alpha: 1, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    crispText(this, x + 14, topY + 24,
      `${ps.nemesis.stars}-starred you. Time for revenge.`,
      bodyTextStyle(12, COLOR.textPrimary),
    ).setDepth(DEPTHS.boardOverlay);
    const btn = makeHiveButton(this, {
      x: x + maxW - 74,
      y: topY + h / 2,
      width: 130,
      height: 34,
      label: 'Revenge raid',
      variant: 'danger',
      fontSize: 12,
      onPress: () => {
        // We stamp "revenge context" so RaidScene pulls the defender
        // from the nemesis id instead of running matchmaking.
        this.registry.set('revengeContext', { defenderId: ps.nemesis!.playerId });
        fadeToScene(this, 'RaidScene');
      },
    });
    btn.container.setDepth(DEPTHS.boardOverlay);
    return topY + h + 8;
  }

  private drawFooter(): void {
    this.footerChrome?.destroy();
    this.footerChrome = null;
    // Mobile: the burger drawer owns every nav action, so skip the
    // desktop footer entirely. We still keep a single pinned CTA
    // at bottom-right — the primary "Raid" action — so players don't
    // have to open the drawer to start a raid.
    if (this.isMobileLayout()) {
      this.footerButtonDefs = [];
      this.footerButtons = [];
      if (!this.layerLabel) {
        this.layerLabel = crispText(this, -9999, -9999, '', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '1px',
        });
      }
      this.drawMobileRaidCta();
      return;
    }

    // Labels come in two flavors. `full` is the desktop reading;
    // `short` is a compact mobile variant that still fits in ~70 px
    // without truncating. layoutFooter picks between them based on
    // scale.width so a phone doesn't get a button that reads
    // "Undergro" because "Flip → Underground" ran out of room.
    const flipFull = (): string =>
      this.layer === 0 ? 'Flip → Underground' : 'Flip → Surface';
    const flipShort = (): string =>
      this.layer === 0 ? '↓ Underground' : '↑ Surface';

    const buttons: Array<{
      full: () => string;
      short: () => string;
      variant: 'primary' | 'secondary';
      onPress: () => void;
    }> = [
      {
        full: flipFull,
        short: flipShort,
        variant: 'secondary',
        onPress: () => {
          // Same reasoning as the burger-drawer flip handler: the
          // move-mode overlay is attached to boardContainer and would
          // be destroyed by the removeAll below, so bail out of move
          // mode first and let the banner/source sprite reset.
          this.exitMoveMode();
          this.layer = this.layer === 0 ? 1 : 0;
          const btn = this.footerButtons[0];
          btn?.setLabel(this.footerLabelForIndex(0));
          this.boardContainer.removeAll(true);
          this.drawBoard();
          this.drawBuildings();
        },
      },
      {
        full: () => '🏆 Ranks',
        short: () => 'Ranks',
        variant: 'secondary',
        onPress: () => fadeToScene(this, 'LeaderboardScene'),
      },
      {
        full: () => '📜 Recent',
        short: () => 'Recent',
        variant: 'secondary',
        onPress: () => fadeToScene(this, 'RaidHistoryScene'),
      },
      {
        full: () => '⚙ Upgrades',
        short: () => 'Upgrade',
        variant: 'secondary',
        onPress: () => fadeToScene(this, 'UpgradeScene'),
      },
      {
        full: () => '👥 Clan',
        short: () => 'Clan',
        variant: 'secondary',
        onPress: () => fadeToScene(this, 'ClanScene'),
      },
      {
        full: () => '📖 Campaign',
        short: () => 'Story',
        variant: 'secondary',
        onPress: () => fadeToScene(this, 'CampaignScene'),
      },
      {
        full: () => '⚔ Arena',
        short: () => 'Arena',
        variant: 'secondary',
        onPress: () => fadeToScene(this, 'ArenaScene'),
      },
      {
        // Help re-opens the onboarding tutorial. Matches the secondary
        // variant so it reads as "just another nav button" rather than
        // an emergency CTA; new players who bounce past the first-visit
        // flow can still find guidance without digging through menus.
        full: () => '❓ Help',
        short: () => 'Help',
        variant: 'secondary',
        onPress: () => {
          openTutorial({ force: true });
        },
      },
      {
        // Primary CTA — brass colour + extra width in layoutFooter()
        // so it reads as the main action. Arrow glyph + rightmost
        // position reinforce the "go forward" cue.
        full: () => 'Raid a base →',
        short: () => 'Raid →',
        variant: 'primary',
        onPress: () => fadeToScene(this, 'RaidScene'),
      },
    ];

    this.footerButtonDefs = buttons;
    this.footerButtons = buttons.map((b) =>
      this.makeButton(0, 0, b.full(), b.variant, b.onPress),
    );
    this.footerChrome = this.add.graphics().setDepth(DEPTHS.hudChrome);
    // Footer buttons have default depth 0; the chrome panel sits at
    // DEPTHS.hudChrome (1), which would otherwise render ON TOP of the
    // buttons and swallow their visuals + pointer hits. Pushing each
    // button container one slot above the chrome keeps them visible
    // and interactive. The DEPTHS.hud slot (8) is safely above chrome
    // and below any modal backdrops, and this is also where the
    // mobile Raid CTA already sits — keeps both paths consistent.
    for (const btn of this.footerButtons) {
      btn.container.setDepth(DEPTHS.hud);
    }
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

  private footerLabelForIndex(i: number): string {
    const def = this.footerButtonDefs[i];
    if (!def) return '';
    // 700 is the breakpoint: below it labels shorten so they never
    // truncate inside the button; above it full marketing copy.
    return this.scale.width < BREAKPOINTS.tablet ? def.short() : def.full();
  }

  private footerButtonDefs: Array<{
    full: () => string;
    short: () => string;
    variant: 'primary' | 'secondary';
    onPress: () => void;
  }> = [];

  // Footer button records so the flip-button label can be refreshed
  // without looking it up by index. Each entry carries a setLabel
  // helper that updates the Text child of the container.
  private footerButtons: HiveButton[] = [];

  private mobileRaidCta: HiveButton | null = null;
  private footerChrome: Phaser.GameObjects.Graphics | null = null;

  private drawMobileRaidCta(): void {
    const btnW = 140;
    const btnH = 52;
    const margin = 16;
    // Respect the iOS home-indicator / safe-area by stacking the CTA
    // a little up from the very bottom. The #game div already insets
    // by env(safe-area-inset-bottom) so `this.scale.height` IS the
    // visible rect — plain margin is enough.
    const y = this.scale.height - margin - btnH / 2;
    const x = this.scale.width - margin - btnW / 2;
    const btn = makeHiveButton(this, {
      x,
      y,
      width: btnW,
      height: btnH,
      label: 'Raid →',
      variant: 'primary',
      fontSize: 16,
      onPress: () => fadeToScene(this, 'RaidScene'),
    });
    btn.container.setDepth(DEPTHS.hud);
    this.tweens.add({
      targets: btn.container,
      scale: { from: 1, to: 1.03 },
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    this.mobileRaidCta = btn;
  }

  private layoutFooter(): void {
    const count = this.footerButtons.length;
    if (count === 0) return;
    const marginX = HomeScene.FOOTER_MARGIN_X;
    const gap = HomeScene.FOOTER_GAP;
    const btnH = HomeScene.FOOTER_BTN_H;

    // Responsive footer. Wide viewports stay in one row; below that we
    // stack into two rows. The breakpoint is computed from the button
    // count + a comfortable per-button minimum so the longest full
    // label ("Flip → Underground") fits without truncating. Before,
    // the breakpoint was a hard-coded 900 px which packed 7-8 buttons
    // onto a 900 px row — giving the Flip button ~115 px to fit a
    // ~150 px label.
    //
    // The primary CTA gets +28% width below, so the wide threshold
    // reserves enough room that the primary doesn't push its neighbors
    // into truncation territory once it scales up. Computed via
    // footerMinWideRow() so footerReservedHeight() can mirror it
    // exactly — a mismatch here would let the board lay out under a
    // 2-row footer the layout predicted as 1 row.
    const wide = this.scale.width >= this.footerMinWideRow();

    // Pick the short or full label per current viewport.
    for (let i = 0; i < count; i++) {
      this.footerButtons[i]!.setLabel(this.footerLabelForIndex(i));
    }

    // Solve button width from the *widest* row's weighted capacity.
    // A primary button occupies 1.28 slots instead of 1, so treating
    // every button as equal-weight (floor(availW / count)) let the
    // expanded primary shove the row off the viewport on widths where
    // btnW stayed below the 220 px clamp (e.g. 1366 px with 8 buttons
    // overflowed by ~45 px). In narrow mode each row is solved
    // independently because the primary only sits in one of them.
    const perRow = wide ? count : Math.ceil(count / 2);
    const availW = this.scale.width - marginX * 2 - gap * (perRow - 1);
    const half = Math.ceil(count / 2);
    const rowWeight = (from: number, to: number): number => {
      let w = 0;
      for (let i = from; i < to; i++) {
        w += this.footerButtonDefs[i]?.variant === 'primary' ? 1.28 : 1;
      }
      return w;
    };
    const maxWeight = wide
      ? rowWeight(0, count)
      : Math.max(rowWeight(0, half), rowWeight(half, count));
    const btnW = Math.max(110, Math.min(220, Math.floor(availW / maxWeight)));
    // Emphasize the primary CTA: +28% width over a secondary button so
    // the gold Raid button reads as the primary action rather than
    // "one of eight". Clamped so we never exceed the hard 220 px cap
    // that keeps ultra-wide footers looking proportional.
    const primaryBtnW = Math.min(260, Math.round(btnW * 1.28));
    const bottomPad = 36;
    const footerTop = wide
      ? this.scale.height - bottomPad - btnH - 18
      : this.scale.height - bottomPad - btnH * 2 - 12 - 18;
    const footerHeight = wide ? btnH + 30 : btnH * 2 + 42;
    this.footerChrome?.clear();
    if (this.footerChrome) {
      drawPanel(
        this.footerChrome,
        14,
        footerTop,
        this.scale.width - 28,
        footerHeight,
        {
          topColor: 0x182319,
          botColor: 0x0a120b,
          stroke: COLOR.brassDeep,
          strokeWidth: 3,
          highlight: COLOR.brass,
          highlightAlpha: 0.14,
          radius: 18,
          shadowOffset: 5,
          shadowAlpha: 0.38,
        },
      );
      this.footerChrome.fillStyle(COLOR.brass, 0.12);
      this.footerChrome.fillRect(28, footerTop + 34, this.scale.width - 56, 2);
    }

    // Per-button width so the primary CTA can be wider than its
    // secondary siblings. Everything reads off footerButtonDefs[i]
    // instead of assuming uniform widths.
    const widthFor = (globalIdx: number): number =>
      this.footerButtonDefs[globalIdx]?.variant === 'primary' ? primaryBtnW : btnW;
    const placeRow = (arr: HiveButton[], y: number, rowStartGlobalIdx: number): void => {
      let rowTotalW = 0;
      for (let i = 0; i < arr.length; i++) {
        rowTotalW += widthFor(rowStartGlobalIdx + i);
      }
      rowTotalW += gap * Math.max(0, arr.length - 1);
      let cursor = (this.scale.width - rowTotalW) / 2;
      for (let i = 0; i < arr.length; i++) {
        const w = widthFor(rowStartGlobalIdx + i);
        arr[i]!.setSize(w, btnH);
        // Button origin is center; add w/2 so left edge === cursor.
        arr[i]!.setPosition(cursor + w / 2, y);
        cursor += w + gap;
      }
    };

    // Pin both rows to the bottom of the viewport with a comfortable
    // margin. The home-indicator / safe-area inset is already applied
    // to the #game div, so bottomPad is purely aesthetic — bigger
    // pushes the whole footer (and by consequence the board above it)
    // up the screen. 36 px keeps the green board from hugging the
    // first row of buttons on laptop viewports.
    if (wide) {
      const y = this.scale.height - bottomPad - btnH / 2;
      placeRow(this.footerButtons, y, 0);
    } else {
      const row1 = this.footerButtons.slice(0, half);
      const row2 = this.footerButtons.slice(half);
      const y2 = this.scale.height - bottomPad - btnH / 2;
      const y1 = y2 - btnH - 12;
      placeRow(row1, y1, 0);
      placeRow(row2, y2, half);
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

  // Minimum viewport width that fits the full footer in one row.
  // Shared between layoutFooter (which paints the row) and
  // footerReservedHeight (which tells the board how much vertical
  // space to leave). Both must agree or the board can be laid out
  // under a 2-row footer that the layout code has actually painted.
  private footerMinWideRow(): number {
    const count = this.footerButtons.length || 8;
    const marginX = HomeScene.FOOTER_MARGIN_X;
    const gap = HomeScene.FOOTER_GAP;
    const minBtnWide = 140;
    // +28% for the primary CTA (footer currently has one Raid button).
    // Missing this bump in `footerReservedHeight()` was leaving a
    // ~40 px dead band around 1222–1262 px where the footer wrapped to
    // 2 rows while the board still reserved space for 1.
    const defs = this.footerButtonDefs;
    const hasPrimary = defs.length > 0
      ? defs.some((d) => d.variant === 'primary')
      : true;
    const primaryBump = hasPrimary ? Math.round(minBtnWide * 0.28) : 0;
    return marginX * 2 + count * minBtnWide + (count - 1) * gap + primaryBump;
  }

  // Vertical budget the footer needs. Mirrors layoutFooter exactly:
  // wide = 1 row with bottom pad; narrow = 2 rows + inter-row gap.
  // Board sizing subtracts this so the board never runs under the
  // footer on tall phones. The `wide` breakpoint computation here
  // must match layoutFooter exactly or the board will either hug
  // the footer or leave a blank gap.
  private footerReservedHeight(): number {
    // Mobile collapses the row into a burger drawer + a single
    // floating Raid CTA. The CTA overlaps the bottom-right corner of
    // the (pannable) board — it's drawn ABOVE the board so no vertical
    // reservation is needed. 20 px keeps the pan clamp from gluing the
    // board's bottom edge under the CTA on extreme viewports.
    if (this.isMobileLayout()) return 20;
    const wide = this.scale.width >= this.footerMinWideRow();
    const btnH = HomeScene.FOOTER_BTN_H;
    const bottomPad = 36;
    const interRow = 12;
    const extraClearance = 28;
    return wide
      ? bottomPad + btnH + extraClearance
      : bottomPad + btnH * 2 + interRow + extraClearance;
  }

  private handleResize(): void {
    // Two sizing modes:
    //
    // * Desktop / tablet: shrink-to-fit so the whole base is visible
    //   at once. This matches the Clash-of-Clans-style "see your
    //   village at a glance" UX players expect on wide viewports.
    //
    // * Mobile: render at 1:1 (or larger than the viewport) so tiles,
    //   buildings and HP bars are big enough to read and tap. The
    //   user pans the map with a drag gesture (see wireBoardTap),
    //   clamped to board edges via clampBoardPan(). Freed-up vertical
    //   space from the burger footer is given back to the playfield.
    const availW = this.scale.width - 24;
    const availH = this.scale.height - HUD_H - this.footerReservedHeight() - 16;
    const fit = Math.min(availW / BOARD_W, availH / BOARD_H, 1);
    const mobile = this.isMobileLayout();
    // On mobile, clamp scale up to 1.0 so tiles stay a comfortable
    // 48 px on-screen; the board will exceed the viewport and be
    // pannable. Desktop sticks with the fit scale.
    const scale = mobile ? Math.max(fit, 1.0) : fit;
    this.boardContainer.setScale(scale);
    this.boardScale = scale;
    // Start centered. clampBoardPan below will keep the edges
    // in-bounds if the user has already dragged.
    const scaledW = BOARD_W * scale;
    const scaledH = BOARD_H * scale;
    const centeredX = (this.scale.width - scaledW) / 2;
    const topRegion = HUD_H;
    const visibleAvailH = this.scale.height - topRegion - this.footerReservedHeight();
    const centeredY = topRegion + (visibleAvailH - scaledH) / 2;
    this.boardContainer.setPosition(centeredX, centeredY);
    this.clampBoardPan();
    // Keep the mobile Raid CTA anchored to the live viewport. Built
    // in drawMobileRaidCta; only reposition if it exists.
    if (this.mobileRaidCta) {
      const bW = 140;
      const bH = 52;
      const m = 16;
      this.mobileRaidCta.setPosition(
        this.scale.width - m - bW / 2,
        this.scale.height - m - bH / 2,
      );
    }
  }

  private boardScale = 1;

  // Clamp boardContainer.(x, y) so the playable rectangle always
  // covers (or is centered inside) the viewport minus HUD / footer
  // reservations. Called after every pan delta + on layout so
  // orientation changes / scene restarts can't strand the board off
  // in an unreachable corner.
  private clampBoardPan(): void {
    const scale = this.boardScale;
    const scaledW = BOARD_W * scale;
    const scaledH = BOARD_H * scale;
    const topRegion = HUD_H;
    const bottomReserve = this.footerReservedHeight();
    const availH = this.scale.height - topRegion - bottomReserve;
    if (scaledW <= this.scale.width) {
      this.boardContainer.x = (this.scale.width - scaledW) / 2;
    } else {
      const minX = this.scale.width - scaledW; // board's right edge meets viewport right edge
      const maxX = 0;
      this.boardContainer.x = Math.max(minX, Math.min(maxX, this.boardContainer.x));
    }
    if (scaledH <= availH) {
      this.boardContainer.y = topRegion + (availH - scaledH) / 2;
    } else {
      const minY = topRegion + availH - scaledH;
      const maxY = topRegion;
      this.boardContainer.y = Math.max(minY, Math.min(maxY, this.boardContainer.y));
    }
  }

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

  private panAnchor: { px: number; py: number; cx: number; cy: number } | null = null;
  private isPanningBoard = false;

  private isWithinBoardRect(px: number, py: number): boolean {
    // Board is inside boardContainer; getBounds() picks up whatever's
    // been drawn into the container (background + frame fill the
    // whole BOARD_W × BOARD_H rect, so those bounds ARE the board).
    const scale = this.boardScale || 1;
    const x0 = this.boardContainer.x;
    const y0 = this.boardContainer.y;
    const w = BOARD_W * scale;
    const h = BOARD_H * scale;
    return px >= x0 && px <= x0 + w && py >= y0 && py <= y0 + h;
  }

  private wireBoardTap(): void {
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (this.burgerDrawer) return;
      // HUD chips (burger, account, codex, resource pills) call
      // stopPropagation on their own handlers, but cross-device event
      // ordering isn't uniform. Hard-gate here so a tap that started
      // inside the HUD strip can never also kick off a board pan —
      // especially important on iOS where two concurrent taps in
      // quick succession can register as both a chip tap AND a
      // scene-level pointerdown.
      if (p.y < HUD_H) return;
      // Reserve space for the mobile Raid CTA in the bottom-right.
      if (this.mobileRaidCta) {
        const b = this.mobileRaidCta.container;
        if (
          Math.abs(p.x - b.x) < 80 &&
          Math.abs(p.y - b.y) < 32
        ) {
          return;
        }
      }
      if (this.pickerContainer) {
        this.tapStartedInsidePicker = true;
        this.tapDownPos = null;
        return;
      }
      this.tapStartedInsidePicker = false;
      this.tapDownPos = { x: p.x, y: p.y };
      this.isPanningBoard = false;
      // Capture the anchor BEFORE we know if this is a tap or a drag.
      // If the gesture turns into a drag (see pointermove), pan math
      // starts from the container's position at this moment.
      this.panAnchor = {
        px: p.x,
        py: p.y,
        cx: this.boardContainer.x,
        cy: this.boardContainer.y,
      };
    });

    // Pan while dragging — mobile only, because on desktop the whole
    // board fits the viewport and there's nothing to pan to. Drag is
    // gated by the tap-vs-drag threshold so brief jitter never
    // becomes a pan.
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.isMobileLayout()) return;
      if (!p.isDown) return;
      if (!this.panAnchor) return;
      if (this.pickerContainer || this.burgerDrawer) return;
      const dx = p.x - this.panAnchor.px;
      const dy = p.y - this.panAnchor.py;
      if (!this.isPanningBoard) {
        if (
          dx * dx + dy * dy <
          HomeScene.TAP_THRESHOLD_PX * HomeScene.TAP_THRESHOLD_PX
        ) {
          return;
        }
        this.isPanningBoard = true;
      }
      this.boardContainer.x = this.panAnchor.cx + dx;
      this.boardContainer.y = this.panAnchor.cy + dy;
      this.clampBoardPan();
    });

    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      // Consume the latched flag exactly once per gesture.
      if (this.tapStartedInsidePicker) {
        this.tapStartedInsidePicker = false;
        return;
      }
      if (this.pickerContainer) return;
      // Grace window after close. Defense-in-depth against any
      // pointerdown we didn't see. Scene clock so the window doesn't
      // drift relative to pause/background state.
      if (
        this.time.now - this.pickerClosedAtMs <
        HomeScene.PICKER_REOPEN_GRACE_MS
      ) {
        return;
      }
      const down = this.tapDownPos;
      this.tapDownPos = null;
      this.panAnchor = null;
      if (!down) return;
      if (this.isPanningBoard) {
        this.isPanningBoard = false;
        return; // pan gesture, don't open picker
      }
      const dx = p.x - down.x;
      const dy = p.y - down.y;
      if (dx * dx + dy * dy > HomeScene.TAP_THRESHOLD_PX * HomeScene.TAP_THRESHOLD_PX) {
        // Drag, not a tap — e.g. user tried to pan but didn't actually
        // move the board (e.g. already at clamp boundary on a desktop
        // viewport). Still treat as not-a-tap.
        return;
      }
      if (!this.isWithinBoardRect(p.x, p.y)) return;
      const scale = this.boardScale || 1;
      const localX = (p.x - this.boardContainer.x) / scale;
      const localY = (p.y - this.boardContainer.y) / scale;
      if (localX < 0 || localX >= BOARD_W || localY < 0 || localY >= BOARD_H) return;
      const tx = Math.floor(localX / TILE);
      const ty = Math.floor(localY / TILE);
      // Move-mode hijacks board taps: the tile the player tapped is
      // the new anchor for the building they're relocating. The
      // existing picker flow is skipped while move-mode is active so
      // a mis-tap into a free area doesn't also try to open the
      // building picker on top of the relocation.
      if (this.moveMode) {
        void this.commitMove(tx, ty);
        return;
      }
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
    const slotH = 122;
    const rows = Math.ceil(kinds.length / cols);
    const W = Math.min(640, this.scale.width - 32);
    const naturalH = 86 + rows * (slotH + 12) + 32;
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
    drawPanel(card, ox, oy, W, H, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.14,
      radius: 16,
      shadowOffset: 5,
      shadowAlpha: 0.35,
    });
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

    const headerPill = this.add.graphics().setDepth(203);
    drawPill(headerPill, ox + 20, oy + 18, 126, 22, { brass: true });
    container.add(headerPill);
    const headerLabel = crispText(
      this,
      ox + 83,
      oy + 29,
      'Build menu',
      labelTextStyle(10, '#2a1d08'),
    )
      .setOrigin(0.5, 0.5)
      .setDepth(203);
    container.add(headerLabel);

    const title = crispText(
      this,
      ox + 20,
      oy + 48,
      this.layer === 0
        ? `Build on surface tile ${tx}, ${ty}`
        : `Build on underground tile ${tx}, ${ty}`,
      displayTextStyle(15, COLOR.textGold, 3),
    )
      .setOrigin(0, 0)
      .setDepth(203);
    container.add(title);
    const subtitle = crispText(
      this,
      ox + 20,
      oy + 70,
      'Choose a structure to place in this slot.',
      bodyTextStyle(12, COLOR.textPrimary),
    )
      .setOrigin(0, 0)
      .setDepth(203);
    container.add(subtitle);

    // Close button
    const close = crispText(
      this,
      ox + W - 18,
      oy + 16,
      'X',
      displayTextStyle(18, '#c3e8b0', 2),
    )
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
      const cy = oy + 92 + row * (slotH + 12) + slotH / 2;
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
      drawPanel(slotBg, cx - slotW / 2 + 4, cy - slotH / 2, slotW - 8, slotH - 8, {
        topColor: placeable ? 0x203725 : 0x342121,
        botColor: placeable ? 0x122016 : 0x1f1212,
        stroke: placeable ? 0x5ba445 : 0xa84848,
        strokeWidth: 2,
        highlight: placeable ? COLOR.brass : 0xffa0a0,
        highlightAlpha: 0.1,
        radius: 10,
        shadowOffset: 3,
        shadowAlpha: 0.25,
      });
      container.add(slotBg);

      const icon = this.add
        .image(cx, cy - 24, `building-${kind}`)
        .setDisplaySize(44, 44)
        .setDepth(204)
        .setAlpha(placeable ? 1 : 0.5);
      container.add(icon);

      const nameText = crispText(
        this,
        cx,
        cy + 8,
        kind.replace(/([A-Z])/g, ' $1').trim(),
        bodyTextStyle(11, placeable ? COLOR.textPrimary : '#d7aaaa'),
      )
        .setOrigin(0.5)
        .setDepth(204);
      container.add(nameText);

      // Count/cap badge shows right next to the name so the player can
      // see the "2/3 turrets" state at a glance.
      const capText = crispText(
        this,
        cx,
        cy + 32,
        `Slots ${current}/${cap}`,
        labelTextStyle(10, capOk ? '#c3e8b0' : '#d98080'),
      )
        .setOrigin(0.5)
        .setDepth(204);
      container.add(capText);

      const costText = crispText(
        this,
        cx,
        cy + 48,
        `S ${cost.sugar}  L ${cost.leafBits}`,
        labelTextStyle(10, canAfford ? '#c3e8b0' : '#d98080'),
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
      this.pickerClosedAtMs = this.time.now;
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

  private toast: Phaser.GameObjects.Container | null = null;
  private flashToast(msg: string): void {
    this.toast?.destroy();
    const width = Math.min(
      Math.max(180, msg.length * 8 + 56),
      this.scale.width - 28,
    );
    const height = 50;
    const baseY = this.scale.height - (this.isMobileLayout() ? 92 : 56);
    const container = this.add
      .container(this.scale.width / 2, baseY)
      .setDepth(DEPTHS.toast)
      .setAlpha(0)
      .setScale(0.97);
    const bg = this.add.graphics();
    drawPanel(bg, -width / 2, -height / 2, width, height, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.18,
      radius: 14,
      shadowOffset: 4,
      shadowAlpha: 0.35,
    });
    drawPill(bg, -width / 2 + 10, -height / 2 + 8, 58, 16, { brass: true });
    const accent = crispText(
      this,
      -width / 2 + 39,
      -height / 2 + 16,
      'NOTICE',
      labelTextStyle(9, '#2a1d08'),
    ).setOrigin(0.5, 0.5);
    const text = crispText(
      this,
      0,
      7,
      msg,
      bodyTextStyle(13, COLOR.textPrimary),
    )
      .setOrigin(0.5, 0.5)
      .setWordWrapWidth(width - 36, true)
      .setAlign('center');
    container.add([bg, accent, text]);
    this.toast = container;
    this.tweens.add({
      targets: container,
      alpha: 1,
      scale: 1,
      y: baseY - 6,
      duration: 180,
      ease: 'Back.easeOut',
    });
    this.tweens.add({
      targets: container,
      alpha: { from: 1, to: 0 },
      y: baseY - 14,
      delay: 1800,
      duration: 320,
      onComplete: () => {
        container.destroy();
        if (this.toast === container) this.toast = null;
      },
    });
  }
}
