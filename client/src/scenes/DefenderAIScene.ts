import Phaser from 'phaser';
import type { Types } from '@hive/shared';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import type { HiveRuntime } from '../main.js';
import { crispText } from '../ui/text.js';
import { makeHiveButton } from '../ui/button.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { COLOR, DEPTHS, bodyTextStyle, displayTextStyle, labelTextStyle } from '../ui/theme.js';
import type {
  AIRuleCatalogResponse,
  AIRuleCatalogEffect,
  AIRuleCatalogTrigger,
} from '../net/Api.js';

// Defender AI editor — the game's differentiating mechanic.
//
// Lists every building in the player's base; for each, shows the
// current rule list (a trigger + effect + params tuple) and a
// "+ Add rule" button. The rule editor is a simple modal with two
// dropdowns (trigger, effect) and param number inputs driven by the
// server-provided catalog. Saving sends a PUT to
// /api/player/building/:id/ai. Server revalidates every rule before
// storing, so this UI is a convenience layer — not the source of
// truth on legal combos.
//
// Keeping the editor local (one scene, one modal) means balance
// changes on the server propagate automatically without shipping
// client.

const HUD_H = 56;

// Stable short labels for the 6 triggers / 7 effects. Falls back to
// the raw id if the server adds one we haven't localized yet.
const TRIGGER_SHORT: Record<string, string> = {
  onLowHp: 'When low HP',
  onEnemyInRange: 'When enemy in range',
  onFlyerInRange: 'When flyer in range',
  onQueenThreatened: 'When queen threatened',
  onTick: 'Every N ticks',
  onAllyDestroyed: 'When ally destroyed',
};
const EFFECT_SHORT: Record<string, string> = {
  boostAttackDamage: 'Boost damage',
  boostAttackRate: 'Fire faster',
  extendAttackRange: 'Extend range',
  revealSelf: 'Reveal self',
  extraSpawn: 'Extra spawn',
  healSelf: 'Heal self',
  aoeRoot: 'AOE root',
};

// Defaults when a player first adds a new rule — chosen from the
// middle of each param's allowed range so the preview is visually
// interesting without being overpowered.
const DEFAULT_PARAMS: Record<string, Types.BuildingAIRule['params']> = {
  onLowHp: { percent: 40 },
  onEnemyInRange: { radius: 3 },
  onFlyerInRange: { radius: 3 },
  onQueenThreatened: { radius: 4 },
  onTick: { ticks: 120 },
  onAllyDestroyed: {},

  boostAttackDamage: { percent: 150, durationTicks: 90 },
  boostAttackRate: { rate: 2, durationTicks: 90 },
  extendAttackRange: { range: 1, durationTicks: 90 },
  revealSelf: {},
  extraSpawn: { maxExtra: 2 },
  healSelf: { hp: 80 },
  aoeRoot: { radius: 2, durationTicks: 60 },
};

export class DefenderAIScene extends Phaser.Scene {
  private catalog: AIRuleCatalogResponse | null = null;
  private base: Types.Base | null = null;
  private rowContainer!: Phaser.GameObjects.Container;
  private loadingText!: Phaser.GameObjects.Text;
  private quotaText!: Phaser.GameObjects.Text;
  private viewportTop = HUD_H + 50;
  private contentHeight = 0;
  private scrollOffset = 0;
  private scrolling = false;
  private scrollStartY = 0;
  private scrollStartOffset = 0;
  private errorText: Phaser.GameObjects.Text | null = null;
  private modal: Phaser.GameObjects.Container | null = null;

  constructor() {
    super('DefenderAIScene');
  }

