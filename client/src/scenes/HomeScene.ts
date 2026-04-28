import Phaser from 'phaser';
import { Sim, Types } from '@hive/shared';
import type { HiveRuntime } from '../main.js';
import type { BuilderEntry } from '../net/Api.js';
import { crispText } from '../ui/text.js';
import { openAccountModal, openAccountInfoModal } from '../ui/accountModal.js';
import { openTutorial, shouldShowTutorial } from '../ui/tutorialModal.js';
import { maybeShowWhileAway } from '../ui/whileAwayModal.js';
import { attachAmbientMotes } from '../ui/ambientMotes.js';
import { setSceneTrack, resumeMusic } from '../ui/music.js';
import { readWinStreak, streakBonusPct } from '../ui/winStreak.js';
import { openMatchPreview } from '../ui/matchPreview.js';
import { openSettings } from '../ui/settingsModal.js';
import { dismissBanner, isBannerDismissed } from '../ui/banners.js';
import { showCoachmark, type CoachmarkHandle } from '../ui/coachmark.js';
import { BUILDING_CODEX } from '../codex/codexData.js';

// First-visit drill flag. Bumped whenever the steps change shape
// (e.g., adding a third step). Until the player completes the
// drill, we re-show on every entry — bailing early stays armed.
//
// v2: added the post-raid "level up your colony" step so a player
// who returns from a successful first raid is shown how to spend
// the loot (tap the Queen Chamber). Returning users see the
// expanded drill once.
const HOME_COACHMARK_DONE_KEY = 'hive:coachmarks:home:v2';
// Companion flag: set the moment the player taps Raid in the
// 'raid' step, cleared when 'colony' step is satisfied. Lets the
// post-raid scene re-entry pick up the drill at the colony step
// even though scene state is rebuilt from scratch on RaidScene exit.
const HOME_COACHMARK_COLONY_ARMED_KEY = 'hive:coachmarks:home:colony-armed';
function shouldShowHomeCoachmarks(): boolean {
  try {
    return localStorage.getItem(HOME_COACHMARK_DONE_KEY) !== '1';
  } catch {
    return false;
  }
}
function markHomeCoachmarksDone(): void {
  try { localStorage.setItem(HOME_COACHMARK_DONE_KEY, '1'); } catch { /* ignore */ }
}
import { openBuildingInfoModal, ROTATABLE_KINDS } from '../ui/buildingInfoModal.js';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { spawnFloatNumber } from '../ui/floatNumber.js';
import { getSettings, setSettings } from '../ui/audio.js';
import { formatCountdown } from '../ui/sceneFrame.js';
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

// Buildings that have separate horizontal + vertical sprite variants.
// When rotated, we swap to the V variant instead of spinning the H sprite.
const KINDS_WITH_V_VARIANTS: ReadonlySet<Types.BuildingKind> = new Set(['LeafWall', 'ThornHedge']);

// Build-menu category buckets. Drives the tab strip above the picker
// slots. "all" is implicit (the default first tab). Walls includes
// V-variants implicitly because the catalog only exposes the H key.
const BUILDING_CATEGORY: Partial<Record<Types.BuildingKind, 'producer' | 'defence' | 'storage' | 'wall'>> = {
  // Producers — anything that ticks resource pendingHarvest.
  DewCollector: 'producer',
  LarvaNursery: 'producer',
  AphidFarm: 'producer',
  // Storage — caps + dedicated banks.
  SugarVault: 'storage',
  LeafSilo: 'storage',
  MilkPot: 'storage',
  // Walls (and corner / V variants pick the same key).
  LeafWall: 'wall',
  ThornHedge: 'wall',
  // Defences — turrets, traps, defender spawners, bunkers.
  MushroomTurret: 'defence',
  PebbleBunker: 'defence',
  DungeonTrap: 'defence',
  AcidSpitter: 'defence',
  SporeTower: 'defence',
  RootSnare: 'defence',
  HiddenStinger: 'defence',
  SpiderNest: 'defence',
  // QueenChamber + TunnelJunction stay uncategorised — they show in
  // "All" but not in any narrow filter (special / colony chrome).
};

// localStorage key for player-pinned building kinds. Schema: a JSON
// array of BuildingKind strings. Bumped when the schema breaks.
const PINNED_KEY = 'hive:pinnedBuildings:v1';

function loadPinnedKinds(): Set<Types.BuildingKind> {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((s): s is Types.BuildingKind => typeof s === 'string'));
  } catch {
    return new Set();
  }
}

function persistPinnedKinds(set: Set<Types.BuildingKind>): void {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify([...set]));
  } catch {
    /* private mode — non-fatal, pins just don't persist */
  }
}

// Walls have hand-tuned horizontal + vertical sprites. When a wall is
// rotated, instead of spinning the H sprite (whose weave bands then
// run sideways and look broken) we swap to the V variant so weave
// stays perpendicular to the long axis. Even rotation values (0, 2)
// render horizontal; odd values (1, 3) render vertical.
// Grace window (scene-time ms) after a modal closes during which
// board taps are still suppressed. The same pointerdown that fell
// through the modal's outside-click dismiss would otherwise fire
// pointerup against the board and open the picker / start a pan.
const MODAL_CLOSE_GRACE_MS = 220;

// Treat the scene as "modal active" if a modal is currently open or
// if one closed within the grace window. Modals (currently
// buildingInfoModal) flip the scene.data flags themselves so this
// helper stays generic — any future modal can opt in by setting the
// same two keys.
function isModalActive(scene: Phaser.Scene): boolean {
  if (scene.data.get('modalActive') === true) return true;
  const closedAt = scene.data.get('modalClosedAt') as number | undefined;
  if (typeof closedAt === 'number' && scene.time.now - closedAt < MODAL_CLOSE_GRACE_MS) {
    return true;
  }
  return false;
}

// Stable identity for a "what next?" suggestion so dismissals are
// scoped. A campaign nudge for chapter 2 is a different banner than
// chapter 3, and a "run a raid" nudge is distinct from both.
function whatNextIdentity(
  s: { sceneKey: string },
  ps: { campaign?: { chapter?: number } | null },
): string {
  if (s.sceneKey === 'CampaignScene') {
    return `campaign-${ps.campaign?.chapter ?? 'unknown'}`;
  }
  return s.sceneKey;
}

// True when the pointer event came from a mouse (vs touch / pen).
// Phaser's Pointer doesn't expose `pointerType` directly in its types,
// but the underlying browser PointerEvent does — read it off `event`
// when present and fall back to "treat as mouse" so desktop hovers
// still work in environments without the property.
function isMousePointer(p: Phaser.Input.Pointer): boolean {
  const ev = (p as Phaser.Input.Pointer & { event?: PointerEvent | TouchEvent }).event;
  if (!ev) return true;
  if ('pointerType' in ev && typeof ev.pointerType === 'string') {
    return ev.pointerType === 'mouse';
  }
  return false;
}

function buildingTextureKey(kind: Types.BuildingKind, rotation: 0 | 1 | 2 | 3 = 0): string {
  if (KINDS_WITH_V_VARIANTS.has(kind) && rotation % 2 === 1) {
    return `building-${kind}V`;
  }
  return `building-${kind}`;
}

