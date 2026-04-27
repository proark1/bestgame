import Phaser from 'phaser';
import { Sim, Types } from '@hive/shared';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import { makeHiveButton } from '../ui/button.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { crispText } from '../ui/text.js';
import { COLOR, DEPTHS, bodyTextStyle, displayTextStyle, labelTextStyle, SPACING } from '../ui/theme.js';
import { addNineSliceIfActive } from '../ui/uiOverrides.js';
import { ALL_CODEX_ENTRIES, type CodexEntry } from '../codex/codexData.js';

// Codex — trading-card reference for every unit and building. The
// focused card is centered full-size; prev and next peek in from the
// sides. Swipe, tap the peek, hit the arrow keys, or tap a thumbnail
// on the rail below to navigate. The card frame is admin-overrideable
// (ui-card-frame 9-slice) with a Graphics brass border as fallback.

const HUD_H = 56;

// Thumbnail rail along the bottom so the user can jump straight to
// any entry.
const RAIL_H = 92;
const RAIL_GAP = 8;
const THUMB_H = 72;
const THUMB_W = 72;

// Card layout.
const CARD_MAX_W = 380;
const CARD_MAX_H = 560;
const CARD_MIN_H_MARGIN = 60; // space above + below the card inside its pane
// Peek offset as a fraction of card width; adjacent cards' centers land
// beyond the focused card's right edge so we see roughly a quarter of
// the neighbor.
const PEEK_FRACTION = 0.78;
// Viewport narrower than this hides the peek entirely (pure single-card).
const PEEK_MIN_W = 720;
// Scale + alpha applied to the peeking neighbors.
const PEEK_SCALE = 0.68;
const PEEK_ALPHA = 0.45;
// Swipe distance (pixels) to count as a prev/next flip.
const SWIPE_THRESHOLD = 60;

interface CardLayout {
  cx: number;
  cy: number;
  w: number;
  h: number;
  peekOffset: number;
  showPeek: boolean;
}

type Slot = -1 | 0 | 1;

export class CodexScene extends Phaser.Scene {
  private entries: CodexEntry[] = ALL_CODEX_ENTRIES;
  private currentIdx = 0;
  private cardsHost!: Phaser.GameObjects.Container;
  private cardSlots: Phaser.GameObjects.Container[] = [];
  private railContainer!: Phaser.GameObjects.Container;
  private railScrollX = 0;
  private railScrolling = false;
  private railScrollStartX = 0;
  private railScrollStartOffset = 0;

  // Horizontal-swipe state on the card area.
  private swipeActive = false;
  private swipeStartX = 0;

  constructor() {
    super('CodexScene');
  }

  create(): void {
    fadeInScene(this);
    installSceneClickDebug(this);
    this.cameras.main.setBackgroundColor('#0f1b10');

    this.drawAmbient();
    this.drawHud();
    this.cardsHost = this.add.container(0, 0);
    this.railContainer = this.add.container(0, 0);
    this.wireRailScroll();
    this.wireCardSwipe();
    this.wireKeyboardNav();
    this.renderCards();
    this.renderRail();

    this.scale.on('resize', this.handleResize, this);
  }

  private handleResize(): void {
    this.renderCards();
    this.renderRail();
  }

  private drawAmbient(): void {
    // Gradient backdrop so the card sits in a pool of light.
    const g = this.add.graphics().setDepth(DEPTHS.background);
    const top = 0x1c3020;
    const bot = 0x070d08;
    const BANDS = 14;
    for (let i = 0; i < BANDS; i++) {
      const t = i / (BANDS - 1);
      const r = lerp((top >> 16) & 0xff, (bot >> 16) & 0xff, t);
      const gc = lerp((top >> 8) & 0xff, (bot >> 8) & 0xff, t);
      const b = lerp(top & 0xff, bot & 0xff, t);
      g.fillStyle((r << 16) | (gc << 8) | b, 1);
      g.fillRect(
        0,
        Math.floor((i * this.scale.height) / BANDS),
        this.scale.width,
        Math.ceil(this.scale.height / BANDS) + 1,
      );
    }
    const glow = this.add.graphics().setDepth(DEPTHS.ambient);
    glow.fillStyle(COLOR.brass, 0.05);
    glow.fillEllipse(this.scale.width / 2, HUD_H + 140, Math.min(880, this.scale.width * 0.92), 240);
    glow.fillStyle(COLOR.greenHi, 0.06);
    glow.fillEllipse(this.scale.width * 0.26, this.scale.height - 120, 360, 160);
  }

