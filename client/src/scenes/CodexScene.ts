import Phaser from 'phaser';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import { makeHiveButton } from '../ui/button.js';
import { COLOR, displayTextStyle, SPACING } from '../ui/theme.js';
import { ALL_CODEX_ENTRIES, type CodexEntry } from '../codex/codexData.js';

// Codex — magic-card-style reference sheet for every unit and
// building in the game. One card on screen at a time with
// prev/next nav and a thumbnail rail along the side so the player
// can jump around.
//
// Not gameplay-affecting; this is the "read the lore + understand
// what each unit does" screen. Wired in from HomeScene's HUD so
// the player can flip to it without leaving the home map.

const HUD_H = 56;

// Card layout constants. The card is sized to fit inside the scene
// with generous margins on every side; the number values below are
// the breathing room budget, not the card size itself.
const CARD_MARGIN_X = 80;
const CARD_MARGIN_TOP = HUD_H + 24;
const CARD_MARGIN_BOTTOM = 24;
// Thumbnail rail along the bottom so the user can tap straight into
// a specific card instead of paging through.
const RAIL_H = 92;
const RAIL_GAP = 8;
const THUMB_H = 72;
const THUMB_W = 72;

export class CodexScene extends Phaser.Scene {
  private entries: CodexEntry[] = ALL_CODEX_ENTRIES;
  private currentIdx = 0;
  private cardContainer!: Phaser.GameObjects.Container;
  private railContainer!: Phaser.GameObjects.Container;
  private railScrollX = 0;
  private railScrolling = false;
  private railScrollStartX = 0;
  private railScrollStartOffset = 0;

  constructor() {
    super('CodexScene');
  }

  create(): void {
    fadeInScene(this);
    installSceneClickDebug(this);
    this.cameras.main.setBackgroundColor('#0f1b10');

    this.drawAmbient();
    this.drawHud();
    this.cardContainer = this.add.container(0, 0);
    this.railContainer = this.add.container(0, 0);
    this.wireRailScroll();
    this.wireKeyboardNav();
    this.renderCard();
    this.renderRail();

    // Repaint on viewport resize so the card + rail recenter.
    this.scale.on('resize', this.handleResize, this);
  }

  private handleResize(): void {
    this.renderCard();
    this.renderRail();
  }

  private drawAmbient(): void {
    // Subtle top-to-bottom gradient so the card sits in a pool of
    // light instead of on a flat slab. Cheap: 14 stacked bands.
    const g = this.add.graphics().setDepth(-100);
    const top = 0x162317;
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
  }

  private drawHud(): void {
    const w = this.scale.width;
    const hud = this.add.graphics();
    hud.fillGradientStyle(
      COLOR.bgPanelHi,
      COLOR.bgPanelHi,
      COLOR.bgPanelLo,
      COLOR.bgPanelLo,
      1,
    );
    hud.fillRect(0, 0, w, HUD_H);
    hud.fillStyle(COLOR.brass, 0.35);
    hud.fillRect(0, 1, w, 1);
    hud.fillStyle(COLOR.brassDeep, 1);
    hud.fillRect(0, HUD_H - 4, w, 1);
    hud.fillStyle(COLOR.brass, 0.7);
    hud.fillRect(0, HUD_H - 3, w, 2);
    hud.fillStyle(0x000000, 0.45);
    hud.fillRect(0, HUD_H, w, 3);

    // Back button — ghost variant, matches other top-bars in the
    // game (Raid / Arena / Leaderboard).
    makeHiveButton(this, {
      x: 72,
      y: HUD_H / 2,
      width: 120,
      height: 36,
      label: '← Home',
      variant: 'ghost',
      fontSize: 13,
      onPress: () => fadeToScene(this, 'HomeScene'),
    });

    this.add
      .text(this.scale.width / 2, HUD_H / 2, '📖 Codex', displayTextStyle(20, '#ffe7b0', 4))
      .setOrigin(0.5);
  }

  private cardBounds(): { x: number; y: number; w: number; h: number } {
    const x = CARD_MARGIN_X;
    const y = CARD_MARGIN_TOP;
    const w = Math.max(320, this.scale.width - CARD_MARGIN_X * 2);
    const h = Math.max(
      360,
      this.scale.height - CARD_MARGIN_TOP - CARD_MARGIN_BOTTOM - RAIL_H,
    );
    return { x, y, w, h };
  }

