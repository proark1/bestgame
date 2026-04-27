import Phaser from 'phaser';
import { Types } from '@hive/shared';
import type { HiveRuntime } from '../main.js';
import type { HeroesStateResponse } from '../net/Api.js';
import { fadeInScene } from '../ui/transitions.js';
import { drawSceneAmbient, drawSceneHud, makeScrollBody } from '../ui/sceneFrame.js';
import { drawPanel } from '../ui/panel.js';
import { makeHiveButton } from '../ui/button.js';
import { crispText } from '../ui/text.js';
import {
  COLOR,
  DEPTHS,
  SPACING,
  bodyTextStyle,
  displayTextStyle,
  labelTextStyle,
} from '../ui/theme.js';

// HeroesScene — manage the player's hero roster.
// Shows every hero in the catalog. Cards split into three states:
//   - Locked (not yet owned, chest still claimable) → "Open Chest"
//     CTA modal that lets the player pick the first hero gift.
//   - Locked (owned others, chest claimed) → "Buy" CTA with the
//     server-quoted next-buy cost.
//   - Owned → "Equip" / "Unequip" toggle. At most MAX_EQUIPPED
//     heroes can be equipped at once.
//
// PR D wires equipped heroes into the raid deck + sim auras. This
// scene is the data-layer / pre-game cockpit.

export class HeroesScene extends Phaser.Scene {
  private state: HeroesStateResponse | null = null;
  private body!: ReturnType<typeof makeScrollBody>;
  private loadingText!: Phaser.GameObjects.Text;

  constructor() {
    super('HeroesScene');
  }

  create(): void {
    fadeInScene(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    drawSceneAmbient(this);
    drawSceneHud(this, 'Heroes', 'HomeScene');
    this.body = makeScrollBody(this);
    this.loadingText = crispText(
      this,
      this.scale.width / 2,
      140,
      'Summoning your champions...',
      bodyTextStyle(14, COLOR.textDim),
    ).setOrigin(0.5);
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) {
      this.loadingText.setText('Offline — no heroes');
      return;
    }
    try {
      this.state = await runtime.api.getHeroes();
      if (!this.scene.isActive()) return;
      this.loadingText.setVisible(false);
      this.render();
    } catch (err) {
      if (!this.scene.isActive()) return;
      this.loadingText.setText(`Error: ${(err as Error).message}`);
    }
  }