  private drawHud(): void {
    const w = this.scale.width;
    const hud = this.add.graphics();
    drawPanel(hud, 0, 0, w, HUD_H, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      strokeWidth: 0,
      highlight: COLOR.brass,
      highlightAlpha: 0.12,
      radius: 0,
      shadowOffset: 0,
      shadowAlpha: 0,
    });
    hud.fillStyle(0x000000, 0.45);
    hud.fillRect(0, HUD_H, w, 3);

    const pill = this.add.graphics();
    drawPill(pill, w / 2 - 194, 18, 94, 20, { brass: true });
    crispText(this, w / 2 - 147, 28, 'Lore deck', labelTextStyle(10, COLOR.textGold)).setOrigin(0.5, 0.5);

    makeHiveButton(this, {
      x: 72,
      y: HUD_H / 2,
      width: 120,
      height: 36,
      label: 'Home',
      variant: 'ghost',
      fontSize: 13,
      onPress: () => fadeToScene(this, 'HomeScene'),
    });

    // Filter toggle — cycles the visible entry set between All /
    // Units / Buildings so the admin can focus the deck. Lives next
    // to the title so it's always one tap away on narrow viewports.
    makeHiveButton(this, {
      x: this.scale.width - 96,
      y: HUD_H / 2,
      width: 120,
      height: 36,
      label: this.filterLabel(),
      variant: 'ghost',
      fontSize: 12,
      onPress: () => this.cycleFilter(),
    });