  private renderCard(): void {
    this.cardContainer.removeAll(true);
    const entry = this.entries[this.currentIdx];
    if (!entry) return;
    const { x, y, w, h } = this.cardBounds();

    // Shadow behind the card for lift.
    const shadow = this.add.graphics();
    shadow.fillStyle(0x000000, 0.55);
    shadow.fillRoundedRect(x - 2, y + 6, w + 4, h, SPACING.radiusLg);
    this.cardContainer.add(shadow);

    // Card body — deep green gradient inside a brass frame.
    const card = this.add.graphics();
    card.fillGradientStyle(0x2a4824, 0x2a4824, 0x162317, 0x162317, 1);
    card.fillRoundedRect(x, y, w, h, SPACING.radiusLg);
    // Brass double border — outer dark brown, inner brass highlight.
    card.lineStyle(4, COLOR.brassDeep, 1);
    card.strokeRoundedRect(x, y, w, h, SPACING.radiusLg);
    card.lineStyle(1, COLOR.brass, 0.85);
    card.strokeRoundedRect(x + 4, y + 4, w - 8, h - 8, SPACING.radiusLg - 4);
    this.cardContainer.add(card);

    // Layout: header (name + role), portrait area, body (story),
    // stats ribbon (power). All centered on the card.
    const headerY = y + 28;
    const portraitY = y + 76;
    const portraitH = Math.min(260, Math.floor(h * 0.42));
    const portraitW = Math.min(portraitH, w - 120);
    const portraitCx = x + w / 2;
    const portraitCy = portraitY + portraitH / 2;

    const nameText = this.add
      .text(x + w / 2, headerY, entry.name, displayTextStyle(26, COLOR.textGold, 4))
      .setOrigin(0.5, 0);
    const roleText = this.add
      .text(x + w / 2, headerY + 32, entry.role, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: COLOR.textDim,
        fontStyle: 'italic',
      })
      .setOrigin(0.5, 0);
    this.cardContainer.add([nameText, roleText]);

    // Portrait plate — dark panel so the sprite reads against a
    // consistent background even when its art has transparent
    // edges or bright highlights that could clash with the card
    // gradient.
    const plate = this.add.graphics();
    plate.fillStyle(0x0a120c, 0.7);
    plate.fillRoundedRect(
      portraitCx - portraitW / 2,
      portraitY,
      portraitW,
      portraitH,
      SPACING.radiusMd,
    );
    plate.lineStyle(2, COLOR.brassDeep, 1);
    plate.strokeRoundedRect(
      portraitCx - portraitW / 2,
      portraitY,
      portraitW,
      portraitH,
      SPACING.radiusMd,
    );
    this.cardContainer.add(plate);