  private render(): void {
    if (!this.state) return;
    this.body.container.removeAll(true);
    const maxW = Math.min(640, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    let y = 0;

    // Intro line — explains the slot cap so the player understands
    // why owning all four still leaves them choosing two.
    this.body.container.add(
      crispText(
        this,
        originX,
        y,
        `Equip up to ${this.state.maxEquipped} heroes for your next raid. ` +
          `Heroes give buffs to nearby allies — see the aura on each card.`,
        bodyTextStyle(13, COLOR.textDim),
      ).setWordWrapWidth(maxW, true),
    );
    y += 56;

    // First-hero chest CTA — only if not yet claimed. Renders a
    // distinct gilded card so it reads as a free reward, not a
    // purchase.
    if (!this.state.ownership.chestClaimed) {
      y = this.renderChestCard(originX, maxW, y);
      y += SPACING.lg;
    }

    const kinds = Object.keys(this.state.catalog) as Types.HeroKind[];
    for (const kind of kinds) {
      y = this.renderHeroCard(kind, originX, maxW, y);
      y += SPACING.md;
    }
    this.body.setContentHeight(y);
  }

  private renderChestCard(originX: number, maxW: number, top: number): number {
    const h = 138;
    const bg = this.add.graphics();
    drawPanel(bg, originX, top, maxW, h, {
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.32,
      radius: 14,
      shadowOffset: 5,
      shadowAlpha: 0.32,
    });
    this.body.container.add(bg);
    this.body.container.add(
      crispText(
        this,
        originX + 18,
        top + 16,
        '🎁 Free hero chest',
        displayTextStyle(18, COLOR.textGold, 3),
      ),
    );
    this.body.container.add(
      crispText(
        this,
        originX + 18,
        top + 46,
        'Pick one hero to start your roster — no resources spent.',
        bodyTextStyle(13, COLOR.textPrimary),
      ).setWordWrapWidth(maxW - 36, true),
    );
    const btn = makeHiveButton(this, {
      x: originX + maxW - 100,
      y: top + h - 32,
      width: 180,
      height: 40,
      label: 'Open chest',
      variant: 'primary',
      fontSize: 14,
      onPress: () => this.openChestModal(),
    });
    this.body.container.add(btn.container);
    return top + h;
  }

  private renderHeroCard(
    kind: Types.HeroKind,
    originX: number,
    maxW: number,
    top: number,
  ): number {
    if (!this.state) return top;
    const def = this.state.catalog[kind];
    const owned = !!this.state.ownership.owned[kind];
    const equipped = this.state.ownership.equipped.includes(kind);
    const fullSlots =
      this.state.ownership.equipped.length >= this.state.maxEquipped &&
      !equipped;
    const h = 168;

    const bg = this.add.graphics();
    drawPanel(bg, originX, top, maxW, h, {
      stroke: equipped ? COLOR.brass : COLOR.brassDeep,
      strokeWidth: equipped ? 3 : 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.18,
      radius: 14,
      shadowOffset: 4,
      shadowAlpha: 0.26,
    });
    this.body.container.add(bg);

    // Portrait — falls back to a glyph if the sprite isn't loaded
    // yet (sprite art lands separately via the admin tool).
    const portraitX = originX + 56;
    const portraitY = top + h / 2;
    if (this.textures.exists(def.spriteKey)) {
      const img = this.add.image(portraitX, portraitY, def.spriteKey);
      img.setDisplaySize(96, 96);
      this.body.container.add(img);
    } else {
      // Procedural fallback: brass disc + first letter, mirrors
      // BootScene's placeholder pattern for unit kinds. Disc is
      // sized to match the eventual sprite footprint so cards stay
      // visually aligned once art lands.
      const circle = this.add.graphics();
      circle.fillStyle(COLOR.brass, 1);
      circle.fillCircle(portraitX, portraitY, 44);
      circle.lineStyle(3, COLOR.brassDeep, 1);
      circle.strokeCircle(portraitX, portraitY, 44);
      this.body.container.add(circle);
      this.body.container.add(
        crispText(
          this,
          portraitX,
          portraitY,
          def.name.charAt(0),
          displayTextStyle(28, COLOR.textDark, 2),
        ).setOrigin(0.5, 0.5),
      );
    }

    const textX = originX + 124;
    this.body.container.add(
      crispText(
        this,
        textX,
        top + 14,
        def.name,
        displayTextStyle(18, COLOR.textGold, 3),
      ),
    );
    this.body.container.add(
      crispText(this, textX, top + 42, def.role, labelTextStyle(11, COLOR.textPrimary)),
    );
    this.body.container.add(
      crispText(
        this,
        textX,
        top + 60,
        Types.describeAura(def.aura),
        bodyTextStyle(12, COLOR.textPrimary),
        // Right edge clearance accounts for the action button at
        // `actionX = originX + maxW - 80` with a max width of 150
        // (Buy CTA), plus a small visual gap. Earlier value of 124
        // left the aura text overlapping the button on the larger
        // hero descriptions.
      ).setWordWrapWidth(maxW - (textX - originX) - 165, true),
    );
    this.body.container.add(
      crispText(
        this,
        textX,
        top + h - 26,
        `HP ${def.hpMax} · DMG ${def.attackDamage} · SPD ${def.speed}`,
        labelTextStyle(11, COLOR.textDim),
      ),
    );

    // Right-side action area. Owned ⇒ Equip/Unequip toggle. Not
    // owned + chest claimed ⇒ Buy CTA. Not owned + chest available
    // ⇒ disabled chest hint (the chest card above is the entry).
    const actionX = originX + maxW - 80;
    const actionY = top + h - 30;
    if (owned) {
      const btn = makeHiveButton(this, {
        x: actionX,
        y: actionY,
        width: 130,
        height: 36,
        label: equipped ? 'Equipped' : (fullSlots ? 'Slots full' : 'Equip'),
        variant: equipped ? 'ghost' : 'primary',
        fontSize: 13,
        onPress: () => {
          if (fullSlots) return;
          void this.toggleEquip(kind, !equipped);
        },
        enabled: !fullSlots || equipped,
      });
      this.body.container.add(btn.container);
    } else if (this.state.ownership.chestClaimed) {
      const cost = this.state.nextBuyCost;
      const canAfford =
        this.state.wallet.sugar >= cost.sugar &&
        this.state.wallet.aphidMilk >= cost.aphidMilk;
      const btn = makeHiveButton(this, {
        x: actionX,
        y: actionY,
        width: 150,
        height: 36,
        label: `${cost.sugar.toLocaleString()}🍯 ${cost.aphidMilk}🥛`,
        variant: canAfford ? 'primary' : 'ghost',
        fontSize: 12,
        onPress: () => {
          if (!canAfford) return;
          void this.buy(kind);
        },
        enabled: canAfford,
      });
      this.body.container.add(btn.container);
    } else {
      // Chest still available — point the player to the chest card
      // above instead of letting them buy at full price. This stays
      // a hint rather than a button so the affordance reads clearly.
      this.body.container.add(
        crispText(
          this,
          actionX,
          actionY,
          'Open the chest above',
          labelTextStyle(11, COLOR.textDim),
        ).setOrigin(0.5, 0.5),
      );
    }
    return top + h;
  }

  private async toggleEquip(kind: Types.HeroKind, equipped: boolean): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      await runtime.api.equipHero(kind, equipped);
      await this.refresh();
    } catch (err) {
      this.flashErr((err as Error).message);
    }
  }

  private async buy(kind: Types.HeroKind): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const res = await runtime.api.buyHero(kind);
      if (runtime.player) {
        runtime.player.player.sugar = res.wallet.sugar;
        runtime.player.player.aphidMilk = res.wallet.aphidMilk;
      }
      await this.refresh();
    } catch (err) {
      this.flashErr((err as Error).message);
    }
  }

  // Modal that lets the player pick which hero to receive from the
  // free chest. Renders all four cards on a backdrop; tapping one
  // claims and refreshes the scene.
  private openChestModal(): void {
    if (!this.state) return;
    const w = Math.min(560, this.scale.width - 32);
    const h = Math.min(420, this.scale.height - 64);
    const ox = (this.scale.width - w) / 2;
    const oy = (this.scale.height - h) / 2;
    const container = this.add.container(0, 0).setDepth(DEPTHS.drawerBackdrop);

    const dim = this.add.rectangle(0, 0, this.scale.width, this.scale.height, 0x000000, 0.62)
      .setOrigin(0, 0)
      .setInteractive();
    dim.on('pointerdown', () => container.destroy(true));
    container.add(dim);

    // Swallow taps on the panel itself so clicks on the title /
    // description / empty cells don't bubble to `dim` and close the
    // modal. Without this any click inside the panel area
    // accidentally dismisses the picker — the user-facing review
    // flagged this as the modal "closing on any internal click".
    const panelHit = this.add.zone(ox + w / 2, oy + h / 2, w, h)
      .setOrigin(0.5, 0.5)
      .setInteractive();
    panelHit.on('pointerdown', (
      _p: Phaser.Input.Pointer,
      _lx: number,
      _ly: number,
      e: Phaser.Types.Input.EventData,
    ) => {
      e?.stopPropagation?.();
    });

    container.add(panelHit);

    const bg = this.add.graphics();
    drawPanel(bg, ox, oy, w, h, {
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.32,
      radius: 16,
      shadowOffset: 6,
      shadowAlpha: 0.4,
    });
    container.add(bg);
    container.add(
      crispText(this, ox + 18, oy + 14, '🎁 Pick your starter hero',
        displayTextStyle(18, COLOR.textGold, 3)),
    );
    container.add(
      crispText(this, ox + 18, oy + 44, 'Free choice. Tap a hero to claim.',
        bodyTextStyle(12, COLOR.textPrimary)),
    );

    // 2×2 grid of hero tiles inside the modal.
    const kinds = Object.keys(this.state.catalog) as Types.HeroKind[];
    const cellW = (w - 60) / 2;
    const cellH = (h - 90) / 2;
    kinds.forEach((kind, i) => {
      if (!this.state) return;
      const def = this.state.catalog[kind];
      const col = i % 2;
      const row = Math.floor(i / 2);
      const cx = ox + 20 + col * (cellW + 20);
      const cy = oy + 70 + row * (cellH + 8);
      const tile = this.add.graphics();
      drawPanel(tile, cx, cy, cellW, cellH, {
        stroke: COLOR.brassDeep,
        strokeWidth: 1,
        highlight: COLOR.brass,
        highlightAlpha: 0.14,
        radius: 10,
        shadowOffset: 2,
        shadowAlpha: 0.2,
      });
      container.add(tile);
      container.add(
        crispText(this, cx + 14, cy + 12, def.name, displayTextStyle(14, COLOR.textGold, 2)),
      );
      container.add(
        crispText(this, cx + 14, cy + 36, def.role, labelTextStyle(10, COLOR.textPrimary)),
      );
      container.add(
        crispText(this, cx + 14, cy + 56, Types.describeAura(def.aura),
          bodyTextStyle(11, COLOR.textPrimary)).setWordWrapWidth(cellW - 28, true),
      );
      const hit = this.add.zone(cx + cellW / 2, cy + cellH / 2, cellW, cellH)
        .setOrigin(0.5, 0.5)
        .setInteractive({ useHandCursor: true });
      hit.on('pointerdown', () => {
        container.destroy(true);
        void this.claimChest(kind);
      });
      container.add(hit);
    });
  }

  private async claimChest(kind: Types.HeroKind): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      // Fire the server claim and the reveal fanfare in parallel —
      // the network round-trip is normally <100 ms but the
      // animation runs ~2 seconds, so a slow network just delays
      // the final refresh, not the celebration. The fanfare's
      // promise resolves either when the animation finishes or
      // when the player skips it (review-flagged: a fixed
      // delayedCall ignored the skip and felt unresponsive).
      const claim = runtime.api.claimHeroChest(kind);
      const fanfare = this.playChestFanfare(kind);
      await Promise.all([claim, fanfare]);
      await this.refresh();
    } catch (err) {
      this.flashErr((err as Error).message);
    }
  }

  // Full-screen reveal ceremony — chest shakes, glows, opens, the
  // hero portrait rises out with a spotlight + name + role. Pure
  // visual: no server interaction. Returns a Promise that resolves
  // either when the animation finishes (~2.4 s) OR when the player
  // taps to skip — caller awaits this to know when it's safe to
  // re-render the underlying scene.
  private playChestFanfare(kind: Types.HeroKind): Promise<void> {
    if (!this.state) return Promise.resolve();
    const def = this.state.catalog[kind];
    const W = this.scale.width;
    const H = this.scale.height;
    const overlay = this.add.container(0, 0).setDepth(DEPTHS.resultBackdrop);

    // Solid black backdrop fades in so the playfield drops away.
    const dim = this.add.rectangle(0, 0, W, H, 0x000000, 0.0).setOrigin(0, 0).setInteractive();
    overlay.add(dim);
    this.tweens.add({ targets: dim, fillAlpha: 0.78, duration: 250, ease: 'Sine.easeOut' });

    // Track every deferred timer + scheduled tween so a skip can
    // tear them all down. Without this, a skipped fanfare would
    // leave the stage 2/3 callbacks queued and fire them against a
    // destroyed overlay (review-flagged: high-priority crash).
    const pendingTimers: Phaser.Time.TimerEvent[] = [];
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((res) => { resolveDone = res; });
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      for (const t of pendingTimers) t.remove(false);
      this.tweens.killTweensOf(overlay);
      this.tweens.killTweensOf(dim);
      if (overlay.active) overlay.destroy(true);
      resolveDone();
    };
    dim.on('pointerdown', finish);

    // Stage 1: chest sits center-screen, shakes, then opens.
    const chestSize = Math.min(180, Math.min(W, H) * 0.32);
    const chestY = H * 0.42;
    const chestBg = this.add.graphics();
    chestBg.fillStyle(COLOR.brassDeep, 1);
    chestBg.fillRoundedRect(-chestSize / 2, -chestSize / 2, chestSize, chestSize * 0.78, 14);
    chestBg.lineStyle(4, 0xffe7b0, 1);
    chestBg.strokeRoundedRect(-chestSize / 2, -chestSize / 2, chestSize, chestSize * 0.78, 14);
    chestBg.fillStyle(COLOR.brass, 1);
    chestBg.fillRoundedRect(-chestSize / 2 + 8, -chestSize / 2 + 8, chestSize - 16, chestSize * 0.16, 6);
    // Lock + glyph.
    const glyph = crispText(this, 0, 0, '🎁', displayTextStyle(Math.floor(chestSize * 0.4), '#3a2a08', 2)).setOrigin(0.5, 0.5);
    const chest = this.add.container(W / 2, chestY, [chestBg, glyph]);
    chest.setScale(0.4);
    overlay.add(chest);

    // Pop + shake. Pop scales it up; shake oscillates rotation.
    this.tweens.add({
      targets: chest,
      scale: 1,
      duration: 360,
      ease: 'Back.easeOut',
    });
    this.tweens.add({
      targets: chest,
      angle: { from: -6, to: 6 },
      duration: 80,
      yoyo: true,
      repeat: 8,
      delay: 360,
      ease: 'Sine.easeInOut',
    });

    // Stage 2: glow radiates outward, chest fades; hero rises.
    const ring = this.add.graphics();
    ring.fillStyle(0xfff2b8, 0);
    overlay.add(ring);
    const glowRadius = { r: 0, alpha: 0.5 };
    pendingTimers.push(this.time.delayedCall(1100, () => {
      if (finished) return;
      this.tweens.add({
        targets: glowRadius,
        r: chestSize * 1.6,
        alpha: 0,
        duration: 700,
        ease: 'Cubic.easeOut',
        onUpdate: () => {
          if (!ring.active) return;
          ring.clear();
          ring.fillStyle(0xfff2b8, glowRadius.alpha);
          ring.fillCircle(W / 2, chestY, glowRadius.r);
        },
        onComplete: () => { if (ring.active) ring.destroy(); },
      });
      this.tweens.add({
        targets: chest,
        scale: 0.6,
        alpha: 0,
        duration: 400,
        ease: 'Sine.easeIn',
        onComplete: () => { if (chest.active) chest.destroy(); },
      });
    }));

    // Stage 3: hero portrait + name + role panel.
    pendingTimers.push(this.time.delayedCall(1450, () => {
      if (finished) return;
      const heroSize = Math.floor(chestSize * 1.05);
      const heroY = chestY - 8;
      let portrait: Phaser.GameObjects.GameObject;
      if (this.textures.exists(def.spriteKey)) {
        const img = this.add.image(W / 2, heroY, def.spriteKey).setDisplaySize(heroSize, heroSize);
        portrait = img;
      } else {
        // Fallback brass disc + first letter, matching the card portrait.
        const fb = this.add.container(W / 2, heroY);
        const disc = this.add.graphics();
        disc.fillStyle(COLOR.brass, 1);
        disc.fillCircle(0, 0, heroSize / 2);
        disc.lineStyle(4, COLOR.brassDeep, 1);
        disc.strokeCircle(0, 0, heroSize / 2);
        const letter = crispText(this, 0, 0, def.name.charAt(0), displayTextStyle(Math.floor(heroSize * 0.45), COLOR.textDark, 2)).setOrigin(0.5, 0.5);
        fb.add([disc, letter]);
        portrait = fb;
      }
      // Phaser GameObject doesn't expose alpha/scale on the base type;
      // we know our portrait variants both support the standard mixin.
      const p = portrait as unknown as Phaser.GameObjects.Image;
      p.setAlpha(0);
      p.setScale(0.7);
      overlay.add(portrait);
      this.tweens.add({
        targets: portrait,
        alpha: 1,
        scale: 1,
        duration: 480,
        ease: 'Back.easeOut',
      });
      // Name + role labels.
      const nameY = heroY + heroSize / 2 + 24;
      const name = crispText(this, W / 2, nameY, def.name, displayTextStyle(28, COLOR.textGold, 4)).setOrigin(0.5, 0.5);
      const role = crispText(this, W / 2, nameY + 32, def.role, labelTextStyle(14, COLOR.textOnDark)).setOrigin(0.5, 0.5);
      name.setAlpha(0); role.setAlpha(0);
      overlay.add(name); overlay.add(role);
      this.tweens.add({ targets: [name, role], alpha: 1, duration: 360, delay: 200, ease: 'Sine.easeOut' });
    }));

    // Auto-finish after the full ceremony — same delay claimChest
    // used to await directly. With the timer captured here, a skip
    // tears it down too.
    pendingTimers.push(this.time.delayedCall(2400, finish));

    return done;
  }

  private flashErr(msg: string): void {
    const t = crispText(this, this.scale.width / 2, this.scale.height - 80,
      msg, bodyTextStyle(13, COLOR.textError)).setOrigin(0.5, 0.5).setDepth(DEPTHS.toast);
    this.tweens.add({ targets: t, alpha: 0, delay: 1800, duration: 320,
      onComplete: () => t.destroy() });
  }
}