    crispText(this, this.scale.width / 2, HUD_H / 2, 'Codex', displayTextStyle(20, '#ffe7b0', 4)).setOrigin(
      0.5,
    );
  }

  private filterMode: 'all' | 'units' | 'buildings' | 'resources' = 'all';
  private filterLabel(): string {
    if (this.filterMode === 'all') return 'All ▾';
    if (this.filterMode === 'units') return 'Units ▾';
    if (this.filterMode === 'buildings') return 'Buildings ▾';
    return 'Resources ▾';
  }
  private cycleFilter(): void {
    const order: Array<'all' | 'units' | 'buildings' | 'resources'> = [
      'all',
      'resources',
      'units',
      'buildings',
    ];
    const next = order[(order.indexOf(this.filterMode) + 1) % order.length]!;
    this.filterMode = next;
    this.entries = next === 'all'
      ? ALL_CODEX_ENTRIES
      : ALL_CODEX_ENTRIES.filter((e) => {
          if (next === 'units') return e.spriteKey.startsWith('unit-');
          if (next === 'buildings') return e.spriteKey.startsWith('building-');
          return e.spriteKey.startsWith('ui-resource-');
        });
    this.currentIdx = Math.min(this.currentIdx, this.entries.length - 1);
    this.scene.restart();
  }

  private computeLayout(): CardLayout {
    const w = this.scale.width;
    const h = this.scale.height;
    const paneTop = HUD_H;
    const paneBottom = h - RAIL_H;
    const paneH = paneBottom - paneTop;
    const cardW = Math.min(CARD_MAX_W, w - 48);
    const cardH = Math.min(CARD_MAX_H, paneH - CARD_MIN_H_MARGIN);
    const cx = w / 2;
    const cy = paneTop + paneH / 2;
    const showPeek = w >= PEEK_MIN_W;
    const peekOffset = showPeek ? Math.round(cardW * PEEK_FRACTION) : cardW * 1.5;
    return { cx, cy, w: cardW, h: cardH, peekOffset, showPeek };
  }

  private renderCards(): void {
    this.cardsHost.removeAll(true);
    this.cardSlots = [];

    const L = this.computeLayout();
    const buildAt = (entry: CodexEntry | undefined, slot: Slot) => {
      if (!entry) return;
      const card = this.buildCard(entry, slot, L);
      this.cardsHost.add(card);
      this.cardSlots.push(card);
    };

    if (L.showPeek) {
      buildAt(this.entries[this.currentIdx - 1], -1);
      buildAt(this.entries[this.currentIdx + 1], +1);
    }
    // Build the focused card last so it z-orders on top of the peeks.
    buildAt(this.entries[this.currentIdx], 0);

    // Nav arrow buttons pinned to the viewport (not the card) so they
    // stay reachable when a peek neighbor overlaps the card edge.
    const arrowY = L.cy;
    const arrowGap = L.showPeek ? 22 : 12;
    if (this.currentIdx > 0) {
      const prev = makeHiveButton(this, {
        x: Math.max(40, L.cx - L.w / 2 - arrowGap - 22),
        y: arrowY,
        width: 44,
        height: 44,
        label: '←',
        variant: 'secondary',
        fontSize: 18,
        onPress: () => this.setIndex(this.currentIdx - 1),
      });
      this.cardsHost.add(prev.container);
    }
    if (this.currentIdx < this.entries.length - 1) {
      const next = makeHiveButton(this, {
        x: Math.min(this.scale.width - 40, L.cx + L.w / 2 + arrowGap + 22),
        y: arrowY,
        width: 44,
        height: 44,
        label: '→',
        variant: 'secondary',
        fontSize: 18,
        onPress: () => this.setIndex(this.currentIdx + 1),
      });
      this.cardsHost.add(next.container);
    }
  }

  private buildCard(
    entry: CodexEntry,
    slot: Slot,
    L: CardLayout,
  ): Phaser.GameObjects.Container {
    const isFocus = slot === 0;
    const x = L.cx + slot * L.peekOffset;
    const y = L.cy;
    const container = this.add.container(x, y);
    container.setScale(isFocus ? 1 : PEEK_SCALE);
    container.setAlpha(isFocus ? 1 : PEEK_ALPHA);
    container.setDepth(isFocus ? 10 : 5);

    const w = L.w;
    const h = L.h;
    const left = -w / 2;
    const top = -h / 2;

    // 1) Shadow for lift.
    const shadow = this.add.graphics();
    shadow.fillStyle(0x000000, 0.55);
    shadow.fillRoundedRect(left - 2, top + 6, w + 4, h, SPACING.radiusLg);
    container.add(shadow);

    // 2) Body background — always paint. When the frame override is
    //    active the frame has a transparent center, so this shows
    //    through; when it's the Graphics fallback the fallback paints
    //    its own gradient on top. Cheap, keeps the layout stable.
    const body = this.add.graphics();
    drawPanel(body, left, top, w, h, {
      topColor: 0x2c4728,
      botColor: 0x132015,
      stroke: COLOR.brassDeep,
      strokeWidth: 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.14,
      radius: SPACING.radiusLg,
      shadowOffset: 0,
      shadowAlpha: 0,
    });
    container.add(body);

    // 3) Frame. Prefer the admin-generated ui-card-frame NineSlice
    //    when the override is active; otherwise paint a brass
    //    double-border matching the rest of the UI.
    const nine = addNineSliceIfActive(this, 'ui-card-frame', 0, 0, w, h, {
      left: 56,
      right: 56,
      top: 96,
      bottom: 96,
    });
    if (nine) {
      container.add(nine);
    } else {
      const frame = this.add.graphics();
      frame.lineStyle(4, COLOR.brassDeep, 1);
      frame.strokeRoundedRect(left, top, w, h, SPACING.radiusLg);
      frame.lineStyle(1, COLOR.brass, 0.85);
      frame.strokeRoundedRect(
        left + 4,
        top + 4,
        w - 8,
        h - 8,
        SPACING.radiusLg - 4,
      );
      container.add(frame);
    }

    // 4) Content: name, role, portrait, stats row, story, power strip.
    const padX = 20;
    let cursorY = top + 20;

    const nameText = crispText(this, 0, cursorY, entry.name, displayTextStyle(24, COLOR.textGold, 4)).setOrigin(
      0.5,
      0,
    );
    container.add(nameText);
    cursorY += 30;

    const roleText = crispText(this, 0, cursorY, entry.role, labelTextStyle(12, COLOR.textDim)).setOrigin(
      0.5,
      0,
    );
    container.add(roleText);
    cursorY += 22;

    // Portrait plate — dark panel so the sprite reads against a
    // consistent background.
    const portraitH = Math.min(200, Math.floor(h * 0.36));
    const portraitW = w - padX * 2;
    const portraitX = left + padX;
    const portraitY = cursorY;
    const plate = this.add.graphics();
    drawPanel(plate, portraitX, portraitY, portraitW, portraitH, {
      topColor: COLOR.bgInset,
      botColor: 0x050905,
      stroke: COLOR.brassDeep,
      strokeWidth: 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.08,
      radius: SPACING.radiusMd,
      shadowOffset: 0,
      shadowAlpha: 0,
    });
    container.add(plate);

    const portraitCx = portraitX + portraitW / 2;
    const portraitCy = portraitY + portraitH / 2;
    if (this.textures.exists(entry.spriteKey)) {
      const spr = this.add.image(portraitCx, portraitCy, entry.spriteKey);
      spr.setOrigin(0.5, 0.5);
      const tex = this.textures.get(entry.spriteKey).getSourceImage() as
        | HTMLImageElement
        | HTMLCanvasElement;
      const nativeW = (tex as HTMLImageElement).width || portraitW;
      const nativeH = (tex as HTMLImageElement).height || portraitH;
      const scale = Math.min(
        (portraitW - 16) / nativeW,
        (portraitH - 16) / nativeH,
        2,
      );
      spr.setScale(scale);
      container.add(spr);
    } else {
      const glyph = crispText(this, portraitCx, portraitCy, '?', displayTextStyle(34, COLOR.textGold, 3)).setOrigin(
        0.5,
        0.5,
      );
      container.add(glyph);
    }
    cursorY = portraitY + portraitH + 12;

    // Stats row — 4 compact HP/DMG/RNG/SPD pills pulled from the
    // sim's UNIT_STATS / BUILDING_STATS.
    const stats = formatStats(entry);
    const statsH = 34;
    if (stats.length > 0) {
      this.addStatsRow(container, left, cursorY, w, statsH, stats);
      cursorY += statsH + 10;
    }

    // Story body — natural height up to a cap. Power strip is placed
    // directly below the story (not pinned to the bottom) so the two
    // blocks read as one continuous body and the card doesn't leave
    // a wide empty band between lore and mechanics on short stories.
    const storyMaxH = Math.max(40, Math.floor(h * 0.22));
    const storyText = crispText(this, left + padX, cursorY, entry.story, {
      ...bodyTextStyle(12, COLOR.textPrimary),
      wordWrap: { width: w - padX * 2, useAdvancedWrap: true },
      lineSpacing: 2,
    }).setOrigin(0, 0);
    const renderedStoryH = Math.min(storyText.height, storyMaxH);
    if (storyText.height > storyMaxH) {
      storyText.setFixedSize(w - padX * 2, storyMaxH);
      storyText.setCrop(0, 0, w - padX * 2, storyMaxH);
    }
    container.add(storyText);
    cursorY += renderedStoryH + 10;

    // Power strip — sits directly under the story. Font size matches
    // the story body so the two reads as the same visual weight.
    const powerLabelH = 14;
    const powerPadY = 6;
    const powerInnerW = w - padX * 2 - 20;
    // Pre-size the power text so we know the strip height before we
    // paint the background. Stays within the remaining card space.
    const remaining = top + h - 12 - cursorY;
    const powerTextProbe = crispText(this, 0, 0, entry.power, {
      ...bodyTextStyle(12, COLOR.textPrimary),
      wordWrap: { width: powerInnerW, useAdvancedWrap: true },
      lineSpacing: 2,
    }).setVisible(false);
    const desiredPowerTextH = powerTextProbe.height;
    powerTextProbe.destroy();
    const powerTextH = Math.max(
      16,
      Math.min(desiredPowerTextH, remaining - powerLabelH - powerPadY * 2 - 4),
    );
    const powerStripH = powerLabelH + powerPadY * 2 + powerTextH + 2;
    const powerStripY = cursorY;

    const strip = this.add.graphics();
    drawPanel(strip, left + padX, powerStripY, w - padX * 2, powerStripH, {
      topColor: 0x1d2f1f,
      botColor: 0x101910,
      stroke: COLOR.brassDeep,
      strokeWidth: 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.1,
      radius: SPACING.radiusMd,
      shadowOffset: 0,
      shadowAlpha: 0,
    });
    container.add(strip);

    const powerLabel = crispText(
      this,
      left + padX + 10,
      powerStripY + powerPadY,
      'Power',
      labelTextStyle(10, COLOR.textGold),
    ).setOrigin(0, 0);
    const powerText = crispText(
      this,
      left + padX + 10,
      powerStripY + powerPadY + powerLabelH + 2,
      entry.power,
      {
        ...bodyTextStyle(12, COLOR.textPrimary),
        wordWrap: { width: powerInnerW, useAdvancedWrap: true },
        lineSpacing: 2,
      },
    ).setOrigin(0, 0);
    if (powerText.height > powerTextH) {
      powerText.setFixedSize(powerInnerW, powerTextH);
      powerText.setCrop(0, 0, powerInnerW, powerTextH);
    }
    container.add([powerLabel, powerText]);

    // Counter in the top-right chrome so the user knows where they
    // are in the deck. Only on the focused card; peeks would double-
    // up with the focused counter and clutter the corners.
    if (isFocus) {
      const counter = crispText(
        this,
        left + w - 14,
        top + 10,
        `${this.currentIdx + 1} / ${this.entries.length}`,
        bodyTextStyle(11, COLOR.textDim),
      ).setOrigin(1, 0);
      container.add(counter);
    }

    // Tapping a peek card flips to it. The hit zone sits on top of
    // everything so it catches the tap before the scene-wide swipe
    // handler treats it as a drag start.
    if (!isFocus) {
      const hit = this.add
        .zone(0, 0, w, h)
        .setOrigin(0.5, 0.5)
        .setInteractive({ useHandCursor: true });
      hit.on('pointerup', () => {
        this.setIndex(this.currentIdx + slot);
      });
      container.add(hit);
    }

    return container;
  }

  private addStatsRow(
    container: Phaser.GameObjects.Container,
    cardLeft: number,
    y: number,
    cardW: number,
    rowH: number,
    stats: Array<{ label: string; value: string }>,
  ): void {
    const padX = 20;
    const innerW = cardW - padX * 2;
    const gap = 4;
    const pillW = (innerW - gap * (stats.length - 1)) / stats.length;
    for (let i = 0; i < stats.length; i++) {
      const { label, value } = stats[i]!;
      const px = cardLeft + padX + i * (pillW + gap);
      const pill = this.add.graphics();
      drawPanel(pill, px, y, pillW, rowH, {
        topColor: COLOR.bgInset,
        botColor: 0x091009,
        stroke: COLOR.brassDeep,
        strokeWidth: 1,
        highlight: COLOR.brass,
        highlightAlpha: 0.08,
        radius: SPACING.radiusSm,
        shadowOffset: 0,
        shadowAlpha: 0,
      });
      container.add(pill);

      const labelText = crispText(this, px + pillW / 2, y + 5, label, labelTextStyle(9, COLOR.textGold)).setOrigin(
        0.5,
        0,
      );
      const valueText = crispText(
        this,
        px + pillW / 2,
        y + 17,
        value,
        bodyTextStyle(12, COLOR.textPrimary),
      ).setOrigin(0.5, 0);
      container.add([labelText, valueText]);
    }
  }

  private renderRail(): void {
    this.railContainer.removeAll(true);
    const y = this.scale.height - RAIL_H;

    const bar = this.add.graphics();
    drawPanel(bar, 0, y, this.scale.width, RAIL_H, {
      topColor: COLOR.bgInset,
      botColor: COLOR.bgDeep,
      strokeWidth: 0,
      highlight: COLOR.brass,
      highlightAlpha: 0.08,
      radius: 0,
      shadowOffset: 0,
      shadowAlpha: 0,
    });
    this.railContainer.add(bar);

    const totalW =
      this.entries.length * THUMB_W + (this.entries.length - 1) * RAIL_GAP;
    const centerX = this.scale.width / 2;
    const startX =
      totalW <= this.scale.width - 32
        ? centerX - totalW / 2
        : 16 + this.railScrollX;

    const thumbsHost = this.add.container(0, 0);
    this.railContainer.add(thumbsHost);

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const thumbX = startX + i * (THUMB_W + RAIL_GAP);
      const thumbY = y + (RAIL_H - THUMB_H) / 2;

      const thumbBg = this.add.graphics();
      const active = i === this.currentIdx;
      drawPanel(thumbBg, thumbX, thumbY, THUMB_W, THUMB_H, {
        topColor: active ? 0x2a4824 : 0x18241a,
        botColor: active ? 0x172315 : 0x0d140e,
        stroke: active ? COLOR.brass : COLOR.brassDeep,
        strokeWidth: active ? 2 : 1,
        highlight: COLOR.brass,
        highlightAlpha: active ? 0.16 : 0.06,
        radius: SPACING.radiusSm,
        shadowOffset: 0,
        shadowAlpha: 0,
      });
      thumbsHost.add(thumbBg);

      if (this.textures.exists(entry.spriteKey)) {
        const thumbImg = this.add.image(
          thumbX + THUMB_W / 2,
          thumbY + THUMB_H / 2,
          entry.spriteKey,
        );
        thumbImg.setOrigin(0.5, 0.5);
        const tex = this.textures.get(entry.spriteKey).getSourceImage() as
          | HTMLImageElement
          | HTMLCanvasElement;
        const nativeW = (tex as HTMLImageElement).width || THUMB_W;
        const nativeH = (tex as HTMLImageElement).height || THUMB_H;
        const scale = Math.min(
          (THUMB_W - 8) / nativeW,
          (THUMB_H - 8) / nativeH,
        );
        thumbImg.setScale(scale);
        thumbsHost.add(thumbImg);
      } else {
        const glyph = crispText(
          this,
          thumbX + THUMB_W / 2,
          thumbY + THUMB_H / 2,
          '?',
          displayTextStyle(22, COLOR.textGold, 2),
        ).setOrigin(0.5, 0.5);
        thumbsHost.add(glyph);
      }

      const hit = this.add
        .zone(thumbX + THUMB_W / 2, thumbY + THUMB_H / 2, THUMB_W, THUMB_H)
        .setOrigin(0.5, 0.5)
        .setInteractive({ useHandCursor: true });
      hit.on('pointerdown', () => this.setIndex(i));
      thumbsHost.add(hit);
    }
  }

  private wireRailScroll(): void {
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.y < this.scale.height - RAIL_H) return;
      this.railScrolling = true;
      this.railScrollStartX = p.x;
      this.railScrollStartOffset = this.railScrollX;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.railScrolling || !p.isDown) return;
      const dx = p.x - this.railScrollStartX;
      this.setRailScroll(this.railScrollStartOffset + dx);
    });
    this.input.on('pointerup', () => {
      this.railScrolling = false;
    });
  }

  private setRailScroll(raw: number): void {
    const totalW =
      this.entries.length * THUMB_W + (this.entries.length - 1) * RAIL_GAP;
    const overflow = Math.max(0, totalW - (this.scale.width - 32));
    const clamped = Math.max(-overflow, Math.min(0, raw));
    this.railScrollX = clamped;
    this.renderRail();
  }

  private wireCardSwipe(): void {
    // Horizontal swipe anywhere in the card pane (between HUD and
    // rail). Peek cards have their own tap-to-flip zones that fire
    // on pointerup before this swipe's threshold check can misread
    // a tap as a tiny drag.
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.y <= HUD_H) return;
      if (p.y >= this.scale.height - RAIL_H) return;
      this.swipeActive = true;
      this.swipeStartX = p.x;
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (!this.swipeActive) return;
      this.swipeActive = false;
      const dx = p.x - this.swipeStartX;
      if (dx > SWIPE_THRESHOLD && this.currentIdx > 0) {
        this.setIndex(this.currentIdx - 1);
      } else if (
        dx < -SWIPE_THRESHOLD &&
        this.currentIdx < this.entries.length - 1
      ) {
        this.setIndex(this.currentIdx + 1);
      }
    });
  }

  private wireKeyboardNav(): void {
    this.input.keyboard?.on('keydown-LEFT', () =>
      this.setIndex(this.currentIdx - 1),
    );
    this.input.keyboard?.on('keydown-RIGHT', () =>
      this.setIndex(this.currentIdx + 1),
    );
  }

  private setIndex(next: number): void {
    const clamped = Math.max(0, Math.min(this.entries.length - 1, next));
    if (clamped === this.currentIdx) return;
    this.currentIdx = clamped;
    this.renderCards();
    this.renderRail();
  }
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