// Wall corner detection: when a wall section has BOTH a horizontal
// neighbour (same row, ±1 col) AND a vertical neighbour (same col,
// ±1 row) of the same kind, it's the elbow of an L-bend and renders
// using the corner sprite so the perpendicular sections butt into a
// rounded node instead of leaving a visible seam. Falls back to the
// regular H/V variant when no corner condition is detected.
function wallTextureKey(
  b: Types.Building,
  base: Types.Base | null,
  rot: 0 | 1 | 2 | 3,
): string {
  if (!KINDS_WITH_V_VARIANTS.has(b.kind)) {
    return buildingTextureKey(b.kind, rot);
  }
  if (!base) return buildingTextureKey(b.kind, rot);
  let hasH = false;
  let hasV = false;
  for (const n of base.buildings) {
    if (n.id === b.id) continue;
    if (n.kind !== b.kind) continue;
    if (n.anchor.layer !== b.anchor.layer) continue;
    if (n.anchor.y === b.anchor.y && Math.abs(n.anchor.x - b.anchor.x) === 1) {
      hasH = true;
    }
    if (n.anchor.x === b.anchor.x && Math.abs(n.anchor.y - b.anchor.y) === 1) {
      hasV = true;
    }
    if (hasH && hasV) break;
  }
  if (hasH && hasV) return `building-${b.kind}Corner`;
  return buildingTextureKey(b.kind, rot);
}

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
const INCOME_PER_SECOND: Partial<Record<Types.BuildingKind, { sugar: number; leafBits: number; aphidMilk: number }>> = {
  DewCollector: { sugar: 8, leafBits: 0, aphidMilk: 0 },
  LarvaNursery: { sugar: 0, leafBits: 3, aphidMilk: 0 },
  SugarVault: { sugar: 2, leafBits: 0, aphidMilk: 0 },
  AphidFarm: { sugar: 0, leafBits: 0, aphidMilk: 0.2 },
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
  // Per-pill subtitle showing "+X/sec" production rate. Hidden when the
  // pill has no producers (e.g. AphidMilk in MVP). Lazily-initialized in
  // drawHud(); update via refreshResourceMeta().
  private sugarRateText: Phaser.GameObjects.Text | null = null;
  private leafRateText: Phaser.GameObjects.Text | null = null;
  private milkRateText: Phaser.GameObjects.Text | null = null;
  // Storage cap headroom from the server (§6.8). Falls back to no-cap
  // when the server payload predates the storage feature.
  private storageCaps: { sugar: number | null; leaf: number | null; milk: number | null } = {
    sugar: null,
    leaf: null,
    milk: null,
  };
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
    attachAmbientMotes(this);
    setSceneTrack('home');
    // Music context stays suspended until a user gesture — defer the
    // first resume to whatever pointer event lands first.
    this.input.once('pointerdown', () => resumeMusic());

    // Layer survives `scene.restart()` via the registry. Without
    // this restore, claiming a streak / comeback / dismissing a
    // banner while looking at the underground would whip the player
    // back to the surface — jarring. The restart paths set this
    // value before calling `scene.restart()`.
    const persistedLayer = this.registry.get('homeLayer') as 0 | 1 | undefined;
    if (persistedLayer === 0 || persistedLayer === 1) {
      this.layer = persistedLayer;
      // One-shot consumption so a fresh navigation back to HomeScene
      // (e.g. from the burger drawer) starts on the surface again.
      this.registry.set('homeLayer', null);
    }

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
      const storage = runtime.player.player.storage;
      if (storage) {
        this.storageCaps = {
          sugar: storage.sugarCap,
          leaf: storage.leafCap,
          // milkCap is opt-in (null until the player builds a
          // MilkPot). undefined on older servers — treat as null
          // so milk renders raw.
          milk: storage.milkCap ?? null,
        };
      }
    }

    // Full-screen layout (Clash-of-Clans style): the board fills the
    // viewport and the HUD floats overlaid on top. boardContainer must
    // be created BEFORE the HUD so HUD elements (added later, with
    // explicit DEPTHS.hud) render above. Position is recomputed in
    // handleResize() — (0, 0) is just a placeholder.
    this.boardContainer = this.add.container(0, 0).setDepth(DEPTHS.board);
    this.drawHud();
    this.drawBoard();
    this.drawBuildings();
    this.drawStickyHooks();
    this.drawFooter();
    this.wireBoardTap();
    // If RaidScene stashed a delta on the way out, pulse the pills
    // and float a "+N" number for each positive gain. One-shot:
    // clear it so a later re-entry (e.g. opening the burger drawer
    // and coming back) doesn't replay the same animation.
    const runtimeForGain = this.registry.get('runtime') as
      | HiveRuntime
      | undefined;
    if (runtimeForGain?.pendingResourceGain) {
      this.pulseResourceGains(runtimeForGain.pendingResourceGain);
      delete runtimeForGain.pendingResourceGain;
    }
    // Kick off catalog fetch (non-blocking) — it's cached per scene
    // enter. If it fails, the picker shows a network error.
    void this.loadCatalog();
    // Builder queue: fetch once now so the upgrade-in-progress
    // chips paint over any building currently being upgraded, then
    // refresh every 5 s so the countdown text stays close to live.
    void this.refreshBuilderEntries();
    this.builderRefreshTimer = this.time.addEvent({
      delay: 5000,
      loop: true,
      callback: () => void this.refreshBuilderEntries(),
    });
    this.events.once('shutdown', () => {
      if (this.builderRefreshTimer) {
        this.builderRefreshTimer.remove(false);
        this.builderRefreshTimer = null;
      }
    });

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
    } else {
      // While-you-were-away report — shown at most once per session
      // when the player has un-seen defenses since their last home
      // visit. Lazy: scheduled after the scene fully paints so the
      // modal lands on a stable backdrop. Won't fire if the
      // tutorial modal is already showing.
      const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
      if (runtime) {
        this.time.delayedCall(500, () => {
          if (!this.scene.isActive()) return;
          void maybeShowWhileAway(this, runtime);
        });
      }
    }

    // Interactive coachmark drill — only on the first visit. Steps:
    //   1. Tap an empty tile → opens the building picker
    //   2. Hit ⚔ Raid → starts the first match
    // Replaces the static text-modal-only onboarding with something
    // gated on the gameplay events that teach the loop. localStorage
    // flag bumped if drill steps ever change shape.
    if (shouldShowHomeCoachmarks() && !this.replayContextActive()) {
      // If the player just returned from their first raid (the
      // raid step set the colony-armed flag), pick up the drill
      // at the colony step instead of restarting from 'tile'.
      let armed = false;
      try {
        armed = localStorage.getItem(HOME_COACHMARK_COLONY_ARMED_KEY) === '1';
      } catch {
        // ignore
      }
      this.coachmarkStep = armed ? 'colony' : 'tile';
      // Delay matched to 1.2s for the colony step so the player
      // sees their loot reward toast first; tile step fires faster
      // so the drill kicks in promptly on a brand-new account.
      this.time.delayedCall(armed ? 1200 : 700, () => this.runCoachmarkStep());
    }

    // Welcome-back harvest banner. The server credits offline
    // production into the wallet on /me (clamped to storage caps +
    // an 8h MAX_OFFLINE_SECONDS), then echoes the credited amounts
    // back as `offlineTrickle`. Surfacing them as a brief toast lets
    // the player understand "this is how production / harvest works"
    // without a separate explainer screen. Skipped when nothing
    // landed (fresh install, instant return) or when this is a
    // post-raid re-entry (which already shows the loot card).
    if (runtime?.player) {
      const trickle = runtime.player.offlineTrickle;
      if (
        trickle &&
        trickle.secondsElapsed > 0 &&
        (trickle.sugarGained + trickle.leafGained + trickle.milkGained) > 0
      ) {
        // One-shot — clear so a coachmark / scene restart doesn't
        // re-fire the toast on the same trickle payload.
        runtime.player.offlineTrickle = {
          secondsElapsed: 0,
          sugarGained: 0,
          leafGained: 0,
          milkGained: 0,
        };
        this.time.delayedCall(450, () => {
          this.flashHarvestToast(trickle);
        });
      }
    }
  }

  // Multi-line "welcome back" banner showing the offline harvest the
  // server just credited. Reads from the offlineTrickle echo that
  // /player/me returns; the wallet has already been updated, so this
  // is purely an explainer. Auto-dismisses after a few seconds; the
  // player can also tap to dismiss early.
  private flashHarvestToast(trickle: {
    secondsElapsed: number;
    sugarGained: number;
    leafGained: number;
    milkGained: number;
  }): void {
    const parts: string[] = [];
    if (trickle.sugarGained > 0) parts.push(`+${trickle.sugarGained} sugar`);
    if (trickle.leafGained > 0) parts.push(`+${trickle.leafGained} leaf`);
    if (trickle.milkGained > 0) parts.push(`+${trickle.milkGained} milk`);
    const hours = Math.floor(trickle.secondsElapsed / 3600);
    const minutes = Math.floor((trickle.secondsElapsed % 3600) / 60);
    const elapsed =
      hours > 0
        ? `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`
        : `${minutes}m`;
    const summary = `${parts.join('  ')} from ${elapsed} of production`;
    this.flashToast(`Harvest delivered — ${summary}`);
  }

  // Tracks whether we're currently being entered from a replay
  // context where the player is in spectate mode (no need to coach
  // them about placement). HomeScene doesn't have a real replay
  // mode today, so this is a future-proof hook.
  private replayContextActive(): boolean {
    return false;
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
    let milk = 0;
    if (this.serverBase) {
      for (const b of this.serverBase.buildings) {
        if (b.hp <= 0) continue;
        const inc = INCOME_PER_SECOND[b.kind];
        if (!inc) continue;
        const lvl = Math.max(1, b.level | 0);
        sugar += inc.sugar * lvl * seconds;
        leaf += inc.leafBits * lvl * seconds;
        milk += inc.aphidMilk * lvl * seconds;
      }
    } else {
      for (const b of STARTER_BUILDINGS) {
        const inc = INCOME_PER_SECOND[b.kind];
        if (!inc) continue;
        sugar += inc.sugar * seconds;
        leaf += inc.leafBits * seconds;
        milk += inc.aphidMilk * seconds;
      }
    }
    // Accumulate fractional milk locally so the HUD eventually ticks up;
    // the server tracks an aphid_milk_residual column and floors per
    // request, so a float bank value here stays in sync once /me runs
    // (which overwrites this.resources.aphidMilk with the integer total).
    if (sugar === 0 && leaf === 0 && milk === 0) return;
    // Local-side trickle visually clamps to the cap — the server is
    // doing the same on the next /me, so showing the player numbers
    // they'll keep rather than ones that snap back is the right call.
    const sugarCap = this.storageCaps.sugar;
    const leafCap = this.storageCaps.leaf;
    const milkCap = this.storageCaps.milk;
    this.resources.sugar = sugarCap !== null
      ? Math.min(sugarCap, this.resources.sugar + sugar)
      : this.resources.sugar + sugar;
    this.resources.leafBits = leafCap !== null
      ? Math.min(leafCap, this.resources.leafBits + leaf)
      : this.resources.leafBits + leaf;
    // Milk cap is opt-in via MilkPot (null = uncapped, matches the
    // pre-MilkPot behaviour). Apply the same min/cap dance as the
    // other resources when it's set.
    this.resources.aphidMilk = milkCap !== null
      ? Math.min(milkCap, this.resources.aphidMilk + milk)
      : this.resources.aphidMilk + milk;
    this.refreshResourcePills();
    this.flashResourceGain();
  }

  private flashResourceGain(): void {
    // Milk is now also produced (AphidFarm at Q4+), so pulse its pill
    // alongside sugar + leaf when the local trickle credits anything.
    this.tweens.add({
      targets: [this.sugarText, this.leafText, this.milkText],
      alpha: { from: 0.5, to: 1 },
      duration: 260,
      ease: 'Sine.easeOut',
    });
  }

  // Bigger one-shot reward animation, fired on scene entry when
  // RaidScene set a pendingResourceGain on the runtime. For each
  // non-zero positive delta we (a) scale-pulse the pill text and
  // (b) float a "+N" number upward from the pill, fading out. Zero
  // and negative deltas are skipped — players don't need a "+0" or
  // a refund to fly across the screen. The whole thing lives on a
  // tween schedule so it never blocks input.
  private pulseResourceGains(deltas: {
    sugar: number;
    leafBits: number;
    aphidMilk: number;
  }): void {
    const targets: Array<{
      text: Phaser.GameObjects.Text | null;
      delta: number;
      color: string;
    }> = [
      { text: this.sugarText, delta: Math.round(deltas.sugar), color: '#ffd98a' },
      { text: this.leafText, delta: Math.round(deltas.leafBits), color: '#c8f2a0' },
      { text: this.milkText, delta: Math.round(deltas.aphidMilk), color: '#dfe8ff' },
    ];
    for (const t of targets) {
      if (!t.text || t.delta <= 0) continue;
      // Scale-pulse the pill text — peaks at 1.18× over ~140 ms,
      // settles back over ~260 ms. yoyo in two halves rather than
      // one long tween so the snap-back has its own ease.
      this.tweens.add({
        targets: t.text,
        scale: 1.18,
        duration: 140,
        ease: 'Cubic.easeOut',
        yoyo: true,
      });
      // Floating "+N" number. Anchored just left of the pill text
      // so it doesn't overlap, drifts up ~28 px while fading.
      const float = crispText(
        this,
        t.text.x - 8,
        t.text.y,
        `+${t.delta.toLocaleString()}`,
        displayTextStyle(13, t.color, 3),
      )
        .setOrigin(1, 0.5)
        .setDepth(DEPTHS.hud + 1);
      this.tweens.add({
        targets: float,
        y: t.text.y - 28,
        alpha: { from: 1, to: 0 },
        duration: 900,
        ease: 'Cubic.easeOut',
        onComplete: () => float.destroy(),
      });
    }
  }

  // Formats the inside-pill value text. Sugar + leaf show
  // "current/cap" on tablet/desktop so the player understands storage
  // gates production (when the value reaches the cap, producers stop
  // crediting until the wallet drains). Phone hides the cap to keep
  // the narrower 122 px pill from overflowing — the cap detail is
  // still reachable via the tap-to-explain popover. Both numbers use
  // k-formatting (1240 → 1.2k) once they exceed 1000.
  private formatPillValue(kind: 'sugar' | 'leaf' | 'milk'): string {
    const fmt = (n: number): string => {
      if (n < 1000) return String(Math.floor(n));
      const thousands = n / 1000;
      // 1.2k below 10k; 10k+ rounds to whole-k so "12k" not "12.3k".
      return thousands >= 10
        ? `${Math.round(thousands)}k`
        : `${thousands.toFixed(1).replace(/\.0$/, '')}k`;
    };
    // aphidMilk accumulates fractional locally (see update() trickle); we
    // floor for display so the HUD pill stays integer-clean and matches
    // what the server has banked at the last /me roundtrip. Milk now
    // honors a cap when MilkPot is built; null (uncapped) renders raw.
    if (kind === 'milk') {
      const cap = this.storageCaps.milk;
      const showCap = cap !== null && !this.isMobileLayout();
      const val = this.resources.aphidMilk;
      return showCap ? `${fmt(val)} / ${fmt(cap)}` : fmt(val);
    }

    const val = kind === 'sugar' ? this.resources.sugar : this.resources.leafBits;
    const cap = kind === 'sugar' ? this.storageCaps.sugar : this.storageCaps.leaf;
    const showCap = cap !== null && !this.isMobileLayout();
    return showCap ? `${fmt(val)} / ${fmt(cap)}` : fmt(val);
  }

  // Sums the per-second production from the active server base (or the
  // STARTER_BUILDINGS fallback) for one resource kind. Mirrors the
  // sim-side scaling: production is paused for hp <= 0 buildings, and
  // each level multiplies linearly. Returns a fractional value so the
  // milk pill (0.2/sec at L1) can render "+0.2/sec".
  private computeRate(kind: 'sugar' | 'leaf' | 'milk'): number {
    const buildings = this.serverBase ? this.serverBase.buildings : null;
    let total = 0;
    if (buildings) {
      for (const b of buildings) {
        if (b.hp <= 0) continue;
        const inc = INCOME_PER_SECOND[b.kind];
        if (!inc) continue;
        const mult = Math.max(1, b.level | 0);
        const r =
          kind === 'sugar' ? inc.sugar :
          kind === 'leaf' ? inc.leafBits :
          inc.aphidMilk;
        total += r * mult;
      }
    } else {
      for (const b of STARTER_BUILDINGS) {
        const inc = INCOME_PER_SECOND[b.kind];
        if (!inc) continue;
        total +=
          kind === 'sugar' ? inc.sugar :
          kind === 'leaf' ? inc.leafBits :
          inc.aphidMilk;
      }
    }
    return total;
  }

  // True when the wallet has hit the storage cap for this resource.
  // Used by the HUD to swap the per-pill rate subtitle from
  // "+8/s" to "FULL" so the player understands production is gated
  // until they spend the wallet down.
  private isResourceCapped(kind: 'sugar' | 'leaf' | 'milk'): boolean {
    if (kind === 'sugar') {
      const cap = this.storageCaps.sugar;
      return cap !== null && this.resources.sugar >= cap;
    }
    if (kind === 'leaf') {
      const cap = this.storageCaps.leaf;
      return cap !== null && this.resources.leafBits >= cap;
    }
    // Milk: uncapped until the player builds a MilkPot (cap = null).
    const milkCap = this.storageCaps.milk;
    return milkCap !== null && this.resources.aphidMilk >= milkCap;
  }

  // Single point of truth for refreshing the HUD pills after any
  // resource mutation (trickle, raid result, upgrade debit, place /
  // move building changing the production curve). Keeps the cap
  // fraction text and per-pill rate subtitle in sync with the wallet.
  private refreshResourcePills(): void {
    if (this.sugarText) this.sugarText.setText(this.formatPillValue('sugar'));
    if (this.leafText) this.leafText.setText(this.formatPillValue('leaf'));
    if (this.milkText) this.milkText.setText(this.formatPillValue('milk'));
    const refreshRate = (
      text: Phaser.GameObjects.Text | null,
      kind: 'sugar' | 'leaf' | 'milk',
    ): void => {
      if (!text) return;
      if (this.isResourceCapped(kind)) {
        text.setText('FULL');
        text.setColor(COLOR.textError);
        return;
      }
      const r = this.computeRate(kind);
      text.setText(r > 0 ? `+${formatRate(r)}/s` : '');
      text.setColor(COLOR.textDim);
    };
    refreshRate(this.sugarRateText, 'sugar');
    refreshRate(this.leafRateText, 'leaf');
    refreshRate(this.milkRateText, 'milk');
  }

  // Scene-wide ambient: a continuous grass background behind the
  // playfield so the area outside the bordered board reads as one
  // continuous map (Clash-of-Clans style — the village sits in a
  // larger green field, not on a pastel page). Cheap: 22 stacked
  // bands + a single radial vignette + a few floating motes.
  private drawAmbient(): void {
    const g = this.add.graphics().setDepth(DEPTHS.background);
    // Grass gradient: a saturated mid-green at the top eases into a
    // slightly cooler shade at the bottom. Tokens live in theme.ts
    // (COLOR.grassTop/grassBot) so RaidScene + ArenaScene render the
    // same field tone — the playfield reads as a village inside one
    // continuous map rather than three differently-tinted pages.
    const top = COLOR.grassTop;
    const bot = COLOR.grassBot;
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
    // a "pool of light" — slightly brighter than the surrounding grass
    // so the eye finds the playable rectangle.
    const glow = this.add.graphics().setDepth(DEPTHS.ambient);
    glow.fillStyle(COLOR.warmGlow, 0.08);
    glow.fillEllipse(
      this.scale.width / 2,
      HUD_H + BOARD_H / 2 - 24,
      BOARD_W * 1.08,
      BOARD_H * 1.08,
    );
    // Soft darker vignette at the very bottom so the footer buttons
    // pop against the grass.
    glow.fillStyle(COLOR.mossDark, 0.18);
    glow.fillEllipse(
      this.scale.width / 2,
      this.scale.height + 40,
      Math.min(this.scale.width * 1.4, 1400),
      260,
    );

    for (let i = 0; i < 14; i++) {
      const mote = this.add
        .circle(
          40 + (i * (this.scale.width - 80)) / 13,
          HUD_H + 70 + ((i * 47) % Math.max(160, this.scale.height - 220)),
          i % 3 === 0 ? 3 : 2,
          i % 4 === 0 ? COLOR.warmGlow : COLOR.greenHi,
          0.16,
        )
        .setDepth(DEPTHS.ambientParticles);
      this.tweens.add({
        targets: mote,
        y: mote.y - (16 + (i % 5) * 5),
        alpha: { from: 0.10 + (i % 3) * 0.03, to: 0.28 },
        duration: 1800 + i * 140,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
  }

  private drawHud(): void {
    // Clash-of-Clans-style overlay HUD: no full-width strip, just
    // floating chips + pills in the corners. The map shows through
    // everywhere else. Each HUD element draws its own pill background
    // (drawPill) so it stays legible over the playfield. When the
    // `ui-hud-bg` admin override is active, an opt-in tiled banner
    // strip is restored at the very top — this keeps the affordance
    // for branded skins while leaving the default look transparent.
    const w = this.scale.width;
    if (isUiOverrideActive(this, 'ui-hud-bg')) {
      this.add
        .tileSprite(0, 0, w, HUD_H, 'ui-hud-bg')
        .setOrigin(0, 0)
        .setDepth(DEPTHS.hudChrome);
    }

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

    // Optional admin-flipped wordmark image — kept for branded skins.
    // When the logo is on, it owns the top-left HUD strip (slightly
    // taller than the bar, anchored to the top-left corner) and the
    // account / level disc drops below it instead of fighting for the
    // same row. Without the override the level disc takes the slot.
    const logoActive = tier !== 'phone' && isUiOverrideActive(this, 'ui-logo');
    if (logoActive) {
      // Bigger than the HUD itself so the wordmark reads from across
      // the screen — the bottom of the logo bleeds a few pixels into
      // the board area where the user-level disc + trophy chip sit
      // beneath it (drawAccountChip handles the vertical offset).
      const logoH = Math.round(HUD_H * 1.4);
      const logoX = tier === 'wide' ? 24 : 16;
      const logo = this.add.image(logoX, 8, 'ui-logo')
        .setOrigin(0, 0)
        .setDepth(DEPTHS.hud);
      const source = logo.texture.getSourceImage();
      const srcW = 'naturalWidth' in source ? source.naturalWidth : source.width;
      const srcH = 'naturalHeight' in source ? source.naturalHeight : source.height;
      const scale = logoH / Math.max(1, srcH);
      logo.setDisplaySize(srcW * scale, logoH);
      logo.setInteractive({ useHandCursor: true });
      logo.on('pointerdown', () => openTutorial({ force: true }));
    }

    // Player profile card — Clash-of-Clans-style level + name combo
    // pinned to the top-left. Replaces the previous "HIVE WARS"
    // wordmark + bare username chip with one card that reads as
    // "your colony at a glance". Drops below the wordmark when the
    // logo override is active so the two stack vertically.
    this.drawAccountChip(tier, logoActive);

    // Resource readouts — gold sugar, green leaf, silver milk.
    // CoC-style vertical stack pinned to the top-right corner. Each
    // pill shows icon + value; the per-second rate floats just below
    // the value (still inside the pill) so the player sees production
    // at a glance without crowding the corner with subtitles.
    const pillFont = tier === 'phone' ? 14 : 16;
    const pillTextStroke = 3;
    this.sugarText = crispText(
      this,
      0,
      0,
      this.formatPillValue('sugar'),
      displayTextStyle(pillFont, COLOR.textGold, pillTextStroke),
    ).setOrigin(1, 0.5);
    this.leafText = crispText(
      this,
      0,
      0,
      this.formatPillValue('leaf'),
      displayTextStyle(pillFont, '#c8f2a0', pillTextStroke),
    ).setOrigin(1, 0.5);
    this.milkText = crispText(
      this,
      0,
      0,
      this.formatPillValue('milk'),
      displayTextStyle(pillFont, '#dfe8ff', pillTextStroke),
    ).setOrigin(1, 0.5);

    const badges: Array<{ icon: string; text: Phaser.GameObjects.Text }> = [
      { icon: 'ui-resource-sugar', text: this.sugarText },
      { icon: 'ui-resource-leaf', text: this.leafText },
      { icon: 'ui-resource-milk', text: this.milkText },
    ];

    const PILL_H = tier === 'phone' ? 30 : 34;
    // Wider pills so "current / cap" (e.g. "1240 / 12000") fits
    // without truncation. Phone keeps the narrower variant; cap on
    // phone reads as "1240" alone (formatPillValue sized for it).
    const PILL_W = tier === 'phone' ? 122 : 168;
    const PILL_PAD_X = tier === 'phone' ? 8 : 10;
    const PILL_GAP = tier === 'phone' ? 6 : SPACING.sm;
    const ICON_SIZE = tier === 'phone' ? 20 : 24;
    const rightEdge = this.scale.width - (tier === 'phone' ? SPACING.sm : SPACING.md);
    const pillX = rightEdge - PILL_W;
    // Stack vertically. Top pill anchors at SPACING.sm from the top so
    // it doesn't collide with the profile card on the left.
    let pillY = SPACING.sm;
    const kinds: Array<'sugar' | 'leaf' | 'milk'> = ['sugar', 'leaf', 'milk'];
    for (let i = 0; i < badges.length; i++) {
      const b = badges[i]!;
      const pcy = pillY + PILL_H / 2;
      const pill = this.add.graphics().setDepth(DEPTHS.hud);
      drawPill(pill, pillX, pillY, PILL_W, PILL_H, { brass: false });
      const icon = this.add
        .image(pillX + PILL_PAD_X + ICON_SIZE / 2, pcy, b.icon)
        .setDisplaySize(ICON_SIZE, ICON_SIZE)
        .setDepth(DEPTHS.hud);
      b.text.setPosition(pillX + PILL_W - PILL_PAD_X, pcy);
      b.text.setDepth(DEPTHS.hud);
      const kind = kinds[i]!;
      const hit = this.add
        .zone(pillX + PILL_W / 2, pcy, PILL_W, PILL_H)
        .setOrigin(0.5, 0.5)
        .setInteractive({ useHandCursor: true })
        .setDepth(DEPTHS.hud);
      hit.on('pointerdown', (
        _p: Phaser.Input.Pointer,
        _lx: number,
        _ly: number,
        e: Phaser.Types.Input.EventData,
      ) => {
        e?.stopPropagation?.();
        this.openResourcePopover(kind, pillX + PILL_W / 2, pcy + PILL_H / 2 + 6);
      });

      // Inline rate badge: "+8/s" sits centered between the icon and
      // the value, dim cream so it reads as a subtitle. Switches to
      // "FULL" in coral when the wallet has hit the storage cap so
      // the player understands "I need a vault before I'll produce
      // more". Skipped on phone tier (no horizontal room) and for
      // kinds with no producers.
      const rateValue = this.computeRate(kind);
      const isFull = this.isResourceCapped(kind);
      const rateLabel = isFull ? 'FULL' : `+${formatRate(rateValue)}/s`;
      const rateColor = isFull ? COLOR.textError : COLOR.textDim;
      if (tier !== 'phone' && (rateValue > 0 || isFull)) {
        const rateText = crispText(
          this,
          pillX + PILL_PAD_X + ICON_SIZE + 6,
          pcy,
          rateLabel,
          labelTextStyle(9, rateColor),
        ).setOrigin(0, 0.5).setDepth(DEPTHS.hud);
        if (kind === 'sugar') this.sugarRateText = rateText;
        else if (kind === 'leaf') this.leafRateText = rateText;
        else this.milkRateText = rateText;
      }

      void pill;
      void icon;
      pillY += PILL_H + PILL_GAP;
    }

    // Codex chip — small disc tucked under the resource stack. Kept
    // here (not in the corner stack) because it's lookup, not action.
    this.drawCodexChip(rightEdge, pillY + PILL_H / 2 + 4, tier);

    // Quick-toggles row — sfx mute + fullscreen, pinned right under
    // the codex chip on the same right edge. One tap, no menu hunt.
    // Both toggles persist via the existing settings / scale APIs.
    this.drawHudQuickToggles(rightEdge, pillY + PILL_H + 12, tier);

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
    const c = this.add.container(cx, cy).setDepth(DEPTHS.hud);
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
      labelTextStyle(10, COLOR.textGold),
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

    // Action list — 17+ entries grouped into 4 categories so the
    // drawer reads as sections instead of a wall of buttons. Each
    // section header is a tiny label rendered at startY, and the
    // entries below follow the same layout/pacing.
    type Entry = { label: string; onPress: () => void; variant?: 'primary' | 'secondary' };
    type Section = { title: string; entries: Entry[] };
    const flipLayer: Entry = {
      label: this.layer === 0 ? '↓ Switch to Underground' : '↑ Switch to Surface',
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
    };
    const sections: Section[] = [
      {
        title: 'COMBAT',
        entries: [
          { label: '⚔  Raid a base', variant: 'primary',
            onPress: () => {
              this.closeBurgerDrawer();
              const rt = this.registry.get('runtime') as HiveRuntime | undefined;
              if (rt) {
                void openMatchPreview(this, rt);
              } else {
                // No runtime = guest sign-in still in flight; fall
                // back to the legacy "go straight to raid" path so
                // boot doesn't dead-end on a partial state.
                fadeToScene(this, 'RaidScene');
              }
            } },
          { label: '📖  Campaign',
            onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'CampaignScene'); } },
          { label: '🏟  Arena',
            onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'ArenaScene'); } },
          { label: '📜  Recent raids',
            onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'RaidHistoryScene'); } },
        ],
      },
      {
        title: 'WARS & FEED',
        entries: [
          { label: '🏰  Clan wars',
            onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'ClanWarsScene'); } },
          { label: '🌐  Hive war',
            onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'HiveWarScene'); } },
          { label: '🎬  Top raids',
            onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'ReplayFeedScene'); } },
        ],
      },
      {
        title: 'PROGRESSION',
        entries: [
          { label: '🌳  Queen path',
            onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'ProgressionScene'); } },
          { label: '👑  Queen',
            onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'QueenSkinScene'); } },
          { label: '⚙  Upgrades',
            onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'UpgradeScene'); } },
          { label: '🗓  Quests',
            onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'QuestsScene'); } },
          { label: '⏳  Builders',
            onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'BuilderQueueScene'); } },
        ],
      },
      {
        title: 'BASE & SOCIAL',
        entries: [
          { label: '🧠  Defender AI',
            onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'DefenderAIScene'); } },
          { label: '👥  Clan',
            onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'ClanScene'); } },
          { label: '🏆  Ranks',
            onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'LeaderboardScene'); } },
          { label: '📖  Codex',
            onPress: () => { this.closeBurgerDrawer(); fadeToScene(this, 'CodexScene'); } },
        ],
      },
      {
        title: 'SYSTEM',
        entries: [
          { label: '❓  Help',
            onPress: () => { this.closeBurgerDrawer(); openTutorial({ force: true }); } },
          { label: '⚙️  Settings',
            onPress: () => { this.closeBurgerDrawer(); openSettings(); } },
          {
            label: this.scale.isFullscreen ? '⤡  Exit fullscreen' : '⤢  Fullscreen',
            onPress: () => {
              this.closeBurgerDrawer();
              // iOS Safari refuses this — silent no-op there.
              if (this.scale.isFullscreen) this.scale.stopFullscreen();
              else this.scale.startFullscreen();
            },
          },
        ],
      },
    ];
    const btnH = 48;
    const btnW = W - 32;
    const startY = 110;
    const gap = 6;
    const sectionGap = 18;
    const headerH = 22;
    let cursorY = startY;
    // Quick layer flip lives above the sections — it's the
    // most-used non-CTA action and shouldn't share a header.
    {
      const y = cursorY + btnH / 2;
      const btn = makeHiveButton(this, {
        x: W / 2, y, width: btnW, height: btnH,
        label: flipLayer.label,
        variant: 'secondary',
        fontSize: 14,
        onPress: flipLayer.onPress,
      });
      container.add(btn.container);
      cursorY += btnH + sectionGap;
    }
    for (const section of sections) {
      // Section header — uppercase tag-style label.
      const header = crispText(this, 16, cursorY, section.title,
        labelTextStyle(10, COLOR.textGold))
        .setOrigin(0, 0);
      container.add(header);
      cursorY += headerH;
      for (const e of section.entries) {
        const y = cursorY + btnH / 2;
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
        cursorY += btnH + gap;
      }
      cursorY += sectionGap - gap;
    }

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
    const pill = this.add.graphics().setDepth(DEPTHS.hud);
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
        : labelTextStyle(11, COLOR.textGold),
    ).setOrigin(0.5, 0.5).setDepth(DEPTHS.hud);
    this.add
      .zone(left + pillW / 2, cy, pillW, pillH)
      .setOrigin(0.5, 0.5)
      .setInteractive({ useHandCursor: true })
      .setDepth(DEPTHS.hud)
      .on('pointerdown', () => fadeToScene(this, 'CodexScene'));
    void pill;
    void glyph;
  }

  // Sfx + fullscreen quick-toggles. Sit just below the codex chip on
  // the same right edge so a single tap from anywhere on the home
  // screen mutes audio or enters fullscreen — without making the
  // player hunt for Settings inside the burger drawer.
  private drawHudQuickToggles(
    rightEdgeX: number,
    cy: number,
    tier: 'wide' | 'narrow' | 'phone',
  ): void {
    const size = tier === 'phone' ? 28 : 32;
    const gap = 6;
    let cursorX = rightEdgeX - size / 2;
    const drawOne = (
      glyph: () => string,
      onPress: () => void,
    ): void => {
      const ix = cursorX;
      const bg = this.add.graphics().setDepth(DEPTHS.hud);
      const txt = crispText(
        this,
        ix,
        cy,
        glyph(),
        labelTextStyle(tier === 'phone' ? 14 : 16, COLOR.textGold),
      ).setOrigin(0.5, 0.5).setDepth(DEPTHS.hud);
      const paint = (): void => {
        bg.clear();
        bg.fillStyle(0x1a2b1a, 0.9);
        bg.lineStyle(1, COLOR.brassDeep, 1);
        bg.fillCircle(ix, cy, size / 2);
        bg.strokeCircle(ix, cy, size / 2);
      };
      paint();
      this.add
        .zone(ix, cy, size, size)
        .setOrigin(0.5, 0.5)
        .setInteractive({ useHandCursor: true })
        .setDepth(DEPTHS.hud)
        .on('pointerdown', () => {
          onPress();
          txt.setText(glyph());
          paint();
        });
      cursorX -= size + gap;
    };

    drawOne(
      () => (getSettings().muted ? '🔇' : '🔊'),
      () => setSettings({ muted: !getSettings().muted }),
    );
    drawOne(
      () => (this.scale.isFullscreen ? '⤡' : '⤢'),
      () => {
        if (this.scale.isFullscreen) this.scale.stopFullscreen();
        else this.scale.startFullscreen();
      },
    );
  }

  // Icon-only profile card — Clash-of-Clans style. A brass level
  // disc sits in the top-left corner with a compact trophy chip
  // underneath. The username pill is gone in fullscreen-map mode;
  // the player can still open the account menu (login / claim /
  // logout) by tapping the disc. Username is surfaced inside the
  // account modal once opened.
  private drawAccountChip(
    tier: 'wide' | 'narrow' | 'phone',
    logoActive = false,
  ): void {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    const trophies = runtime?.player?.player.trophies ?? 0;
    const level = this.currentQueenLevel();
    const burgerSlot = this.isMobileLayout() ? 40 + SPACING.sm : 0;

    // Level disc — bright brass with the level number, mirrors CoC's
    // experience badge in the corner. When the logo override is on we
    // park the disc directly below the wordmark instead of inside the
    // HUD bar, so the user sees [LOGO] / [LEVEL+TROPHY] stacked.
    const discSize = tier === 'phone' ? 36 : 44;
    const discX = burgerSlot + SPACING.sm + discSize / 2;
    const cy = logoActive
      ? Math.round(HUD_H * 1.4) + 16 + discSize / 2
      : HUD_H / 2;
    const discBg = this.add.graphics().setDepth(DEPTHS.hud);
    drawPill(discBg, discX - discSize / 2, cy - discSize / 2, discSize, discSize, {
      brass: true,
    });
    crispText(
      this,
      discX,
      cy,
      String(level),
      displayTextStyle(tier === 'phone' ? 16 : 20, COLOR.textDark, 2),
    ).setOrigin(0.5, 0.5).setDepth(DEPTHS.hud);

    // Off-screen accountChip placeholder — kept so the fetchMe()
    // callback has somewhere to write. The username is no longer
    // shown on the HUD; it surfaces inside the account modal when
    // the disc is tapped.
    this.accountChip = crispText(this, -9999, -9999, '', labelTextStyle(10));

    // Trophy chip directly under the disc. Same on every tier so the
    // top-left icon stack is consistent across viewports.
    const trophyW = tier === 'phone' ? 52 : 60;
    const trophyH = tier === 'phone' ? 16 : 18;
    const trophyY = cy + discSize / 2 + 4;
    const trophyBg = this.add.graphics().setDepth(DEPTHS.hud);
    drawPill(trophyBg, discX - trophyW / 2, trophyY, trophyW, trophyH, {
      brass: false,
    });
    crispText(
      this,
      discX,
      trophyY + trophyH / 2,
      `▲ ${trophies}`,
      labelTextStyle(tier === 'phone' ? 9 : 10, COLOR.textGold),
    ).setOrigin(0.5, 0.5).setDepth(DEPTHS.hud);
    void trophyBg;

    // Win-streak chip — paints between the trophy count and the tier
    // badge whenever the session streak is hot (>= 2). Pulses to draw
    // the eye toward "you're on a roll, raid again."
    const streak = readWinStreak();
    if (streak.count >= 2) {
      const streakW = tier === 'phone' ? 60 : 70;
      const streakH = tier === 'phone' ? 16 : 18;
      const streakY = trophyY + trophyH + 3;
      const streakBg = this.add.graphics().setDepth(DEPTHS.hud);
      streakBg.fillStyle(0xff7a92, 1);
      streakBg.fillRoundedRect(discX - streakW / 2, streakY, streakW, streakH, 5);
      streakBg.lineStyle(1, 0xb13455, 1);
      streakBg.strokeRoundedRect(discX - streakW / 2, streakY, streakW, streakH, 5);
      const bonus = streakBonusPct(streak.count);
      const streakLabel = crispText(
        this,
        discX,
        streakY + streakH / 2,
        bonus > 0 ? `🔥 ${streak.count} · +${bonus}%` : `🔥 ${streak.count} streak`,
        labelTextStyle(tier === 'phone' ? 8 : 9, '#fff8ec'),
      ).setOrigin(0.5, 0.5).setDepth(DEPTHS.hud);
      this.tweens.add({
        targets: [streakBg, streakLabel],
        alpha: { from: 0.85, to: 1 },
        duration: 700,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    // Tier badge — small color chip directly under the trophy count
    // showing the player's ladder identity (Worker/Soldier/Drone/...).
    // Tappable to open the leaderboard.
    const tierData = Sim.trophyTierFor(trophies);
    const tierW = tier === 'phone' ? 64 : 72;
    const tierH = tier === 'phone' ? 16 : 18;
    // When the streak chip is showing, push the tier badge below it
    // so the two don't overlap. The streak chip uses the same vertical
    // slot, so we add streakH + gap when active.
    const streakStackOffset =
      streak.count >= 2 ? (tier === 'phone' ? 19 : 21) : 0;
    const tierY = trophyY + trophyH + 3 + streakStackOffset;
    const tierBg = this.add.graphics().setDepth(DEPTHS.hud);
    tierBg.fillStyle(tierData.color, 1);
    tierBg.fillRoundedRect(discX - tierW / 2, tierY, tierW, tierH, 5);
    tierBg.lineStyle(1, COLOR.strokeDark, 1);
    tierBg.strokeRoundedRect(discX - tierW / 2, tierY, tierW, tierH, 5);
    crispText(
      this,
      discX,
      tierY + tierH / 2,
      `${tierData.glyph} ${tierData.name} ${tierData.stripe}`,
      labelTextStyle(tier === 'phone' ? 8 : 9, '#1f2148'),
    ).setOrigin(0.5, 0.5).setDepth(DEPTHS.hud);

    // Single hit zone covering disc + trophy chip — entire icon
    // stack is tappable so even fat-finger taps catch the menu.
    const hitH = discSize + 4 + trophyH;
    this.add
      .zone(discX, cy + 2, Math.max(discSize, trophyW), hitH)
      .setOrigin(0.5, 0.5)
      .setInteractive({ useHandCursor: true })
      .setDepth(DEPTHS.hud)
      .on('pointerdown', () => this.openAccountMenu());

    // fetchMe still runs so the off-screen accountChip stays in
    // sync; the modal that opens on tap reads from rt.auth, not
    // from accountChip, but keeping the field warm avoids dead
    // state across scene restarts.
    const rt = this.registry.get('runtime') as HiveRuntime | undefined;
    if (rt) {
      void rt.auth.fetchMe().then((me) => {
        if (!me || !this.accountChip?.active) return;
        const name = me.isGuest || !me.username ? 'GUEST' : `@${me.username}`;
        // Truncate long usernames so the trophy badge stays inside
        // the name pill (narrow tier has ~10 chars of room before
        // the badge eats the tail).
        const limit = tier === 'wide' ? 14 : 10;
        this.accountChip.setText(
          name.length > limit ? `${name.slice(0, limit - 1)}…` : name,
        );
        this.accountChip.setColor(me.isGuest ? COLOR.textDim : COLOR.textGold);
      });
    }
  }

  private drawBoard(): void {
    // Layer-aware palette. Surface = bright pastel mint daylight;
    // underground = warm peachy tan with butter highlights. Both
    // tracks match the vibrant-pastel theme in theme.ts.
    const palette =
      this.layer === 0
        ? {
            grid: 0x4d9b5c,
            decorA: 0xd3f1d8,  // pale mint highlights
            decorB: 0x6cd47e,  // saturated mint dots
            frame: 0x4d9b5c,
            highlight: 0xe8fff0,
          }
        : {
            // Underground is packed earth — the grid is a darker
            // chocolate brown so the cells read against the dirt
            // wash. Decorations are pebble-grey + sand specks.
            grid: 0x3a2410,
            decorA: 0xc9a781,  // pale sand specks
            decorB: 0x8a6f4d,  // pebble grey-brown
            frame: 0x3a2410,
            highlight: 0xd6b58d,
          };

    // Solid layer underlay — fully opaque so no painterly board-
    // background sprite shows through with brown patches behind the
    // grid. Surface = saturated grass green; underground = packed
    // earth brown (the rocks layer below adds enough texture without
    // needing the sprite). Skipping the board-background image
    // entirely also avoids a placeholder-loaded fallback that the
    // user perceived as "brown boxes behind the grid".
    const underlay = this.add.graphics();
    underlay.setDepth(DEPTHS.boardUnder);
    if (this.layer === 0) {
      underlay.fillStyle(0x6cbf6a, 1);
    } else {
      underlay.fillStyle(0x6b4524, 1);
    }
    underlay.fillRect(0, 0, BOARD_W, BOARD_H);
    this.boardContainer.add(underlay);

    // Underground gets a few extra "rock" decals along the edges so
    // it reads as a tunnel chamber rather than a flat brown square.
    // Deterministic seed so the pattern doesn't flicker on redraw.
    if (this.layer === 1) {
      const rocks = this.add.graphics();
      let rseed = 0x10cafe;
      const rrnd = (): number => {
        rseed ^= rseed << 13;
        rseed ^= rseed >>> 17;
        rseed ^= rseed << 5;
        return ((rseed >>> 0) / 0xffffffff);
      };
      rocks.fillStyle(0x3a2410, 0.55);
      for (let i = 0; i < 24; i++) {
        const onEdge = rrnd() < 0.5;
        const x = onEdge
          ? (rrnd() < 0.5 ? rrnd() * 24 : BOARD_W - rrnd() * 24)
          : rrnd() * BOARD_W;
        const y = onEdge
          ? rrnd() * BOARD_H
          : (rrnd() < 0.5 ? rrnd() * 24 : BOARD_H - rrnd() * 24);
        const r = 3 + rrnd() * 5;
        rocks.fillCircle(x, y, r);
      }
      // A few darker root scratches in the middle so the field has
      // texture beyond just rock clusters.
      rocks.lineStyle(2, 0x2b1a08, 0.35);
      for (let i = 0; i < 8; i++) {
        const x1 = rrnd() * BOARD_W;
        const y1 = rrnd() * BOARD_H;
        const len = 18 + rrnd() * 30;
        const ang = rrnd() * Math.PI * 2;
        rocks.lineBetween(x1, y1, x1 + Math.cos(ang) * len, y1 + Math.sin(ang) * len);
      }
      this.boardContainer.add(rocks);
    }

    // Corner vignette — darkens the edges so the eye focuses on the
    // center of the base. Four triangular gradients built out of
    // overlapping alpha-rects, cheap and GPU-friendly.
    const bg = this.add.graphics();
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

    // Grid lines — drawn as crisp small box outlines so each tile reads
    // as a discrete cell against the grass. The previous render used
    // continuous full-board lines at low alpha; a per-tile stroke with
    // a slightly inset rect keeps the box visible without bleeding the
    // grid color across building art.
    const grid = this.add.graphics();
    grid.lineStyle(1, palette.grid, 0.55);
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        grid.strokeRect(x * TILE + 0.5, y * TILE + 0.5, TILE - 1, TILE - 1);
      }
    }

    // No visible board frame in fullscreen-map mode. The previous
    // render painted a rounded mint outline + drop shadow, which
    // read as a raised "card" floating on the grass — the user
    // perceived it as letterboxing. Letting the playfield bleed
    // straight into the surrounding ambient grass gives the true
    // CoC-style "village inside one continuous map" feel.
    const frame = this.add.graphics();
    void frame;

    // No mode-title banner inside the board — the layer-flip button
    // in the bottom-left corner doubles as the mode indicator (☀ for
    // surface, ⛏ for underground), so a redundant brass chip on the
    // playfield would just compete with building art for attention.
    this.boardContainer.add([bg, deco, grid, frame]);
  }

  // Index of server-base building sprites keyed by the building's
  // stable `id`. Lets us surgically update / remove a single sprite on
  // an upgrade or demolish without a full board repaint (which causes
  // flicker + churns every sprite's tween timer).
  private homeBuildingSprites: Map<string, Phaser.GameObjects.Image> = new Map();

  // Persistent overlay graphic that paints a soft "+" on every empty
  // buildable tile, plus the corresponding pulse tween so the marks
  // breathe gently. Cleared and rebuilt whenever the layout changes
  // (build, demolish, move, layer switch). Hidden during move-mode +
  // picker so it doesn't compete with those overlays.
  private emptyTileHints: Phaser.GameObjects.Graphics | null = null;
  private emptyTileHintsTween: Phaser.Tweens.Tween | null = null;

  private drawEmptyTileHints(): void {
    if (this.emptyTileHintsTween) {
      this.emptyTileHintsTween.stop();
      this.emptyTileHintsTween = null;
    }
    if (this.emptyTileHints) {
      this.emptyTileHints.destroy();
      this.emptyTileHints = null;
    }
    // While the player is moving a building or has the picker open,
    // those flows render their own overlays — stack avoidance.
    if (this.moveMode) return;
    if (this.pickerContainer) return;

    const g = this.add.graphics();
    // Tiny brass "+" — small enough to disappear behind a building
    // sprite but visible on bare grass. Smaller than before (3 px
    // arms instead of 5, hairline stroke) so the grid stays the
    // primary structure on the board.
    g.lineStyle(1, COLOR.brass, 0.45);

    let drewAny = false;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        if (this.isTileOccupied(x, y, this.layer)) continue;
        const cx = x * TILE + TILE / 2;
        const cy = y * TILE + TILE / 2;
        g.lineBetween(cx - 3, cy, cx + 3, cy);
        g.lineBetween(cx, cy - 3, cx, cy + 3);
        drewAny = true;
      }
    }

    if (!drewAny) {
      g.destroy();
      return;
    }

    this.boardContainer.add(g);
    // Layering note: container z-order in Phaser is insertion order
    // (boardContainer doesn't sortChildrenFlag), so the hints render
    // on top of the grid + building sprites by virtue of being added
    // last. That's fine — hints only paint on empty tiles, so they
    // never visually overlap a building, and the brass "+" reads
    // cleanly over the grid lines underneath.
    this.emptyTileHints = g;
    // Gentle breathing pulse so the affordances feel alive without
    // being distracting (matches CoC's "tap here" subtle hint cadence).
    this.emptyTileHintsTween = this.tweens.add({
      targets: g,
      alpha: { from: 0.55, to: 1 },
      duration: 1600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  private drawBuildings(): void {
    // Prefer the server's base snapshot. Fall back to the hardcoded
    // starter layout when running guest-local (DB unavailable).
    if (this.serverBase) {
      this.homeBuildingSprites.clear();
      for (const b of this.serverBase.buildings) {
        const spr = this.createBuildingSprite(b);
        if (spr) this.homeBuildingSprites.set(b.id, spr);
      }
    } else {
      for (const b of STARTER_BUILDINGS) {
        const spansBoth = b.kind === 'QueenChamber';
        if (!spansBoth && b.layer !== this.layer) continue;
        // Match createBuildingSprite: chamber 2×2 fills four cells,
        // every other starter is 1×1. Sprites display at exact
        // footprint × TILE so they line up with the grid.
        const fw = spansBoth ? 2 : 1;
        const fh = spansBoth ? 2 : 1;
        const x = b.x * TILE + (fw * TILE) / 2;
        const y = b.y * TILE + (fh * TILE) / 2;
        const spr = this.add.image(x, y, `building-${b.kind}`);
        spr.setOrigin(0.5, 0.5) /* center sprite within footprint cell so it never bleeds above the grid */;
        spr.setAlpha(spansBoth && b.layer !== this.layer ? 0.65 : 1);
        spr.setDisplaySize(fw * TILE, fh * TILE);
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
    // Affordances paint after the buildings exist so isTileOccupied
    // sees the live layout.
    this.drawEmptyTileHints();
    this.drawHarvestIndicators();
    // Re-render upgrade badges with each building rebuild so a
    // newly-enqueued / completed job swaps its chip without
    // waiting for the 5 s refresh tick.
    this.drawUpgradeIndicators();
  }

  // Per-building floating coin chip rendered on top of any producer
  // whose pendingHarvest bucket has at least one pending unit.
  // Tapping the chip (or the building sprite below it) calls
  // /player/harvest, which claims every producer at once and updates
  // the wallet. Chips are recreated whenever the base snapshot
  // changes — drawBuildings is the canonical re-render hook.
  private harvestChips: Phaser.GameObjects.Container[] = [];

  // Active in-progress builder jobs (one per building being upgraded
  // / placed). Refreshed on scene create + every 5 s while the
  // scene is open, so the badge labels under each building stay
  // accurate without hammering the API. Cleared on shutdown.
  private builderEntries: BuilderEntry[] = [];
  private upgradeChips: Phaser.GameObjects.Container[] = [];
  private builderRefreshTimer: Phaser.Time.TimerEvent | null = null;

  // Pull the live builder queue from the server. Called once on
  // scene create + on a 5 s ticker so the per-building badge text
  // stays close to real-time. Failures are non-fatal (no badges
  // is fine) so the scene never crashes on offline.
  private async refreshBuilderEntries(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const r = await runtime.api.getBuilder();
      if (!this.scene.isActive()) return;
      this.builderEntries = r.entries;
      this.drawUpgradeIndicators();
    } catch {
      /* swallow — offline or API blip */
    }
  }

  private drawUpgradeIndicators(): void {
    for (const c of this.upgradeChips) c.destroy();
    this.upgradeChips = [];
    if (!this.serverBase || this.builderEntries.length === 0) return;
    const now = Date.now();
    const entriesById = new Map<string, BuilderEntry>();
    for (const e of this.builderEntries) {
      if (e.targetKind !== 'building') continue;
      entriesById.set(e.targetId, e);
    }
    if (entriesById.size === 0) return;

    for (const b of this.serverBase.buildings) {
      const entry = entriesById.get(b.id);
      if (!entry) continue;
      const spansBoth = (b.spans?.length ?? 0) > 1;
      const onThisLayer = spansBoth || b.anchor.layer === this.layer;
      if (!onThisLayer) continue;

      // Anchor the badge over the building's top-right corner so
      // it never collides with the harvest chip (top-center) on
      // the same building.
      const cx = b.anchor.x * TILE + b.footprint.w * TILE - 8;
      const cy = b.anchor.y * TILE + 6;
      const chip = this.add.container(cx, cy).setDepth(DEPTHS.boardOverlay);

      // Round amber background with hammer glyph + countdown text.
      // Hammer 🔨 is a single-codepoint emoji that rasterises on
      // every modern OS; falls back to "↑" if the platform's
      // emoji set fails (rare).
      const bg = this.add.graphics();
      bg.fillStyle(0xf4a623, 0.95);
      bg.fillRoundedRect(-32, -10, 64, 22, 11);
      bg.lineStyle(2, 0x6e3c0a, 1);
      bg.strokeRoundedRect(-32, -10, 64, 22, 11);

      const endsAt = new Date(entry.endsAt).getTime();
      const secondsLeft = Math.max(0, Math.round((endsAt - now) / 1000));
      const label = secondsLeft > 0 ? formatCountdown(secondsLeft) : 'done';
      const text = crispText(
        this,
        4,
        0,
        `🔨 ${label}`,
        labelTextStyle(10, '#1f1208'),
      ).setOrigin(0.5, 0.5);

      chip.add([bg, text]);
      // Subtle bob so the chip reads as "active" without competing
      // with the harvest chip's stronger pulse.
      this.tweens.add({
        targets: chip,
        y: cy - 2,
        duration: 1100,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
      this.boardContainer.add(chip);
      this.upgradeChips.push(chip);
    }
  }

  private drawHarvestIndicators(): void {
    for (const c of this.harvestChips) c.destroy();
    this.harvestChips = [];
    if (!this.serverBase) return;
    for (const b of this.serverBase.buildings) {
      if (!this.buildingHasPendingHarvest(b)) continue;
      // Skip buildings that aren't on the current layer (the chip
      // only makes sense over the visible sprite). Spans-both
      // buildings render on every layer so still pass.
      const spansBoth = (b.spans?.length ?? 0) > 1;
      const onThisLayer = spansBoth || b.anchor.layer === this.layer;
      if (!onThisLayer) continue;
      const cx = b.anchor.x * TILE + (b.footprint.w * TILE) / 2;
      const cy = b.anchor.y * TILE - 10;
      const chip = this.add.container(cx, cy).setDepth(DEPTHS.boardOverlay);
      // Per-resource icon — reads as "tap to harvest sugar" rather
      // than a generic ✨. Picked from whichever resource has the
      // largest pending bucket on this building (a DewCollector
      // pends only sugar; an AphidFarm only milk; a SugarVault
      // pends both sugar trickle + leaf-on-destroy, but vault
      // production is sugar-dominant). Renders the matching
      // sprite from `ui-harvest-{kind}` if available, otherwise
      // an emoji glyph fallback (pre-art rendering).
      const dominant = this.dominantPendingResource(b);
      const spriteKey = `ui-harvest-${dominant}`;
      const fallbackGlyph = dominant === 'sugar' ? '🍯' : dominant === 'leaf' ? '🍃' : '🥛';
      const bg = this.add.graphics();
      bg.fillStyle(COLOR.brass, 0.95);
      bg.fillCircle(0, 0, 14);
      bg.lineStyle(2, COLOR.brassDeep, 1);
      bg.strokeCircle(0, 0, 14);
      let face: Phaser.GameObjects.GameObject;
      if (this.textures.exists(spriteKey)) {
        face = this.add.image(0, 0, spriteKey).setDisplaySize(20, 20);
      } else {
        face = crispText(this, 0, 1, fallbackGlyph, displayTextStyle(13, COLOR.textDark, 1)).setOrigin(0.5, 0.5);
      }
      const hit = this.add.zone(0, 0, 36, 36).setOrigin(0.5, 0.5).setInteractive({ useHandCursor: true });
      // Tap on the harvest chip MUST NOT also open the building info
      // modal of the producer beneath it. Phaser's input dispatch isn't
      // reliable here because the chip is a child of a container while
      // the building sprite lives directly on boardContainer — the two
      // interactives end up at adjacent depths and pointerup occasionally
      // lands on the building. Belt + braces:
      //   1. stopPropagation on pointerdown + pointerup so the bubbling
      //      path is closed when topOnly does work.
      //   2. Latch a "harvest tap was just here" timestamp the building
      //      sprite's pointerup checks before opening its modal.
      //   3. Latch the scene-level board-tap guard so wireBoardTap()'s
      //      pointerup branch doesn't open the empty-tile picker either.
      const stop = (e: Phaser.Types.Input.EventData): void => {
        e?.stopPropagation?.();
      };
      hit.on('pointerdown', (_p: Phaser.Input.Pointer, _lx: number, _ly: number, e: Phaser.Types.Input.EventData) => {
        stop(e);
        this.harvestTapAtMs = this.time.now;
        this.tapStartedInsidePicker = true;
        void this.runHarvest();
      });
      hit.on('pointerup', (_p: Phaser.Input.Pointer, _lx: number, _ly: number, e: Phaser.Types.Input.EventData) => {
        stop(e);
        this.harvestTapAtMs = this.time.now;
      });
      chip.add([bg, face, hit]);
      // Gentle bobbing tween so the chip reads as "ready to claim"
      // — same affordance CoC uses on its mortar / collector ready
      // state. Cheap, single tween per chip.
      this.tweens.add({
        targets: chip,
        y: cy - 4,
        duration: 700,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
      this.boardContainer.add(chip);
      this.harvestChips.push(chip);
    }
    // Toggle the global "Collect All" CTA based on whether any
    // producer is ready. Defined later in this file.
    this.refreshCollectAllVisibility();
  }

  private buildingHasPendingHarvest(b: Types.Building): boolean {
    const p = b.pendingHarvest;
    if (!p) return false;
    return (p.sugar | 0) > 0 || (p.leafBits | 0) > 0 || (p.aphidMilk | 0) > 0;
  }

  // Pick which resource icon to show on a producer's harvest chip.
  // Defaults to whichever bucket holds the largest pending value;
  // ties broken by sugar > leaf > milk (the order the player
  // unlocks them).
  private dominantPendingResource(b: Types.Building): 'sugar' | 'leaf' | 'milk' {
    const p = b.pendingHarvest;
    if (!p) return 'sugar';
    const s = p.sugar | 0, l = p.leafBits | 0, m = p.aphidMilk | 0;
    if (s >= l && s >= m) return 'sugar';
    if (l >= m) return 'leaf';
    return 'milk';
  }

  private async runHarvest(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const res = await runtime.api.harvestAll();
      // Patch runtime so a subsequent scene enter sees the new
      // wallet + base. Keep storage caps in sync via /me on next
      // load — they don't change on harvest.
      if (runtime.player) {
        runtime.player.base = res.base;
        runtime.player.player.sugar = res.player.sugar;
        runtime.player.player.leafBits = res.player.leafBits;
        runtime.player.player.aphidMilk = res.player.aphidMilk;
      }
      this.serverBase = res.base;
      this.resources = {
        sugar: res.player.sugar,
        leafBits: res.player.leafBits,
        aphidMilk: res.player.aphidMilk,
      };
      this.refreshResourcePills();
      // Sell the wallet change visually — float a chip from each
      // ready producer to the matching pill so the harvest reads as
      // physical and not just a counter snap. Done BEFORE the board
      // repaint below so the chips' source coords map to where the
      // building actually rendered.
      const pillTargets = this.resourcePillTargets();
      for (const b of res.base.buildings) {
        const prevPending = this.serverBase?.buildings.find((x) => x.id === b.id)?.pendingHarvest;
        if (!prevPending) continue;
        const cx = b.anchor.x * TILE + (b.footprint.w * TILE) / 2 + this.boardContainer.x;
        const cy = b.anchor.y * TILE + this.boardContainer.y;
        if ((prevPending.sugar | 0) > 0 && pillTargets.sugar) {
          spawnFloatNumber({ scene: this, x: cx, y: cy, amount: prevPending.sugar | 0, kind: 'sugar', toX: pillTargets.sugar.x, toY: pillTargets.sugar.y });
        }
        if ((prevPending.leafBits | 0) > 0 && pillTargets.leaf) {
          spawnFloatNumber({ scene: this, x: cx, y: cy, amount: prevPending.leafBits | 0, kind: 'leaf', toX: pillTargets.leaf.x, toY: pillTargets.leaf.y });
        }
        if ((prevPending.aphidMilk | 0) > 0 && pillTargets.milk) {
          spawnFloatNumber({ scene: this, x: cx, y: cy, amount: prevPending.aphidMilk | 0, kind: 'milk', toX: pillTargets.milk.x, toY: pillTargets.milk.y });
        }
      }
      // Re-render so the cleared pendingHarvest fields stop chips.
      this.boardContainer.removeAll(true);
      this.drawBoard();
      this.drawBuildings();
      const parts: string[] = [];
      if (res.harvested.sugar > 0) parts.push(`+${res.harvested.sugar} sugar`);
      if (res.harvested.leafBits > 0) parts.push(`+${res.harvested.leafBits} leaf`);
      if (res.harvested.aphidMilk > 0) parts.push(`+${res.harvested.aphidMilk} milk`);
      if (parts.length > 0) {
        this.flashToast(`Harvested ${parts.join(', ')}`);
      }
      const overflow = res.overflow.sugar + res.overflow.leafBits;
      if (overflow > 0) {
        // Surface storage-cap overflow so the player understands they
        // need a vault upgrade; without this the harvest would silently
        // discard the over-cap portion and the math wouldn't add up.
        this.time.delayedCall(800, () => {
          this.flashToast(`Storage full — ${overflow} lost. Upgrade your vault to keep more.`);
        });
      }
    } catch (err) {
      this.flashToast(`Harvest failed: ${(err as Error).message}`);
    }
  }

  // Screen coords of the sugar / leaf / milk pill targets so floating
  // resource chips know where to drift toward. Reads from the live
  // text gameobjects so it stays correct after a HUD reflow.
  private resourcePillTargets(): {
    sugar: { x: number; y: number } | null;
    leaf: { x: number; y: number } | null;
    milk: { x: number; y: number } | null;
  } {
    const fromText = (
      t: Phaser.GameObjects.Text | undefined,
    ): { x: number; y: number } | null =>
      t && t.active ? { x: t.x - t.width / 2, y: t.y } : null;
    return {
      sugar: fromText(this.sugarText),
      leaf: fromText(this.leafText),
      milk: fromText(this.milkText),
    };
  }

  private collectAllButton: HiveButton | null = null;

  private refreshCollectAllVisibility(): void {
    const anyPending = (this.serverBase?.buildings ?? []).some((b) =>
      this.buildingHasPendingHarvest(b),
    );
    if (anyPending) {
      this.drawCollectAllButton();
    } else if (this.collectAllButton) {
      this.collectAllButton.destroy();
      this.collectAllButton = null;
    }
  }

  private drawCollectAllButton(): void {
    if (this.collectAllButton) return;
    // Anchor between the resource stack and the bottom-right corner
    // stack so it lands in the player's natural scan path. Positioned
    // by handleResize on viewport changes.
    const x = this.scale.width - 100;
    const y = HUD_H + 200;
    const btn = makeHiveButton(this, {
      x,
      y,
      width: 168,
      height: 38,
      label: 'Collect All ✨',
      variant: 'primary',
      fontSize: 13,
      onPress: () => { void this.runHarvest(); },
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
    this.collectAllButton = btn;
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
    const rot = (b.rotation ?? 0) as 0 | 1 | 2 | 3;
    const spr = this.add.image(x, y, wallTextureKey(b, this.serverBase, rot));
    spr.setOrigin(0.5, 0.5) /* center sprite within footprint cell so it never bleeds above the grid */;
    spr.setAlpha(spansBoth && b.anchor.layer !== this.layer ? 0.65 : 1);
    // Buildings render at exactly footprint × TILE so each kind
    // sits inside its grid cells instead of bleeding across the
    // surrounding lines. This makes the grid the single source of
    // truth for building scale: a 1×1 fits one tile, a 2×2
    // (QueenChamber, AcidSpitter, SpiderNest) fills four, and the
    // size hierarchy chamber > medium > small reads cleanly without
    // any oversize fudge factor.
    spr.setDisplaySize(b.footprint.w * TILE, b.footprint.h * TILE);
    // For wall kinds rotation is encoded in the texture (LeafWall vs
    // LeafWallV). For any other rotatable kind we'd still map the 90°
    // step to a Phaser transform, but currently only walls rotate so
    // this branch is effectively dead — kept for forward-compat.
    if (rot !== 0 && !KINDS_WITH_V_VARIANTS.has(b.kind)) {
      spr.setRotation((rot * Math.PI) / 2);
    }
    this.tweens.add({
      targets: spr,
      scale: { from: spr.scale, to: spr.scale * 1.03 },
      duration: 1400 + Math.random() * 800,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    // Generous hit area: the building's painterly texture usually
    // has empty corners in the 128×128 source, but we want the tap
    // target to match the tile footprint the player sees. Override
    // the default texture-size rect with a wider one so a click
    // "near" the building still counts as "on" it. Coordinates are
    // texture-space (0,0 = top-left of source image); padding by
    // 20% on each side closes the gap without overlapping neighbor
    // tiles meaningfully.
    const padX = spr.width * 0.2;
    const padY = spr.height * 0.2;
    spr.setInteractive(
      new Phaser.Geom.Rectangle(-padX, -padY, spr.width + padX * 2, spr.height + padY * 2),
      Phaser.Geom.Rectangle.Contains,
    );
    spr.input!.cursor = 'pointer';
    // Claim the pointerdown so the scene-level board-tap handler
    // in wireBoardTap() doesn't also open the empty-tile picker
    // when the press actually landed on this sprite. Without this,
    // some touches register both the sprite's tap (→ modal) AND
    // the scene's tap (→ picker) in the same gesture, giving the
    // "building tapped shows the picker too" behavior the user
    // flagged.
    spr.on('pointerdown', (
      _p: Phaser.Input.Pointer,
      _lx: number,
      _ly: number,
      e: Phaser.Types.Input.EventData,
    ) => {
      e?.stopPropagation?.();
    });
    spr.on('pointerup', (
      p: Phaser.Input.Pointer,
      _lx: number,
      _ly: number,
      e: Phaser.Types.Input.EventData,
    ) => {
      e?.stopPropagation?.();
      // Suppress the info modal if the same gesture just hit a harvest
      // chip — the chip sits over the building sprite, so the player's
      // intent was "collect" not "inspect". See harvestTapAtMs notes.
      if (this.time.now - this.harvestTapAtMs < HomeScene.HARVEST_TAP_GRACE_MS) {
        return;
      }
      const dragDist = Phaser.Math.Distance.Between(
        p.downX, p.downY, p.upX, p.upY,
      );
      if (dragDist > HomeScene.TAP_THRESHOLD_PX) return;
      // While in move mode, tapping a different building switches the
      // move target rather than opening the info modal — staying in
      // move mode lets the player relocate several buildings without
      // re-entering edit mode each time. enterMoveMode() exits the
      // current target (line ~1557 self-check) and rebuilds the
      // overlay/arrows/drag bindings against the new target.
      if (this.moveMode) {
        if (this.moveMode.building.id !== b.id) {
          this.enterMoveMode(b);
        }
        return;
      }
      this.openBuildingInfo(b);
    });
    // Desktop hover: show the building's name + level as a quick
    // tooltip without opening the full info modal. Touch devices
    // synthesize a brief pointerover on tap, so we gate on
    // `event.pointerType === 'mouse'` to keep the tooltip a desktop
    // affordance.
    spr.on('pointerover', (p: Phaser.Input.Pointer) => {
      if (!isMousePointer(p)) return;
      this.showBuildingHover(b, spr);
    });
    spr.on('pointerout', () => {
      this.hideBuildingHover(b.id);
    });
    this.boardContainer.add(spr);
    return spr;
  }

  // Single-flight tooltip per hovered building. Stored on the scene so
  // a fast pointer-out → pointer-over on a different building doesn't
  // leak labels. Container holds {bg, text} drawn relative to the
  // building's center; cleaned up on pointer-out and on board redraw.
  private buildingHoverTip: { id: string; container: Phaser.GameObjects.Container } | null = null;

  private showBuildingHover(b: Types.Building, spr: Phaser.GameObjects.Image): void {
    this.hideBuildingHover();
    const codex = BUILDING_CODEX[b.kind];
    const name = codex?.name ?? b.kind.replace(/([A-Z])/g, ' $1').trim();
    // Headline: name + level. Sub-line: a kind-specific stat the
    // player actually cares about (production rate for producers,
    // hp for everything else). Read off live runtime data so an
    // upgraded turret reflects the new HP without a sprite refresh.
    const headline = `${name}  ·  Lv ${b.level}`;
    const lines: string[] = [headline];
    const inc = INCOME_PER_SECOND[b.kind];
    if (inc) {
      const mult = Math.max(1, b.level);
      const rate: string[] = [];
      if (inc.sugar) rate.push(`+${(inc.sugar * mult).toFixed(0)} sugar/s`);
      if (inc.leafBits) rate.push(`+${(inc.leafBits * mult).toFixed(0)} leaf/s`);
      if (inc.aphidMilk) rate.push(`+${(inc.aphidMilk * mult).toFixed(2)} milk/s`);
      if (rate.length) lines.push(rate.join('  ·  '));
    }
    const hpMax = b.hpMax ?? b.hp;
    if (hpMax > 0) {
      const hpPct = Math.max(0, Math.min(100, Math.round((b.hp / hpMax) * 100)));
      lines.push(`HP ${b.hp}/${hpMax} (${hpPct}%)`);
    }
    const padX = 10;
    const padY = 6;
    const lineH = 14;
    const headTxt = crispText(this, 0, 0, headline, labelTextStyle(11, COLOR.textGold))
      .setOrigin(0.5, 0);
    const subTxts: Phaser.GameObjects.Text[] = lines.slice(1).map((s, i) =>
      crispText(this, 0, lineH * (i + 1), s, labelTextStyle(10, COLOR.textPrimary))
        .setOrigin(0.5, 0),
    );
    const widest = Math.max(headTxt.width, ...subTxts.map((t) => t.width));
    const w = widest + padX * 2;
    const h = padY * 2 + lineH + lineH * subTxts.length;
    const bg = this.add.graphics();
    bg.fillStyle(0x000000, 0.82);
    bg.fillRoundedRect(-w / 2, -padY, w, h, 5);
    bg.lineStyle(1, COLOR.brassDeep, 0.9);
    bg.strokeRoundedRect(-w / 2, -padY, w, h, 5);
    const cx = spr.x;
    const cy = spr.y - spr.displayHeight / 2 - h - 4;
    const container = this.add.container(cx, cy, [bg, headTxt, ...subTxts]);
    container.setDepth(DEPTHS.boardOverlay + 5);
    this.boardContainer.add(container);
    this.buildingHoverTip = { id: b.id, container };
  }

  private hideBuildingHover(id?: string): void {
    if (!this.buildingHoverTip) return;
    if (id !== undefined && this.buildingHoverTip.id !== id) return;
    this.buildingHoverTip.container.destroy(true);
    this.buildingHoverTip = null;
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

  // Per-second income read off the server base snapshot. Mirrors the
  // game-side income code so popover numbers match what actually
  // ticks into the HUD. Ignores hp<=0 buildings (destroyed producers
  // stop earning).
  private currentIncomePerSecond(): { sugar: number; leaf: number; milk: number } {
    let sugar = 0, leaf = 0, milk = 0;
    const base = this.serverBase;
    if (!base) return { sugar, leaf, milk };
    for (const b of base.buildings) {
      if (b.hp <= 0) continue;
      const inc = INCOME_PER_SECOND[b.kind];
      if (!inc) continue;
      const mult = Math.max(1, b.level);
      sugar += (inc.sugar ?? 0) * mult;
      leaf += (inc.leafBits ?? 0) * mult;
    }
    return { sugar, leaf, milk };
  }

  private resourcePopover: Phaser.GameObjects.Container | null = null;

  // Render a small popover underneath a resource pill. Explains
  // the per-second rate, next-upgrade cost (if the currently
  // selected building has one), and time-to-affordable. Tap outside
  // to dismiss.
  private openResourcePopover(
    kind: 'sugar' | 'leaf' | 'milk',
    anchorX: number,
    anchorY: number,
  ): void {
    this.resourcePopover?.destroy(true);
    // Read from the same in-scene state the HUD pills use:
    //   - this.resources tracks the locally-trickled wallet so the
    //     popover doesn't show stale numbers between server
    //     round-trips.
    //   - this.computeRate() returns a non-zero rate even on the
    //     guest path (where serverBase is null) by falling back to
    //     STARTER_BUILDINGS, matching what the pill rate text shows.
    const rate = this.computeRate(kind);
    const have = kind === 'sugar' ? this.resources.sugar
      : kind === 'leaf' ? this.resources.leafBits
      : Math.floor(this.resources.aphidMilk);
    const title =
      kind === 'sugar' ? 'Sugar' :
      kind === 'leaf' ? 'Leaf' : 'Aphid milk';
    const lines: string[] = [];
    // Show cap fraction in the popover (moved out of the pill text
    // so the HUD glance stays clean). Milk is uncapped.
    const cap =
      kind === 'sugar' ? this.storageCaps.sugar :
      kind === 'leaf' ? this.storageCaps.leaf :
      null;
    lines.push(cap !== null ? `Current: ${have} / ${cap}` : `Current: ${have}`);
    if (cap !== null && have >= cap) {
      lines.push('At cap — production paused. Upgrade storage or spend resources.');
    }
    if (rate > 0) {
      lines.push(`Income: +${rate}/sec from ${kind === 'sugar' ? 'Dew Collectors' : 'Larva Nurseries'}`);
      // Quick "how long to 1000" style estimate so players sense
      // the rate in concrete time units.
      const target = Math.max(1000, have + 500);
      const secs = Math.max(0, Math.ceil((target - have) / rate));
      if (secs > 0 && secs < 48 * 3600) {
        lines.push(`Next ${target}: in ${formatCountdown(secs)}`);
      }
    } else if (kind === 'milk') {
      lines.push('Earn from daily streaks, comeback packs, chapter clears.');
    } else {
      lines.push('Build producers to raise your rate.');
    }

    const W = 260;
    const lineH = 18;
    const padY = 12;
    const bodyH = padY + 18 + lines.length * lineH + padY;
    const left = Math.max(12, Math.min(this.scale.width - W - 12, anchorX - W / 2));
    const top = Math.min(this.scale.height - bodyH - 12, anchorY + 4);
    const container = this.add.container(0, 0).setDepth(DEPTHS.drawer);

    // Backdrop tap closes — lightweight since a resource popover is
    // transient chrome, not a modal. Added FIRST so it sits underneath
    // the panel + text in the container's draw order (Phaser containers
    // honor insertion order for children, not per-child setDepth).
    const backdrop = this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0x000000, 0)
      .setOrigin(0, 0)
      .setInteractive();
    backdrop.on('pointerdown', () => {
      container.destroy(true);
      if (this.resourcePopover === container) this.resourcePopover = null;
    });
    container.add(backdrop);

    const bg = this.add.graphics();
    // Use the default light cream panel (same as buildingInfoModal +
    // every modern modal in the game). Earlier this overrode topColor
    // to a dark mossy 0x2a3f2d while the body text stayed in navy
    // textPrimary — a dark-on-dark combo the user flagged as
    // unreadable. Light panel + dark text matches every other modal
    // and removes the contrast issue at the source.
    drawPanel(bg, left, top, W, bodyH, {
      stroke: COLOR.brassDeep,
      strokeWidth: 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.18,
      radius: 10,
      shadowOffset: 4,
      shadowAlpha: 0.28,
    });
    container.add(bg);
    container.add(
      crispText(this, left + 14, top + 10, title, labelTextStyle(11, COLOR.textGold)),
    );
    let ly = top + 28;
    for (const ln of lines) {
      container.add(
        crispText(this, left + 14, ly, ln, bodyTextStyle(11, COLOR.textPrimary))
          .setWordWrapWidth(W - 28, true),
      );
      ly += lineH;
    }
    this.resourcePopover = container;
  }

  // Tap handler: open the building info / upgrade modal. On a
  // successful upgrade or demolish we update only the affected sprite
  // (not the whole board), which keeps the scene snappy as bases
  // grow and avoids resetting the idle tweens on every other building.
  private openBuildingInfo(b: Types.Building): void {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    // First-tap on the QueenChamber after returning from the first
    // raid satisfies the colony coachmark step. Calling
    // advanceCoachmark unconditionally is safe — it's a no-op when
    // the current step doesn't match.
    if (b.kind === 'QueenChamber') {
      this.advanceCoachmark('colony');
    }
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
        // The freed tiles are now buildable — repaint affordances.
        this.drawEmptyTileHints();
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
    arrowContainer: Phaser.GameObjects.Container;
    paintOverlay: () => void;
    paintArrows: () => void;
    origSpriteAlpha: number;
    // Pre-drag sprite coords so we can cleanly reset if the user
    // drops on an invalid tile or cancels mid-drag.
    origSpriteXY: { x: number; y: number };
    keyListener: (e: KeyboardEvent) => void;
    dragOrigin: { px: number; py: number } | null;
  } | null = null;

  private enterMoveMode(b: Types.Building): void {
    if (this.moveMode) this.exitMoveMode();
    if (!this.serverBase) return;

    // The sprite stays fully visible (a 35% alpha was confusing; the
    // player needs to see what they're moving). We use a yellow outline
    // overlay around its current tile to mark it "picked up" instead.
    const spr = this.homeBuildingSprites.get(b.id);
    const origAlpha = spr?.alpha ?? 1;
    const origXY = spr ? { x: spr.x, y: spr.y } : { x: 0, y: 0 };

    // Tile validity overlay. Lives inside boardContainer so it scales
    // and pans with the board. A single Graphics is cheaper than one
    // rect per tile and repaints in one pass.
    const overlayContainer = this.add.container(0, 0);
    const overlayGraphics = this.add.graphics();
    const selectionGraphics = this.add.graphics();
    overlayContainer.add(overlayGraphics);
    overlayContainer.add(selectionGraphics);
    this.boardContainer.add(overlayContainer);
    overlayContainer.setDepth(DEPTHS.boardOverlay);

    const { w: fw, h: fh } = b.footprint;
    const paintOverlay = (): void => {
      overlayGraphics.clear();
      selectionGraphics.clear();
      if (!this.serverBase) return;
      const cur = this.serverBase.buildings.find((x) => x.id === b.id) ?? b;
      // Validity gets a tiny corner glyph (small triangle) plus a
      // hairline outline at low alpha. The previous full-tile fill at
      // 0.16 alpha created a chunky red mosaic that competed with the
      // grid; the outline+corner version is far less intrusive while
      // still calling out invalid tiles.
      for (let y = 0; y <= GRID_H - fh; y++) {
        for (let x = 0; x <= GRID_W - fw; x++) {
          const valid = this.isMoveTargetValid(cur, x, y, this.layer);
          const color = valid ? 0x5ba445 : 0xd94c4c;
          const px = x * TILE;
          const py = y * TILE;
          const w = fw * TILE;
          const h = fh * TILE;
          overlayGraphics.fillStyle(color, valid ? 0.10 : 0.07);
          overlayGraphics.fillRect(px, py, w, h);
          overlayGraphics.lineStyle(1, color, valid ? 0.55 : 0.35);
          overlayGraphics.strokeRect(px + 1, py + 1, w - 2, h - 2);
          // Tiny corner triangle marks the placement anchor without
          // taking up the whole tile.
          const corner = 6;
          overlayGraphics.fillStyle(color, valid ? 0.85 : 0.55);
          overlayGraphics.fillTriangle(
            px, py,
            px + corner, py,
            px, py + corner,
          );
        }
      }
      // Brass outline on the building's CURRENT tile so the player
      // can see what they're about to move.
      selectionGraphics.lineStyle(3, 0xffd98a, 0.95);
      selectionGraphics.strokeRect(
        cur.anchor.x * TILE,
        cur.anchor.y * TILE,
        fw * TILE,
        fh * TILE,
      );
    };
    paintOverlay();

    // --- Arrow nudge buttons --------------------------------------------
    //
    // Four small buttons positioned on the four sides of the building's
    // current tile. Each taps fires a 1-tile nudge. Repainted every
    // time the building moves (via the API or drag release) so they
    // track the new position.
    const arrowContainer = this.add.container(0, 0).setDepth(DEPTHS.drawer);
    const paintArrows = (): void => {
      arrowContainer.removeAll(true);
      const cur = this.serverBase?.buildings.find((x) => x.id === b.id) ?? b;
      // Convert tile coords to on-screen coords through boardContainer's
      // scale + offset so the arrows stay with the building even while
      // the player pans/zooms the board.
      const scale = this.boardScale || 1;
      const cx = this.boardContainer.x + (cur.anchor.x + cur.footprint.w / 2) * TILE * scale;
      const topY = this.boardContainer.y + cur.anchor.y * TILE * scale;
      const botY = this.boardContainer.y + (cur.anchor.y + cur.footprint.h) * TILE * scale;
      const leftX = this.boardContainer.x + cur.anchor.x * TILE * scale;
      const rightX = this.boardContainer.x + (cur.anchor.x + cur.footprint.w) * TILE * scale;
      const midY = this.boardContainer.y + (cur.anchor.y + cur.footprint.h / 2) * TILE * scale;
      // Small arrow chips — the user specifically asked for a
      // minimal "hint" control rather than the chunky 40-px CTAs
      // that felt too heavy on a small building sprite.
      const OFFSET = 18;
      const mkArrow = (x: number, y: number, label: string, dx: number, dy: number): void => {
        const btn = makeHiveButton(this, {
          x,
          y,
          width: 26,
          height: 26,
          label,
          variant: 'primary',
          fontSize: 12,
          onPress: () => { void this.nudgeMove(dx, dy); },
        });
        btn.container.setDepth(DEPTHS.drawer);
        arrowContainer.add(btn.container);
      };
      mkArrow(cx, topY - OFFSET, '↑', 0, -1);
      mkArrow(cx, botY + OFFSET, '↓', 0, 1);
      mkArrow(leftX - OFFSET, midY, '←', -1, 0);
      mkArrow(rightX + OFFSET, midY, '→', 1, 0);
    };
    paintArrows();

    // --- Drag the building sprite ---------------------------------------
    //
    // Phaser's built-in drag flag uses the pointer delta to move the
    // GameObject; we piggyback on dragstart/drag/dragend to snap-to-
    // grid visually and commit on release.
    if (spr) {
      this.input.setDraggable(spr, true);
      spr.on('dragstart', () => {
        if (this.moveMode) this.moveMode.dragOrigin = { px: spr.x, py: spr.y };
      });
      spr.on('drag', (_pointer: Phaser.Input.Pointer, dragX: number, dragY: number) => {
        spr.setPosition(dragX, dragY);
      });
      spr.on('dragend', (pointer: Phaser.Input.Pointer) => {
        // boardContainer coords → tile coords. The sprite origin is
        // (0.5, 0.75) so the tile is anchored near the sprite's base.
        if (!this.serverBase || !this.moveMode) return;
        const cur = this.serverBase.buildings.find((x) => x.id === b.id) ?? b;
        const scale = this.boardScale || 1;
        const localX = (pointer.x - this.boardContainer.x) / scale;
        const localY = (pointer.y - this.boardContainer.y) / scale;
        const tx = Math.max(
          0,
          Math.min(GRID_W - cur.footprint.w, Math.floor(localX / TILE - cur.footprint.w / 2 + 0.5)),
        );
        const ty = Math.max(
          0,
          Math.min(GRID_H - cur.footprint.h, Math.floor(localY / TILE - cur.footprint.h / 2 + 0.5)),
        );
        void this.commitMove(tx, ty);
      });
    }

    // --- Banner with Cancel ---------------------------------------------
    const bannerW = Math.min(520, this.scale.width - 32);
    const bannerH = 56;
    const bannerX = (this.scale.width - bannerW) / 2;
    const bannerY = HUD_H + 8;
    const banner = this.add.container(0, 0).setDepth(DEPTHS.drawer);
    const bg = this.add.graphics();
    drawPanel(bg, bannerX, bannerY, bannerW, bannerH, {
      // Light cream panel for readable navy body text — was dark
      // mossy 0x2a3f2d which made the body unreadable.
      stroke: COLOR.brassDeep,
      strokeWidth: 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.18,
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
    const hintText = ROTATABLE_KINDS.has(b.kind)
      ? 'Drag or use arrows to position. Tap Rotate to flip wall orientation.'
      : 'Drag the building or tap the arrow buttons to move it.';
    banner.add(
      crispText(this, bannerX + 16, bannerY + 28,
        hintText,
        bodyTextStyle(12, COLOR.textPrimary),
      ),
    );
    // Rotate button for walls — lives on the move banner so the
    // player can rotate without leaving move mode (Clash-of-Clans
    // edit-mode parity). Calls the same /rotate API the info modal
    // uses, then updates the sprite + serverBase in place so move
    // mode stays continuous.
    const canRotate = ROTATABLE_KINDS.has(b.kind);
    if (canRotate) {
      const rotateBtn = makeHiveButton(this, {
        x: bannerX + bannerW - 170,
        y: bannerY + bannerH / 2,
        width: 92,
        height: 36,
        label: 'Rotate',
        variant: 'primary',
        fontSize: 12,
        onPress: () => void this.rotateInMoveMode(b.id),
      });
      rotateBtn.container.setDepth(DEPTHS.drawer);
      banner.add(rotateBtn.container);
    }
    const cancelBtn = makeHiveButton(this, {
      x: bannerX + bannerW - 70,
      y: bannerY + bannerH / 2,
      width: 120,
      height: 36,
      label: 'Done',
      variant: 'ghost',
      fontSize: 12,
      onPress: () => this.exitMoveMode(),
    });
    cancelBtn.container.setDepth(DEPTHS.drawer);
    banner.add(cancelBtn.container);

    const keyListener = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') this.exitMoveMode();
    };
    window.addEventListener('keydown', keyListener);

    this.moveMode = {
      building: b,
      overlay: overlayContainer,
      banner,
      arrowContainer,
      paintOverlay,
      paintArrows,
      origSpriteAlpha: origAlpha,
      origSpriteXY: origXY,
      keyListener,
      dragOrigin: null,
    };
  }

  // In-place rotate while move mode is active. Calls the rotate API
  // and applies the new rotation to the existing sprite without
  // tearing down move mode (so the player keeps their drag handles,
  // arrow nudges, and the green/red overlay remains).
  private async rotateInMoveMode(buildingId: string): Promise<void> {
    if (!this.moveMode) return;
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const r = await runtime.api.rotateBuilding({ buildingId });
      if (runtime.player) runtime.player.base = r.base;
      this.serverBase = r.base;
      const updated = r.base.buildings.find((x) => x.id === buildingId);
      if (!updated) return;
      // Update the sprite's texture directly — much smoother than
      // destroy+recreate (which would also kill the dragstart/drag
      // handlers move mode set up in enterMoveMode). For walls the
      // H/V swap happens here; for any future non-wall rotatable kind
      // we'd fall back to a Phaser setRotation transform.
      const spr = this.homeBuildingSprites.get(buildingId);
      if (spr) {
        const rot = (updated.rotation ?? 0) as 0 | 1 | 2 | 3;
        if (KINDS_WITH_V_VARIANTS.has(updated.kind)) {
          spr.setTexture(wallTextureKey(updated, this.serverBase, rot));
          spr.setRotation(0);
        } else {
          spr.setRotation((rot * Math.PI) / 2);
        }
      }
      // The footprint stayed the same (rotation is cosmetic), but
      // refresh overlays in case anything depends on the latest
      // serverBase snapshot.
      this.moveMode.paintOverlay();
      this.moveMode.paintArrows();
    } catch (err) {
      // Surface the failure but stay in move mode; the player can
      // retry or exit.
      // eslint-disable-next-line no-console
      console.warn('rotateBuilding failed:', err);
    }
  }

  private exitMoveMode(): void {
    if (!this.moveMode) return;
    const { building, overlay, banner, arrowContainer, origSpriteAlpha, keyListener } = this.moveMode;
    overlay.destroy(true);
    banner.destroy(true);
    arrowContainer.destroy(true);
    const spr = this.homeBuildingSprites.get(building.id);
    if (spr) {
      spr.setAlpha(origSpriteAlpha);
      // Make sure the sprite is at its persisted tile position (not
      // wherever a canceled drag might have left it) AND no longer
      // flagged as draggable.
      this.input.setDraggable(spr, false);
      spr.off('dragstart');
      spr.off('drag');
      spr.off('dragend');
      this.snapSpriteToBuilding(spr, building.id);
    }
    window.removeEventListener('keydown', keyListener);
    this.moveMode = null;
    // Move mode suppressed the build-tile affordances while it was
    // active; restore them now that the player can place again.
    this.drawEmptyTileHints();
  }

  private snapSpriteToBuilding(
    spr: Phaser.GameObjects.Image,
    buildingId: string,
  ): void {
    const cur = this.serverBase?.buildings.find((x) => x.id === buildingId);
    if (!cur) return;
    const x = cur.anchor.x * TILE + (cur.footprint.w * TILE) / 2;
    const y = cur.anchor.y * TILE + (cur.footprint.h * TILE) / 2;
    spr.setPosition(x, y);
  }

  // Arrow nudge — move the active building by (dx, dy) tiles. Same
  // server validation as the drag/tap paths; we bail silently if the
  // target tile is out of bounds or blocked.
  private async nudgeMove(dx: number, dy: number): Promise<void> {
    if (!this.moveMode || !this.serverBase) return;
    const cur = this.serverBase.buildings.find(
      (x) => x.id === this.moveMode!.building.id,
    );
    if (!cur) return;
    const tx = cur.anchor.x + dx;
    const ty = cur.anchor.y + dy;
    if (!this.isMoveTargetValid(cur, tx, ty, this.layer)) {
      this.flashToast('That tile is blocked.');
      return;
    }
    await this.commitMove(tx, ty);
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
    // Use the latest snapshot of the building (it may have moved since
    // the modal opened). Falls back to the mode's starting snapshot
    // only if it somehow vanished from the server state.
    const currentSnap =
      this.serverBase?.buildings.find((x) => x.id === mode.building.id) ??
      mode.building;
    if (!this.isMoveTargetValid(currentSnap, tx, ty, this.layer)) {
      this.flashToast('That tile is blocked.');
      // Snap the (possibly just-dragged) sprite back to the building's
      // persisted location so the player sees "nothing happened."
      const spr = this.homeBuildingSprites.get(mode.building.id);
      if (spr) this.snapSpriteToBuilding(spr, mode.building.id);
      return;
    }
    try {
      const r = await runtime.api.moveBuilding({
        buildingId: mode.building.id,
        anchor: {
          x: tx,
          y: ty,
          // Multi-layer buildings keep their own anchor layer; single-
          // layer ones follow the currently-viewed layer. The server
          // re-asserts this invariant so a tampered client can't
          // change a Queen Chamber's layer.
          layer:
            currentSnap.spans && currentSnap.spans.length > 1
              ? currentSnap.anchor.layer
              : this.layer,
        },
      });
      this.serverBase = r.base;
      if (runtime.player) runtime.player.base = r.base;
      // Snap the sprite to the new position rather than recreating it
      // (recreation would lose the draggable flag + event handlers
      // registered in enterMoveMode). Repaint the overlay + arrows
      // so they follow the building's new tile.
      const spr = this.homeBuildingSprites.get(mode.building.id);
      if (spr) this.snapSpriteToBuilding(spr, mode.building.id);
      mode.paintOverlay();
      mode.paintArrows();
    } catch (err) {
      this.flashToast((err as Error).message);
      // Restore the sprite to the pre-drag position on any failure.
      const spr = this.homeBuildingSprites.get(mode.building.id);
      if (spr) this.snapSpriteToBuilding(spr, mode.building.id);
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
    const storage = runtime.player.player.storage;
    if (storage) {
      this.storageCaps = {
        sugar: storage.sugarCap,
        leaf: storage.leafCap,
        milk: storage.milkCap ?? null,
      };
    }
    this.refreshResourcePills();
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

    // First-raid tutorial banner — shows once, while tutorial_stage
    // is still in the "saw prologue, hasn't fought yet" range. Hand-
    // off into RaidScene with the tutorialMission flag set so the
    // raid runs against the scripted under-defended TUTORIAL_BASE
    // (guaranteed first-win onboarding, top-10 audit #8).
    //
    // Local-marker gate: RaidScene stamps `hive.tutorial.completed`
    // in localStorage as soon as the tutorial raid wins, BEFORE
    // the network round-trip lands. Honouring it here means a
    // transient /player/tutorial 5xx can't cause the banner to
    // re-appear on the next home mount. The server eventually
    // catches up via the retry loop in RaidScene.
    let locallyCompleted = false;
    try {
      locallyCompleted = localStorage.getItem('hive.tutorial.completed') === '1';
    } catch {
      /* private mode: trust server stage */
    }
    const stage = ps.tutorialStage ?? 0;
    if (!locallyCompleted && stage >= 5 && stage < 10) {
      topY = this.drawFirstRaidBanner(topY);
    }

    // Comeback banner — the strongest signal (away 3+ days). Pushed
    // above everything else. Dismissible: each appearance is keyed on
    // the comeback-pending flag transition, so dismissing once doesn't
    // wipe the next return-from-AFK trigger.
    if (ps.streak?.comebackPending && !isBannerDismissed('comeback', 'pending')) {
      topY = this.drawComebackBanner(topY, runtime);
    }

    // Streak banner — shows current streak day + claim button if
    // today's reward isn't claimed yet. Dismissed-key includes the
    // streak day so dismissing day-3's banner doesn't auto-dismiss
    // day-4 when it lands tomorrow.
    if (
      ps.streak &&
      ps.streak.count > 0 &&
      ps.streak.lastClaim < ps.streak.count &&
      !isBannerDismissed('streak', String(ps.streak.count))
    ) {
      topY = this.drawStreakBanner(topY, runtime);
    }

    // Nemesis ribbon — unavenged loss to an identified opponent.
    // Auto-fetches the full nemesis payload (online-status / name).
    // Dismiss-key includes the nemesis player id so dismissing Alice
    // doesn't suppress Bob if a different opponent later 3-stars us.
    if (
      ps.nemesis &&
      !ps.nemesis.avenged &&
      !isBannerDismissed('nemesis', ps.nemesis.playerId)
    ) {
      topY = this.drawNemesisRibbon(topY, runtime);
    }

    // "What next?" banner — always last in the stack. Only shows a
    // CTA when there's a concrete next action the player hasn't
    // taken yet. Silently skipped when the other banners already
    // cover the most valuable action (comeback, streak claim,
    // revenge) so we never repeat nudges. Also skipped when the
    // player has explicitly dismissed this specific suggestion: each
    // suggestion has a stable identity (sceneKey + chapter where
    // applicable) so dismissing "Campaign chapter 2" doesn't
    // suppress "Run a raid" or "Campaign chapter 3".
    const suggestion = this.pickNextSuggestion(ps);
    if (suggestion) {
      const suggestionId = whatNextIdentity(suggestion, ps);
      if (!isBannerDismissed('whatNext', suggestionId)) {
        topY = this.drawWhatNextBanner(topY, suggestion, suggestionId);
      }
    }
    void topY;
  }

  // Picks the single highest-priority next action based on server
  // state the client already has. Returns null when nothing
  // actionable beats the banners already stacked above this call.
  // Order is: clan war (time-bound and most social) > campaign
  // (narrative thread) > quests (daily). Extend as more systems
  // need surfacing.
  private pickNextSuggestion(
    ps: NonNullable<NonNullable<HiveRuntime['player']>['player']>,
  ): { title: string; body: string; cta: string; sceneKey: string } | null {
    const campaign = ps.campaign;
    // Active campaign chapter: if there's a mission in the current
    // chapter still uncompleted, nudge the player toward Campaign.
    if (campaign && campaign.progress < 3) {
      return {
        title: 'Campaign mission waiting',
        body: `Chapter ${campaign.chapter} has missions you haven't cleared yet.`,
        cta: 'Open campaign',
        sceneKey: 'CampaignScene',
      };
    }
    return {
      title: 'Run a raid',
      body: 'A quick raid fills the sugar vault and earns season XP.',
      cta: 'Raid now',
      sceneKey: 'RaidScene',
    };
  }

  private drawWhatNextBanner(
    topY: number,
    s: { title: string; body: string; cta: string; sceneKey: string },
    suggestionId: string,
  ): number {
    const maxW = Math.min(520, this.scale.width - 24);
    const x = (this.scale.width - maxW) / 2;
    const h = 58;
    const bg = this.add.graphics().setDepth(DEPTHS.boardOverlay);
    drawPanel(bg, x, topY, maxW, h, {
      // Light cream panel for readable body text. Was dark mossy
      // 0x2a3f2d/0x09100a which made the navy textPrimary body
      // unreadable.
      stroke: COLOR.brassDeep, strokeWidth: 2,
      highlight: COLOR.brass, highlightAlpha: 0.18,
      radius: 10, shadowOffset: 3, shadowAlpha: 0.22,
    });
    crispText(this, x + 14, topY + 8,
      s.title.toUpperCase(),
      labelTextStyle(10, COLOR.textGold),
    ).setDepth(DEPTHS.boardOverlay);
    crispText(this, x + 14, topY + 26,
      s.body,
      bodyTextStyle(12, COLOR.textPrimary),
    ).setDepth(DEPTHS.boardOverlay).setWordWrapWidth(maxW - 200, true);
    const btn = makeHiveButton(this, {
      x: x + maxW - 96,
      y: topY + h / 2,
      width: 130,
      height: 34,
      label: s.cta,
      variant: 'primary',
      fontSize: 12,
      onPress: () => fadeToScene(this, s.sceneKey),
    });
    btn.container.setDepth(DEPTHS.boardOverlay);
    // Dismiss × — every banner the user sees should be closeable so
    // they can clear the top of the screen at will. Uses the same
    // dismissBanner persistence the comeback/streak/nemesis banners
    // do, keyed on the suggestion identity so a dismissed "campaign
    // chapter 2" nudge stays gone but a fresh "campaign chapter 3"
    // appears later.
    this.addBannerCloseButton(x, maxW, topY, 'whatNext', suggestionId);
    return topY + h + 8;
  }

  // Small ✕ close button used by every dismissable banner. Persists
  // the dismissal under (kind, identity) so it survives reloads
  // until a new banner instance replaces this one.
  private addBannerCloseButton(
    panelX: number,
    panelW: number,
    panelY: number,
    kind: string,
    identity: string,
  ): void {
    const cx = panelX + panelW - 16;
    const cy = panelY + 14;
    const btn = this.add
      .text(cx, cy, '✕', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: COLOR.textOnDark,
      })
      .setOrigin(0.5, 0.5)
      .setDepth(DEPTHS.boardOverlay + 1)
      .setInteractive({ useHandCursor: true });
    btn.on(
      'pointerdown',
      (
        _p: Phaser.Input.Pointer,
        _lx: number,
        _ly: number,
        e: Phaser.Types.Input.EventData,
      ) => {
        // Stop propagation so the dismiss tap doesn't bubble up to
        // the board handlers (wireBoardTap), which would otherwise
        // see this as a "tap on empty tile" and start a placement
        // gesture or pan.
        e?.stopPropagation?.();
        dismissBanner(kind, identity);
        // Persist the current layer across the restart so the
        // player isn't whipped back to the surface mid-navigation.
        this.registry.set('homeLayer', this.layer);
        // Cheapest re-render: scene.restart picks up the new banner
        // suppression set without us tracking sprite handles per
        // banner. Same pattern claimStreak / claimComeback use
        // after a successful claim.
        this.scene.restart();
      },
    );
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
      labelTextStyle(10, COLOR.textGold),
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
    this.addBannerCloseButton(x, maxW, topY, 'comeback', 'pending');
    void bg;
    return topY + h + 10;
  }

  private async claimComeback(runtime: HiveRuntime): Promise<void> {
    try {
      const r = await runtime.api.claimComeback();
      this.resources.sugar = r.resources.sugar;
      this.resources.leafBits = r.resources.leafBits;
      this.resources.aphidMilk = r.resources.aphidMilk;
      this.refreshResourcePills();
      if (runtime.player) {
        if (runtime.player.player.streak) runtime.player.player.streak.comebackPending = false;
      }
      this.registry.set('homeLayer', this.layer);
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
    // Taller banner so the 7-day pip chain has room without
    // crowding the title + claim CTA.
    const h = 78;
    const bg = this.add.graphics().setDepth(DEPTHS.boardOverlay);
    drawPanel(bg, x, topY, maxW, h, {
      stroke: COLOR.brassDeep, strokeWidth: 2,
      highlight: COLOR.brass, highlightAlpha: 0.18,
      radius: 10, shadowOffset: 3, shadowAlpha: 0.22,
    });
    crispText(this, x + 14, topY + 8,
      `Login streak: day ${ps.streak.count}`,
      labelTextStyle(11, COLOR.textGold),
    ).setDepth(DEPTHS.boardOverlay);
    crispText(this, x + 14, topY + 26,
      ps.streak.nextReward.label,
      bodyTextStyle(12, COLOR.textPrimary),
    ).setDepth(DEPTHS.boardOverlay);

    // 7-day pip chain — visual progress that makes "make it to day 7"
    // tangible. Claimed days are gold-filled, today's day pulses, and
    // upcoming days are dim. Keeps the player oriented even when the
    // numeric "day N" alone wouldn't sell the journey.
    const today = ps.streak.count;
    const claimedThrough = ps.streak.lastClaim;
    const pipCount = 7;
    const pipSize = 18;
    const pipGap = 6;
    const totalPipsW = pipCount * pipSize + (pipCount - 1) * pipGap;
    const pipsStartX = x + 14;
    const pipsY = topY + 50;
    const todayIdx = ((Math.max(1, today) - 1) % pipCount) + 1;
    for (let i = 1; i <= pipCount; i++) {
      const px = pipsStartX + (i - 1) * (pipSize + pipGap);
      const isClaimed = i <= claimedThrough;
      const isToday = i === todayIdx;
      const isUpcoming = i > today;
      const fill = isClaimed
        ? 0xfdcd6a // gold
        : isToday
        ? 0xff90a8 // pulsing coral for today
        : isUpcoming
        ? 0xece2e7 // dim
        : 0xfff4d6; // pending claim today's day (warm)
      const stroke = isClaimed ? 0xc99b3a : isToday ? 0xb13455 : 0xb8a285;
      const pip = this.add
        .graphics()
        .setDepth(DEPTHS.boardOverlay);
      pip.fillStyle(fill, 1);
      pip.fillRoundedRect(px, pipsY, pipSize, pipSize, 5);
      pip.lineStyle(1.5, stroke, 1);
      pip.strokeRoundedRect(px, pipsY, pipSize, pipSize, 5);
      const dayTxt = crispText(this, px + pipSize / 2, pipsY + pipSize / 2,
        String(i),
        bodyTextStyle(10, isClaimed || isToday ? '#1f2148' : '#6e7196'),
      ).setOrigin(0.5).setDepth(DEPTHS.boardOverlay);
      if (isToday) {
        // Soft pulse on today's pip to signal "claim me".
        this.tweens.add({
          targets: [pip, dayTxt],
          alpha: { from: 0.7, to: 1 },
          duration: 700,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      }
    }
    // Tiny day-7 trophy hint at the right of the chain so the
    // commitment payoff is visible at a glance.
    crispText(this, pipsStartX + totalPipsW + 8, pipsY + pipSize / 2,
      '🏆',
      bodyTextStyle(14, COLOR.textGold),
    ).setOrigin(0, 0.5).setDepth(DEPTHS.boardOverlay);

    const btn = makeHiveButton(this, {
      x: x + maxW - 70,
      y: topY + 22,
      width: 120,
      height: 34,
      label: 'Claim',
      variant: 'primary',
      fontSize: 12,
      onPress: () => { void this.claimStreak(runtime); },
    });
    btn.container.setDepth(DEPTHS.boardOverlay);
    this.addBannerCloseButton(x, maxW, topY, 'streak', String(ps.streak.count));
    return topY + h + 8;
  }

  private async claimStreak(runtime: HiveRuntime): Promise<void> {
    try {
      const r = await runtime.api.claimStreak();
      this.resources.sugar = r.resources.sugar;
      this.resources.leafBits = r.resources.leafBits;
      this.resources.aphidMilk = r.resources.aphidMilk;
      this.refreshResourcePills();
      if (runtime.player?.player.streak) {
        runtime.player.player.streak.lastClaim = r.streakDay;
      }
      this.registry.set('homeLayer', this.layer);
      this.scene.restart();
    } catch (err) {
      console.warn('streak claim failed', err);
    }
  }

  private drawFirstRaidBanner(topY: number): number {
    const maxW = Math.min(520, this.scale.width - 24);
    const x = (this.scale.width - maxW) / 2;
    const h = 70;
    const bg = this.add.graphics().setDepth(DEPTHS.boardOverlay);
    drawPanel(bg, x, topY, maxW, h, {
      stroke: COLOR.brassDeep, strokeWidth: 2,
      highlight: COLOR.brass, highlightAlpha: 0.28,
      radius: 12, shadowOffset: 4, shadowAlpha: 0.3,
    });
    crispText(this, x + 16, topY + 10,
      'YOUR FIRST RAID',
      labelTextStyle(11, COLOR.textGold),
    ).setDepth(DEPTHS.boardOverlay);
    crispText(this, x + 16, topY + 30,
      'A scout outpost is unguarded. Take it.',
      bodyTextStyle(13, COLOR.textPrimary),
    ).setDepth(DEPTHS.boardOverlay);
    crispText(this, x + 16, topY + 48,
      'Drag a path from the left edge — the swarm follows.',
      bodyTextStyle(11, COLOR.textDim),
    ).setDepth(DEPTHS.boardOverlay);
    const btn = makeHiveButton(this, {
      x: x + maxW - 84,
      y: topY + h / 2,
      width: 150,
      height: 40,
      label: '⚔ Begin raid',
      variant: 'primary',
      fontSize: 13,
      onPress: () => {
        // Stamp the tutorial flag so RaidScene routes the raid
        // against the scripted base instead of matchmaking. The
        // tutorial flag is consumed once on RaidScene.create.
        this.registry.set('tutorialMission', true);
        fadeToScene(this, 'RaidScene');
      },
    });
    btn.container.setDepth(DEPTHS.boardOverlay);
    // Pulse the CTA so the new player's eye catches it without
    // having to read the body text first.
    this.tweens.add({
      targets: btn.container,
      scale: { from: 1, to: 1.04 },
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    return topY + h + 8;
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
    this.addBannerCloseButton(x, maxW, topY, 'nemesis', ps.nemesis.playerId);
    return topY + h + 8;
  }

  // Tracks the icon buttons in the bottom corners so handleResize
  // can repaint them at the right edge / bottom edge after the
  // viewport changes. Each entry is just the button container so we
  // can dispose them on scene restart without touching the rest of
  // the HUD.
  private cornerActionButtons: HiveButton[] = [];
  // Direct reference to the corner Raid CTA so the coachmark drill
  // can halo it without needing to introspect cornerActionButtons by
  // index (the index shifts when stack-top-budget hides entries on
  // shorter viewports).
  private cornerRaidButton: HiveButton | null = null;
  // Online-now chip — paints next to the Raid CTA. Refreshed
  // every 30s; cached value persists across scene restarts.
  private onlineNowText: Phaser.GameObjects.Text | null = null;
  private onlineNowBg: Phaser.GameObjects.Graphics | null = null;
  private onlineNowTimer: number | null = null;

  private drawCornerActionStacks(): void {
    for (const btn of this.cornerActionButtons) btn.destroy();
    this.cornerActionButtons = [];
    this.cornerRaidButton = null;

    // Compact icon-only buttons — 44 px square, big enough for a
    // thumb tap, small enough that two columns of three buttons fit
    // comfortably above the corner CTAs without crowding the
    // playfield. Each label is a single emoji glyph that reads as
    // an icon at this size; the button factory handles the rest.
    const iconBtnSize = 44;
    const stackGap = 8;
    const bottomCtaH = HomeScene.FOOTER_BTN_H;
    const bottomPad = 18;
    const ctaTop = this.scale.height - bottomPad - bottomCtaH;
    // Fixed top boundary just below the HUD pills + profile card.
    // The previous formulation derived this from `ctaTop - SPACING.lg`,
    // which puts the budget at e.g. 674 px on a 768 px screen — but
    // the FIRST icon already sits at ~664 px (above the budget),
    // so the early-out triggered at i=0 and no icons rendered.
    const stackTopBudget = HUD_H + 130;

    type Entry = { label: string; onPress: () => void; variant?: 'primary' | 'secondary' };
    // Layer flip is the BOTTOM entry of the left stack so it sits in
    // the corner where the player's thumb naturally rests; Quests +
    // Recent + Help climb up from there. The icon reflects the
    // CURRENT mode (not the destination) so the button reads as a
    // status indicator at a glance — ☀ on surface, ⛏ underground.
    const flipIcon = this.layer === 0 ? '☀' : '⛏';
    const leftStack: Entry[] = [
      {
        label: flipIcon,
        onPress: () => {
          this.exitMoveMode();
          this.layer = this.layer === 0 ? 1 : 0;
          this.boardContainer.removeAll(true);
          this.drawBoard();
          this.drawBuildings();
          this.drawCornerActionStacks();
        },
      },
      { label: '🗓', onPress: () => fadeToScene(this, 'QuestsScene') },
      { label: '📜', onPress: () => fadeToScene(this, 'RaidHistoryScene') },
      { label: '❓', onPress: () => openTutorial({ force: true }) },
    ];
    // Raid is the bottom-most right-stack entry — primary variant so
    // the gold pill reads as the main action of the screen even at
    // 44 px square. Settings / Upgrades / Clan / Ranks climb up.
    const rightStack: Entry[] = [
      {
        label: '⚔',
        variant: 'primary',
        onPress: () => {
          this.advanceCoachmark('raid');
          const rt = this.registry.get('runtime') as HiveRuntime | undefined;
          if (rt) {
            void openMatchPreview(this, rt);
          } else {
            fadeToScene(this, 'RaidScene');
          }
        },
      },
      { label: '⚙', onPress: () => openSettings() },
      { label: '⚒', onPress: () => fadeToScene(this, 'UpgradeScene') },
      // Heroes screen (PR C). Owned heroes + the chest gift live
      // here; PR D wires equipped heroes into the raid deck.
      { label: '🦸', onPress: () => fadeToScene(this, 'HeroesScene') },
      { label: '👥', onPress: () => fadeToScene(this, 'ClanScene') },
      { label: '🏆', onPress: () => fadeToScene(this, 'LeaderboardScene') },
    ];

    const placeColumn = (entries: Entry[], anchorX: number, side: 'left' | 'right'): void => {
      const bottomY = this.scale.height - bottomPad - iconBtnSize / 2;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        const y = bottomY - i * (iconBtnSize + stackGap);
        if (y < stackTopBudget) break; // Don't paint into the HUD pills.
        const x = side === 'left'
          ? anchorX + iconBtnSize / 2
          : anchorX - iconBtnSize / 2;
        const btn = makeHiveButton(this, {
          x,
          y,
          width: iconBtnSize,
          height: iconBtnSize,
          label: e.label,
          variant: e.variant ?? 'secondary',
          fontSize: 20,
          onPress: e.onPress,
        });
        btn.container.setDepth(DEPTHS.hud);
        this.cornerActionButtons.push(btn);
        // Stash the Raid button by label so the coachmark can halo
        // it without indexing the array (shifted on small heights).
        if (e.label === '⚔') this.cornerRaidButton = btn;
      }
    };

    // Left column anchors at bottom-left; right column at bottom-
    // right. Both grow upward.
    const leftAnchorX = HomeScene.FOOTER_MARGIN_X;
    const rightAnchorX = this.scale.width - HomeScene.FOOTER_MARGIN_X;
    placeColumn(leftStack, leftAnchorX, 'left');
    placeColumn(rightStack, rightAnchorX, 'right');
    void ctaTop; // ctaTop kept for layout reference; not currently used.

    // Online-now chip — sits just above the Raid CTA so the player's
    // eye lands on a "X online" social signal right next to the
    // matchmaking button. Painted last so it draws above the icon
    // stack regardless of column ordering.
    this.paintOnlineChip();
  }

  private paintOnlineChip(): void {
    if (this.onlineNowText) {
      this.onlineNowText.destroy();
      this.onlineNowText = null;
    }
    if (this.onlineNowBg) {
      this.onlineNowBg.destroy();
      this.onlineNowBg = null;
    }
    const btn = this.cornerRaidButton;
    if (!btn) return;
    const r = btn.container.getBounds();
    const chipW = 96;
    const chipH = 22;
    const chipX = r.x + r.width / 2 - chipW / 2;
    const chipY = r.y - chipH - 6;
    this.onlineNowBg = this.add.graphics().setDepth(DEPTHS.hud);
    this.onlineNowBg.fillStyle(0x1f2148, 0.78);
    this.onlineNowBg.fillRoundedRect(chipX, chipY, chipW, chipH, 11);
    this.onlineNowBg.lineStyle(1.5, 0x6cd47e, 0.9);
    this.onlineNowBg.strokeRoundedRect(chipX, chipY, chipW, chipH, 11);
    // Heartbeat dot — small green circle that pulses, signalling "live".
    const dot = this.add
      .circle(chipX + 12, chipY + chipH / 2, 4, 0x6cd47e, 1)
      .setDepth(DEPTHS.hud);
    this.tweens.add({
      targets: dot,
      alpha: { from: 0.4, to: 1 },
      duration: 700,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    this.cornerActionButtons.push({
      destroy: () => dot.destroy(),
    } as unknown as HiveButton);
    this.onlineNowText = crispText(
      this,
      chipX + chipW / 2 + 6,
      chipY + chipH / 2,
      '— online',
      labelTextStyle(10, '#fff8ec'),
    ).setOrigin(0.5, 0.5).setDepth(DEPTHS.hud);
    void this.refreshOnlineCount();
    if (this.onlineNowTimer !== null) window.clearInterval(this.onlineNowTimer);
    this.onlineNowTimer = window.setInterval(() => {
      void this.refreshOnlineCount();
    }, 30_000);
    this.events.once('shutdown', () => {
      if (this.onlineNowTimer !== null) {
        window.clearInterval(this.onlineNowTimer);
        this.onlineNowTimer = null;
      }
    });
  }

  private async refreshOnlineCount(): Promise<void> {
    const rt = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!rt || !this.onlineNowText) return;
    try {
      const count = await rt.api.getOnlineCount();
      if (!this.onlineNowText.active) return;
      // Format: 1.2k for thousands, plain for under 1000.
      const fmt = count >= 1000
        ? `${(count / 1000).toFixed(1)}k online`
        : `${count} online`;
      this.onlineNowText.setText(fmt);
    } catch {
      // Silent — leave the placeholder text.
    }
  }

  private drawFooter(): void {
    this.footerChrome?.destroy();
    this.footerChrome = null;
    for (const btn of this.cornerActionButtons) btn.destroy();
    this.cornerActionButtons = [];
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

    // The flip and raid actions used to be wide labelled CTAs in the
    // bottom corners. Per CoC's pattern (and the user's ask) they are
    // now the same size as the rest of the corner stack — small icon
    // rectangles that read alongside Quests / Recent / Settings / etc.
    // footerButtons stays empty in fullscreen-map mode; the layer
    // flip + raid trigger live inside drawCornerActionStacks below.
    this.footerButtonDefs = [];
    this.footerButtons = [];
    if (!this.layerLabel) {
      this.layerLabel = crispText(this, -9999, -9999, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '1px',
      });
    }
    this.drawCornerActionStacks();
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

  // First-visit coachmark drill state. Each step gates on the
  // gameplay event it teaches; the tracker advances when the
  // matching handler fires advanceCoachmark(stepName). Steps:
  //   - 'tile'   → tap an empty tile to open the building picker
  //   - 'raid'   → hit ⚔ Raid to start the first match
  //   - 'colony' → after returning from the first raid, tap the
  //                Queen Chamber and level the colony so the loot
  //                turns into a tier-up
  //   - 'done'   → drill complete; flag written, never re-shown
  private coachmarkStep: 'tile' | 'raid' | 'colony' | 'done' = 'done';
  private activeCoachmark: CoachmarkHandle | null = null;

  private runCoachmarkStep(): void {
    if (!this.scene.isActive()) return;
    if (this.activeCoachmark) {
      this.activeCoachmark.complete();
      this.activeCoachmark = null;
    }
    if (this.coachmarkStep === 'tile') {
      // Halo the centre of the board so the eye snaps to "tap
      // anywhere in here". boardContainer is centered in the viewport
      // by handleResize(), so its world position picks up wherever
      // the board currently sits (centered or panned).
      const bx = this.boardContainer.x;
      const by = this.boardContainer.y;
      const w = GRID_W * TILE * (this.boardContainer.scaleX || 1);
      const h = GRID_H * TILE * (this.boardContainer.scaleY || 1);
      this.activeCoachmark = showCoachmark({
        scene: this,
        target: { x: bx + w / 4, y: by + h / 3, w: w / 2, h: h / 3 },
        prefer: 'below',
        title: 'Place a building',
        body: 'Tap any empty tile to open the picker. Defenders go on the surface; economy + storage go underground.',
      });
    } else if (this.coachmarkStep === 'raid') {
      // Halo whichever Raid CTA is live for the current layout —
      // mobileRaidCta on phones, cornerRaidButton (bottom-right
      // primary corner button) on desktop.
      let target = { x: 16, y: 16, w: 120, h: 48 };
      if (this.mobileRaidCta) {
        const r = this.mobileRaidCta.container.getBounds();
        target = { x: r.x, y: r.y, w: r.width, h: r.height };
      } else if (this.cornerRaidButton) {
        const r = this.cornerRaidButton.container.getBounds();
        target = { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      this.activeCoachmark = showCoachmark({
        scene: this,
        target,
        prefer: 'above',
        title: 'Try a raid',
        body: 'Tap to attack another colony. Drag a pheromone path on the battlefield to deploy your swarm.',
      });
    } else if (this.coachmarkStep === 'colony') {
      // Halo the Queen Chamber so the player learns where the
      // colony-level upgrade lives. Bot-base raids reliably loot
      // sugar; the previous step has the player completing one,
      // so by now they should have enough to consider an upgrade.
      const qSpr = this.findQueenChamberSprite();
      if (!qSpr) {
        // Defensive: if the Queen sprite isn't on this layer (rare —
        // QueenChamber spans both), skip this step so the drill
        // doesn't dead-end. Player can discover the upgrade flow on
        // their own when they tap the chamber later.
        this.completeColonyCoachmark();
        return;
      }
      const b = qSpr.getBounds();
      this.activeCoachmark = showCoachmark({
        scene: this,
        target: { x: b.x, y: b.y, w: b.width, h: b.height },
        prefer: 'below',
        title: 'Level up your colony',
        body: 'Tap your Queen Chamber to spend the loot you just earned. Each colony tier unlocks new buildings and units.',
      });
    }
  }

  // Helper: find the rendered QueenChamber sprite for the colony
  // coachmark halo. Server-base path keeps a sprite map indexed by
  // building id; the starter-base fallback path doesn't, but both
  // share boardContainer iteration semantics. Returns null if the
  // chamber isn't on the current layer (the player can flip layers
  // and the coachmark will re-fire on next runCoachmarkStep).
  private findQueenChamberSprite(): Phaser.GameObjects.Image | null {
    if (this.serverBase) {
      const queen = this.serverBase.buildings.find(
        (b) => b.kind === 'QueenChamber',
      );
      if (queen) {
        const spr = this.homeBuildingSprites.get(queen.id);
        if (spr && spr.active) return spr;
      }
      return null;
    }
    // Guest / starter-base path: drawBuildings() pushes sprites
    // straight onto boardContainer without populating
    // homeBuildingSprites, so the indexed lookup above misses every
    // guest. Walk the container's children and find the one whose
    // texture key is the QueenChamber sprite. Cheap (a base has
    // ~10-20 children) and only runs once per coachmark step.
    for (const child of this.boardContainer.list) {
      if (
        child instanceof Phaser.GameObjects.Image &&
        child.texture.key === 'building-QueenChamber' &&
        child.active
      ) {
        return child;
      }
    }
    return null;
  }

  // Latch the drill to 'done' from 'colony' (or skip past it from
  // 'raid' when arming isn't possible). Centralised so the helper
  // and the normal advance path share teardown.
  private completeColonyCoachmark(): void {
    this.coachmarkStep = 'done';
    if (this.activeCoachmark) {
      this.activeCoachmark.complete();
      this.activeCoachmark = null;
    }
    try {
      localStorage.removeItem(HOME_COACHMARK_COLONY_ARMED_KEY);
    } catch {
      // ignore
    }
    markHomeCoachmarksDone();
  }

  private advanceCoachmark(satisfied: 'tile' | 'raid' | 'colony'): void {
    if (this.coachmarkStep !== satisfied) return;
    if (this.activeCoachmark) {
      this.activeCoachmark.acknowledge();
      this.activeCoachmark = null;
    }
    if (satisfied === 'tile') {
      this.coachmarkStep = 'raid';
    } else if (satisfied === 'raid') {
      // Player tapped Raid — arm the colony step so when they
      // return to HomeScene after the first match, the drill
      // picks up at "tap your Queen". The localStorage flag
      // bridges across the scene transition (HomeScene state
      // is rebuilt on re-entry).
      try {
        localStorage.setItem(HOME_COACHMARK_COLONY_ARMED_KEY, '1');
      } catch {
        // private mode — drill just stops here, harmless
      }
      // No more in-scene step; the colony halo fires on the NEXT
      // create() once the raid is over.
      this.coachmarkStep = 'done';
      return;
    } else {
      // 'colony' satisfied — drill complete.
      this.completeColonyCoachmark();
      return;
    }
    this.time.delayedCall(380, () => this.runCoachmarkStep());
  }
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
      onPress: () => {
        this.advanceCoachmark('raid');
        fadeToScene(this, 'RaidScene');
      },
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
    const btnH = HomeScene.FOOTER_BTN_H;
    const marginX = HomeScene.FOOTER_MARGIN_X;
    const bottomPad = 18;

    for (let i = 0; i < count; i++) {
      this.footerButtons[i]!.setLabel(this.footerLabelForIndex(i));
    }

    // Two-button corner layout (CoC-style):
    //   index 0: Flip layer  → bottom-left, secondary
    //   index 1: Raid → primary CTA bottom-right
    // Index ordering matters because footerButtonDefs[0] is the
    // layer-flip button referenced by the burger drawer's onPress
    // and by isMoveMode toggle paths. footerButtons[1] holds the
    // Raid CTA — the 'raid' coachmark target.
    const layerW = 168;
    const raidW = 200;
    const y = this.scale.height - bottomPad - btnH / 2;
    const flipBtn = this.footerButtons[0];
    const raidBtn = this.footerButtons[1];
    if (flipBtn) {
      flipBtn.setSize(layerW, btnH);
      flipBtn.setPosition(marginX + layerW / 2, y);
    }
    if (raidBtn) {
      raidBtn.setSize(raidW, btnH);
      raidBtn.setPosition(this.scale.width - marginX - raidW / 2, y);
    }
    this.footerChrome?.clear();
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
    // Fit-to-viewport board scale. The base playfield is 16x12 tiles
    // at 48 px (768x576). On a 1080p desktop that's ~40% of the
    // viewport with ambient grass eating the rest — the user
    // perceives that as "not fullscreen". Scaling the boardContainer
    // up so the playfield fills the visible rect (preserving the 4:3
    // aspect; grass falls naturally into the leftover bands) gives
    // the CoC fullscreen-village feel on every desktop / tablet.
    //
    // Mobile viewports smaller than the board (e.g. 375x812 portrait
    // phone) skip the zoom and pan instead — clampBoardPan lets the
    // player drag to see the whole base, just like CoC. Cap at 2.4x
    // so 4K monitors don't render comically chunky tiles.
    const fitW = this.scale.width / BOARD_W;
    const fitH = this.scale.height / BOARD_H;
    const fit = Math.min(fitW, fitH);
    const scale = Math.max(1.0, Math.min(2.4, fit));
    this.boardContainer.setScale(scale);
    this.boardScale = scale;
    // Start centered. clampBoardPan below will keep the edges
    // in-bounds if the user has already dragged.
    const scaledW = BOARD_W * scale;
    const scaledH = BOARD_H * scale;
    const centeredX = (this.scale.width - scaledW) / 2;
    const centeredY = (this.scale.height - scaledH) / 2;
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
  // covers (or is centered inside) the full viewport. Called after
  // every pan delta + on layout so orientation changes / scene
  // restarts can't strand the board off in an unreachable corner.
  // No HUD/footer reserves — the HUD is a transparent overlay so the
  // board can scroll freely under it (Clash-of-Clans style).
  private clampBoardPan(): void {
    const scale = this.boardScale;
    const scaledW = BOARD_W * scale;
    const scaledH = BOARD_H * scale;
    if (scaledW <= this.scale.width) {
      this.boardContainer.x = (this.scale.width - scaledW) / 2;
    } else {
      const minX = this.scale.width - scaledW; // board's right edge meets viewport right edge
      const maxX = 0;
      this.boardContainer.x = Math.max(minX, Math.min(maxX, this.boardContainer.x));
    }
    if (scaledH <= this.scale.height) {
      this.boardContainer.y = (this.scale.height - scaledH) / 2;
    } else {
      const minY = this.scale.height - scaledH;
      const maxY = 0;
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
  // Timestamp of the last harvest-chip tap (down or up). The producer
  // building sits directly under the chip; without this latch the same
  // tap fires the building's pointerup handler immediately after the
  // chip's, opening the info modal on top of the harvest call. The
  // building handler bails out for the duration of HARVEST_TAP_GRACE_MS.
  private harvestTapAtMs = 0;
  private static readonly HARVEST_TAP_GRACE_MS = 280;

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
      // While a modal (e.g. building info) is open, board taps must
      // not also start a pan or open the empty-tile picker — the
      // user's tap is dismissing the modal, not interacting with the
      // board behind it. Same applies for a brief grace after close
      // so the matching pointerup doesn't immediately fire either.
      if (isModalActive(this)) return;
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

    // Pan while dragging — Clash-of-Clans style: the board can be
    // bigger than the viewport on any device, so any layout that has
    // room to pan does. clampBoardPan() snaps small/centered cases
    // back to center so this becomes a noop when the board already
    // fits. Drag is gated by the tap-vs-drag threshold so brief
    // jitter never becomes a pan.
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!p.isDown) return;
      if (!this.panAnchor) return;
      if (this.pickerContainer || this.burgerDrawer) return;
      if (isModalActive(this)) return;
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
      // Same modal-active gate as pointerdown — picks up the case
      // where the modal opened between down and up.
      if (isModalActive(this)) return;
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
      // First-visit drill — opening the building picker satisfies
      // step 1 ("Place a building"). Step 2 (the Raid CTA) lands
      // automatically on the next runCoachmarkStep call.
      this.advanceCoachmark('tile');
    });

    // Safety net: if a touch is interrupted (pointer leaves the game,
    // browser context menu, OS gesture, multi-touch glitch) the
    // matching pointerup never fires and our tap-state flags stay
    // stuck. The next tap then either drops silently or gets
    // misinterpreted as a drag/pan, which presents to the player as
    // "clicks stop working until I refresh." Resetting on the
    // strand-edge events makes the next gesture clean.
    const resetTapState = (): void => {
      this.tapDownPos = null;
      this.panAnchor = null;
      this.isPanningBoard = false;
      this.tapStartedInsidePicker = false;
    };
    this.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, resetTapState);
    this.input.on(Phaser.Input.Events.GAME_OUT, resetTapState);
    // Some browsers fire a generic pointercancel on the underlying
    // canvas without a Phaser-level translation. Bridge it through.
    const canvas = this.game.canvas;
    if (canvas) {
      const onCancel = (): void => resetTapState();
      canvas.addEventListener('pointercancel', onCancel);
      canvas.addEventListener('lostpointercapture', onCancel);
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
        canvas.removeEventListener('pointercancel', onCancel);
        canvas.removeEventListener('lostpointercapture', onCancel);
      });
    }
  }

  private isTileOccupied(tx: number, ty: number, layer: Types.Layer): boolean {
    if (this.serverBase) {
      for (const b of this.serverBase.buildings) {
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
    // Guest-local fallback: serverBase is unavailable so the scene is
    // rendering STARTER_BUILDINGS instead. They're 1×1 except the
    // QueenChamber (2×2 spanning both layers), so widen the hit-test
    // accordingly.
    for (const b of STARTER_BUILDINGS) {
      const isQueen = b.kind === 'QueenChamber';
      const w = isQueen ? 2 : 1;
      const h = isQueen ? 2 : 1;
      const onLayer = isQueen || b.layer === layer;
      if (!onLayer) continue;
      if (tx >= b.x && tx < b.x + w && ty >= b.y && ty < b.y + h) {
        return true;
      }
    }
    return false;
  }

  private pickerContainer: Phaser.GameObjects.Container | null = null;
  // Off-display-list graphics used as the building-strip's geometry
  // mask; tracked here so closePicker can destroy it (the scene's
  // automatic teardown only walks display-list children).
  private pickerMaskShape: Phaser.GameObjects.Graphics | null = null;

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
    // Layout: on desktop the picker is a slim, full-width strip pinned
    // to the bottom of the viewport so the player can still see most of
    // the board behind it. On phone-narrow viewports we fall back to
    // the original centered card so the slots stay tap-sized.
    //
    // Common layout: header / title / subtitle stack on top; building
    // tiles sit in a single horizontal row below, scrollable when the
    // row overflows the modal width.
    const isWide = !this.isMobileLayout();
    const slotW = isWide ? 96 : 116;
    const slotH = isWide ? 116 : 140;
    const slotGap = 10;
    const headerH = isWide ? 56 : 86;
    const footerH = isWide ? 14 : 28;
    const stripH = slotH + 16;
    const W = isWide
      ? this.scale.width
      : Math.min(640, this.scale.width - 32);
    const H = isWide
      ? headerH + stripH + footerH
      : Math.min(this.scale.height - 80, headerH + stripH + footerH);
    const ox = isWide ? 0 : (this.scale.width - W) / 2;
    const oy = isWide
      ? this.scale.height - H
      : (this.scale.height - H) / 2;

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

    // Header layout differs between desktop (slim full-width strip,
    // pill + title on a single row) and phone (taller stacked card).
    const headerPill = this.add.graphics().setDepth(203);
    const pillY = isWide ? oy + 10 : oy + 18;
    drawPill(headerPill, ox + 20, pillY, 126, 22, { brass: true });
    container.add(headerPill);
    const headerLabel = crispText(
      this,
      ox + 83,
      pillY + 11,
      'Build menu',
      labelTextStyle(10, COLOR.textGold),
    )
      .setOrigin(0.5, 0.5)
      .setDepth(203);
    container.add(headerLabel);

    const titleText = this.layer === 0
      ? `Build on surface tile ${tx}, ${ty}`
      : `Build on underground tile ${tx}, ${ty}`;
    const subtitleText = 'Choose a structure to place in this slot.';
    if (isWide) {
      // Single-row header: pill on the left, title + subtitle to its
      // right, close button on the far right.
      const title = crispText(
        this,
        ox + 160,
        oy + 14,
        titleText,
        displayTextStyle(14, COLOR.textGold, 2),
      )
        .setOrigin(0, 0)
        .setDepth(203);
      container.add(title);
      const subtitle = crispText(
        this,
        ox + 160,
        oy + 32,
        subtitleText,
        bodyTextStyle(11, COLOR.textPrimary),
      )
        .setOrigin(0, 0)
        .setDepth(203);
      container.add(subtitle);
    } else {
      const title = crispText(
        this,
        ox + 20,
        oy + 48,
        titleText,
        displayTextStyle(15, COLOR.textGold, 3),
      )
        .setOrigin(0, 0)
        .setDepth(203);
      container.add(title);
      const subtitle = crispText(
        this,
        ox + 20,
        oy + 70,
        subtitleText,
        bodyTextStyle(12, COLOR.textPrimary),
      )
        .setOrigin(0, 0)
        .setDepth(203);
      container.add(subtitle);
    }

    // Close button
    const close = crispText(
      this,
      ox + W - 18,
      isWide ? oy + 8 : oy + 16,
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
    const pinned = loadPinnedKinds();

    // Category tab strip — sits between the header and the slot
    // strip. "All" / "Pinned" / "Producers" / "Defences" / "Walls" /
    // "Storage". Tapping a tab re-renders the strip below with the
    // matching subset; pinned kinds always sort to the front.
    type CatId = 'all' | 'pinned' | 'producer' | 'defence' | 'wall' | 'storage';
    const catLabels: Array<{ id: CatId; label: string }> = [
      { id: 'all', label: 'All' },
      { id: 'pinned', label: '★ Pinned' },
      { id: 'producer', label: 'Producers' },
      { id: 'defence', label: 'Defences' },
      { id: 'wall', label: 'Walls' },
      { id: 'storage', label: 'Storage' },
    ];
    let activeCat: CatId = 'all';
    const tabH = isWide ? 22 : 26;
    const tabGap = 6;
    const tabPadX = 10;
    const tabsTop = oy + headerH - tabH - 4;
    const tabsContainer = this.add.container(0, 0).setDepth(206);
    container.add(tabsContainer);
    const tabBgs: Map<CatId, Phaser.GameObjects.Graphics> = new Map();
    let tabCursorX = ox + 16;
    for (const t of catLabels) {
      const txtTmp = crispText(this, 0, 0, t.label, labelTextStyle(10, COLOR.textGold));
      const tw = Math.max(48, txtTmp.width + tabPadX * 2);
      txtTmp.destroy();
      const tabBg = this.add.graphics();
      tabBgs.set(t.id, tabBg);
      const tabLabel = crispText(
        this,
        tabCursorX + tw / 2,
        tabsTop + tabH / 2,
        t.label,
        labelTextStyle(10, COLOR.textGold),
      ).setOrigin(0.5, 0.5);
      const tabZone = this.add
        .zone(tabCursorX, tabsTop, tw, tabH)
        .setOrigin(0, 0)
        .setInteractive({ useHandCursor: true });
      tabZone.on('pointerdown', () => {
        if (activeCat === t.id) return;
        activeCat = t.id;
        repaintTabs();
        renderSlots();
      });
      tabsContainer.add([tabBg, tabLabel, tabZone]);
      // Capture for repaint — uses a closure over (tabBg, tabCursorX, tw).
      const xx = tabCursorX;
      const ww = tw;
      tabBg.setData('paint', () => {
        tabBg.clear();
        const isActive = activeCat === t.id;
        tabBg.fillStyle(isActive ? 0x3a7f3a : 0x1a2b1a, 1);
        tabBg.lineStyle(1, isActive ? 0xffd98a : COLOR.brassDeep, 1);
        tabBg.fillRoundedRect(xx, tabsTop, ww, tabH, 6);
        tabBg.strokeRoundedRect(xx, tabsTop, ww, tabH, 6);
      });
      tabCursorX += tw + tabGap;
    }
    const repaintTabs = (): void => {
      for (const [, bg] of tabBgs) {
        const paint = bg.getData('paint') as undefined | (() => void);
        paint?.();
      }
    };
    repaintTabs();

    // Horizontal strip: filtered slots laid out in one row inside a
    // container that gets masked to the modal interior. Pointer
    // drag + mouse wheel scroll the row when it overflows.
    const stripPadX = 16;
    const stripTop = oy + headerH;
    const stripBottom = stripTop + stripH;
    const stripContainer = this.add.container(0, 0).setDepth(204);
    container.add(stripContainer);

    // Mask so the strip clips to the modal's interior rect.
    const maskShape = this.make.graphics({ x: 0, y: 0 });
    maskShape.fillStyle(0xffffff, 1);
    maskShape.fillRect(ox + stripPadX, stripTop, W - stripPadX * 2, stripH);
    const mask = maskShape.createGeometryMask();
    stripContainer.setMask(mask);
    this.pickerMaskShape = maskShape;

    let scrollX = 0;
    const viewportW = W - stripPadX * 2;
    let maxScroll = 0;
    const setScroll = (raw: number): void => {
      scrollX = Math.max(0, Math.min(maxScroll, raw));
      stripContainer.setX(-scrollX);
    };

    // Drag + wheel scroll. Backdrop owns "tap outside to close",
    // cardZone swallows taps in the modal padding — we wire the
    // strip-area hit zone for the scroll gestures so a slot tap
    // still lands on the slot's own hit zone (depth 205, above
    // this zone at 203).
    const stripHit = this.add
      .zone(ox + stripPadX, stripTop, viewportW, stripH)
      .setOrigin(0, 0)
      .setDepth(203)
      .setInteractive();
    container.add(stripHit);
    let dragStartX = 0;
    let dragStartScroll = 0;
    let dragging = false;
    let dragMoved = false;
    stripHit.on('pointerdown', (p: Phaser.Input.Pointer) => {
      dragging = true;
      dragMoved = false;
      dragStartX = p.x;
      dragStartScroll = scrollX;
    });
    stripHit.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!dragging || !p.isDown) return;
      const dx = p.x - dragStartX;
      if (Math.abs(dx) > 4) dragMoved = true;
      setScroll(dragStartScroll - dx);
    });
    stripHit.on('pointerup', () => {
      dragging = false;
    });
    stripHit.on('pointerupoutside', () => {
      dragging = false;
    });
    stripHit.on(
      'wheel',
      (
        _p: Phaser.Input.Pointer,
        _objs: unknown[],
        dx: number,
        dy: number,
      ) => {
        // Trackpad horizontals come through dx; mouse wheel comes
        // through dy. Either should scroll the strip.
        setScroll(scrollX + (dx !== 0 ? dx : dy));
      },
    );

    const renderSlots = (): void => {
      // Wipe the previous render — pinned toggle / tab change reuse
      // this same function instead of destroying + reopening the
      // whole picker.
      stripContainer.removeAll(true);
      const filtered = kinds.filter((k) => {
        if (activeCat === 'all') return true;
        if (activeCat === 'pinned') return pinned.has(k);
        return BUILDING_CATEGORY[k] === activeCat;
      });
      // Pinned kinds float to the front of every tab so the player's
      // most-used buildings are one tap from any context.
      filtered.sort((a, b) => {
        const ap = pinned.has(a) ? 0 : 1;
        const bp = pinned.has(b) ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return 0;
      });
      const totalContentW = Math.max(0, filtered.length * (slotW + slotGap) - slotGap);
      maxScroll = Math.max(0, totalContentW - viewportW);
      setScroll(0);

      if (filtered.length === 0) {
        const empty = crispText(
          this,
          ox + W / 2,
          stripTop + stripH / 2,
          activeCat === 'pinned' ? 'No pinned buildings yet — tap ★ on a slot to pin it.' : 'No buildings in this category.',
          labelTextStyle(11, COLOR.textPrimary),
        ).setOrigin(0.5, 0.5);
        stripContainer.add(empty);
        return;
      }

      filtered.forEach((kind, i) => {
        renderOneSlot(kind, i);
      });
    };

    const renderOneSlot = (kind: Types.BuildingKind, i: number): void => {
      const cx = ox + stripPadX + i * (slotW + slotGap) + slotW / 2;
      const cy = stripTop + stripH / 2;
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
        ? `${kind} cap ${current}/${cap} — level up the colony to unlock more`
        : !layerOk
          ? `${kind} belongs on the ${kindRules!.allowedLayers[0] === 0 ? 'surface' : 'underground'} layer — flip layers and try again`
          : !canAfford
            ? `Need ${cost.sugar} sugar & ${cost.leafBits} leaf — have ${this.resources.sugar}/${this.resources.leafBits}`
            : null;
      const placeable = denyReason === null;

      // All slot graphics live inside stripContainer so they scroll
      // and get masked together. Depths within the container don't
      // need to fight the outer modal — the mask is on the
      // container, not the children.
      const slotBg = this.add.graphics();
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
      stripContainer.add(slotBg);

      const icon = this.add
        .image(cx, cy - 28, `building-${kind}`)
        .setDisplaySize(40, 40)
        .setAlpha(placeable ? 1 : 0.5);
      stripContainer.add(icon);

      const nameText = crispText(
        this,
        cx,
        cy + 0,
        kind.replace(/([A-Z])/g, ' $1').trim(),
        bodyTextStyle(11, placeable ? COLOR.textPrimary : '#d7aaaa'),
      ).setOrigin(0.5);
      stripContainer.add(nameText);

      const role = BUILDING_CODEX[kind]?.role ?? '';
      if (role) {
        const roleText = crispText(
          this,
          cx,
          cy + 18,
          role,
          labelTextStyle(9, placeable ? '#9fc79a' : '#a8807a'),
        ).setOrigin(0.5);
        stripContainer.add(roleText);
      }

      const capText = crispText(
        this,
        cx,
        cy + 36,
        `Slots ${current}/${cap}`,
        labelTextStyle(10, capOk ? '#c3e8b0' : '#d98080'),
      ).setOrigin(0.5);
      stripContainer.add(capText);

      const costText = crispText(
        this,
        cx,
        cy + 52,
        `S ${cost.sugar}  L ${cost.leafBits}`,
        labelTextStyle(10, canAfford ? '#c3e8b0' : '#d98080'),
      ).setOrigin(0.5);
      stripContainer.add(costText);

      // Slot hit zone sits ABOVE the strip-scroll hit zone (depth
      // 205 vs 203) so a tap on the slot lands here, not on the
      // pan handler. Drag still scrolls — see dragMoved guard
      // below: a drag that moved more than 4 px cancels the click
      // so the user never accidentally builds while panning.
      const hit = this.add
        .zone(cx, cy, slotW - 8, slotH - 8)
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: placeable });
      hit.on('pointerdown', (p: Phaser.Input.Pointer) => {
        // Mirror the strip drag detector — the slot zone catches
        // pointerdown first, so seed the same start state.
        dragStartX = p.x;
        dragStartScroll = scrollX;
        dragMoved = false;
      });
      hit.on('pointermove', (p: Phaser.Input.Pointer) => {
        if (!p.isDown) return;
        const dx = p.x - dragStartX;
        if (Math.abs(dx) > 4) {
          dragMoved = true;
          setScroll(dragStartScroll - dx);
        }
      });
      hit.on('pointerup', () => {
        if (dragMoved) return;
        if (!placeable) {
          this.flashToast(denyReason!);
          return;
        }
        void this.commitPlacement(kind, tx, ty);
      });
      stripContainer.add(hit);

      // Pin star — top-right of the slot. Toggles localStorage and
      // re-renders the strip so the pinned kind floats to the front
      // of the current tab. Star renders gold when pinned, faint
      // grey when not.
      const isPinned = pinned.has(kind);
      const star = crispText(
        this,
        cx + slotW / 2 - 14,
        cy - slotH / 2 + 6,
        isPinned ? '★' : '☆',
        labelTextStyle(14, isPinned ? COLOR.textGold : '#7d8a6e'),
      )
        .setOrigin(0.5, 0)
        .setInteractive({ useHandCursor: true });
      star.on('pointerdown', (
        _p: Phaser.Input.Pointer,
        _lx: number,
        _ly: number,
        e: Phaser.Types.Input.EventData,
      ) => {
        // Stop propagation so the slot's tap-to-place doesn't also
        // fire when the player toggles a pin.
        e?.stopPropagation?.();
        if (pinned.has(kind)) pinned.delete(kind);
        else pinned.add(kind);
        persistPinnedKinds(pinned);
        renderSlots();
      });
      stripContainer.add(star);
    };

    renderSlots();

    this.pickerContainer = container;
  }

  private closePicker(): void {
    if (this.pickerContainer) {
      this.pickerContainer.destroy(true);
      this.pickerContainer = null;
      // The mask graphics is created via make.graphics() so it
      // sits outside the scene's display list — destroy it here
      // explicitly. Without this it would leak across opens.
      if (this.pickerMaskShape) {
        this.pickerMaskShape.destroy();
        this.pickerMaskShape = null;
      }
      // Stamp the grace window so a pointerup that arrives just after
      // this call can't open a new picker on the closing tap's tile.
      this.pickerClosedAtMs = this.time.now;
      // Build affordances were suppressed while the picker was open;
      // restore them now.
      this.drawEmptyTileHints();
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
      // Placement may change the production curve and storage cap
      // (e.g. placed a Vault → cap rose), so refresh pill rates too.
      this.refreshResourcePills();
      // Float the cost off the placement tile back to the matching
      // pill so the player sees the wallet *spend* as a physical
      // motion. Cheap, motion-only — no extra round-trips.
      const cost = this.catalog[kind];
      if (cost) {
        const targets = this.resourcePillTargets();
        const sx = tx * TILE + TILE / 2 + this.boardContainer.x;
        const sy = ty * TILE + TILE / 2 + this.boardContainer.y;
        if (cost.sugar > 0 && targets.sugar) {
          spawnFloatNumber({ scene: this, x: sx, y: sy, amount: -cost.sugar, kind: 'sugar', toX: targets.sugar.x, toY: targets.sugar.y });
        }
        if (cost.leafBits > 0 && targets.leaf) {
          spawnFloatNumber({ scene: this, x: sx, y: sy, amount: -cost.leafBits, kind: 'leaf', toX: targets.leaf.x, toY: targets.leaf.y });
        }
        if (cost.aphidMilk > 0 && targets.milk) {
          spawnFloatNumber({ scene: this, x: sx, y: sy, amount: -cost.aphidMilk, kind: 'milk', toX: targets.milk.x, toY: targets.milk.y });
        }
      }
      // Re-render buildings.
      this.boardContainer.removeAll(true);
      this.drawBoard();
      this.drawBuildings();
      // 5-second undo affordance. Server stamped placedAt on the
      // placement; the matching /undo-placement endpoint enforces
      // the window. We just have to surface the button + tear it
      // down on timeout. Pulled the new id out of the response so
      // the undo call hits the right row.
      const newBuilding = res.base.buildings.find(
        (b) => b.kind === kind &&
               b.anchor.x === tx &&
               b.anchor.y === ty &&
               b.anchor.layer === this.layer,
      );
      if (newBuilding) {
        this.showUndoPlacement(newBuilding.id, kind);
      } else {
        this.flashToast(`Placed ${kind}`);
      }
    } catch (err) {
      this.flashToast((err as Error).message);
    }
  }

  // 5-second "↶ Undo" banner anchored top-center. Counts down each
  // second; tap calls /undo-placement which refunds the cost. On
  // success we patch runtime state + re-render. On expiry we tear
  // down the banner and just flash a "Placed X" toast like before.
  private undoBanner: Phaser.GameObjects.Container | null = null;
  private undoTimer: Phaser.Time.TimerEvent | null = null;
  private showUndoPlacement(buildingId: string, kind: Types.BuildingKind): void {
    if (this.undoBanner) {
      this.undoBanner.destroy(true);
      this.undoBanner = null;
    }
    if (this.undoTimer) {
      this.undoTimer.destroy();
      this.undoTimer = null;
    }
    const w = 280;
    const h = 36;
    const x = (this.scale.width - w) / 2;
    const y = HUD_H + 4;
    const panel = this.add.container(0, 0).setDepth(DEPTHS.toast);
    const bg = this.add.graphics();
    bg.fillStyle(0x1a2b1a, 0.96);
    bg.lineStyle(2, COLOR.brassDeep, 1);
    bg.fillRoundedRect(x, y, w, h, 10);
    bg.strokeRoundedRect(x, y, w, h, 10);
    const labelText = crispText(this, x + 12, y + h / 2,
      `Placed ${kind}`,
      bodyTextStyle(12, COLOR.textPrimary)).setOrigin(0, 0.5);
    const undoBtn = crispText(this, x + w - 12, y + h / 2,
      '↶ Undo (5s)',
      labelTextStyle(11, COLOR.textGold))
      .setOrigin(1, 0.5)
      .setInteractive({ useHandCursor: true });
    panel.add([bg, labelText, undoBtn]);
    this.undoBanner = panel;
    let secondsLeft = 5;
    undoBtn.on('pointerdown', () => { void this.commitUndoPlacement(buildingId); });
    this.undoTimer = this.time.addEvent({
      delay: 1000,
      repeat: 4,
      callback: () => {
        secondsLeft--;
        if (secondsLeft <= 0) {
          this.tearDownUndoBanner();
        } else {
          undoBtn.setText(`↶ Undo (${secondsLeft}s)`);
        }
      },
    });
  }

  private tearDownUndoBanner(): void {
    if (this.undoBanner) {
      this.undoBanner.destroy(true);
      this.undoBanner = null;
    }
    if (this.undoTimer) {
      this.undoTimer.destroy();
      this.undoTimer = null;
    }
  }

  private async commitUndoPlacement(buildingId: string): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    this.tearDownUndoBanner();
    try {
      const r = await runtime.api.undoPlacement(buildingId);
      if (runtime.player) {
        runtime.player.base = r.base;
        runtime.player.player.sugar = r.player.sugar;
        runtime.player.player.leafBits = r.player.leafBits;
        runtime.player.player.aphidMilk = r.player.aphidMilk;
      }
      this.serverBase = r.base;
      this.resources = {
        sugar: r.player.sugar,
        leafBits: r.player.leafBits,
        aphidMilk: r.player.aphidMilk,
      };
      this.refreshResourcePills();
      // Float the refund FROM the pills outward so it reads as a
      // wallet payback (mirror of the placement spend animation).
      const targets = this.resourcePillTargets();
      const cx = this.scale.width / 2;
      const cy = this.scale.height / 2;
      if (r.refunded.sugar > 0 && targets.sugar) {
        spawnFloatNumber({ scene: this, x: targets.sugar.x, y: targets.sugar.y, amount: r.refunded.sugar, kind: 'sugar', toX: cx, toY: cy });
      }
      if (r.refunded.leafBits > 0 && targets.leaf) {
        spawnFloatNumber({ scene: this, x: targets.leaf.x, y: targets.leaf.y, amount: r.refunded.leafBits, kind: 'leaf', toX: cx, toY: cy });
      }
      if (r.refunded.aphidMilk > 0 && targets.milk) {
        spawnFloatNumber({ scene: this, x: targets.milk.x, y: targets.milk.y, amount: r.refunded.aphidMilk, kind: 'milk', toX: cx, toY: cy });
      }
      this.boardContainer.removeAll(true);
      this.drawBoard();
      this.drawBuildings();
      this.flashToast(`Refunded ${r.refunded.sugar} sugar / ${r.refunded.leafBits} leaf`);
    } catch (err) {
      this.flashToast(`Undo failed: ${(err as Error).message}`);
    }
  }

  // Re-entrancy guard for openAccountMenu. fetchMe() is async, and
  // rapid taps on the chip would otherwise stack a separate fetch +
  // modal per click — the first promise resolving opens one modal,
  // the second opens a duplicate behind it. Cleared on success/error
  // so a slow-network tap doesn't permanently disable the chip.
  private accountMenuOpening = false;

  // Open the right account modal based on session state. Guests see
  // the Register/Login modal (claim or swap accounts); logged-in users
  // see the Account modal with a Log out button — putting "Register"
  // under the chip of an already-registered user reads as a bug.
  // fetchMe() is small (cached server-side) so calling it on every
  // chip tap is fine; we still fall back to the guest modal if the
  // call fails so the chip is never inert.
  private async openAccountMenu(): Promise<void> {
    if (this.accountMenuOpening) return;
    const rt = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!rt) return;
    this.accountMenuOpening = true;
    let me: Awaited<ReturnType<typeof rt.auth.fetchMe>> = null;
    try {
      me = await rt.auth.fetchMe();
    } catch {
      // Network blip — fall through to the guest modal so the user
      // still has an action they can take.
    } finally {
      this.accountMenuOpening = false;
    }
    if (me && !me.isGuest && me.username) {
      openAccountInfoModal({
        username: me.username,
        onLogout: () => {
          rt.auth.logout();
          // Hard reload so every cached snapshot in scenes (player,
          // base, donations, clan) is rebuilt against the next
          // freshly-minted guest session. scene.restart() alone would
          // leave HiveRuntime stale.
          window.location.reload();
        },
      });
      return;
    }
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
    if (this.toast) {
      this.tweens.killTweensOf(this.toast);
      this.toast.destroy();
    }
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
      labelTextStyle(9, COLOR.textGold),
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
    // Close button (X)
    const closeBtn = crispText(
      this,
      width / 2 - 12,
      -height / 2 + 8,
      '✕',
      bodyTextStyle(16, COLOR.textPrimary),
    )
      .setOrigin(0.5, 0.5)
      .setInteractive();
    closeBtn.on('pointerdown', () => {
      this.tweens.killTweensOf(container);
      container.destroy();
      if (this.toast === container) this.toast = null;
    });
    container.add([bg, accent, text, closeBtn]);
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

// "+8/sec" for integer rates, "+0.2/sec" for fractional ones (only the
// AphidFarm L1 baseline at the moment). Drops the trailing ".0" so a
// freshly-upgraded farm doesn't read "+0.2/sec → +0.4/sec → +0.6/sec".
function formatRate(rate: number): string {
  if (Number.isInteger(rate)) return String(rate);
  return rate.toFixed(1);
}
