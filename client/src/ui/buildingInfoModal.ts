import Phaser from 'phaser';
import { Types, Sim } from '@hive/shared';
import type { HiveRuntime } from '../main.js';
import type { BuildingCatalog } from '../net/Api.js';
import { BUILDING_CODEX } from '../codex/codexData.js';
import {
  QUEEN_UNLOCKS_BY_TIER,
  QUEEN_TIER_UNIT_LABELS,
  QUEEN_TIER_BUILDING_LABELS,
} from '../codex/queenTiers.js';
import { crispText } from './text.js';
import { drawPanel, drawPill } from './panel.js';
import { makeHiveButton, type HiveButton } from './button.js';
import { openConfirm } from './confirmModal.js';
import {
  COLOR,
  DEPTHS,
  bodyTextStyle,
  displayTextStyle,
  labelTextStyle,
} from './theme.js';

// Building info + upgrade modal. Opens when the player taps one of
// their own buildings on HomeScene. Shows stats (HP, damage, range,
// production, cooldown) and offers an upgrade button (debits resources
// and bumps the level via /api/player/upgrade-building) plus a
// demolish button for non-Queen buildings.
//
// Purely Phaser — no DOM — so the modal layers cleanly on top of
// the game board in the same scene. Closes on backdrop tap.

const MODAL_W = 380;
// Modal is tall enough to fit the description block on top of the
// stats + four stacked action buttons (Upgrade / Move / Rotate /
// Demolish) at the bottom. The card always renders the same height
// regardless of whether the building is rotatable (Rotate is hidden
// for non-walls but the reserved slot keeps the layout stable).
const MODAL_H = 640;
const MAX_BUILDING_LEVEL = 10;
// Only the straight-section walls rotate — their painted asset has a
// long axis so spinning the sprite 90° produces a visibly different
// vertical section. Bunkers / towers are rounded and don't read as
// "oriented" so rotating them looks broken; we keep them off the list.
export const ROTATABLE_KINDS: ReadonlySet<Types.BuildingKind> = new Set<Types.BuildingKind>([
  'LeafWall',
  'ThornHedge',
]);

// QUEEN_UNLOCKS_BY_TIER, UNIT_LABELS (as QUEEN_TIER_UNIT_LABELS) and
// KIND_LABELS (as QUEEN_TIER_BUILDING_LABELS) live in
// ../codex/queenTiers.ts now — shared with ProgressionScene so a
// single source of truth backs both the modal preview and the full
// roadmap view.
const UNIT_LABELS = QUEEN_TIER_UNIT_LABELS;
const KIND_LABELS = QUEEN_TIER_BUILDING_LABELS;

// Per-second production table — pulled from the server's catalog
// response at open time (see openBuildingInfoModal). A fallback table
// is kept for older servers that predate the catalog fields so the
// modal still renders something sensible when we can't reach them.
const INCOME_FALLBACK: Partial<
  Record<Types.BuildingKind, { sugar: number; leafBits: number; aphidMilk: number }>
> = {
  DewCollector: { sugar: 8, leafBits: 0, aphidMilk: 0 },
  LarvaNursery: { sugar: 0, leafBits: 3, aphidMilk: 0 },
  SugarVault: { sugar: 2, leafBits: 0, aphidMilk: 0 },
  AphidFarm: { sugar: 0, leafBits: 0, aphidMilk: 0.2 },
};

// Computed stats at a given level — UI-side mirror of the shared sim's
// LEVEL_STAT_PERCENT table. We read the base stat from Sim.BUILDING_STATS
// and scale with level to render "current vs next" previews.
function statMultiplier(level: number): number {
  return Sim.levelStatPercent(Math.max(1, level)) / 100;
}

export interface OpenBuildingInfoOpts {
  scene: Phaser.Scene;
  runtime: HiveRuntime;
  building: Types.Building;
  onUpdated: (base: Types.Base) => void;
  onDemolish?: (base: Types.Base) => void;
  // Fired when the player taps "Move". The modal closes itself first;
  // the caller is responsible for kicking off the in-scene placement-
  // preview flow and issuing the /building/:id/move API call on a
  // valid tile tap.
  onMoveRequest?: (building: Types.Building) => void;
}