// Per-entry compact stat pills. Units pull hp/dmg/range/speed from
// UNIT_STATS; buildings pull hp/dmg/range/cooldown when they can
// attack, and hp + destroy-drops when they can't.
function formatStats(
  entry: CodexEntry,
): Array<{ label: string; value: string }> {
  const unitStats = (Sim.UNIT_STATS as Record<string, Types.UnitStats>)[entry.kind];
  if (unitStats) {
    const dps =
      unitStats.attackCooldownTicks > 0
        ? (Sim.toFloat(unitStats.attackDamage) * 30) /
          unitStats.attackCooldownTicks
        : 0;
    return [
      { label: 'HP', value: String(Sim.toInt(unitStats.hpMax)) },
      { label: 'DMG', value: String(Sim.toInt(unitStats.attackDamage)) },
      { label: 'RNG', value: Sim.toFloat(unitStats.attackRange).toFixed(1) },
      { label: 'DPS', value: dps.toFixed(1) },
    ];
  }
  const bstats = (Sim.BUILDING_STATS as Record<string, Sim.BuildingStats>)[
    entry.kind
  ];
  if (bstats) {
    if (bstats.canAttack) {
      const dps =
        bstats.attackCooldownTicks > 0
          ? (Sim.toFloat(bstats.attackDamage) * 30) / bstats.attackCooldownTicks
          : 0;
      return [
        { label: 'HP', value: String(bstats.hpMax) },
        { label: 'DMG', value: String(Sim.toInt(bstats.attackDamage)) },
        { label: 'RNG', value: Sim.toFloat(bstats.attackRange).toFixed(1) },
        { label: 'DPS', value: dps.toFixed(1) },
      ];
    }
    const loot: Array<{ label: string; value: string }> = [
      { label: 'HP', value: String(bstats.hpMax) },
    ];
    if (bstats.dropsSugarOnDestroy > 0) {
      loot.push({ label: 'SUGAR', value: String(bstats.dropsSugarOnDestroy) });
    }
    if (bstats.dropsLeafBitsOnDestroy > 0) {
      loot.push({
        label: 'LEAF',
        value: String(bstats.dropsLeafBitsOnDestroy),
      });
    }
    return loot;
  }
  return [];
}
