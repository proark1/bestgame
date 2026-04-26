import Phaser from 'phaser';
import { Sim, Types } from '@hive/shared';
import { bakeTrailDot } from '../assets/placeholders.js';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { ANIMATED_UNIT_KINDS } from '../assets/atlas.js';
import { makeHiveButton } from '../ui/button.js';
import { sfxVictory, sfxDefeat } from '../ui/audio.js';
import { shareOutcome as shareOutcomeTransport } from '../net/share.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { COLOR, DEPTHS, bodyTextStyle, displayTextStyle, labelTextStyle } from '../ui/theme.js';
import { BUILDING_CODEX, UNIT_CODEX } from '../codex/codexData.js';
import type { HiveRuntime } from '../main.js';
import type { MatchResponse } from '../net/Api.js';

// RaidScene — the first end-to-end playable loop.
// The player attacks a hard-coded bot base. They pick a unit from the
// bottom deck, drag a pheromone path from the spawn edge into the base,
// and release to deploy. The shared deterministic sim steps at 30 Hz,
// and this scene renders it: units walk the path, turrets fire, HP bars
// drop, buildings crumble, loot ticks up, stars award at the end.

const TILE = 48;
const GRID_W = 16;
const GRID_H = 12;
const BOARD_W = TILE * GRID_W;
const BOARD_H = TILE * GRID_H;
const HUD_H = 56;
const DECK_CARD_H = 96;
const DECK_CARD_W = 108;
const DECK_GRID_GAP = 12;
const TICK_HZ = 30;
const RAID_SECONDS = 90;
const SPAWN_ZONE_W = TILE * 2;
const SPAWN_ZONE_H = TILE * 2;

type SpawnEdge = 'left' | 'top' | 'bottom';

interface DeckEntry {
  kind: Types.UnitKind;
  count: number;
  icon: string;
  label: string;
}

// A saved tactic captures a finished path geometry so the player can
// re-deploy it with one tap. Stored in localStorage; never sent to the
// server (the server only sees the resulting `deployPath` SimInput).
interface SavedTactic {
  name: string;
  unitKind: Types.UnitKind;
  // Polyline in TILE coordinates (so the geometry survives any future
  // grid resize and is independent of the on-screen board scale).
  pointsTile: Array<{ x: number; y: number }>;
  modifier?: Types.PathModifier;
  spawnEdge: SpawnEdge;
}

const TACTICS_STORAGE_KEY = 'hive:tactics:v1';
const TACTICS_LIMIT = 8; // tight cap — keeps the panel readable
const MODIFIER_BAR_H = 44;

function loadSavedTactics(): SavedTactic[] {
  try {
    const raw = localStorage.getItem(TACTICS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Light schema check — anything malformed is dropped silently
    // rather than crashing the scene.
    return parsed.filter(
      (t): t is SavedTactic =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as SavedTactic).name === 'string' &&
        typeof (t as SavedTactic).unitKind === 'string' &&
        Array.isArray((t as SavedTactic).pointsTile),
    );
  } catch {
    return [];
  }
}