// Opens the modal. Returns a close fn in case the caller wants to
// close it externally (e.g. scene shutdown). Safe to ignore —
// backdrop-tap + × button already handle the common case.
//
// Balance tables (income per second + upgrade cost curve + per-kind
// base cost) are fetched from the server's /player/building/catalog
// endpoint on open, so the modal stays in sync with server-side
// balance changes without a client redeploy. While the fetch is in
// flight, a fallback table keeps the opening render usable; we
// re-render the card once the catalog arrives.
export function openBuildingInfoModal(opts: OpenBuildingInfoOpts): () => void {
  const { scene, runtime, building } = opts;
  // Balance tables (income per second + per-kind costs + level-cost
  // curve) come from the server catalog. Kicked off async so the modal
  // opens instantly with the fallback tables and upgrades to the
  // authoritative numbers when the fetch resolves.
  let catalog: BuildingCatalog | null = null;
  const W = scene.scale.width;
  const H = scene.scale.height;

  const root = scene.add.container(0, 0).setDepth(DEPTHS.resultCard);

  // Dim backdrop — tap anywhere OUTSIDE the card closes. Previously
  // the backdrop covered the whole screen and any click on empty
  // card chrome (title text, stat rows, gaps between buttons) fell
  // through to the backdrop's pointerdown and closed the modal —
  // not what the user expects. Check coordinates against the card
  // rect so only true "outside" clicks dismiss.
  const cx = (W - MODAL_W) / 2;
  const cy = (H - MODAL_H) / 2;
  const backdrop = scene.add
    .rectangle(0, 0, W, H, 0x000000, 0.62)
    .setOrigin(0, 0)
    .setInteractive();
  root.add(backdrop);

  // Modal card. Reuses the result-card palette for visual coherence
  // with the rest of the game.
  const card = scene.add.graphics();
  drawPanel(card, cx, cy, MODAL_W, MODAL_H, {
    topColor: COLOR.bgPanelHi,
    botColor: COLOR.bgPanelLo,
    stroke: COLOR.brassDeep,
    strokeWidth: 3,
    highlight: COLOR.brass,
    highlightAlpha: 0.16,
    radius: 18,
    shadowOffset: 6,
    shadowAlpha: 0.42,
  });
  root.add(card);

  // A transparent interactive zone covering the card rect. Phaser
  // fires pointer events on the topmost interactive object at the
  // click point; adding this zone means clicks on card chrome
  // (title, stat rows, gaps) land here instead of on the backdrop,
  // so the modal stays open unless the click is genuinely outside.
  // Also prevents the board-tap handler in HomeScene from reacting
  // to the same click (the scene-level pointer handler only runs
  // when no interactive object consumed the event).
  const cardHit = scene.add
    .zone(cx, cy, MODAL_W, MODAL_H)
    .setOrigin(0, 0)
    .setInteractive();
  root.add(cardHit);
  cardHit.on('pointerdown', (
    _p: Phaser.Input.Pointer,
    _lx: number,
    _ly: number,
    e: Phaser.Types.Input.EventData,
  ) => {
    e?.stopPropagation?.();
  });

  const close = (): void => {
    // Stop the countdown ticker before tearing down — it holds a
    // reference into bodyContainer's children that would otherwise
    // keep firing after destroy.
    if (activeCountdownTicker) {
      activeCountdownTicker.remove();
      activeCountdownTicker = null;
    }
    root.destroy(true);
  };
  // Only close if the click actually fell through to the backdrop
  // (i.e. the card-hit zone above didn't consume it). Coordinate
  // check is belt-and-braces for any Phaser edge case where both
  // receive the event.
  backdrop.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
    const insideCard =
      pointer.x >= cx && pointer.x <= cx + MODAL_W &&
      pointer.y >= cy && pointer.y <= cy + MODAL_H;
    if (!insideCard) close();
  });

  // Header: kind label + level pill. Re-rendered on upgrade so we
  // wrap everything after the backdrop inside a `body` container we
  // can swap out.
  const bodyContainer = scene.add.container(cx, cy);
  root.add(bodyContainer);

  // Closure-level ticker handle. The pending-upgrade branch in
  // renderBody starts a 1Hz ticker to drive the live countdown.
  // renderBody can be re-invoked (catalog load, post-upgrade refresh,
  // post-skip refresh) — without this, each call would leak a fresh
  // ticker. Hoisting + disposing here keeps exactly one ticker alive.
  let activeCountdownTicker: Phaser.Time.TimerEvent | null = null;

  const renderBody = (b: Types.Building): void => {
    bodyContainer.removeAll(true);
    // Dispose any prior countdown ticker before re-rendering. Whether
    // or not the new render starts a new one, the old one is dead.
    if (activeCountdownTicker) {
      activeCountdownTicker.remove();
      activeCountdownTicker = null;
    }

    const title = KIND_LABELS[b.kind] ?? b.kind;
    const level = b.level ?? 1;
    const codex = BUILDING_CODEX[b.kind];

    // ---- Header: name + role pill + level pill + close × -----------------
    bodyContainer.add(
      crispText(scene, MODAL_W / 2, 18, title, displayTextStyle(20, COLOR.textGold, 4))
        .setOrigin(0.5, 0),
    );
    if (codex?.role) {
      bodyContainer.add(
        crispText(scene, MODAL_W / 2, 46, codex.role, labelTextStyle(11, COLOR.textDim))
          .setOrigin(0.5, 0),
      );
    }
    const pill = scene.add.graphics();
    drawPill(pill, MODAL_W / 2 - 50, 64, 100, 22, { brass: true });
    bodyContainer.add(pill);
    bodyContainer.add(
      crispText(scene, MODAL_W / 2, 75, `Level ${level}`, labelTextStyle(11, COLOR.textGold))
        .setOrigin(0.5, 0.5),
    );
    const closeX = crispText(scene, MODAL_W - 16, 14, '×',
      displayTextStyle(22, COLOR.textPrimary, 2))
      .setOrigin(1, 0)
      .setInteractive({ useHandCursor: true });
    closeX.on('pointerdown', close);
    bodyContainer.add(closeX);

    // ---- Description block (from BUILDING_CODEX) -----------------------
    let sy = 100;
    if (codex) {
      // Short lore + concrete "what this does in raids" lines stacked
      // as two body paragraphs. Wraps to the modal width.
      const storyText = crispText(scene, 22, sy, codex.story, bodyTextStyle(11, COLOR.textPrimary))
        .setWordWrapWidth(MODAL_W - 44, true);
      bodyContainer.add(storyText);
      sy += storyText.height + 6;
      const powerText = crispText(scene, 22, sy, codex.power, bodyTextStyle(11, COLOR.textDim))
        .setWordWrapWidth(MODAL_W - 44, true);
      bodyContainer.add(powerText);
      sy += powerText.height + 10;
    }

    // ---- Stats list ----------------------------------------------------
    const stats = Sim.BUILDING_STATS[b.kind];
    const mult = statMultiplier(level);
    // Per-level multiplier at the *next* level — used to render a
    // side-by-side "current → next" preview so the player knows what
    // each upgrade buys before they spend the cost (GDD §6.9).
    const isQueenForPreview = b.kind === 'QueenChamber';
    const queenMaxForPreview = catalog?.maxQueenLevel ?? 5;
    const buildingMax = isQueenForPreview ? queenMaxForPreview : MAX_BUILDING_LEVEL;
    const showNextStats = level < buildingMax;
    const nextMult = showNextStats ? statMultiplier(level + 1) : mult;
    const addStat = (label: string, value: string, next?: string): void => {
      bodyContainer.add(
        crispText(scene, 22, sy, label, labelTextStyle(11, COLOR.textMuted)),
      );
      const valueText = crispText(
        scene,
        MODAL_W - 22,
        sy,
        value,
        bodyTextStyle(13, COLOR.textPrimary),
      ).setOrigin(1, 0);
      bodyContainer.add(valueText);
      // Dim "→ next" suffix sits to the LEFT of the value text — uses
      // the value's measured width to anchor itself so the right-edge
      // alignment of the value column stays clean across rows.
      if (next && next !== value) {
        const nextX = MODAL_W - 22 - valueText.width - 6;
        bodyContainer.add(
          crispText(scene, nextX, sy + 1, `→ ${next}`, labelTextStyle(11, COLOR.textGold))
            .setOrigin(1, 0),
        );
      }
      sy += 20;
    };
    if (stats) {
      const hpMax = b.hpMax ?? Math.round(stats.hpMax * mult);
      const hp = b.hp ?? hpMax;
      const nextHpMax = showNextStats ? Math.round(stats.hpMax * nextMult) : null;
      addStat('Hit points', `${hp} / ${hpMax}`,
        nextHpMax !== null ? `${nextHpMax} / ${nextHpMax}` : undefined);
      if (stats.canAttack) {
        const dmgPerHit = Sim.toFloat(stats.attackDamage) * mult;
        const attacksPerSec = 30 / stats.attackCooldownTicks;
        const nextDmg = showNextStats
          ? (Sim.toFloat(stats.attackDamage) * nextMult).toFixed(1)
          : undefined;
        addStat('Damage per hit', dmgPerHit.toFixed(1), nextDmg);
        // Attacks / sec doesn't scale with level (cooldown is fixed by
        // sim) so we render no preview — keeping the row consistent
        // with the others' "→ next" pattern, just blank when nothing
        // would change.
        addStat('Attacks / sec', attacksPerSec.toFixed(2));
        addStat('Range (tiles)', Sim.toFloat(stats.attackRange).toFixed(1));
      }
      if (stats.dropsSugarOnDestroy > 0) {
        addStat('Sugar stored', String(stats.dropsSugarOnDestroy));
      }
      if (stats.dropsLeafBitsOnDestroy > 0) {
        addStat('Leaf bits stored', String(stats.dropsLeafBitsOnDestroy));
      }
    }
    const incomeMap = catalog?.incomePerSecond ?? INCOME_FALLBACK;
    const income = incomeMap[b.kind];
    if (income) {
      const levelMult = Math.max(1, level);
      const nextLevelMult = showNextStats ? level + 1 : levelMult;
      if (income.sugar > 0) {
        addStat(
          'Sugar / sec',
          `+${income.sugar * levelMult}`,
          showNextStats ? `+${income.sugar * nextLevelMult}` : undefined,
        );
      }
      if (income.leafBits > 0) {
        addStat(
          'Leaf / sec',
          `+${income.leafBits * levelMult}`,
          showNextStats ? `+${income.leafBits * nextLevelMult}` : undefined,
        );
      }
      if (income.aphidMilk > 0) {
        // Milk rate is fractional at L1 (0.2/sec) but lands on whole
        // numbers at higher levels (e.g. L5 → 1.0). Wrap in Number()
        // after toFixed(1) to drop trailing ".0" so the display reads
        // "+1" / "+2" once the curve hits integer territory — matches
        // the HUD's formatRate logic.
        addStat(
          'Milk / sec',
          `+${Number((income.aphidMilk * levelMult).toFixed(1))}`,
          showNextStats ? `+${Number((income.aphidMilk * nextLevelMult).toFixed(1))}` : undefined,
        );
      }
    }

    // ---- Actions -------------------------------------------------------
    const isQueen = b.kind === 'QueenChamber';
    const atMax = level >= MAX_BUILDING_LEVEL;
    const canRotate = !isQueen && ROTATABLE_KINDS.has(b.kind);
    const actionBtnW = MODAL_W - 44;
    const actionBtnH = 42;
    const actionGap = 7;
    // How many action buttons we actually paint in this render.
    const actionSlots = isQueen ? 1 : (canRotate ? 4 : 3);
    const actionsBottomY = MODAL_H - 20;
    const actionsStartY =
      actionsBottomY - actionBtnH * actionSlots - actionGap * (actionSlots - 1) + actionBtnH / 2;

    if (isQueen) {
      // Queen has its own max-level + cost curve separate from the
      // regular building curve (MAX_BUILDING_LEVEL is 10; Queen caps
      // at MAX_QUEEN_LEVEL which is 5 on the server). We read the
      // authoritative number from the catalog so a server balance
      // change is picked up client-side without a redeploy.
      const queenMax = catalog?.maxQueenLevel ?? 5;
      const queenAtMax = level >= queenMax;
      const queenCost = !queenAtMax
        ? catalog?.queenUpgradeCost?.[level - 1] ?? null
        : null;
      const wallet = runtime.player?.player ?? null;
      const haveSugar = wallet?.sugar ?? 0;
      const haveLeaf = wallet?.leafBits ?? 0;
      const haveMilk = wallet?.aphidMilk ?? 0;
      const queenAffordable =
        !!queenCost &&
        haveSugar >= queenCost.sugar &&
        haveLeaf >= queenCost.leafBits &&
        haveMilk >= queenCost.aphidMilk;

      // Blurb + cost / status line, depending on which state we're
      // in. The button itself mirrors the regular-building pattern:
      // ghost+"Max level" when maxed, ghost+"Upgrade Queen (need
      // more)" when unaffordable, secondary+"Upgrade Queen" when
      // ready. Clicks are gated so a disabled button is also
      // functionally inert.
      // Unlock preview — what new buildings + units appear at the next
      // tier. Renders before the cost line so the player sees the
      // reward, then the price. Suppressed at max (nothing more to
      // unlock).
      const nextTierUnlocks = !queenAtMax ? QUEEN_UNLOCKS_BY_TIER[level + 1] : null;
      const unlocksY = actionsStartY - actionBtnH / 2 - 88;
      if (nextTierUnlocks) {
        const items: string[] = [];
        for (const kind of nextTierUnlocks.buildings) {
          items.push(KIND_LABELS[kind] ?? kind);
        }
        for (const kind of nextTierUnlocks.units) {
          items.push(UNIT_LABELS[kind] ?? kind);
        }
        if (items.length > 0) {
          bodyContainer.add(
            crispText(scene, 22, unlocksY,
              `L${level + 1} unlocks: ${items.join(', ')}`,
              bodyTextStyle(11, COLOR.textGold),
            ).setWordWrapWidth(MODAL_W - 44, true),
          );
        }
      }
      bodyContainer.add(
        crispText(scene, 22, actionsStartY - actionBtnH / 2 - 46,
          'Queen upgrades unlock new building slots and tiers.',
          bodyTextStyle(11, COLOR.textDim),
        ).setWordWrapWidth(MODAL_W - 44, true),
      );
      const costY = actionsStartY - actionBtnH / 2 - 16;
      let costLine: string;
      let costColor: string = COLOR.textDim;
      if (queenAtMax) {
        costLine = `Queen is at max level (${queenMax}).`;
      } else if (!queenCost) {
        costLine = 'Loading upgrade cost…';
      } else if (queenAffordable) {
        // Include aphid milk when it's part of the cost so the player
        // sees the full price, not just sugar + leaf.
        const milkPart = queenCost.aphidMilk > 0
          ? ` · ${queenCost.aphidMilk} milk`
          : '';
        costLine = `Next level: ${queenCost.sugar} sugar · ${queenCost.leafBits} leaf${milkPart}`;
      } else {
        const needs: string[] = [];
        if (queenCost.sugar > haveSugar) needs.push(`${queenCost.sugar - haveSugar} more sugar`);
        if (queenCost.leafBits > haveLeaf) needs.push(`${queenCost.leafBits - haveLeaf} more leaf`);
        if (queenCost.aphidMilk > haveMilk) needs.push(`${queenCost.aphidMilk - haveMilk} more milk`);
        costLine = `Need ${needs.join(' + ')}`;
        costColor = '#ff9a80';
      }
      bodyContainer.add(
        crispText(scene, MODAL_W / 2, costY, costLine, bodyTextStyle(12, costColor))
          .setOrigin(0.5, 0.5),
      );

      const queenEnabled = !queenAtMax && queenAffordable;
      // Three disabled sub-states: maxed, still-loading, or can't
      // afford. Each gets a distinct label + toast so "why can't I
      // click this?" is always answered by the UI itself.
      const queenLabel = queenAtMax
        ? 'Max level'
        : !queenCost
          ? 'Loading…'
          : queenAffordable
            ? 'Upgrade Queen'
            : 'Upgrade Queen (need more)';
      const btn = makeHiveButton(scene, {
        x: MODAL_W / 2,
        y: actionsStartY,
        width: actionBtnW,
        height: actionBtnH,
        label: queenLabel,
        variant: queenEnabled ? 'secondary' : 'ghost',
        fontSize: 14,
        enabled: queenEnabled,
        onPress: () => {
          if (!queenEnabled) {
            if (queenAtMax) flashToast(scene, 'The Queen is already at her highest tier.');
            else if (!queenCost) flashToast(scene, 'Still loading upgrade costs…');
            else flashToast(scene, 'Not enough resources for the next Queen tier.');
            return;
          }
          void doQueenUpgrade(scene, runtime, b, (base) => {
            const fresh = base.buildings.find((x) => x.id === b.id);
            if (fresh) renderBody(fresh);
            opts.onUpdated(base);
          });
        },
      });
      bodyContainer.add(btn.container);
      return;
    }

    // Cost + affordability. We check the cached player resource totals
    // that HomeScene keeps in sync — when the player hasn't got enough
    // sugar/leaf for the next upgrade, we dim the Upgrade button and
    // replace the cost line with a concrete "Need X more sugar" hint.
    const cost = atMax ? null : estimateCost(b, catalog);
    const wallet = runtime.player?.player ?? null;
    const haveSugar = wallet?.sugar ?? 0;
    const haveLeaf = wallet?.leafBits ?? 0;
    const affordable = !!cost && haveSugar >= cost.sugar && haveLeaf >= cost.leafBits;
    const missingSugar = cost ? Math.max(0, cost.sugar - haveSugar) : 0;
    const missingLeaf = cost ? Math.max(0, cost.leafBits - haveLeaf) : 0;

    const costLineY = actionsStartY - actionBtnH / 2 - 16;
    if (atMax) {
      bodyContainer.add(
        crispText(scene, MODAL_W / 2, costLineY,
          'This building is at max level.',
          bodyTextStyle(12, COLOR.textDim),
        ).setOrigin(0.5, 0.5),
      );
    } else if (affordable) {
      bodyContainer.add(
        crispText(scene, MODAL_W / 2, costLineY,
          `Next level: ${cost!.sugar} sugar · ${cost!.leafBits} leaf`,
          bodyTextStyle(12, COLOR.textDim),
        ).setOrigin(0.5, 0.5),
      );
    } else {
      const needs: string[] = [];
      if (missingSugar > 0) needs.push(`${missingSugar} more sugar`);
      if (missingLeaf > 0) needs.push(`${missingLeaf} more leaf`);
      bodyContainer.add(
        crispText(scene, MODAL_W / 2, costLineY,
          `Need ${needs.join(' + ')}`,
          bodyTextStyle(12, '#ff9a80'),
        ).setOrigin(0.5, 0.5),
      );
    }

    // Upgrade — green. Disabled + ghost when the player can't afford
    // so the button itself signals "not yet". When the building has a
    // pending upgrade in flight (builder time gate), the button
    // becomes a "Skip with milk" CTA showing the live countdown +
    // milk price; tapping it consumes milk and finalizes immediately.
    const upgradeEnabled = !atMax && affordable;
    let slotIdx = 0;
    const slotY = (): number =>
      actionsStartY + (actionBtnH + actionGap) * slotIdx++;

    const isPending = !!b.pendingCompletesAt && !!b.pendingToLevel;
    if (isPending) {
      const completesAt = b.pendingCompletesAt!;
      const wallet = runtime.player?.player ?? null;
      const haveMilk = wallet?.aphidMilk ?? 0;
      // Live countdown: refresh every second while modal is open. Each
      // tick re-derives the remaining ms + milk price and updates the
      // button label in place. event.removed cleanup runs on close().
      const formatRemaining = (ms: number): string => {
        if (ms <= 0) return 'finishing…';
        const totalSec = Math.ceil(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
      };
      const remaining = (): number => Sim.remainingMsAt(completesAt, Date.now());
      const skipPrice = (): number => Sim.skipCostMilk(remaining());
      const skipLabel = (): string => {
        const r = remaining();
        if (r <= 0) return 'Finalizing…';
        const price = skipPrice();
        const canAfford = haveMilk >= price;
        return canAfford
          ? `Skip ${formatRemaining(r)} (${price} milk)`
          : `${formatRemaining(r)} left (need ${price} milk)`;
      };
      const skipBtn: HiveButton = makeHiveButton(scene, {
        x: MODAL_W / 2,
        y: slotY(),
        width: actionBtnW,
        height: actionBtnH,
        label: skipLabel(),
        variant: haveMilk >= skipPrice() ? 'secondary' : 'ghost',
        fontSize: 12,
        enabled: haveMilk >= skipPrice(),
        onPress: () => {
          const price = skipPrice();
          if (haveMilk < price) {
            flashToast(scene, 'Not enough milk to skip this upgrade.');
            return;
          }
          void doSkipBuilder(scene, runtime, b, (base) => {
            const fresh = base.buildings.find((x) => x.id === b.id);
            if (fresh) renderBody(fresh);
            opts.onUpdated(base);
          });
        },
      });
      bodyContainer.add(skipBtn.container);
      // 1 Hz countdown ticker. Updates the button label in place via
      // HiveButton.setLabel (encapsulation-safe — no child iteration).
      // Stored on the outer closure so a subsequent renderBody can
      // dispose it before starting its own; outer onClose cleanup
      // also drops it so a closed modal doesn't keep ticking.
      activeCountdownTicker = scene.time.addEvent({
        delay: 1000,
        loop: true,
        callback: () => {
          const r = remaining();
          if (r <= 0) {
            // Timer elapsed — stop ticking and signal "finalizing" until
            // the next /me promotes the level. Subsequent renderBody
            // (triggered by upstream refresh) will paint the post-bump
            // stats. Closing + reopening would also work but loses UX.
            if (activeCountdownTicker) {
              activeCountdownTicker.remove();
              activeCountdownTicker = null;
            }
            skipBtn.setLabel('Finalizing…');
            return;
          }
          skipBtn.setLabel(skipLabel());
        },
      });
    } else {
      const upgradeLabel = atMax
        ? 'Max level'
        : affordable
          ? 'Upgrade'
          : 'Upgrade (need more)';
      const upgradeBtn: HiveButton = makeHiveButton(scene, {
        x: MODAL_W / 2,
        y: slotY(),
        width: actionBtnW,
        height: actionBtnH,
        label: upgradeLabel,
        variant: upgradeEnabled ? 'secondary' : 'ghost',
        fontSize: 14,
        enabled: upgradeEnabled,
        onPress: () => {
          if (!upgradeEnabled) return;
          void doUpgrade(scene, runtime, b, (base) => {
            const fresh = base.buildings.find((x) => x.id === b.id);
            if (fresh) renderBody(fresh);
            opts.onUpdated(base);
          });
        },
      });
      bodyContainer.add(upgradeBtn.container);
    }

    // Move.
    const moveBtn = makeHiveButton(scene, {
      x: MODAL_W / 2,
      y: slotY(),
      width: actionBtnW,
      height: actionBtnH,
      label: 'Move',
      variant: 'ghost',
      fontSize: 14,
      onPress: () => {
        close();
        opts.onMoveRequest?.(b);
      },
    });
    bodyContainer.add(moveBtn.container);

    // Rotate — only for walls + bunker + thorn hedge. Keeps the slot
    // reserved so the Demolish button ends up in the same screen slot
    // across kinds (matters for muscle memory).
    if (canRotate) {
      const rotateBtn = makeHiveButton(scene, {
        x: MODAL_W / 2,
        y: slotY(),
        width: actionBtnW,
        height: actionBtnH,
        label: 'Rotate',
        variant: 'ghost',
        fontSize: 14,
        onPress: () => {
          void doRotate(scene, runtime, b, (base) => {
            const fresh = base.buildings.find((x) => x.id === b.id);
            if (fresh) renderBody(fresh);
            opts.onUpdated(base);
          });
        },
      });
      bodyContainer.add(rotateBtn.container);
    }

    // Demolish.
    const demBtn = makeHiveButton(scene, {
      x: MODAL_W / 2,
      y: slotY(),
      width: actionBtnW,
      height: actionBtnH,
      label: 'Demolish',
      variant: 'danger',
      fontSize: 14,
      onPress: () => {
        void openConfirm({
          title: 'Demolish this building?',
          body: 'You will not get the resources back. This action cannot be undone.',
          confirmLabel: 'Demolish',
          danger: true,
        }).then((confirmed) => {
          if (!confirmed) return;
          void doDemolish(scene, runtime, b, (base) => {
            close();
            opts.onDemolish?.(base);
          });
        });
      },
    });
    bodyContainer.add(demBtn.container);
  };

  renderBody(building);

  // Upgrade to the authoritative balance tables asap. If the scene
  // tears down before the fetch resolves (user closed the modal or
  // left the scene), check that the root container is still in the
  // display list before touching it.
  runtime.api
    .getBuildingCatalog()
    .then((c) => {
      catalog = c;
      if (!root.active) return;
      const current =
        runtime.player?.base.buildings.find((x) => x.id === building.id) ??
        building;
      renderBody(current);
    })
    .catch(() => {
      // Keep the fallback numbers; nothing actionable on a failed fetch.
    });

  return close;
}