  create(): void {
    fadeInScene(this);
    installSceneClickDebug(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    this.drawAmbient();
    this.drawHud();
    this.quotaText = crispText(
      this,
      this.scale.width / 2,
      HUD_H + 22,
      '',
      bodyTextStyle(12, COLOR.textDim),
    ).setOrigin(0.5);
    this.rowContainer = this.add.container(0, this.viewportTop);
    this.loadingText = crispText(
      this,
      this.scale.width / 2,
      HUD_H + 100,
      'Loading defender brain...',
      bodyTextStyle(14, COLOR.textDim),
    ).setOrigin(0.5);
    this.wireScroll();
    void this.fetchAll();
  }

  private drawAmbient(): void {
    const g = this.add.graphics().setDepth(DEPTHS.background);
    const top = 0x203224;
    const bot = 0x070d08;
    const bands = 18;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      const r = Math.round(((top >> 16) & 0xff) + (((bot >> 16) & 0xff) - ((top >> 16) & 0xff)) * t);
      const gc = Math.round(((top >> 8) & 0xff) + (((bot >> 8) & 0xff) - ((top >> 8) & 0xff)) * t);
      const b = Math.round((top & 0xff) + ((bot & 0xff) - (top & 0xff)) * t);
      g.fillStyle((r << 16) | (gc << 8) | b, 1);
      g.fillRect(
        0,
        Math.floor((i * this.scale.height) / bands),
        this.scale.width,
        Math.ceil(this.scale.height / bands) + 1,
      );
    }
    const glow = this.add.graphics().setDepth(DEPTHS.ambient);
    glow.fillStyle(COLOR.brass, 0.05);
    glow.fillEllipse(this.scale.width / 2, HUD_H + 160, Math.min(860, this.scale.width * 0.9), 220);
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
    hud.fillStyle(0x000000, 0.4);
    hud.fillRect(0, HUD_H, w, 3);
    crispText(
      this,
      this.scale.width / 2,
      HUD_H / 2,
      'Defender AI',
      displayTextStyle(20, COLOR.textGold, 4),
    ).setOrigin(0.5);
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
  }