function persistSavedTactics(list: SavedTactic[]): void {
  try {
    localStorage.setItem(TACTICS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Quota or private mode — non-fatal, tactics just won't persist
    // across sessions.
  }
}

const MODIFIER_GLYPH: Record<Types.PathModifierKind | 'none', string> = {
  none: '∅',
  split: '⑂',
  ambush: '◆',
  dig: '↧',
};

const MODIFIER_LABEL: Record<Types.PathModifierKind | 'none', string> = {
  none: 'Direct',
  split: 'Split',
  ambush: 'Ambush',
  dig: 'Dig',
};

// Full attacker roster with default deck counts. The scene filters
// this down to the kinds the player has unlocked at their current
// Queen Chamber level — unlock thresholds live on the server in
// server/api/src/game/buildingRules.ts::UNIT_UNLOCK_QUEEN_LEVEL and
// are mirrored here for fast client-side gating (the server still
// rejects locked deploys in routes/raid.ts so this is UX, not trust).
const ALL_DECK: Array<DeckEntry & { unlockQueenLevel: number }> = [
  { kind: 'SoldierAnt', count: 10, icon: 'unit-SoldierAnt', label: 'Soldier', unlockQueenLevel: 1 },
  { kind: 'WorkerAnt',  count: 8,  icon: 'unit-WorkerAnt',  label: 'Worker',   unlockQueenLevel: 1 },
  { kind: 'DirtDigger', count: 4,  icon: 'unit-DirtDigger', label: 'Digger',   unlockQueenLevel: 1 },
  { kind: 'Wasp',       count: 4,  icon: 'unit-Wasp',       label: 'Wasp',     unlockQueenLevel: 1 },
  { kind: 'FireAnt',    count: 6,  icon: 'unit-FireAnt',    label: 'FireAnt',  unlockQueenLevel: 2 },
  { kind: 'Termite',    count: 5,  icon: 'unit-Termite',    label: 'Termite',  unlockQueenLevel: 3 },
  { kind: 'Dragonfly',  count: 4,  icon: 'unit-Dragonfly',  label: 'Dragon',   unlockQueenLevel: 3 },
  { kind: 'Mantis',     count: 3,  icon: 'unit-Mantis',     label: 'Mantis',   unlockQueenLevel: 4 },
  { kind: 'Scarab',     count: 2,  icon: 'unit-Scarab',     label: 'Scarab',   unlockQueenLevel: 5 },
];

function queenLevelFromBase(base: Types.Base | undefined): number {
  if (!base) return 1;
  const queen = base.buildings.find((b) => b.kind === 'QueenChamber');
  const lvl = queen?.level ?? 1;
  return Math.max(1, Math.min(5, Math.floor(lvl)));
}

function buildDeck(attackerQueenLevel: number): DeckEntry[] {
  return ALL_DECK
    .filter((d) => d.unlockQueenLevel <= attackerQueenLevel)
    .map((d) => {
      // Strip the gate field from the runtime deck entry — RaidScene
      // logic keys off of {kind, count, icon, label} only.
      const { unlockQueenLevel: _unlock, ...rest } = d;
      void _unlock;
      return rest;
    });
}

const BOT_BASE: Types.Base = {
  baseId: 'bot-0',
  ownerId: 'bot-0',
  faction: 'Beetles',
  gridSize: { w: GRID_W, h: GRID_H },
  resources: { sugar: 1600, leafBits: 420, aphidMilk: 0 },
  trophies: 100,
  version: 1,
  tunnels: [],
  buildings: [
    {
      id: 'b-queen',
      kind: 'QueenChamber',
      anchor: { x: 8, y: 6, layer: 0 },
      footprint: { w: 2, h: 2 },
      spans: [0, 1],
      level: 1,
      hp: 800,
      hpMax: 800,
    },
    {
      id: 'b-turret-1',
      kind: 'MushroomTurret',
      anchor: { x: 5, y: 4, layer: 0 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 400,
      hpMax: 400,
    },
    {
      id: 'b-turret-2',
      kind: 'MushroomTurret',
      anchor: { x: 12, y: 4, layer: 0 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 400,
      hpMax: 400,
    },
    {
      id: 'b-wall-1',
      kind: 'LeafWall',
      anchor: { x: 6, y: 6, layer: 0 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 600,
      hpMax: 600,
    },
    {
      id: 'b-wall-2',
      kind: 'LeafWall',
      anchor: { x: 11, y: 6, layer: 0 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 600,
      hpMax: 600,
    },
    {
      id: 'b-bunker',
      kind: 'PebbleBunker',
      anchor: { x: 3, y: 9, layer: 0 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 900,
      hpMax: 900,
    },
    {
      id: 'b-vault-1',
      kind: 'SugarVault',
      anchor: { x: 10, y: 9, layer: 1 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 350,
      hpMax: 350,
    },
    {
      id: 'b-vault-2',
      kind: 'SugarVault',
      anchor: { x: 5, y: 9, layer: 1 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 350,
      hpMax: 350,
    },
  ],
};

export class RaidScene extends Phaser.Scene {
  private cfg!: Sim.SimConfig;
  private state!: Sim.SimState;
  private pendingInputs: Types.SimInput[] = [];

  private boardContainer!: Phaser.GameObjects.Container;
  private buildingSprites = new Map<number, Phaser.GameObjects.Image>();
  private buildingHpBars = new Map<number, Phaser.GameObjects.Graphics>();
  private buildingRoleLabels = new Map<number, Phaser.GameObjects.Text>();
  // Side-maps for the hit-flash and death-burst juice. Kept separate
  // from SimState so the sim stays pure and replayable.
  private buildingLastHp = new Map<number, number>();
  private buildingKillPlayed = new Set<number>();
  private unitLastHp = new Map<number, number>();
  // Sprites can be either a static Image or an animated Sprite (walk
  // cycle) depending on the kind + admin toggle. Both share the same
  // x/y/alpha/setDisplaySize surface we touch each tick, so the Map
  // stores the common base type.
  private unitSprites = new Map<
    number,
    Phaser.GameObjects.Image | Phaser.GameObjects.Sprite
  >();
  // Previous-frame screen position for each live unit. Used to gate
  // the walk-cycle animation — a unit that hasn't moved since the
  // last render call is idle (attacking, stunned, waiting on a turret
  // to die), and should freeze on the rest frame instead of jogging
  // in place. Cleared when the unit dies.
  private unitLastPos = new Map<number, { x: number; y: number }>();
  // Populated from GET /api/settings/animation at scene create.
  // A kind is "animated" iff (it's in ANIMATED_UNIT_KINDS) AND
  // (this Record has it set to true) AND (the walk texture loaded).
  private animationEnabled: Record<string, boolean> = {};
  private trailEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
  private attackerQueenLevel = 1;
  // Track deployment unit counts for stagger indexing: unit count per (tick, ownerSlot).
  // Entries are cleared after each tick to prevent memory leaks in long sessions.
  private deploymentUnitCounts = new Map<string, number>();

  // Trail drawing state.
  private selectedDeckIdx = 0;
  private deckEntries: DeckEntry[] = [];
  // Stored in board-local pixels, not world/screen pixels, so the drawn
  // trail and the committed deploy path stay locked together even when the
  // board is scaled for mobile layouts.
  private drawingPoints: Array<{ x: number; y: number }> = [];
  private trailGraphics!: Phaser.GameObjects.Graphics;
  private isDrawing = false;
  private lastSpawnEdge: SpawnEdge = 'left';

  // Pheromone path modifier state. The player picks a mode here BEFORE
  // drawing; on commit, the chosen modifier is auto-attached at the
  // path's midpoint waypoint. 'none' = vintage straight-shot path.
  private currentModifierMode: Types.PathModifierKind | 'none' = 'none';
  private modifierBar!: Phaser.GameObjects.Container;
  private modifierButtons: Array<{
    kind: Types.PathModifierKind | 'none';
    container: Phaser.GameObjects.Container;
    bg: Phaser.GameObjects.Graphics;
    label: Phaser.GameObjects.Text;
  }> = [];
  private modifierStamp!: Phaser.GameObjects.Container;
  // Saved tactics — local-only, persisted to localStorage. Each entry
  // is a finished pheromone path the player liked enough to keep:
  // unit kind, modifier, and the polyline in tile space.
  private tacticsPanel: Phaser.GameObjects.Container | null = null;
  private lastDraft: SavedTactic | null = null;
  private saveTacticBtn!: Phaser.GameObjects.Container;

  // UI widgets.
  private timerText!: Phaser.GameObjects.Text;
  private starsText!: Phaser.GameObjects.Text;
  private lootText!: Phaser.GameObjects.Text;
  private deckTrayBg!: Phaser.GameObjects.Graphics;
  private deckSelectedIcon!: Phaser.GameObjects.Image;
  private deckSelectedText!: Phaser.GameObjects.Text;
  private deckUnitCountText!: Phaser.GameObjects.Text;
  private deckHintText!: Phaser.GameObjects.Text;
  private deckUnlockText!: Phaser.GameObjects.Text;
  private boardGuide!: Phaser.GameObjects.Container;
  private spawnZoneGraphics!: Phaser.GameObjects.Graphics;
  private spawnZoneLabel!: Phaser.GameObjects.Text;
  private spawnZoneCue!: Phaser.GameObjects.Container;
  private deckContainers: Phaser.GameObjects.Container[] = [];
  // Parallel array to deckContainers — avoids monkey-patching the
  // container with a labelText property.
  private deckLabels: Phaser.GameObjects.Text[] = [];

  private simTickElapsed = 0; // fractional tick accumulator
  private deckCardScale = 1;
  private started = false;
  private resultShown = false;
  // Captured from the match response so raid/submit can round-trip
  // against the same defender + seed + base snapshot that was used
  // to run the sim.
  private matchContext: MatchResponse | null = null;
  private raidInputs: Types.SimInput[] = [];
  private submitted = false;
  private replayName: string | null = null;
  private replayNameText: Phaser.GameObjects.Text | null = null;

  // Stickiness contexts (consumed from registry once per raid).
  private warContext: { warId: string; defenderId: string } | null = null;
  private campaignContext: { missionId: number; chapterId: number; title: string } | null = null;
  private replayContext: {
    id: string;
    seed: number;
    baseSnapshot: Types.Base;
    inputs: Types.SimInput[];
    replayName: string;
    attackerName: string;
    defenderName: string;
  } | null = null;
  private revengeContext: { defenderId: string } | null = null;

  constructor() {
    super('RaidScene');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0f1b10');
    fadeInScene(this);
    installSceneClickDebug(this);
    // Reset all per-run state. Scene instances are reused across raids,
    // so previous-run state must be cleared here or it'll leak.
    // Deck is filtered by the attacker's own Queen level — locked
    // kinds aren't shown at all. Matches CoC's barracks-gated card
    // roster and keeps raid UI uncluttered at low tiers.
    const initRuntime = this.registry.get('runtime') as HiveRuntime | undefined;
    this.attackerQueenLevel = queenLevelFromBase(initRuntime?.player?.base);
    this.deckEntries = buildDeck(this.attackerQueenLevel);
    this.deckContainers = [];
    this.deckLabels = [];
    this.buildingSprites.clear();
    this.buildingHpBars.clear();
    this.buildingRoleLabels.clear();
    this.buildingLastHp.clear();
    this.buildingKillPlayed.clear();
    this.unitSprites.clear();
    this.unitLastHp.clear();
    this.unitLastPos.clear();
    this.deploymentUnitCounts.clear();
    this.animationEnabled = {};
    // Fetch admin toggles without blocking scene start. By the time the
    // first unit spawns (usually a couple of ticks in), the settings
    // have resolved and animated kinds get walk-cycle sprites; before
    // that, everyone's static, which is the safe fallback anyway.
    const rt = this.registry.get('runtime') as HiveRuntime | undefined;
    if (rt) {
      void rt.api.getAnimationSettings().then((s) => {
        this.animationEnabled = s;
      });
    }
    this.pendingInputs = [];
    this.raidInputs = [];
    this.simTickElapsed = 0;
    this.resultShown = false;
    this.started = false;
    this.submitted = false;
    this.selectedDeckIdx = 0;
    this.drawingPoints = [];
    this.isDrawing = false;
    this.matchContext = null;
    this.currentModifierMode = 'none';
    this.modifierButtons = [];
    this.lastDraft = null;
    this.tacticsPanel = null;

    // Start the scene synchronously against the hard-coded bot so there's
    // never a white flash; if a matchmaking response arrives shortly
    // after, it replaces the state and re-renders.
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    const attackerUnitLevels = (runtime?.player?.player.unitLevels ?? undefined) as
      | Record<string, number>
      | undefined;
    // Stickiness hooks: scenes can stamp a match/replay context on
    // the registry before transitioning here. When present, we honor
    // it instead of running matchmaking. Contexts are consumed once.
    const prefilledMatch = this.registry.get('prefilledMatch') as MatchResponse | null;
    const warCtx = this.registry.get('warContext') as {
      warId: string; defenderId: string;
    } | null;
    const campaignCtx = this.registry.get('campaignMission') as {
      missionId: number; chapterId: number; title: string;
    } | null;
    const replayCtx = this.registry.get('replayContext') as {
      id: string; seed: number; baseSnapshot: Types.Base;
      inputs: Types.SimInput[]; replayName: string;
      attackerName: string; defenderName: string;
    } | null;
    const revengeCtx = this.registry.get('revengeContext') as {
      defenderId: string;
    } | null;
    // One-shot consumption so a back-and-forth doesn't re-fire.
    this.registry.set('prefilledMatch', null);
    this.registry.set('warContext', null);
    this.registry.set('campaignMission', null);
    this.registry.set('replayContext', null);
    this.registry.set('revengeContext', null);
    this.warContext = warCtx;
    this.campaignContext = campaignCtx;
    this.replayContext = replayCtx;
    this.revengeContext = revengeCtx;

    const seed = prefilledMatch?.seed
      ?? replayCtx?.seed
      ?? 0xc0ffee;
    const snapshot = prefilledMatch?.baseSnapshot
      ?? replayCtx?.baseSnapshot
      ?? BOT_BASE;
    this.cfg = {
      tickRate: 30,
      maxTicks: TICK_HZ * RAID_SECONDS,
      initialSnapshot: snapshot,
      seed,
      ...(attackerUnitLevels ? { attackerUnitLevels } : {}),
    };
    this.state = Sim.createInitialState(this.cfg);
    if (prefilledMatch) {
      this.matchContext = prefilledMatch;
    } else if (replayCtx) {
      // Replay mode: we'll auto-play the stored inputs after create()
      // finishes and skip match fetching + submission. Scheduled on a
      // tick so the scene is fully wired before the first deploy.
      this.time.delayedCall(50, () => this.bootReplayPlayback());
    } else {
      void this.fetchMatchFromServer();
    }

    this.drawHud();
    this.boardContainer = this.add.container(0, HUD_H);
    this.drawBoard();
    this.drawBuildingsFromState();
    this.trailGraphics = this.add.graphics().setDepth(DEPTHS.boardOverlay);
    this.boardContainer.add(this.trailGraphics);
    // Modifier stamp lives inside the boardContainer so it scales with
    // the board on mobile. Hidden by default; shown briefly after a
    // commit, fades with the trail.
    this.modifierStamp = this.add.container(0, 0).setDepth(DEPTHS.boardOverlay + 1).setVisible(false);
    this.boardContainer.add(this.modifierStamp);
    this.drawModifierBar();
    this.drawDeckTray();
    this.drawDeck();

    this.wirePointerInput();

    const trailKey = bakeTrailDot(this);

    // Particle trail that follows every unit. One shared emitter is far
    // cheaper than per-unit emitters; we just move its position each frame
    // when rendering to whichever unit needs a puff this tick.
    this.trailEmitter = this.add.particles(0, 0, trailKey, {
      lifespan: 340,
      speed: { min: 0, max: 10 },
      scale: { start: 0.9, end: 0 },
      alpha: { start: 0.6, end: 0 },
      blendMode: 'ADD',
      frequency: -1, // manual emit — explode() when we want a puff
      quantity: 1,
    });
    this.trailEmitter.setDepth(DEPTHS.trail);
    this.boardContainer.add(this.trailEmitter);

    this.events.once('shutdown', () => this.scale.off('resize', this.layout, this));
    this.scale.on('resize', this.layout, this);
    this.layout();

    this.started = true;
  }

  override update(_time: number, deltaMs: number): void {
    if (!this.started) return;
    if (this.state.outcome !== 'ongoing' && this.state.tick >= this.cfg.maxTicks)
      return;
    // Replay-mode controls: pause halts the sim entirely, speed
    // multiplies the simulated delta so 2× / 4× playback does the
    // same number of ticks per frame the sim would otherwise do in
    // twice / four times as many renders. Live raids ignore both —
    // replayContext is non-null only when we're replaying.
    if (this.replayContext && this.replayPaused) return;
    const replayMult = this.replayContext ? this.replaySpeed : 1;

    // Step the deterministic sim at 30 Hz regardless of render rate.
    const msPerTick = 1000 / TICK_HZ;
    this.simTickElapsed += deltaMs * replayMult;
    while (this.simTickElapsed >= msPerTick && this.state.outcome === 'ongoing') {
      this.simTickElapsed -= msPerTick;
      const nextTick = this.state.tick + 1;
      const batch: Types.SimInput[] = [];
      for (let i = this.pendingInputs.length - 1; i >= 0; i--) {
        if (this.pendingInputs[i]!.tick <= nextTick) {
          batch.unshift(this.pendingInputs[i]!);
          this.pendingInputs.splice(i, 1);
        }
      }
      Sim.step(this.state, this.cfg, batch);
    }

    this.renderFrame();

    if (this.state.outcome !== 'ongoing') this.showResult();
  }

  private drawHud(): void {
    const g = this.add.graphics();
    g.fillGradientStyle(
      COLOR.bgPanelHi,
      COLOR.bgPanelHi,
      COLOR.bgPanelLo,
      COLOR.bgPanelLo,
      1,
    );
    g.fillRect(0, 0, this.scale.width, HUD_H);
    g.fillStyle(COLOR.brass, 0.35);
    g.fillRect(0, 1, this.scale.width, 1);
    g.fillStyle(COLOR.brassDeep, 1);
    g.fillRect(0, HUD_H - 4, this.scale.width, 1);
    g.fillStyle(COLOR.brass, 0.7);
    g.fillRect(0, HUD_H - 3, this.scale.width, 2);
    g.fillStyle(0x000000, 0.45);
    g.fillRect(0, HUD_H, this.scale.width, 3);

    makeHiveButton(this, {
      x: 80,
      y: HUD_H / 2,
      width: 120,
      height: 36,
      label: '← Home',
      variant: 'ghost',
      fontSize: 13,
      onPress: () => fadeToScene(this, 'HomeScene'),
    });

    this.timerText = this.add
      .text(this.scale.width / 2, HUD_H / 2, '1:30', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '20px',
        color: '#ffd98a',
      })
      .setOrigin(0.5);

    this.starsText = this.add
      .text(this.scale.width - 16, HUD_H / 2 - 10, '★ 0', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '16px',
        color: '#ffd98a',
      })
      .setOrigin(1, 0.5);

    this.lootText = this.add
      .text(this.scale.width - 16, HUD_H / 2 + 10, 'loot: 0', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#c3e8b0',
      })
      .setOrigin(1, 0.5);

    // Pre-raid loot preview — sums every defender building's
    // drops-on-destroy so the player sees the upper bound of what they
    // can carry out of this raid. Sits just under the timer; centered
    // so it reads as a "stake" rather than a status counter. The live
    // `lootText` above ticks up during the raid and represents what
    // they've actually banked at this point.
    const lootable = this.computeLootableTotal();
    if (lootable.sugar > 0 || lootable.leafBits > 0) {
      this.add
        .text(
          this.scale.width / 2,
          HUD_H + 6,
          `LOOTABLE  ${lootable.sugar} sugar · ${lootable.leafBits} leaf`,
          {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '11px',
            color: '#c3e8b0',
          },
        )
        .setOrigin(0.5, 0)
        .setAlpha(0.85);
    }
  }

  // Sums dropsSugarOnDestroy / dropsLeafBitsOnDestroy across every
  // alive building in the defender base. The deterministic sim credits
  // these at the moment a building hits hp <= 0, so this preview is the
  // hard ceiling on the raid's loot — what the player can possibly
  // come away with assuming a 100% wipe.
  private computeLootableTotal(): { sugar: number; leafBits: number } {
    let sugar = 0;
    let leafBits = 0;
    for (const b of this.state.buildings) {
      if (b.hp <= 0) continue;
      const stats = Sim.BUILDING_STATS[b.kind];
      if (!stats) continue;
      sugar += stats.dropsSugarOnDestroy;
      leafBits += stats.dropsLeafBitsOnDestroy;
    }
    return { sugar, leafBits };
  }

  private drawBoard(): void {
    // Board background sprite (loaded by BootScene or rendered as placeholder)
    const bgSprite = this.add.image(BOARD_W / 2, BOARD_H / 2, 'board-background');
    bgSprite.setDisplaySize(BOARD_W, BOARD_H);
    bgSprite.setDepth(DEPTHS.boardUnder);

    // Minimal grid - very subtle for alignment only
    const grid = this.add.graphics({ lineStyle: { width: 0.5, color: 0x1d3a1a, alpha: 0.15 } });
    for (let x = 0; x <= GRID_W; x++) grid.lineBetween(x * TILE, 0, x * TILE, BOARD_H);
    for (let y = 0; y <= GRID_H; y++) grid.lineBetween(0, y * TILE, BOARD_W, y * TILE);

    this.spawnZoneGraphics = this.add.graphics().setDepth(2);

    // Left spawn zone (2 tiles wide, full height)
    this.spawnZoneGraphics.fillStyle(0xc3e8b0, 0.09);
    this.spawnZoneGraphics.fillRect(0, 0, SPAWN_ZONE_W, BOARD_H);
    this.spawnZoneGraphics.lineStyle(3, 0xc3e8b0, 0.45);
    this.spawnZoneGraphics.strokeRect(0, 0, SPAWN_ZONE_W, BOARD_H);

    // Top spawn zone (excluding corner covered by left)
    this.spawnZoneGraphics.fillStyle(0xc3e8b0, 0.09);
    this.spawnZoneGraphics.fillRect(SPAWN_ZONE_W, 0, BOARD_W - SPAWN_ZONE_W, SPAWN_ZONE_H);
    this.spawnZoneGraphics.lineStyle(3, 0xc3e8b0, 0.45);
    this.spawnZoneGraphics.strokeRect(SPAWN_ZONE_W, 0, BOARD_W - SPAWN_ZONE_W, SPAWN_ZONE_H);

    // Bottom spawn zone (excluding corner covered by left)
    this.spawnZoneGraphics.fillStyle(0xc3e8b0, 0.09);
    this.spawnZoneGraphics.fillRect(SPAWN_ZONE_W, BOARD_H - SPAWN_ZONE_H, BOARD_W - SPAWN_ZONE_W, SPAWN_ZONE_H);
    this.spawnZoneGraphics.lineStyle(3, 0xc3e8b0, 0.45);
    this.spawnZoneGraphics.strokeRect(SPAWN_ZONE_W, BOARD_H - SPAWN_ZONE_H, BOARD_W - SPAWN_ZONE_W, SPAWN_ZONE_H);

    // Chevron indicators for each edge
    const leftChevrons = [0, 1, 2].map((i) =>
      this.add
        .text(SPAWN_ZONE_W / 2, 140 + i * 120, '>>>', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '22px',
          color: '#c3e8b0',
        })
        .setOrigin(0.5)
        .setAlpha(0.28),
    );

    const topChevrons = [0, 1, 2].map((i) =>
      this.add
        .text(140 + i * 120, SPAWN_ZONE_H / 2, 'vvv', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '22px',
          color: '#c3e8b0',
        })
        .setOrigin(0.5)
        .setAlpha(0.28),
    );

    const bottomChevrons = [0, 1, 2].map((i) =>
      this.add
        .text(140 + i * 120, BOARD_H - SPAWN_ZONE_H / 2, '^^^', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '22px',
          color: '#c3e8b0',
        })
        .setOrigin(0.5)
        .setAlpha(0.28),
    );

    this.spawnZoneLabel = this.add
      .text(SPAWN_ZONE_W / 2, BOARD_H / 2, 'SPAWN\nEDGE', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '18px',
        color: '#c3e8b0',
        align: 'center',
      })
      .setOrigin(0.5)
      .setAlpha(0.75)
      .setDepth(3);

    const allChevrons = [...leftChevrons, ...topChevrons, ...bottomChevrons];
    this.spawnZoneCue = this.add.container(0, 0, allChevrons);
    this.spawnZoneCue.setDepth(3);
    this.tweens.add({
      targets: allChevrons,
      alpha: { from: 0.18, to: 0.55 },
      duration: 900,
      stagger: 60,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    this.boardContainer.add([
      bgSprite,
      this.spawnZoneGraphics,
      grid,
      this.spawnZoneCue,
      this.spawnZoneLabel,
    ]);
  }

  private drawBuildingsFromState(): void {
    for (const b of this.state.buildings) {
      // Cross-layer buildings render once (both copies share id);
      // dedupe by first occurrence.
      if (this.buildingSprites.has(b.id)) continue;
      const x = b.anchorX * TILE + (b.w * TILE) / 2;
      const y = b.anchorY * TILE + (b.h * TILE) / 2;
      const spr = this.add.image(x, y, `building-${b.kind}`);
      spr.setOrigin(0.5, 0.75);
      // Bumped the minimum visible footprint from 1.6× tile → 1.85×
      // so buildings read bigger on the board; matches HomeScene's
      // same bump. Source sprites are 128 px, so at 89 px display
      // we're at a cleaner 0.69 downscale (less blur).
      spr.setDisplaySize(TILE * Math.max(b.w, 1.85), TILE * Math.max(b.h, 1.85));
      this.boardContainer.add(spr);
      this.buildingSprites.set(b.id, spr);

      const bar = this.add.graphics();
      this.boardContainer.add(bar);
      this.buildingHpBars.set(b.id, bar);

      const codex = BUILDING_CODEX[b.kind];
      if (codex) {
        const labelY = b.anchorY * TILE - 6;
        const roleLabel = this.add
          .text(x, labelY, codex.role, {
            fontSize: '10px',
            fontFamily: 'ui-monospace, monospace',
            color: COLOR.textGold,
            backgroundColor: '#09100acc',
            padding: { x: 4, y: 2 },
          })
          .setOrigin(0.5, 1)
          .setDepth(6);
        this.boardContainer.add(roleLabel);
        this.buildingRoleLabels.set(b.id, roleLabel);
      }
    }
  }

  private drawDeck(): void {
    for (let i = 0; i < this.deckEntries.length; i++) {
      const e = this.deckEntries[i]!;
      const container = this.add.container(0, 0).setDepth(31);

      const bg = this.add.graphics();
      const icon = this.add.image(0, -14, e.icon).setDisplaySize(46, 46);
      const label = this.add
        .text(0, 15, `${e.label} ×${e.count}`, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '12px',
          color: '#e6f5d2',
        })
        .setOrigin(0.5);
      const unitRole = UNIT_CODEX[e.kind]?.role ?? '';

      container.add([bg, icon, label]);
      if (unitRole) {
        const roleText = this.add
          .text(0, 29, unitRole, {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '9px',
            color: '#9fc79a',
          })
          .setOrigin(0.5);
        container.add(roleText);
      }
      container.setSize(DECK_CARD_W, DECK_CARD_H);
      container
        .setInteractive(
          new Phaser.Geom.Rectangle(
            -DECK_CARD_W / 2,
            -DECK_CARD_H / 2,
            DECK_CARD_W,
            DECK_CARD_H,
          ),
          Phaser.Geom.Rectangle.Contains,
        )
        .on('pointerdown', () => {
          this.selectDeckIndex(i);
        });

      this.deckContainers.push(container);
      this.deckLabels.push(label);
      this.redrawDeckCard(i);
    }
    this.refreshDeckUi();
  }

  private wirePointerInput(): void {
    // Board can be scaled down on narrow viewports (phone, narrow
    // laptop). Convert world-space pointer coords to board-local
    // tiles by reading boardContainer.(x, y, scaleX) directly.
    //
    // Previously this used boardContainer.getBounds(), but Phaser
    // Graphics children report (0, 0, 0, 0) bounds regardless of
    // what's been drawn into them — so the container's bounds end
    // up dominated by Sprite children (buildings, units), which move
    // and appear/disappear during a raid. That produced a drifting
    // offset between the cursor and the pheromone-trail preview.
    // Direct (.x, .y, .scaleX) reads are deterministic and always
    // reflect the layout() position, no matter what's on the board.
    const withinBoard = (px: number, py: number): boolean => {
      const scale = this.boardContainer.scaleX || 1;
      const x0 = this.boardContainer.x;
      const y0 = this.boardContainer.y;
      const w = BOARD_W * scale;
      const h = BOARD_H * scale;
      return px >= x0 && px <= x0 + w && py >= y0 && py <= y0 + h;
    };
    const toBoardLocal = (px: number, py: number): { x: number; y: number } => {
      const scale = this.boardContainer.scaleX || 1;
      return {
        x: Phaser.Math.Clamp((px - this.boardContainer.x) / scale, 0, BOARD_W),
        y: Phaser.Math.Clamp((py - this.boardContainer.y) / scale, 0, BOARD_H),
      };
    };
    const determineSpawnEdge = (px: number, py: number): SpawnEdge | null => {
      const local = toBoardLocal(px, py);
      // Left edge: x <= 2 tiles
      if (local.x <= SPAWN_ZONE_W) return 'left';
      // Top edge: y <= 2 tiles (excluding corners covered by left)
      if (local.y <= SPAWN_ZONE_H && local.x > SPAWN_ZONE_W) return 'top';
      // Bottom edge: y >= height - 2 tiles (excluding corners covered by left)
      if (local.y >= BOARD_H - SPAWN_ZONE_H && local.x > SPAWN_ZONE_W) return 'bottom';
      return null;
    };

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (!withinBoard(p.x, p.y)) return;
      if (this.state.outcome !== 'ongoing') return;
      if (this.currentDeckEntry().count <= 0) return;
      const edge = determineSpawnEdge(p.x, p.y);
      if (!edge) {
        this.deckHintText.setText('Start your drag from a glowing spawn edge (left, top, or bottom).');
        return;
      }
      this.lastSpawnEdge = edge;
      const local = toBoardLocal(p.x, p.y);
      this.isDrawing = true;
      this.drawingPoints = [local];
      this.boardGuide.setVisible(false);
      const burst = Math.min(this.currentDeckEntry().count, 5);
      const modSuffix = this.currentModifierMode === 'none'
        ? ''
        : ` (${MODIFIER_LABEL[this.currentModifierMode]} marker active)`;
      this.deckHintText.setText(
        `Draw through the base, then release to deploy up to ${burst}.${modSuffix}`,
      );
      this.renderTrailPreview();
    });

    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.isDrawing) return;
      const local = toBoardLocal(p.x, p.y);
      const last = this.drawingPoints[this.drawingPoints.length - 1]!;
      const dx = local.x - last.x;
      const dy = local.y - last.y;
      if (dx * dx + dy * dy < 14 * 14) return;
      if (this.drawingPoints.length >= 32) return;
      this.drawingPoints.push(local);
      this.renderTrailPreview();
    });

    this.input.on('pointerup', () => {
      if (!this.isDrawing) return;
      this.isDrawing = false;
      this.deckHintText.setText('Pick a unit, then drag on the battlefield to draw its path.');
      if (this.drawingPoints.length < 2) {
        this.trailGraphics.clear();
        this.boardGuide.setVisible(this.raidInputs.length === 0 && this.currentDeckEntry().count > 0);
        return;
      }
      // Commit as a deploy input targeted for the next tick.
      const entry = this.currentDeckEntry();
      const tilePoints: Types.PheromonePoint[] = this.drawingPoints.map((p) => {
        return {
          x: Sim.fromFloat(p.x / TILE),
          y: Sim.fromFloat(p.y / TILE),
        };
      });
      const burst = Math.min(entry.count, 5);
      entry.count -= burst;
      if (entry.count <= 0) {
        const next = this.deckEntries.findIndex((candidate) => candidate.count > 0);
        if (next >= 0) this.selectedDeckIdx = next;
      }
      this.refreshDeckUi();

      // Auto-attach the active modifier at the polyline's midpoint
      // waypoint. We never use index 0 (spawn) — pheromone_follow only
      // fires modifiers on arrival, so 0 would be inert.
      const modifier: Types.PathModifier | undefined =
        this.currentModifierMode === 'none' || tilePoints.length < 3
          ? undefined
          : {
              kind: this.currentModifierMode,
              pointIndex: Math.max(1, Math.floor((tilePoints.length - 1) / 2)),
            };
      const input: Types.SimInput = {
        type: 'deployPath',
        tick: this.state.tick + 1,
        ownerSlot: 0,
        path: {
          pathId: 0,
          spawnLayer: 0,
          unitKind: entry.kind,
          count: burst,
          points: tilePoints,
          ...(modifier ? { modifier } : {}),
        },
      };
      this.pendingInputs.push(input);
      // Save as a draft so the player can hit "Save tactic" right after
      // a successful commit without re-drawing.
      this.lastDraft = {
        name: `${entry.label} ${MODIFIER_LABEL[this.currentModifierMode]}`,
        unitKind: entry.kind,
        pointsTile: this.drawingPoints.map((p) => ({
          x: p.x / TILE,
          y: p.y / TILE,
        })),
        ...(modifier ? { modifier } : {}),
        spawnEdge: this.lastSpawnEdge,
      };
      this.refreshSaveTacticEnabled();
      // Stamp the modifier glyph on the trail at the marker waypoint.
      if (modifier) {
        const markerPx = this.drawingPoints[modifier.pointIndex];
        if (markerPx) this.flashModifierStamp(markerPx.x, markerPx.y, this.currentModifierMode);
      }
      // Replay timeline for server submission — every deploy the player
      // commits is recorded. Defeat/timeout endings submit this list
      // via /api/raid/submit, where the shared sim re-runs it to verify
      // the outcome before awarding trophies/loot.
      this.raidInputs.push(input);
      const start = this.drawingPoints[0];
      if (start) this.spawnDeployPopup(start.x + 18, start.y - 8, entry.label, burst);

      // fade the committed trail
      this.tweens.add({
        targets: this.trailGraphics,
        alpha: { from: 1, to: 0 },
        duration: 600,
        onComplete: () => {
          this.trailGraphics.clear();
          this.trailGraphics.setAlpha(1);
        },
      });
    });
  }

  private currentDeckEntry(): DeckEntry {
    return this.deckEntries[this.selectedDeckIdx]!;
  }

  // ---------- Path modifier toolbar + saved tactics ----------

  private drawModifierBar(): void {
    this.modifierBar = this.add.container(0, 0).setDepth(32);
    const bg = this.add.graphics();
    this.modifierBar.add(bg);
    // Background panel — re-painted in layout() at the right width.
    (this.modifierBar as Phaser.GameObjects.Container & { _bg?: Phaser.GameObjects.Graphics })._bg = bg;

    const order: Array<Types.PathModifierKind | 'none'> = ['none', 'split', 'ambush', 'dig'];
    const buttonW = 96;
    const buttonH = 32;
    const gap = 6;
    let cursorX = 0;
    for (const kind of order) {
      const containerBtn = this.add.container(cursorX, 0);
      const btnBg = this.add.graphics();
      const label = this.add
        .text(buttonW / 2, buttonH / 2, `${MODIFIER_GLYPH[kind]}  ${MODIFIER_LABEL[kind]}`, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '13px',
          color: '#e6f5d2',
        })
        .setOrigin(0.5);
      containerBtn.add([btnBg, label]);
      containerBtn.setSize(buttonW, buttonH);
      containerBtn.setInteractive(
        new Phaser.Geom.Rectangle(0, 0, buttonW, buttonH),
        Phaser.Geom.Rectangle.Contains,
      );
      containerBtn.on('pointerdown', () => this.setModifierMode(kind));
      this.modifierBar.add(containerBtn);
      this.modifierButtons.push({ kind, container: containerBtn, bg: btnBg, label });
      cursorX += buttonW + gap;
    }

    // Save & Tactics action buttons share the bar's right side.
    const actionW = 110;
    const saveContainer = this.add.container(cursorX + 8, 0);
    const saveBg = this.add.graphics();
    const saveLabel = this.add
      .text(actionW / 2, buttonH / 2, '★ Save', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#ffd98a',
      })
      .setOrigin(0.5);
    saveContainer.add([saveBg, saveLabel]);
    saveContainer.setSize(actionW, buttonH);
    saveContainer.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, actionW, buttonH),
      Phaser.Geom.Rectangle.Contains,
    );
    saveContainer.on('pointerdown', () => this.handleSaveTactic());
    (saveContainer as Phaser.GameObjects.Container & { _bg?: Phaser.GameObjects.Graphics; _label?: Phaser.GameObjects.Text })._bg = saveBg;
    (saveContainer as Phaser.GameObjects.Container & { _bg?: Phaser.GameObjects.Graphics; _label?: Phaser.GameObjects.Text })._label = saveLabel;
    this.modifierBar.add(saveContainer);
    this.saveTacticBtn = saveContainer;
    cursorX += actionW + 8;

    const tacContainer = this.add.container(cursorX + 8, 0);
    const tacBg = this.add.graphics();
    const tacLabel = this.add
      .text(actionW / 2, buttonH / 2, '☰ Tactics', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#c3e8b0',
      })
      .setOrigin(0.5);
    tacContainer.add([tacBg, tacLabel]);
    tacContainer.setSize(actionW, buttonH);
    tacContainer.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, actionW, buttonH),
      Phaser.Geom.Rectangle.Contains,
    );
    tacContainer.on('pointerdown', () => this.toggleTacticsPanel());
    this.paintActionButton(tacBg, false);
    this.modifierBar.add(tacContainer);

    this.refreshModifierBar();
    this.refreshSaveTacticEnabled();
  }

  private paintActionButton(bg: Phaser.GameObjects.Graphics, pressed: boolean): void {
    bg.clear();
    bg.fillStyle(pressed ? 0x2a4530 : 0x1a2b1a, 1);
    bg.lineStyle(2, COLOR.brassDeep, 1);
    bg.fillRoundedRect(0, 0, 110, 32, 8);
    bg.strokeRoundedRect(0, 0, 110, 32, 8);
  }

  private refreshModifierBar(): void {
    for (const b of this.modifierButtons) {
      const selected = b.kind === this.currentModifierMode;
      b.bg.clear();
      b.bg.fillStyle(selected ? 0x3a7f3a : 0x1a2b1a, 1);
      b.bg.lineStyle(2, selected ? 0xffd98a : COLOR.brassDeep, 1);
      b.bg.fillRoundedRect(0, 0, 96, 32, 8);
      b.bg.strokeRoundedRect(0, 0, 96, 32, 8);
      b.label.setColor(selected ? '#fff' : '#e6f5d2');
    }
  }

  private setModifierMode(kind: Types.PathModifierKind | 'none'): void {
    this.currentModifierMode = kind;
    this.refreshModifierBar();
    this.deckHintText.setText(
      kind === 'none'
        ? 'Direct path — units walk straight through.'
        : `${MODIFIER_LABEL[kind]} marker armed — placed at path midpoint on commit.`,
    );
  }

  private flashModifierStamp(
    px: number,
    py: number,
    kind: Types.PathModifierKind | 'none',
  ): void {
    if (kind === 'none') return;
    this.modifierStamp.removeAll(true);
    const ring = this.add.graphics();
    ring.lineStyle(3, 0xffd98a, 1);
    ring.strokeCircle(0, 0, 16);
    ring.fillStyle(0x162216, 0.85);
    ring.fillCircle(0, 0, 16);
    const glyph = this.add
      .text(0, 0, MODIFIER_GLYPH[kind], {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '20px',
        color: '#ffd98a',
      })
      .setOrigin(0.5);
    this.modifierStamp.add([ring, glyph]);
    this.modifierStamp.setPosition(px, py);
    this.modifierStamp.setVisible(true);
    this.modifierStamp.setAlpha(1);
    this.tweens.killTweensOf(this.modifierStamp);
    this.tweens.add({
      targets: this.modifierStamp,
      alpha: 0,
      duration: 900,
      delay: 300,
      onComplete: () => this.modifierStamp.setVisible(false),
    });
  }

  private refreshSaveTacticEnabled(): void {
    const btn = this.saveTacticBtn as Phaser.GameObjects.Container & {
      _bg?: Phaser.GameObjects.Graphics;
      _label?: Phaser.GameObjects.Text;
    };
    const enabled = !!this.lastDraft;
    if (btn._bg) {
      btn._bg.clear();
      btn._bg.fillStyle(enabled ? 0x3a3520 : 0x1a1a16, 1);
      btn._bg.lineStyle(2, enabled ? 0xffd98a : 0x554d2c, 1);
      btn._bg.fillRoundedRect(0, 0, 110, 32, 8);
      btn._bg.strokeRoundedRect(0, 0, 110, 32, 8);
    }
    if (btn._label) btn._label.setAlpha(enabled ? 1 : 0.45);
  }

  private handleSaveTactic(): void {
    if (!this.lastDraft) return;
    const list = loadSavedTactics();
    const auto = `${this.lastDraft.name} #${list.length + 1}`;
    const next: SavedTactic = { ...this.lastDraft, name: auto };
    list.push(next);
    while (list.length > TACTICS_LIMIT) list.shift();
    persistSavedTactics(list);
    this.spawnDeployPopup(this.scale.width / 2, HUD_H + MODIFIER_BAR_H + 12, 'Saved', 1);
    if (this.tacticsPanel) {
      this.closeTacticsPanel();
      this.openTacticsPanel();
    }
  }

  private toggleTacticsPanel(): void {
    if (this.tacticsPanel) {
      this.closeTacticsPanel();
    } else {
      this.openTacticsPanel();
    }
  }

  private openTacticsPanel(): void {
    const list = loadSavedTactics();
    const w = Math.min(this.scale.width - 32, 360);
    const h = Math.min(this.scale.height - HUD_H - 80, 320);
    const panel = this.add.container(this.scale.width / 2, HUD_H + 60).setDepth(80);
    const bg = this.add.graphics();
    drawPanel(bg, -w / 2, 0, w, h, {
      topColor: 0x172117,
      botColor: 0x0a120b,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.18,
      radius: 14,
      shadowOffset: 5,
      shadowAlpha: 0.4,
    });
    panel.add(bg);
    const title = this.add
      .text(0, 14, 'Saved Tactics', displayTextStyle(15, '#ffd98a', 3))
      .setOrigin(0.5, 0);
    panel.add(title);
    const closeBtn = this.add
      .text(w / 2 - 18, 14, '✕', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '16px',
        color: '#c3e8b0',
      })
      .setOrigin(0.5, 0)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.closeTacticsPanel());
    panel.add(closeBtn);
    if (list.length === 0) {
      const empty = this.add
        .text(0, 60, 'Draw a path, then hit ★ Save to bank a tactic.', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '12px',
          color: '#9fc79a',
          align: 'center',
          wordWrap: { width: w - 40 },
        })
        .setOrigin(0.5, 0);
      panel.add(empty);
    } else {
      const rowH = 38;
      for (let i = 0; i < list.length; i++) {
        const t = list[i]!;
        const rowY = 50 + i * (rowH + 4);
        const row = this.add.container(0, rowY);
        const rowBg = this.add.graphics();
        rowBg.fillStyle(0x1a2b1a, 1);
        rowBg.lineStyle(1, COLOR.brassDeep, 1);
        rowBg.fillRoundedRect(-w / 2 + 12, 0, w - 24, rowH, 8);
        rowBg.strokeRoundedRect(-w / 2 + 12, 0, w - 24, rowH, 8);
        const text = this.add
          .text(-w / 2 + 22, rowH / 2, t.name, {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '12px',
            color: '#e6f5d2',
          })
          .setOrigin(0, 0.5);
        const meta = `${t.unitKind}${t.modifier ? ' · ' + MODIFIER_GLYPH[t.modifier.kind] : ''}`;
        const metaText = this.add
          .text(w / 2 - 90, rowH / 2, meta, {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '11px',
            color: '#9fc79a',
          })
          .setOrigin(0, 0.5);
        const useBtn = this.add
          .text(w / 2 - 24, rowH / 2, '▶', {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '14px',
            color: '#ffd98a',
          })
          .setOrigin(0.5, 0.5)
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', () => {
            this.deployTactic(t);
            this.closeTacticsPanel();
          });
        row.add([rowBg, text, metaText, useBtn]);
        panel.add(row);
      }
    }
    this.tacticsPanel = panel;
  }

  private closeTacticsPanel(): void {
    if (this.tacticsPanel) {
      this.tacticsPanel.destroy(true);
      this.tacticsPanel = null;
    }
  }

  private deployTactic(t: SavedTactic): void {
    // Find a deck slot for this kind with stock; fall back silently if
    // the player has none of the unit type left.
    const idx = this.deckEntries.findIndex((d) => d.kind === t.unitKind && d.count > 0);
    if (idx < 0) {
      this.deckHintText.setText(`No ${t.unitKind} left for that tactic.`);
      return;
    }
    this.selectedDeckIdx = idx;
    const entry = this.deckEntries[idx]!;
    const burst = Math.min(entry.count, 5);
    const tilePoints: Types.PheromonePoint[] = t.pointsTile.map((p) => ({
      x: Sim.fromFloat(p.x),
      y: Sim.fromFloat(p.y),
    }));
    entry.count -= burst;
    this.refreshDeckUi();
    const input: Types.SimInput = {
      type: 'deployPath',
      tick: this.state.tick + 1,
      ownerSlot: 0,
      path: {
        pathId: 0,
        spawnLayer: 0,
        unitKind: entry.kind,
        count: burst,
        points: tilePoints,
        ...(t.modifier ? { modifier: t.modifier } : {}),
      },
    };
    this.pendingInputs.push(input);
    this.raidInputs.push(input);
    // Brief preview trail in screen-pixel space so the player sees what
    // the tactic actually drew on the board.
    this.trailGraphics.clear();
    this.trailGraphics.lineStyle(4, 0xffd98a, 0.95);
    this.trailGraphics.beginPath();
    for (let i = 0; i < t.pointsTile.length; i++) {
      const px = t.pointsTile[i]!.x * TILE;
      const py = t.pointsTile[i]!.y * TILE;
      if (i === 0) this.trailGraphics.moveTo(px, py);
      else this.trailGraphics.lineTo(px, py);
    }
    this.trailGraphics.strokePath();
    this.tweens.add({
      targets: this.trailGraphics,
      alpha: { from: 1, to: 0 },
      duration: 700,
      onComplete: () => {
        this.trailGraphics.clear();
        this.trailGraphics.setAlpha(1);
      },
    });
    if (t.modifier) {
      const markerTile = t.pointsTile[t.modifier.pointIndex];
      if (markerTile) {
        this.flashModifierStamp(
          markerTile.x * TILE,
          markerTile.y * TILE,
          t.modifier.kind,
        );
      }
    }
  }

  private drawDeckTray(): void {
    this.deckTrayBg = this.add.graphics().setDepth(30);
    this.deckSelectedIcon = this.add
      .image(0, 0, this.deckEntries[0]?.icon ?? 'unit-WorkerAnt')
      .setDisplaySize(34, 34)
      .setDepth(31);
    this.deckSelectedText = this.add
      .text(0, 0, '', displayTextStyle(15, '#ffd98a', 3))
      .setOrigin(0.5, 0)
      .setDepth(31);
    this.deckUnitCountText = this.add
      .text(0, 0, '', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '28px',
        fontStyle: 'bold',
        color: '#c3e8b0',
      })
      .setOrigin(0.5, 0.5)
      .setDepth(31);
    this.deckHintText = this.add
      .text(
        0,
        0,
        'Pick a unit, then drag on the battlefield to draw its path.',
        { ...bodyTextStyle(11, '#c3e8b0'), align: 'center' },
      )
      .setOrigin(0.5, 0)
      .setDepth(31);
    this.deckUnlockText = this.add
      .text(0, 0, '', { ...labelTextStyle(10, '#9fc79a'), align: 'center' })
      .setOrigin(0.5, 0)
      .setDepth(31);
    const guideBg = this.add.graphics();
    drawPanel(guideBg, -118, -22, 236, 44, {
      topColor: 0x172117,
      botColor: 0x0a120b,
      stroke: COLOR.brassDeep,
      strokeWidth: 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.2,
      radius: 14,
      shadowOffset: 3,
      shadowAlpha: 0.35,
    });
    const guideText = this.add
      .text(0, 0, 'Drag a path here to attack', displayTextStyle(13, '#ffd98a', 3))
      .setOrigin(0.5);
    this.boardGuide = this.add.container(BOARD_W / 2, 28, [guideBg, guideText]);
    this.boardGuide.setDepth(15);
    this.boardContainer.add(this.boardGuide);
    this.tweens.add({
      targets: this.boardGuide,
      alpha: { from: 0.55, to: 1 },
      duration: 850,
      yoyo: true,
      repeat: -1,
    });
  }

  private selectDeckIndex(index: number): void {
    this.selectedDeckIdx = Phaser.Math.Clamp(index, 0, this.deckEntries.length - 1);
    const container = this.deckContainers[this.selectedDeckIdx];
    if (container) {
      this.tweens.killTweensOf(container);
      container.setScale(this.deckCardScale);
      this.tweens.add({
        targets: container,
        scaleX: this.deckCardScale * 1.05,
        scaleY: this.deckCardScale * 1.05,
        duration: 110,
        yoyo: true,
      });
    }
    this.refreshDeckUi();
  }

  private redrawDeckCard(index: number): void {
    const container = this.deckContainers[index];
    const bgObj = container?.getAt(0) as Phaser.GameObjects.Graphics | undefined;
    const label = this.deckLabels[index];
    const entry = this.deckEntries[index];
    if (!container || !bgObj || !label || !entry) return;
    const selected = index === this.selectedDeckIdx;
    const depleted = entry.count <= 0;
    bgObj.clear();
    bgObj.fillStyle(
      depleted ? 0x241d1d : selected ? 0x3a7f3a : 0x1a2b1a,
      1,
    );
    bgObj.lineStyle(
      3,
      depleted ? 0x5a4141 : selected ? 0xffd98a : 0x2c5a23,
      1,
    );
    bgObj.fillRoundedRect(
      -DECK_CARD_W / 2,
      -DECK_CARD_H / 2 + 6,
      DECK_CARD_W,
      DECK_CARD_H - 12,
      10,
    );
    bgObj.strokeRoundedRect(
      -DECK_CARD_W / 2,
      -DECK_CARD_H / 2 + 6,
      DECK_CARD_W,
      DECK_CARD_H - 12,
      10,
    );
    bgObj.fillStyle(selected ? 0xffffff : COLOR.brass, selected ? 0.1 : 0.04);
    bgObj.fillRoundedRect(
      -DECK_CARD_W / 2 + 6,
      -DECK_CARD_H / 2 + 12,
      DECK_CARD_W - 12,
      8,
      6,
    );
    label.setText(`${entry.label} ×${entry.count}`);
    label.setColor(depleted ? '#d98080' : '#e6f5d2');
    container.setAlpha(depleted ? 0.55 : 1);
  }

  private refreshDeckUi(): void {
    for (let i = 0; i < this.deckContainers.length; i++) this.redrawDeckCard(i);
    const entry = this.currentDeckEntry();
    if (!entry) return;
    this.deckSelectedIcon.setTexture(entry.icon);
    this.deckSelectedIcon.setAlpha(entry.count > 0 ? 1 : 0.5);
    const status = entry.count > 0 ? `${entry.count} ready` : 'depleted';
    const burst = Math.min(entry.count, 5);
    const unitCodex = UNIT_CODEX[entry.kind];
    const roleStr = unitCodex ? ` — ${unitCodex.role}` : '';
    this.deckSelectedText.setText(
      `${entry.label}${roleStr} (${status})${entry.count > 0 ? ` • deploys ${burst}` : ''}`,
    );

    // Unit count display: shows current/max count, color-coded by readiness
    const totalCount = ALL_DECK.find((d) => d.kind === entry.kind)?.count ?? 0;
    const countStr = `${entry.count}/${totalCount}`;
    let countColor = '#c3e8b0'; // green default
    if (entry.count === 0) {
      countColor = '#d98080'; // red if depleted
    } else if (entry.count <= totalCount / 2) {
      countColor = '#ffd98a'; // gold if caution (half or less)
    }
    this.deckUnitCountText.setText(countStr);
    this.deckUnitCountText.setColor(countColor);

    this.deckHintText.setText(
      entry.count > 0
        ? (unitCodex?.power
            ? `${unitCodex.power.slice(0, 90)}${unitCodex.power.length > 90 ? '…' : ''}`
            : 'Drag across the battlefield to draw its attack path.')
        : 'This unit is depleted. Pick another card to keep attacking.',
    );
    const upcoming = ALL_DECK.filter((d) => d.unlockQueenLevel > this.attackerQueenLevel)
      .slice(0, 2)
      .map((d) => `${d.label} L${d.unlockQueenLevel}`);
    this.deckUnlockText.setText(
      upcoming.length > 0
        ? `Next unlocks: ${upcoming.join(' • ')}`
        : 'All attacker units unlocked at your current Queen level.',
    );
    const showOnboarding = !this.isDrawing && this.raidInputs.length === 0 && entry.count > 0;
    this.boardGuide.setVisible(showOnboarding);
    this.spawnZoneCue.setVisible(showOnboarding);
    this.spawnZoneLabel.setVisible(showOnboarding);
  }

  private deckLayoutMetrics(): {
    rows: 1 | 2 | 3;
    cols: number;
    scale: number;
    trayHeight: number;
  } {
    // Minimum scale that keeps a card tap-friendly (48 px physical
    // targets per iOS HIG; DECK_CARD_W * 0.62 ≈ 67 px, comfortable for
    // thumbs and still shows the icon + count). Below this we wrap to
    // another row rather than shrinking cards further.
    const MIN_SCALE = 0.62;
    const WRAP_SCALE = 0.78;

    const count = Math.max(1, this.deckEntries.length);
    const availW = this.scale.width - 24;
    const scaleFor = (cols: number): number =>
      Math.min(
        1,
        (availW - DECK_GRID_GAP * Math.max(0, cols - 1)) / (DECK_CARD_W * cols),
      );

    // Pick the fewest rows that keep cards readable. Previously capped
    // at 2 rows, which on ≤360 px phones packed 5 cards into a row at
    // scale ~0.53 — below the tap-target floor. Now we fall through to
    // 3 rows when 2 would still shrink cards past MIN_SCALE.
    let rows: 1 | 2 | 3 = 1;
    if (scaleFor(count) < WRAP_SCALE) rows = 2;
    if (rows === 2 && scaleFor(Math.ceil(count / 2)) < MIN_SCALE) rows = 3;

    const cols = Math.ceil(count / rows);
    const scale = Math.max(MIN_SCALE, scaleFor(cols));
    const rowHeight = DECK_CARD_H * scale;
    const trayHeight =
      Math.ceil(56 + rows * rowHeight + (rows - 1) * DECK_GRID_GAP + 18);
    return { rows, cols, scale, trayHeight };
  }

  // Spawn the right visual for a unit. Three conditions must all be
  // true to render the walk-cycle animation:
  //
  //   1. The kind is in the hand-curated animated list (only 3 ship today).
  //   2. The admin hasn't disabled it via /admin/api/settings/animation.
  //   3. The walk spritesheet actually loaded (Gemini may not have
  //      generated it yet, or the asset might be missing on disk).
  //
  // Any miss → fall back to the static `unit-${kind}` image. The
  // fallback path is the one every non-animated unit uses today, so
  // there's zero behavioral change for Beetle / Spider / DirtDigger /
  // etc. — the feature is purely additive.
  private makeUnitSprite(
    kind: Types.UnitKind,
    x: number,
    y: number,
  ): Phaser.GameObjects.Image | Phaser.GameObjects.Sprite {
    const isAnimatedKind = (ANIMATED_UNIT_KINDS as readonly string[]).includes(kind);
    const enabled = this.animationEnabled[kind] !== false;
    const sheetKey = `unit-${kind}-walk`;
    const animKey = `walk-${kind}`;
    if (
      isAnimatedKind &&
      enabled &&
      this.textures.exists(sheetKey) &&
      this.anims.exists(animKey)
    ) {
      const spr = this.add
        .sprite(x, y, sheetKey)
        .setDisplaySize(36, 36)
        .setOrigin(0.5, 0.7);
      spr.play(animKey);
      return spr;
    }
    return this.add
      .image(x, y, `unit-${kind}`)
      .setDisplaySize(36, 36)
      .setOrigin(0.5, 0.7);
  }

  private renderTrailPreview(): void {
    // drawingPoints already live in board-local coordinates, so the
    // preview can be drawn directly without any world-to-local math.
    this.trailGraphics.clear();
    this.trailGraphics.lineStyle(6, 0xffd98a, 0.85);
    this.trailGraphics.beginPath();
    for (let i = 0; i < this.drawingPoints.length; i++) {
      const p = this.drawingPoints[i]!;
      if (i === 0) this.trailGraphics.moveTo(p.x, p.y);
      else this.trailGraphics.lineTo(p.x, p.y);
    }
    this.trailGraphics.strokePath();
    this.trailGraphics.fillStyle(0xffd98a, 0.9);
    for (const p of this.drawingPoints) {
      this.trailGraphics.fillCircle(p.x, p.y, 4);
    }
    const start = this.drawingPoints[0];
    const end = this.drawingPoints[this.drawingPoints.length - 1];
    if (start) {
      this.trailGraphics.lineStyle(3, 0xc3e8b0, 0.95);
      this.trailGraphics.strokeCircle(start.x, start.y, 10);
      this.trailGraphics.fillStyle(0xc3e8b0, 0.95);
      this.trailGraphics.fillCircle(start.x, start.y, 5);
    }
    if (end) {
      this.trailGraphics.lineStyle(3, 0xffd98a, 1);
      this.trailGraphics.strokeCircle(end.x, end.y, 12);
    }
  }

  private renderFrame(): void {
    // HUD timer & loot
    const ticksRemaining = Math.max(0, this.cfg.maxTicks - this.state.tick);
    const secondsRemaining = Math.ceil(ticksRemaining / TICK_HZ);
    const mm = Math.floor(secondsRemaining / 60);
    const ss = secondsRemaining % 60;
    this.timerText.setText(`${mm}:${ss.toString().padStart(2, '0')}`);
    const stars = this.currentStars();
    this.starsText.setText('★'.repeat(stars) + '☆'.repeat(3 - stars));
    this.lootText.setText(
      `loot: ${this.state.attackerSugarLooted} sugar · ${this.state.attackerLeafBitsLooted} leaf`,
    );

    // Clear per-tick deployment counters to prevent memory leaks in long sessions.
    this.deploymentUnitCounts.clear();

    // Buildings: update HP bars and fade destroyed ones.
    for (const b of this.state.buildings) {
      const spr = this.buildingSprites.get(b.id);
      const bar = this.buildingHpBars.get(b.id);
      if (!spr || !bar) continue;
      if (b.hp <= 0) {
        if (spr.alpha > 0.2) {
          const label = this.buildingRoleLabels.get(b.id);
          const tweenTargets = label ? [spr, label] : [spr];
          this.tweens.add({ targets: tweenTargets, alpha: 0.18, duration: 200 });
          // Juice: Queen death is the hero moment — camera-punch zoom
          // out + long shake + a wide particle burst. Every other
          // building gets a smaller thud + debris puff. `destroyed`
          // tracks whether we've already played the kill effect on
          // this building so the tween doesn't re-fire every tick of
          // the 200ms fade.
          if (!this.buildingKillPlayed.has(b.id)) {
            this.buildingKillPlayed.add(b.id);
            const centerX = b.anchorX * TILE + (b.w * TILE) / 2;
            const centerY = b.anchorY * TILE + (b.h * TILE) / 2;
            this.spawnDebrisBurst(centerX, centerY, b.kind === 'QueenChamber' ? 24 : 10);
            if (b.kind === 'QueenChamber') {
              this.cameras.main.shake(340, 0.012);
              this.cameras.main.flash(180, 255, 230, 160);
              // Brief zoom punch: scale up the board container then
              // ease back. Uses the existing boardContainer transform
              // (layout() reads .x/.y/.scaleX) so no layout math breaks.
              const baseScale = this.boardContainer.scaleX || 1;
              this.tweens.add({
                targets: this.boardContainer,
                scaleX: baseScale * 1.08,
                scaleY: baseScale * 1.08,
                duration: 160,
                yoyo: true,
                ease: 'Sine.easeOut',
              });
            } else {
              this.cameras.main.shake(120, 0.004);
            }
            // Floating loot text for buildings that drop resources on
            // kill. Pulled from BUILDING_STATS via the sim-side loot
            // accumulators — we read the delta since the last frame.
            const bstats = Sim.BUILDING_STATS[b.kind];
            if (bstats.dropsSugarOnDestroy > 0 || bstats.dropsLeafBitsOnDestroy > 0) {
              this.spawnLootPopup(
                centerX,
                centerY - 16,
                bstats.dropsSugarOnDestroy,
                bstats.dropsLeafBitsOnDestroy,
              );
            }
          }
        }
        bar.clear();
        continue;
      }
      // Hit flash: tint the sprite briefly white-hot the frame a
      // building's hp drops. Compare to the previous tick to catch
      // the transition; store hp in a side Map so we don't leak fields
      // onto sim state.
      const prevHp = this.buildingLastHp.get(b.id) ?? b.hp;
      if (b.hp < prevHp) {
        spr.setTint(0xffe799);
        this.time.delayedCall(70, () => spr.clearTint());
      }
      this.buildingLastHp.set(b.id, b.hp);
      const hpFrac = Math.max(0, Math.min(1, b.hp / b.hpMax));
      const barX = b.anchorX * TILE + (b.w * TILE) / 2 - 22;
      const barY = b.anchorY * TILE - 10;
      bar.clear();
      bar.fillStyle(0x1a1208, 0.7);
      bar.fillRoundedRect(barX, barY, 44, 6, 2);
      bar.fillStyle(hpFrac > 0.5 ? 0x5ba445 : hpFrac > 0.2 ? 0xf2d06b : 0xd94c4c, 1);
      bar.fillRoundedRect(barX + 1, barY + 1, 42 * hpFrac, 4, 2);
    }

    // Units: sync sprites to sim positions; puff the shared trail emitter.
    const alive = new Set<number>();
    for (const u of this.state.units) {
      alive.add(u.id);
      let spr = this.unitSprites.get(u.id);
      const x = Sim.toFloat(u.x) * TILE;
      const y = Sim.toFloat(u.y) * TILE;
      if (!spr) {
        spr = this.makeUnitSprite(u.kind, x, y);
        this.boardContainer.add(spr);
        this.unitSprites.set(u.id, spr);
        // Entry animation: only animate attacker units sliding in from their
        // spawn edge. Defender units (spawned by buildings) don't animate.
        if (u.owner === 0) {
          const key = `${this.state.tick}:0`;
          const staggerIndex = this.deploymentUnitCounts.get(key) ?? 0;
          this.deploymentUnitCounts.set(key, staggerIndex + 1);
          this.applyUnitEntryAnimation(spr, u, x, y, staggerIndex);
        }
      } else {
        spr.setPosition(x, y);
      }

      // Movement-gated animation. For walk-cycle Sprites (not plain
      // Images), play the animation only while the unit has actually
      // moved since last render; freeze on frame 0 when it's stopped
      // (attacking, waiting on a turret, pathing stalled). Plain
      // Images stay unaffected — their "idle" IS their default look.
      //
      // The tracking map only holds entries for Sprite units, and
      // the per-unit position record is mutated in place each frame
      // instead of re-allocated, so the loop adds zero per-frame
      // garbage for the non-animated majority and one insertion per
      // animated unit over the unit's lifetime.
      if (spr instanceof Phaser.GameObjects.Sprite) {
        const prev = this.unitLastPos.get(u.id);
        const MOVE_EPSILON = 0.15;
        const moving =
          !prev ||
          Math.abs(x - prev.x) > MOVE_EPSILON ||
          Math.abs(y - prev.y) > MOVE_EPSILON;
        if (moving) {
          if (!spr.anims.isPlaying) {
            const animKey = `walk-${u.kind}`;
            if (this.anims.exists(animKey)) spr.play(animKey);
          }
        } else if (spr.anims.isPlaying) {
          spr.anims.pause();
          spr.setFrame(0);
        }
        if (prev) {
          prev.x = x;
          prev.y = y;
        } else {
          this.unitLastPos.set(u.id, { x, y });
        }
      }
      const hpFrac = Math.max(0, Math.min(1, u.hp / u.hpMax));
      spr.setAlpha(0.35 + 0.65 * hpFrac);
      // Hit flash for units — same logic as buildings, keyed on a
      // side Map of last-seen hp. Cheap: one Map lookup + one
      // comparison per live unit per frame.
      const prevHp = this.unitLastHp.get(u.id) ?? u.hp;
      if (u.hp < prevHp && u.hp > 0) {
        spr.setTint(0xffe0c0);
        this.time.delayedCall(60, () => {
          // The sprite might be gone by the time the delayed call fires
          // if the unit died within 60ms of the hit; guard before touch.
          if (this.unitSprites.get(u.id) === spr) spr.clearTint();
        });
      }
      this.unitLastHp.set(u.id, u.hp);
      // Emit one tiny pheromone puff at the unit's feet every ~5 frames.
      // Rate-limited implicitly by the alternating (id % 5 === tick % 5)
      // check so we don't drown in particles with a full swarm.
      if ((u.id + this.state.tick) % 5 === 0) {
        this.trailEmitter.emitParticle(1, x, y + 4);
      }
    }
    for (const [id, spr] of this.unitSprites) {
      if (!alive.has(id)) {
        // Unit death burst: small puff at last-known sprite position.
        this.spawnDebrisBurst(spr.x, spr.y, 6);
        spr.destroy();
        this.unitSprites.delete(id);
        this.unitLastHp.delete(id);
        this.unitLastPos.delete(id);
      }
    }
  }

  // Small debris / hit-burst emitter. Reuses the trail-dot texture so
  // we don't pay for a second atlas key. Called on kills (unit or
  // building) to give a satisfying pop at the kill site.
  private spawnDebrisBurst(x: number, y: number, quantity: number): void {
    this.trailEmitter.emitParticle(quantity, x, y);
  }

  // Confetti burst for the victory card. Spawns ~24 small colored
  // rectangles along the top of the card, each tweened downward
  // with gravity-ish falloff and a soft alpha fade. Pure Phaser;
  // no particle manager so there's nothing to clean up between
  // raids. Colors are drawn from the theme palette so it matches
  // the rest of the game rather than looking generic.
  private emitConfetti(centerY: number): void {
    const colors = [0xffd98a, 0xf7edd0, 0x83c76b, 0x5ba445, 0xffc44d, 0xd94c4c];
    for (let i = 0; i < 28; i++) {
      const color = colors[i % colors.length]!;
      const x = this.scale.width / 2 + (Math.random() - 0.5) * this.scale.width * 0.7;
      const y = centerY - 20 + Math.random() * 16;
      const size = 5 + Math.random() * 5;
      const dot = this.add
        .rectangle(x, y, size, size * 1.5, color, 1)
        .setRotation(Math.random() * Math.PI)
        .setDepth(DEPTHS.resultContent)
        .setScrollFactor(0);
      const fallDistance = 220 + Math.random() * 200;
      const horizontal = (Math.random() - 0.5) * 120;
      this.tweens.add({
        targets: dot,
        y: y + fallDistance,
        x: x + horizontal,
        alpha: { from: 1, to: 0 },
        rotation: dot.rotation + (Math.random() - 0.5) * Math.PI * 3,
        duration: 1400 + Math.random() * 600,
        ease: 'Cubic.easeIn',
        onComplete: () => dot.destroy(),
      });
    }
  }

  // Floating "+N sugar / +M leaf" popup at a kill location. Rises,
  // fades, and auto-destroys so repeated kills don't leak DOM/objects.
  private spawnLootPopup(x: number, y: number, sugar: number, leaf: number): void {
    const parts: string[] = [];
    if (sugar > 0) parts.push(`+${sugar}🍬`);
    if (leaf > 0) parts.push(`+${leaf}🍃`);
    if (parts.length === 0) return;
    const text = this.add
      .text(x, y, parts.join(' '), {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#ffd98a',
        stroke: '#1a1208',
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(DEPTHS.raidHudLabel);
    this.boardContainer.add(text);
    this.tweens.add({
      targets: text,
      y: y - 36,
      alpha: { from: 1, to: 0 },
      duration: 900,
      ease: 'Sine.easeOut',
      onComplete: () => text.destroy(),
    });
  }

  private spawnDeployPopup(x: number, y: number, label: string, count: number): void {
    const text = this.add
      .text(x, y, `+${count} ${label}`, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#c3e8b0',
        stroke: '#1a1208',
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(DEPTHS.raidHudLabel);
    this.boardContainer.add(text);
    this.tweens.add({
      targets: text,
      y: y - 24,
      alpha: { from: 1, to: 0 },
      duration: 700,
      ease: 'Sine.easeOut',
      onComplete: () => text.destroy(),
    });
  }

  private currentStars(): 0 | 1 | 2 | 3 {
    let total = 0;
    let destroyed = 0;
    let queenDead = false;
    for (const b of this.state.buildings) {
      total++;
      if (b.hp <= 0) {
        destroyed++;
        if (b.kind === 'QueenChamber') queenDead = true;
      }
    }
    const pct = total === 0 ? 0 : destroyed / total;
    return queenDead && pct >= 0.9 ? 3 : queenDead || pct >= 0.5 ? 2 : pct > 0 ? 1 : 0;
  }

  private applyUnitEntryAnimation(
    spr: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite,
    u: Types.Unit,
    targetX: number,
    targetY: number,
    staggerIndex: number = 0,
  ): void {
    // Determine spawn edge from the unit's path to support Replay mode
    // and ensure correctness if frames are dropped.
    const path = this.state.paths.find((p) => p.pathId === u.pathId);
    const firstPoint = path?.points[0];
    let edge: SpawnEdge | null = null;
    if (firstPoint) {
      const px = Sim.toFloat(firstPoint.x) * TILE;
      const py = Sim.toFloat(firstPoint.y) * TILE;
      if (px <= SPAWN_ZONE_W) edge = 'left';
      else if (py <= SPAWN_ZONE_H) edge = 'top';
      else if (py >= BOARD_H - SPAWN_ZONE_H) edge = 'bottom';
    }
    // Fall back to lastSpawnEdge if path point is ambiguous.
    edge = edge ?? this.lastSpawnEdge;
    if (!edge) return;

    // Calculate starting position off-screen based on spawn edge.
    // Units slide in from ~2 tiles away (SPAWN_ZONE_W/H) in the direction
    // they entered.
    let startX = targetX;
    let startY = targetY;
    const offset = SPAWN_ZONE_W; // Same as spawn zone width

    switch (edge) {
      case 'left':
        startX = targetX - offset;
        break;
      case 'top':
        startY = targetY - SPAWN_ZONE_H;
        break;
      case 'bottom':
        startY = targetY + SPAWN_ZONE_H;
        break;
    }

    // Start the sprite at the off-screen position.
    spr.setPosition(startX, startY);

    // Burst staggering: delay animation based on unit index in the deployment.
    // With 40ms stagger and max 5 units per burst, wave effect spans ~160ms.
    const STAGGER_MS = 40;
    const delay = staggerIndex * STAGGER_MS;

    // Tween to the actual position over 300ms with Power2.easeOut for
    // a snappy, satisfying entry feel. Matches Clash of Clans troop
    // deployment animation style. Delay is staggered for wave effect.
    this.tweens.add({
      targets: spr,
      x: targetX,
      y: targetY,
      duration: 300,
      delay,
      ease: 'Power2.easeOut',
    });
  }

  // Pulls a real opponent from /api/match. If the attacker has no
  // authenticated session or the API 503s, we quietly stay on the bot
  // base the scene already booted with — raid still plays.
  private async fetchMatchFromServer(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const match = await runtime.api.requestMatch(
        runtime.player?.player.trophies ?? 100,
      );
      // Race guard: if the player already started committing inputs
      // against the fallback bot base before this response arrived,
      // swapping the sim state mid-raid would corrupt the replay
      // (matchToken would point at one base, inputs collected against
      // another). Keep the bot fight and let the raid run its course
      // — the only cost is the match token becomes an unused
      // pending_matches row that expires in 15 min.
      if (this.raidInputs.length > 0 || this.isDrawing || this.submitted) {
        return;
      }
      this.matchContext = match;
      // Rebuild sim against the real opponent's snapshot. Carry the
      // attacker unit-level table forward so the client sim produces
      // the same hash the server will when it re-runs.
      const attackerUnitLevels = (runtime?.player?.player.unitLevels ?? undefined) as
        | Record<string, number>
        | undefined;
      this.cfg = {
        tickRate: 30,
        maxTicks: TICK_HZ * RAID_SECONDS,
        initialSnapshot: match.baseSnapshot,
        seed: match.seed,
        ...(attackerUnitLevels ? { attackerUnitLevels } : {}),
      };
      this.state = Sim.createInitialState(this.cfg);
      // Re-render buildings from the new state. Wipe the board of the
      // stale bot sprites first.
      for (const spr of this.buildingSprites.values()) spr.destroy();
      this.buildingSprites.clear();
      for (const bar of this.buildingHpBars.values()) bar.destroy();
      this.buildingHpBars.clear();
      for (const lbl of this.buildingRoleLabels.values()) lbl.destroy();
      this.buildingRoleLabels.clear();
      // Juice-pass side maps share the same per-raid lifecycle.
      this.buildingLastHp.clear();
      this.buildingKillPlayed.clear();
      this.drawBuildingsFromState();
      this.add
        .text(this.scale.width / 2, 4, `vs ${match.opponent.displayName}`, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '12px',
          color: match.opponent.isBot ? '#c3e8b0' : '#ffd98a',
        })
        .setOrigin(0.5, 0)
        .setDepth(DEPTHS.raidHudValue);
    } catch (err) {
      // Non-fatal — keep the hard-coded bot.
      console.warn('match fetch failed, staying on bot:', err);
    }
  }

  // Submit the full raid replay to the server. Server re-runs the sim
  // authoritatively, persists to the `raids` table, and returns the
  // player's new resource totals. We patch those into runtime.player so
  // HomeScene shows the updated numbers when the scene re-enters.
  private async submitToServer(): Promise<void> {
    if (this.submitted) return;
    this.submitted = true;
    // Replay-mode raids skip submission entirely — the sim already ran
    // with canned inputs and no real raid is being performed.
    if (this.replayContext) return;
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime || !this.matchContext) return;
    try {
      const res = await runtime.api.submitRaid({
        matchToken: this.matchContext.matchToken,
        inputs: this.raidInputs,
        clientResultHash: Sim.hashToHex(Sim.hashSimState(this.state)),
      });
      if (runtime.player) {
        runtime.player.player.trophies = res.player.trophies;
        runtime.player.player.sugar = res.player.sugar;
        runtime.player.player.leafBits = res.player.leafBits;
        runtime.player.player.aphidMilk = res.player.aphidMilk;
      }
      this.replayName = res.replayName ?? null;
      if (this.replayNameText && this.replayName) {
        this.replayNameText.setText(`"${this.replayName}"`);
      }
      // Surface the colony-rank cap hint when the server clamped the
      // payout. The result panel's loot text was set ahead of submit
      // from the unclamped sim totals; replace it with the actual
      // banked numbers so the player isn't misled about their wallet
      // gain. If the cap fired, append a one-liner explaining why.
      if (res.loot && this.lootText) {
        const capLine = res.loot.capped
          ? ` (cap @ rank ${res.loot.colonyRank})`
          : '';
        this.lootText.setText(
          `loot: ${res.loot.sugar} sugar · ${res.loot.leafBits} leaf${capLine}`,
        );
      }

      // Secondary submits: war attack, campaign mission. Best-effort —
      // a failure here doesn't invalidate the primary raid result.
      const stars = this.currentStars();
      if (this.warContext && stars >= 0) {
        runtime.api
          .warSubmitAttack({
            defenderPlayerId: this.warContext.defenderId,
            stars,
          })
          .catch((err) => console.warn('war attack submit failed:', err));
      }
      if (this.campaignContext && this.state.outcome === 'attackerWin' && stars >= 1) {
        runtime.api
          .completeMission(this.campaignContext.missionId)
          .catch((err) => console.warn('campaign submit failed:', err));
      }
    } catch (err) {
      // Showing an error would steal focus from the result screen;
      // log and move on — the local result is already displayed.
      console.warn('raid submit failed:', err);
    }
  }

  // Replay playback: queue every stored input into the pending queue
  // so the normal run loop consumes them at the right ticks. The
  // standard sim step will do the rest.
  private bootReplayPlayback(): void {
    if (!this.replayContext) return;
    this.pendingInputs = [...this.replayContext.inputs];
    this.started = true;
    this.add
      .text(this.scale.width / 2, 4, `Replay: ${this.replayContext.replayName}`, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
        color: '#ffd98a',
      })
      .setOrigin(0.5, 0)
      .setDepth(DEPTHS.raidHudValue);

    // Replay control strip — pause/play + 1×/2×/4× speed. The sim
    // is deterministic and runs off pendingInputs, so "speed" is
    // just a multiplier on how many sim ticks we advance per render
    // frame; "pause" is a boolean the update loop reads before
    // stepping. Both pieces are read by the run loop below.
    this.replayControls = this.add.container(0, 0).setDepth(DEPTHS.raidHudValue);
    const barY = this.scale.height - 52;
    const center = this.scale.width / 2;
    const pauseBtn = makeHiveButton(this, {
      x: center - 96,
      y: barY,
      width: 80,
      height: 32,
      label: '❚❚ Pause',
      variant: 'ghost',
      fontSize: 11,
      onPress: () => {
        this.replayPaused = !this.replayPaused;
        pauseBtn.setLabel(this.replayPaused ? '▶ Play' : '❚❚ Pause');
      },
    });
    this.replayControls.add(pauseBtn.container);
    const speeds: Array<1 | 2 | 4> = [1, 2, 4];
    speeds.forEach((s, i) => {
      const btn = makeHiveButton(this, {
        x: center + 10 + i * 60,
        y: barY,
        width: 50,
        height: 32,
        label: `${s}×`,
        variant: this.replaySpeed === s ? 'primary' : 'ghost',
        fontSize: 11,
        onPress: () => {
          this.replaySpeed = s;
          // Cheapest way to refresh the variant highlight is a re-
          // render of the control strip.
          this.replayControls?.destroy(true);
          this.replayControls = null;
          this.bootReplayPlayback();
        },
      });
      this.replayControls?.add(btn.container);
    });
  }
  private replayPaused = false;
  private replaySpeed: 1 | 2 | 4 = 1;
  private replayControls: Phaser.GameObjects.Container | null = null;

  private showResult(): void {
    if (this.resultShown) return;
    this.resultShown = true;
    // Fire-and-forget the server submission. The result card renders
    // immediately; loot/trophies in the HUD will reflect on return
    // to HomeScene either way.
    void this.submitToServer();

    const stars = this.currentStars();

    // Card is a bit taller on wins to accommodate the Share button.
    // Width clamps to the viewport (minus a 16 px margin each side) so
    // the card never bleeds off ultra-narrow phones. On normal widths
    // this is a no-op — min(400, viewport-32) is still 400.
    const isWin = this.state.outcome === 'attackerWin' && stars > 0;
    const cardW = Math.min(400, this.scale.width - 32);
    const cardH = isWin ? 290 : 240;
    const card = this.add.graphics().setDepth(DEPTHS.resultCard);
    const cx = (this.scale.width - cardW) / 2;
    const cy = (this.scale.height - cardH) / 2;
    // Dim backdrop behind the card so the outcome commands the eye.
    // Single fill at 0.865 alpha matches the double-overlay dim the
    // old code produced (1 - (1-0.7)(1-0.55) ≈ 0.865) without the
    // extra Graphics object.
    const backdrop = this.add.graphics().setDepth(DEPTHS.resultBackdrop);
    backdrop.fillStyle(0x000000, 0.865);
    backdrop.fillRect(0, 0, this.scale.width, this.scale.height);
    // CoC-style card: gradient fill, thick brass stroke, drop shadow.
    card.fillStyle(0x000000, 0.5);
    card.fillRoundedRect(cx + 3, cy + 6, cardW, cardH, 18);
    card.fillGradientStyle(
      COLOR.bgPanelHi,
      COLOR.bgPanelHi,
      COLOR.bgPanelLo,
      COLOR.bgPanelLo,
      1,
    );
    card.fillRoundedRect(cx, cy, cardW, cardH, 18);
    card.lineStyle(5, COLOR.brassDeep, 1);
    card.strokeRoundedRect(cx, cy, cardW, cardH, 18);
    card.lineStyle(1.5, COLOR.brass, 0.85);
    card.strokeRoundedRect(cx + 4, cy + 4, cardW - 8, cardH - 8, 14);

    const heading = isWin ? 'Raid Successful!' : 'Raid Failed';
    this.add
      .text(
        this.scale.width / 2,
        cy + 38,
        heading,
        displayTextStyle(24, isWin ? COLOR.textGold : '#ffb0a0', 4),
      )
      .setOrigin(0.5)
      .setDepth(DEPTHS.resultContent);

    // Poetic replay name (server stamps it at /raid/submit). The
    // request is fire-and-forget on the result card, so we render an
    // empty placeholder and patch it in once the name arrives.
    if (isWin) {
      this.replayNameText = this.add
        .text(
          this.scale.width / 2,
          cy + 62,
          this.replayName ? `"${this.replayName}"` : '',
          displayTextStyle(13, COLOR.textDim, 2),
        )
        .setOrigin(0.5)
        .setDepth(DEPTHS.resultContent);
    }

    this.add
      .text(
        this.scale.width / 2,
        cy + 84,
        '★'.repeat(stars) + '☆'.repeat(3 - stars),
        displayTextStyle(36, COLOR.textGold, 4),
      )
      .setOrigin(0.5)
      .setDepth(DEPTHS.resultContent);

    // Loot line. On wins the numbers animate up from zero so the
    // player feels the coin-drop. On losses we show the final
    // (usually zero) totals immediately.
    const lootText = this.add
      .text(
        this.scale.width / 2,
        cy + 130,
        isWin
          ? `0 sugar · 0 leaf`
          : `${this.state.attackerSugarLooted} sugar · ${this.state.attackerLeafBitsLooted} leaf`,
        displayTextStyle(15, isWin ? COLOR.textGold : COLOR.textDim, 3),
      )
      .setOrigin(0.5)
      .setDepth(DEPTHS.resultContent);
    if (isWin) {
      const tally = { sugar: 0, leaf: 0 };
      this.tweens.add({
        targets: tally,
        sugar: this.state.attackerSugarLooted,
        leaf: this.state.attackerLeafBitsLooted,
        duration: 900,
        ease: 'Cubic.easeOut',
        onUpdate: () => {
          lootText.setText(
            `${Math.round(tally.sugar)} sugar · ${Math.round(tally.leaf)} leaf`,
          );
        },
      });
    }

    // "NEW BEST" ribbon when this raid exceeds the player's tracked
    // personal best for single-raid sugar loot. Written after every
    // win so it always reflects the best they've ever done.
    if (isWin) {
      const PB_KEY = 'hive.bestRaidSugar';
      let prev = 0;
      try { prev = Number(localStorage.getItem(PB_KEY) ?? '0') || 0; } catch { /* ignore */ }
      if (this.state.attackerSugarLooted > prev) {
        try { localStorage.setItem(PB_KEY, String(this.state.attackerSugarLooted)); } catch { /* ignore */ }
        const ribbon = this.add
          .text(
            this.scale.width / 2,
            cy + 162,
            '★  NEW BEST  ★',
            displayTextStyle(12, '#ffe7b0', 3),
          )
          .setOrigin(0.5)
          .setDepth(DEPTHS.resultContent)
          .setAlpha(0);
        this.tweens.add({
          targets: ribbon,
          alpha: 1,
          scale: { from: 0.6, to: 1 },
          duration: 380,
          delay: 900,
          ease: 'Back.easeOut',
        });
      }
    }

    // Audio sting + confetti burst. Confetti uses the existing
    // trailEmitter's spare capacity so we don't add a second particle
    // manager; a handful of colored dots at the top-center of the
    // screen is the whole effect — cheap but it transforms the "a
    // modal appeared" moment into a celebration.
    if (isWin) {
      sfxVictory();
      this.emitConfetti(cy - 8);
    } else {
      sfxDefeat();
    }

    const actionsY = isWin ? cy + 220 : cy + 170;

    // Replace the old Text-backed buttons with our shared beveled
    // buttons so the result modal matches the rest of the UI. On a
    // win we render two side-by-side; on a loss the single "back"
    // button centers. Widths scale with the card so the pair stays
    // inside the card rather than overflowing on narrow phones —
    // previously these were hard-wired to 180 px at ±100 from center,
    // which overlapped badly at ≤400 px viewports.
    const innerW = cardW - 32;
    const btnW = isWin ? Math.min(180, Math.floor((innerW - 12) / 2)) : Math.min(220, innerW);
    const split = isWin ? btnW / 2 + 6 : 0;
    makeHiveButton(this, {
      x: this.scale.width / 2 - split,
      y: actionsY,
      width: btnW,
      height: 46,
      label: 'Back to home',
      variant: 'secondary',
      fontSize: 15,
      onPress: () => fadeToScene(this, 'HomeScene'),
    }).container.setDepth(DEPTHS.resultContent);

    if (isWin) {
      makeHiveButton(this, {
        x: this.scale.width / 2 + split,
        y: actionsY,
        width: btnW,
        height: 46,
        label: '📣 Share',
        variant: 'primary',
        fontSize: 15,
        onPress: () => void this.shareOutcome(stars),
      }).container.setDepth(DEPTHS.resultContent);
    }
  }

  // Fire-and-forget share. Web Share API → clipboard. On clipboard copy
  // we flash a toast so the user knows something happened (the OS share
  // sheet provides its own confirmation).
  private async shareOutcome(stars: 0 | 1 | 2 | 3): Promise<void> {
    const opponent = this.matchContext?.opponent.displayName ?? 'a rival hive';
    // Pull the poetic name the server stamped on the replay. Falls
    // back to plain-text when the response hasn't settled yet.
    const namePrefix = this.replayName ? `"${this.replayName}" — ` : '';
    const text =
      `${namePrefix}${'★'.repeat(stars)} Raided ${opponent} in Hive Wars! ` +
      `${this.state.attackerSugarLooted} sugar + ${this.state.attackerLeafBitsLooted} leaf looted.`;
    try {
      const mode = await shareOutcomeTransport({ text });
      // User may have tapped Back-to-home while the share sheet was up;
      // touching a torn-down scene would throw.
      if (!this.scene.isActive()) return;
      if (mode === 'clipboard') this.flashShareToast('Copied to clipboard');
      else if (mode === 'unavailable')
        this.flashShareToast('Share unavailable here');
    } catch (err) {
      console.warn('share failed', err);
      if (this.scene.isActive()) this.flashShareToast('Share failed');
    }
  }

  private flashShareToast(msg: string): void {
    const container = this.add
      .container(this.scale.width / 2, this.scale.height - 40)
      .setDepth(DEPTHS.toast);
    const t = this.add
      .text(0, 0, msg, {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#0f1b10',
        backgroundColor: '#ffd98a',
        padding: { left: 10, right: 10, top: 6, bottom: 6 },
      })
      .setOrigin(0.5);
    container.add(t);
    container.setSize(t.width, t.height).setInteractive({ useHandCursor: true });
    container.on('pointerdown', () => {
      this.tweens.killTweensOf(container);
      container.destroy();
    });
    this.tweens.add({
      targets: container,
      alpha: { from: 1, to: 0 },
      delay: 1600,
      duration: 400,
      onComplete: () => container.destroy(),
    });
  }

  private layout(): void {
    // Mobile-aware board sizing. Reserve HUD + modifier bar + deck,
    // scale board to fit the remaining rectangle, center with padding.
    // Everything else (units, buildings, trail graphics) lives inside
    // the container so they scale together; pointer math unscales.
    const deckLayout = this.deckLayoutMetrics();
    const availW = this.scale.width - 24;
    const availH = this.scale.height - HUD_H - MODIFIER_BAR_H - deckLayout.trayHeight - 40;
    const scale = Math.min(availW / BOARD_W, availH / BOARD_H, 1);
    this.boardContainer.setScale(scale);
    const scaledW = BOARD_W * scale;
    const scaledH = BOARD_H * scale;
    const xOffset = Math.max(12, (this.scale.width - scaledW) / 2);
    const yOffset = HUD_H + MODIFIER_BAR_H + Math.max(8, (availH - scaledH) / 2);
    this.boardContainer.setPosition(xOffset, yOffset);

    // Modifier bar — positioned between HUD and the board. Re-paint
    // its background each layout in case scale.width changed.
    if (this.modifierBar) {
      // Bar contents: 4 modifier buttons (96 wide), 2 action buttons (110 wide)
      // with gaps. Re-center the whole strip on every layout pass so it
      // tracks viewport resizes.
      const groupW = 4 * 96 + 3 * 6 + 8 + 110 + 8 + 110;
      const startX = Math.max(12, (this.scale.width - groupW) / 2);
      this.modifierBar.setPosition(startX, HUD_H + 6);
      const bg = (this.modifierBar as Phaser.GameObjects.Container & {
        _bg?: Phaser.GameObjects.Graphics;
      })._bg;
      if (bg) {
        bg.clear();
        bg.fillStyle(0x0a120b, 0.6);
        bg.fillRoundedRect(-12, -4, groupW + 24, 40, 10);
      }
    }
    this.starsText.setX(this.scale.width - 16);
    this.lootText.setX(this.scale.width - 16);
    this.timerText.setX(this.scale.width / 2);

    const trayTop = this.scale.height - deckLayout.trayHeight - 12;
    this.deckTrayBg.clear();
    drawPanel(this.deckTrayBg, 12, trayTop, this.scale.width - 24, deckLayout.trayHeight, {
      topColor: 0x182319,
      botColor: 0x09120a,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.16,
      radius: 16,
      shadowOffset: 5,
      shadowAlpha: 0.42,
    });
    this.deckTrayBg.fillStyle(COLOR.brass, 0.18);
    this.deckTrayBg.fillRect(28, trayTop + 44, this.scale.width - 56, 2);
    drawPill(
      this.deckTrayBg,
      this.scale.width / 2 - 178,
      trayTop + 10,
      44,
      36,
      { brass: true },
    );

    this.deckSelectedIcon.setPosition(this.scale.width / 2 - 154, trayTop + 28);
    this.deckSelectedText
      .setWordWrapWidth(220)
      .setPosition(this.scale.width / 2 + 12, trayTop + 10);
    this.deckUnitCountText
      .setPosition(this.scale.width / 2 + 82, trayTop + 24);
    this.deckHintText
      .setWordWrapWidth(this.scale.width - 56)
      .setPosition(this.scale.width / 2, trayTop + 28);
    this.deckUnlockText
      .setWordWrapWidth(this.scale.width - 56)
      .setPosition(this.scale.width / 2, trayTop + 44);

    const rowHeight = DECK_CARD_H * deckLayout.scale;
    this.deckCardScale = deckLayout.scale;
    const rowGap = DECK_GRID_GAP;
    const gridTop = trayTop + 72;
    for (let row = 0; row < deckLayout.rows; row++) {
      const rowStartIndex = row * deckLayout.cols;
      const rowCount = Math.min(
        deckLayout.cols,
        Math.max(0, this.deckEntries.length - rowStartIndex),
      );
      if (rowCount <= 0) continue;
      const rowWidth =
        rowCount * DECK_CARD_W * deckLayout.scale +
        Math.max(0, rowCount - 1) * DECK_GRID_GAP;
      const rowStartX = (this.scale.width - rowWidth) / 2 + (DECK_CARD_W * deckLayout.scale) / 2;
      for (let col = 0; col < rowCount; col++) {
        const index = rowStartIndex + col;
        const container = this.deckContainers[index];
        if (!container) continue;
        container.setScale(deckLayout.scale);
        container.setPosition(
          rowStartX + col * (DECK_CARD_W * deckLayout.scale + DECK_GRID_GAP),
          gridTop + row * (rowHeight + rowGap) + rowHeight / 2,
        );
      }
    }
  }
}