// Cost preview — reads both the cost curve and the per-kind base
// price from the server catalog so the "Upgrade — NNN sugar" label
// tracks any balance change on the server side. Returns zeros when
// the catalog hasn't loaded yet (rare race on slow networks); the
// server is still authoritative on the actual debit at submit time.
function estimateCost(
  b: Types.Building,
  catalog: BuildingCatalog | null,
): { sugar: number; leafBits: number } {
  if (!catalog?.baseCost || !catalog.levelCostMult) return { sugar: 0, leafBits: 0 };
  const base = catalog.baseCost[b.kind];
  if (!base) return { sugar: 0, leafBits: 0 };
  const level = b.level ?? 1;
  const mult =
    catalog.levelCostMult[level - 1] ??
    catalog.levelCostMult[catalog.levelCostMult.length - 1] ??
    1;
  return {
    sugar: Math.floor(base.sugar * mult),
    leafBits: Math.floor(base.leafBits * mult),
  };
}

async function doUpgrade(
  scene: Phaser.Scene,
  runtime: HiveRuntime,
  b: Types.Building,
  onDone: (base: Types.Base, newLevel: number) => void,
): Promise<void> {
  try {
    const r = await runtime.api.upgradeBuilding(b.id);
    if (runtime.player) {
      runtime.player.player.sugar = r.player.sugar;
      runtime.player.player.leafBits = r.player.leafBits;
      runtime.player.player.aphidMilk = r.player.aphidMilk;
      runtime.player.player.trophies = r.player.trophies;
      runtime.player.base = r.base;
    }
    // The server returns the queued target level; the actual `level`
    // field on the building stays at its current value until /me
    // promotes the pending. Pass the queued level so the modal can
    // hint at the in-flight tier without misleading the player about
    // current stats.
    onDone(r.base, r.pendingToLevel);
  } catch (err) {
    flashToast(scene, (err as Error).message);
  }
}