  private wireScroll(): void {
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (this.modal) return; // swallowed by modal
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
        if (this.modal) return;
        this.setScroll(this.scrollOffset - dy);
      },
    );
  }

  private setScroll(raw: number): void {
    const viewportH = this.scale.height - this.viewportTop - 16;
    const minOffset = Math.min(0, viewportH - this.contentHeight);
    this.scrollOffset = Phaser.Math.Clamp(raw, minOffset, 0);
    this.rowContainer.y = this.viewportTop + this.scrollOffset;
  }

  private async fetchAll(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime || !runtime.player) {
      this.loadingText.setText('Offline — cannot edit rules');
      return;
    }
    try {
      const [cat, me] = await Promise.all([
        runtime.api.getAIRulesCatalog(),
        runtime.api.getPlayerMe(),
      ]);
      if (!this.scene.isActive()) return;
      this.catalog = cat;
      this.base = me.base;
      // Refresh the cached runtime.player so other scenes see the
      // latest base too.
      runtime.player = me;
      this.loadingText.destroy();
      this.render();
    } catch (err) {
      if (!this.scene.isActive()) return;
      this.loadingText.setText(`Error: ${(err as Error).message}`);
    }
  }

  private queenLevel(): number {
    if (!this.base) return 1;
    const q = this.base.buildings.find((b) => b.kind === 'QueenChamber');
    return Math.max(1, Math.min(5, q?.level ?? 1));
  }

  private rulesInBase(): number {
    if (!this.base) return 0;
    return this.base.buildings.reduce((n, b) => n + (b.aiRules?.length ?? 0), 0);
  }

  private render(): void {
    this.rowContainer.removeAll(true);
    if (!this.catalog || !this.base) return;
    const qLevel = this.queenLevel();
    const unlockAt = this.catalog.limits.unlockQueenLevel;
    const quota = this.catalog.limits.quotaByQueenLevel[qLevel] ?? 0;
    const used = this.rulesInBase();
    if (qLevel < unlockAt) {
      this.quotaText.setText(
        `Defender AI unlocks at Queen L${unlockAt} (you're L${qLevel}).`,
      );
      return;
    }
    this.quotaText.setText(
      `Queen L${qLevel} · ${used}/${quota} rules used across base`,
    );

    const maxW = Math.min(620, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    let y = 0;

    // List one row per building that can accept rules (i.e. at least
    // one effect kind matches it).
    const buildings = this.base.buildings.filter((b) =>
      this.catalog!.effects.some((e) => e.allowedKinds.includes(b.kind)),
    );
    for (const b of buildings) {
      y = this.renderBuildingRow(b, originX, maxW, y);
    }
    this.contentHeight = y + 16;
  }

  private renderBuildingRow(
    b: Types.Building,
    originX: number,
    maxW: number,
    y: number,
  ): number {
    const rowH = 88;
    const bg = this.add.graphics();
    drawPanel(bg, originX, y, maxW, rowH, {
      topColor: COLOR.bgCard,
      botColor: COLOR.bgInset,
      stroke: COLOR.outline,
      strokeWidth: 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.08,
      radius: 12,
      shadowOffset: 3,
      shadowAlpha: 0.2,
    });
    this.rowContainer.add(bg);

    const icon = this.add
      .image(originX + 36, y + rowH / 2, `building-${b.kind}`)
      .setDisplaySize(48, 48);
    this.rowContainer.add(icon);

    this.rowContainer.add(
      crispText(this, originX + 72, y + 12, b.kind, bodyTextStyle(14, COLOR.textPrimary)).setOrigin(0, 0),
    );
    const rules = b.aiRules ?? [];
    const desc =
      rules.length === 0
        ? 'No rules — tap Edit to add one'
        : rules
            .map(
              (r) =>
                `${TRIGGER_SHORT[r.trigger] ?? r.trigger} → ${
                  EFFECT_SHORT[r.effect] ?? r.effect
                }`,
            )
            .join(', ');
    this.rowContainer.add(
      crispText(this, originX + 72, y + 38, desc, bodyTextStyle(11, COLOR.textDim))
        .setOrigin(0, 0)
        .setWordWrapWidth(maxW - 176, true),
    );

    const btn = makeHiveButton(this, {
      x: originX + maxW - 56,
      y: y + rowH / 2,
      width: 84,
      height: 34,
      label: 'Edit',
      variant: 'secondary',
      fontSize: 12,
      onPress: () => this.openEditor(b),
    });
    this.rowContainer.add(btn.container);

    return y + rowH + 8;
  }

  // -- editor modal ---------------------------------------------------------

  private openEditor(b: Types.Building): void {
    if (!this.catalog) return;
    this.closeEditor();
    const W = Math.min(520, this.scale.width - 24);
    const H = Math.min(520, this.scale.height - 80);
    const ox = (this.scale.width - W) / 2;
    const oy = (this.scale.height - H) / 2;
    const container = this.add.container(0, 0).setDepth(500);
    this.modal = container;

    const back = this.add.graphics();
    back.fillStyle(0x000000, 0.7);
    back.fillRect(0, 0, this.scale.width, this.scale.height);
    const backZone = this.add
      .zone(0, 0, this.scale.width, this.scale.height)
      .setOrigin(0, 0)
      .setInteractive();
    backZone.on('pointerdown', () => this.closeEditor());
    container.add([back, backZone]);

    const card = this.add.graphics();
    card.fillStyle(0x1a2b1a, 0.98);
    card.lineStyle(3, 0xffd98a, 1);
    card.fillRoundedRect(ox, oy, W, H, 12);
    card.strokeRoundedRect(ox, oy, W, H, 12);
    const cardZone = this.add
      .zone(ox, oy, W, H)
      .setOrigin(0, 0)
      .setInteractive();
    container.add([card, cardZone]);

    container.add(
      this.text(
        ox + W / 2,
        oy + 16,
        `Rules for ${b.kind}`,
        '#ffd98a',
        15,
        0.5,
        0,
      ),
    );

    // Work on a mutable copy so cancel doesn't persist local tweaks.
    const working: Types.BuildingAIRule[] = (b.aiRules ?? []).map((r) => ({
      ...r,
      params: { ...r.params },
    }));

    const drawRules = (): void => {
      // Clear rule widgets (keep background). We re-add everything
      // between the header and the footer on each re-draw.
      const preserved = [back, backZone, card, cardZone];
      container.list.slice().forEach((c) => {
        if (!preserved.includes(c as never)) (c as Phaser.GameObjects.GameObject).destroy();
      });
      container.removeAll(false);
      container.add(preserved);
      container.add(
        this.text(
          ox + W / 2,
          oy + 16,
          `Rules for ${b.kind}`,
          '#ffd98a',
          15,
          0.5,
          0,
        ),
      );

      // Render each existing rule.
      let yy = oy + 48;
      working.forEach((r, i) => {
        const rowBg = this.add.graphics();
        rowBg.fillStyle(0x0f1b10, 0.8);
        rowBg.lineStyle(1, 0x2c5a23, 1);
        rowBg.fillRoundedRect(ox + 12, yy, W - 24, 80, 6);
        rowBg.strokeRoundedRect(ox + 12, yy, W - 24, 80, 6);
        container.add(rowBg);

        // Trigger cycle button
        const triggerLabel = TRIGGER_SHORT[r.trigger] ?? r.trigger;
        container.add(
          this.text(ox + 22, yy + 10, 'Trigger', '#ffd98a', 10, 0, 0),
        );
        const tBtn = this.textButton(
          ox + 22,
          yy + 28,
          triggerLabel,
          () => this.cycleTrigger(r, b.kind, working, i, drawRules),
        );
        container.add(tBtn);

        // Effect cycle button
        container.add(
          this.text(ox + 22 + 200, yy + 10, 'Effect', '#ffd98a', 10, 0, 0),
        );
        const eBtn = this.textButton(
          ox + 22 + 200,
          yy + 28,
          EFFECT_SHORT[r.effect] ?? r.effect,
          () => this.cycleEffect(r, b.kind, working, i, drawRules),
        );
        container.add(eBtn);

        // Param adjusters — render one per param key required by the
        // combo of (trigger, effect). Adjust via +/- buttons.
        const paramKeys = this.paramKeysFor(r.trigger, r.effect);
        paramKeys.forEach((rawKey, j) => {
          // The catalog types `params` keys narrowly; cast once here
          // so read/write stays type-safe downstream.
          const k = rawKey as keyof Types.BuildingAIRule['params'];
          const px = ox + 22 + j * 110;
          const py = yy + 52;
          container.add(
            this.text(px, py, rawKey, '#c3e8b0', 9, 0, 0),
          );
          const cur = r.params[k] ?? 0;
          container.add(
            this.text(px, py + 12, String(cur), '#ffffff', 12, 0, 0),
          );
          const minus = this.textButton(px + 56, py + 8, '–', () => {
            r.params[k] = Math.max(0, (r.params[k] ?? 0) - this.paramStep(rawKey));
            drawRules();
          });
          const plus = this.textButton(px + 80, py + 8, '+', () => {
            r.params[k] = (r.params[k] ?? 0) + this.paramStep(rawKey);
            drawRules();
          });
          container.add([minus, plus]);
        });

        const rm = this.textButton(ox + W - 42, yy + 10, '✕', () => {
          working.splice(i, 1);
          drawRules();
        }, { color: '#d94c4c' });
        container.add(rm);

        yy += 88;
      });

      // Footer buttons: Add / Cancel / Save.
      const footerY = oy + H - 44;
      const canAdd = working.length < (this.catalog?.limits.maxRulesPerBuilding ?? 8);
      const addBtn = this.textButton(
        ox + 22,
        footerY,
        canAdd ? '+ Add rule' : '(max rules)',
        () => {
          if (!canAdd) return;
          const seed = this.seedRule(b.kind);
          if (seed) {
            working.push(seed);
            drawRules();
          }
        },
        { color: canAdd ? '#c3e8b0' : '#777' },
      );
      container.add(addBtn);

      const cancelBtn = this.textButton(ox + W - 170, footerY, 'Cancel', () =>
        this.closeEditor(),
      );
      container.add(cancelBtn);

      const saveBtn = this.textButton(
        ox + W - 90,
        footerY,
        'Save',
        () => void this.saveRules(b.id, working),
        { color: '#ffd98a' },
      );
      container.add(saveBtn);
    };

    drawRules();
  }

  private closeEditor(): void {
    if (this.modal) {
      this.modal.destroy(true);
      this.modal = null;
    }
  }

  private paramKeysFor(
    trigger: Types.AIRuleTrigger,
    effect: Types.AIRuleEffect,
  ): string[] {
    const t = this.catalog?.triggers.find((x) => x.id === trigger);
    const e = this.catalog?.effects.find((x) => x.id === effect);
    // Use a Set-like dedupe so overlapping keys (durationTicks on
    // effect, etc.) only render once.
    const keys: string[] = [];
    for (const k of t?.params ?? []) if (!keys.includes(k)) keys.push(k);
    for (const k of e?.params ?? []) if (!keys.includes(k)) keys.push(k);
    return keys;
  }

  // Step size per param so +/- buttons move in sensible increments.
  private paramStep(k: string): number {
    switch (k) {
      case 'percent': return 10;
      case 'radius': return 0.5;
      case 'ticks': return 15;
      case 'durationTicks': return 15;
      case 'rate': return 1;
      case 'range': return 0.5;
      case 'maxExtra': return 1;
      case 'hp': return 20;
      default: return 1;
    }
  }

  private validEffectsFor(kind: Types.BuildingKind): AIRuleCatalogEffect[] {
    if (!this.catalog) return [];
    return this.catalog.effects.filter((e) => e.allowedKinds.includes(kind));
  }

  private validTriggersFor(
    kind: Types.BuildingKind,
    effectId: Types.AIRuleEffect,
  ): AIRuleCatalogTrigger[] {
    if (!this.catalog) return [];
    const allowedTriggers = new Set(
      this.catalog.combos
        .filter((c) => c.effect === effectId)
        .map((c) => c.trigger),
    );
    return this.catalog.triggers.filter(
      (t) => allowedTriggers.has(t.id) && this.validEffectsFor(kind).some((e) => e.id === effectId),
    );
  }

  private seedRule(kind: Types.BuildingKind): Types.BuildingAIRule | null {
    // First effect the kind supports, then first trigger that pairs
    // with that effect — gives the player a non-empty starting point.
    const effects = this.validEffectsFor(kind);
    if (effects.length === 0) return null;
    const eff = effects[0]!;
    const triggers = this.validTriggersFor(kind, eff.id);
    if (triggers.length === 0) return null;
    const trig = triggers[0]!;
    return {
      id: `new-${Date.now()}`,
      trigger: trig.id,
      effect: eff.id,
      params: {
        ...(DEFAULT_PARAMS[trig.id] ?? {}),
        ...(DEFAULT_PARAMS[eff.id] ?? {}),
      },
    };
  }

  private cycleTrigger(
    r: Types.BuildingAIRule,
    kind: Types.BuildingKind,
    _list: Types.BuildingAIRule[],
    _idx: number,
    redraw: () => void,
  ): void {
    const triggers = this.validTriggersFor(kind, r.effect);
    if (triggers.length === 0) return;
    const cur = triggers.findIndex((t) => t.id === r.trigger);
    const next = triggers[(cur + 1) % triggers.length]!;
    r.trigger = next.id;
    // Reset params to the defaults for the new trigger so stale fields
    // (e.g. radius left over from onEnemyInRange) don't leak in.
    r.params = {
      ...(DEFAULT_PARAMS[next.id] ?? {}),
      ...(DEFAULT_PARAMS[r.effect] ?? {}),
    };
    redraw();
  }

  private cycleEffect(
    r: Types.BuildingAIRule,
    kind: Types.BuildingKind,
    _list: Types.BuildingAIRule[],
    _idx: number,
    redraw: () => void,
  ): void {
    const effects = this.validEffectsFor(kind);
    if (effects.length === 0) return;
    const cur = effects.findIndex((e) => e.id === r.effect);
    const next = effects[(cur + 1) % effects.length]!;
    r.effect = next.id;
    // Make sure the trigger is still legal with the new effect.
    const triggers = this.validTriggersFor(kind, next.id);
    if (!triggers.some((t) => t.id === r.trigger) && triggers[0]) {
      r.trigger = triggers[0].id;
    }
    r.params = {
      ...(DEFAULT_PARAMS[r.trigger] ?? {}),
      ...(DEFAULT_PARAMS[next.id] ?? {}),
    };
    redraw();
  }

  private async saveRules(
    buildingId: string,
    rules: Types.BuildingAIRule[],
  ): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const res = await runtime.api.setBuildingRules(buildingId, rules);
      if (!this.scene.isActive()) return;
      this.base = res.base;
      if (runtime.player) runtime.player.base = res.base;
      this.closeEditor();
      this.render();
    } catch (err) {
      this.showError((err as Error).message);
    }
  }

  private showError(msg: string): void {
    if (this.errorText) {
      this.errorText.setText(msg).setVisible(true);
    } else {
      this.errorText = this.add
        .text(this.scale.width / 2, this.viewportTop - 16, msg, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '12px',
          color: '#d94c4c',
        })
        .setOrigin(0.5)
        .setDepth(600);
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

  private textButton(
    x: number,
    y: number,
    label: string,
    onPress: () => void,
    opts: { color?: string } = {},
  ): Phaser.GameObjects.Text {
    const color = opts.color ?? '#c3e8b0';
    const t = this.add
      .text(x, y, label, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
        color,
      })
      .setInteractive({ useHandCursor: true });
    t.on('pointerdown', onPress);
    return t;
  }
}