    // Sprite — contained to the portrait plate. If the texture is
    // missing (placeholder failed, slow load) we fall back to a
    // centered emoji so the card still reads as "a thing" instead
    // of a blank square.
    if (this.textures.exists(entry.spriteKey)) {
      const spr = this.add.image(portraitCx, portraitCy, entry.spriteKey);
      spr.setOrigin(0.5, 0.5);
      const tex = this.textures.get(entry.spriteKey).getSourceImage();
      const nativeW = (tex as HTMLImageElement).width || portraitW;
      const nativeH = (tex as HTMLImageElement).height || portraitH;
      const sx = (portraitW - 16) / nativeW;
      const sy = (portraitH - 16) / nativeH;
      const scale = Math.min(sx, sy, 2);
      spr.setScale(scale);
      this.cardContainer.add(spr);
    } else {
      const glyph = this.add
        .text(portraitCx, portraitCy, '🐜', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '48px',
        })
        .setOrigin(0.5, 0.5);
      this.cardContainer.add(glyph);
    }

    // Body + power blurb. The body sits directly below the
    // portrait; power is the highlight strip at the bottom of
    // the card. Use Phaser's built-in wordWrap so the text flows
    // to whatever width the card is today.
    const bodyMarginX = 24;
    const bodyTop = portraitY + portraitH + 18;
    const bodyWidth = w - bodyMarginX * 2;
    const storyText = this.add
      .text(x + bodyMarginX, bodyTop, entry.story, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: COLOR.textPrimary,
        wordWrap: { width: bodyWidth, useAdvancedWrap: true },
        lineSpacing: 3,
      })
      .setOrigin(0, 0);
    this.cardContainer.add(storyText);

    // Power strip — pinned to the bottom of the card so the blurb
    // above can reflow without colliding with it.
    const powerStripH = 72;
    const powerStripY = y + h - powerStripH - 12;
    const strip = this.add.graphics();
    strip.fillStyle(0x1a2b1a, 1);
    strip.fillRoundedRect(
      x + bodyMarginX,
      powerStripY,
      w - bodyMarginX * 2,
      powerStripH,
      SPACING.radiusMd,
    );
    strip.lineStyle(1, COLOR.brass, 0.55);
    strip.strokeRoundedRect(
      x + bodyMarginX,
      powerStripY,
      w - bodyMarginX * 2,
      powerStripH,
      SPACING.radiusMd,
    );
    this.cardContainer.add(strip);

    const powerLabel = this.add
      .text(x + bodyMarginX + 12, powerStripY + 8, 'POWER', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '11px',
        color: COLOR.textGold,
        fontStyle: 'bold',
      })
      .setOrigin(0, 0);
    const powerText = this.add
      .text(x + bodyMarginX + 12, powerStripY + 26, entry.power, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: COLOR.textPrimary,
        wordWrap: { width: w - bodyMarginX * 2 - 24, useAdvancedWrap: true },
        lineSpacing: 2,
      })
      .setOrigin(0, 0);
    this.cardContainer.add([powerLabel, powerText]);

    // Prev / next nav — arrow buttons on the left / right of the
    // card, tucked at the vertical midpoint. Keyboard arrows +
    // thumbnail rail are the other two nav paths.
    const arrowY = y + h / 2;
    if (this.currentIdx > 0) {
      const prev = makeHiveButton(this, {
        x: x - 40,
        y: arrowY,
        width: 44,
        height: 44,
        label: '←',
        variant: 'secondary',
        fontSize: 18,
        onPress: () => this.setIndex(this.currentIdx - 1),
      });
      this.cardContainer.add(prev.container);
    }
    if (this.currentIdx < this.entries.length - 1) {
      const next = makeHiveButton(this, {
        x: x + w + 40,
        y: arrowY,
        width: 44,
        height: 44,
        label: '→',
        variant: 'secondary',
        fontSize: 18,
        onPress: () => this.setIndex(this.currentIdx + 1),
      });
      this.cardContainer.add(next.container);
    }

    // Counter in the top-right of the card chrome so the user
    // knows where they are in the deck.
    const counter = this.add
      .text(
        x + w - 16,
        y + 14,
        `${this.currentIdx + 1} / ${this.entries.length}`,
        {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '12px',
          color: COLOR.textDim,
        },
      )
      .setOrigin(1, 0);
    this.cardContainer.add(counter);
  }

  private renderRail(): void {
    this.railContainer.removeAll(true);
    const y = this.scale.height - RAIL_H;

    // Rail background strip.
    const bar = this.add.graphics();
    bar.fillStyle(0x0a120c, 0.85);
    bar.fillRect(0, y, this.scale.width, RAIL_H);
    bar.fillStyle(COLOR.brass, 0.35);
    bar.fillRect(0, y, this.scale.width, 1);
    this.railContainer.add(bar);

    // Thumbnails — a horizontal strip of every codex entry. The
    // current one is outlined brass; others are muted. Clicking
    // one jumps straight to that card.
    const totalW =
      this.entries.length * THUMB_W + (this.entries.length - 1) * RAIL_GAP;
    // If the rail fits, center it; otherwise pan on drag.
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
      thumbBg.fillStyle(active ? 0x2a4824 : 0x162317, 1);
      thumbBg.fillRoundedRect(thumbX, thumbY, THUMB_W, THUMB_H, SPACING.radiusSm);
      thumbBg.lineStyle(active ? 2 : 1, active ? COLOR.brass : COLOR.brassDeep, 1);
      thumbBg.strokeRoundedRect(
        thumbX,
        thumbY,
        THUMB_W,
        THUMB_H,
        SPACING.radiusSm,
      );
      thumbsHost.add(thumbBg);

      if (this.textures.exists(entry.spriteKey)) {
        const thumbImg = this.add.image(
          thumbX + THUMB_W / 2,
          thumbY + THUMB_H / 2,
          entry.spriteKey,
        );
        thumbImg.setOrigin(0.5, 0.5);
        const tex = this.textures.get(entry.spriteKey).getSourceImage();
        const nativeW = (tex as HTMLImageElement).width || THUMB_W;
        const nativeH = (tex as HTMLImageElement).height || THUMB_H;
        const scale = Math.min((THUMB_W - 8) / nativeW, (THUMB_H - 8) / nativeH);
        thumbImg.setScale(scale);
        thumbsHost.add(thumbImg);
      } else {
        const glyph = this.add
          .text(thumbX + THUMB_W / 2, thumbY + THUMB_H / 2, '❓', {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '28px',
          })
          .setOrigin(0.5, 0.5);
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
    // Horizontal drag on the rail area only — avoids capturing the
    // card above, where there's nothing to scroll. Clamped so the
    // edge cards are always reachable.
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

  private wireKeyboardNav(): void {
    // Arrow keys flip cards for desktop users who don't want to
    // chase the tiny buttons. Non-capturing so the user can still
    // scroll the rail with the mouse while a key is held.
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
    this.renderCard();
    this.renderRail();
  }
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}