async function doSkipBuilder(
  scene: Phaser.Scene,
  runtime: HiveRuntime,
  b: Types.Building,
  onDone: (base: Types.Base) => void,
): Promise<void> {
  try {
    const r = await runtime.api.skipBuilder(b.id);
    if (runtime.player) {
      runtime.player.player.sugar = r.player.sugar;
      runtime.player.player.leafBits = r.player.leafBits;
      runtime.player.player.aphidMilk = r.player.aphidMilk;
      runtime.player.player.trophies = r.player.trophies;
      runtime.player.base = r.base;
    }
    onDone(r.base);
  } catch (err) {
    flashToast(scene, (err as Error).message);
  }
}

// Queen upgrade — advances the QueenChamber by one tier. We keep
// the modal open afterwards and re-render with the fresh building
// (new level, new cost line, possibly "max level") so the player
// sees the progression without having to close + reopen. Errors
// surface via the shared flashToast.
async function doQueenUpgrade(
  scene: Phaser.Scene,
  runtime: HiveRuntime,
  _building: Types.Building,
  onDone: (base: Types.Base) => void,
): Promise<void> {
  try {
    const r = await runtime.api.upgradeQueen();
    if (runtime.player) {
      runtime.player.player.sugar = r.player.sugar;
      runtime.player.player.leafBits = r.player.leafBits;
      runtime.player.player.aphidMilk = r.player.aphidMilk;
      runtime.player.player.trophies = r.player.trophies;
      runtime.player.base = r.base;
    }
    onDone(r.base);
  } catch (err) {
    flashToast(scene, (err as Error).message);
  }
}

async function doRotate(
  scene: Phaser.Scene,
  runtime: HiveRuntime,
  b: Types.Building,
  onDone: (base: Types.Base) => void,
): Promise<void> {
  try {
    const r = await runtime.api.rotateBuilding({ buildingId: b.id });
    if (runtime.player) runtime.player.base = r.base;
    onDone(r.base);
  } catch (err) {
    flashToast(scene, (err as Error).message);
  }
}

async function doDemolish(
  scene: Phaser.Scene,
  runtime: HiveRuntime,
  b: Types.Building,
  onDone: (base: Types.Base) => void,
): Promise<void> {
  try {
    const r = await runtime.api.deleteBuilding(b.id);
    if (runtime.player) {
      runtime.player.base = r.base;
    }
    onDone(r.base);
  } catch (err) {
    // Surface failures to the player rather than silently swallowing
    // them — demolition often fails for recoverable reasons (network
    // blip, 409 on a just-raided base) and the player needs to know
    // why the building is still there.
    flashToast(scene, (err as Error).message);
  }
}

function flashToast(scene: Phaser.Scene, msg: string): void {
  const container = scene.add
    .container(scene.scale.width / 2, scene.scale.height - 60)
    .setDepth(DEPTHS.toast);
  const t = scene.add
    .text(0, 0, msg, {
      fontFamily: 'ui-monospace, monospace',
      fontSize: '13px',
      color: '#0f1b10',
      backgroundColor: '#ffd98a',
      padding: { left: 12, right: 12, top: 6, bottom: 6 },
    })
    .setOrigin(0.5);
  container.add(t);
  container.setSize(t.width, t.height).setInteractive({ useHandCursor: true });
  container.on('pointerdown', () => {
    scene.tweens.killTweensOf(container);
    container.destroy();
  });
  scene.tweens.add({
    targets: container,
    alpha: { from: 1, to: 0 },
    delay: 1600,
    duration: 400,
    onComplete: () => container.destroy(),
  });
}
