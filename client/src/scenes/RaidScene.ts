import Phaser from 'phaser';
import { Sim, Types } from '@hive/shared';
import { bakeTrailDot } from '../assets/placeholders.js';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { ANIMATED_UNIT_KINDS } from '../assets/atlas.js';
import { makeHiveButton } from '../ui/button.js';
import {
  sfxVictory, sfxDefeat,
  sfxDeploy, sfxDig, sfxAmbush, sfxSplit,
  sfxModifierTick, sfxBuildingHit, sfxBuildingDestroyed,
  sfxQueenDestroyed, sfxUnitDeath,
} from '../ui/audio.js';
import { shareOutcome as shareOutcomeTransport } from '../net/share.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { COLOR, DEPTHS, bodyTextStyle, displayTextStyle, labelTextStyle } from '../ui/theme.js';
import { showCoachmark, type CoachmarkHandle } from '../ui/coachmark.js';
import { haptic } from '../ui/haptics.js';
import { openUnitInfoModal } from '../ui/unitInfoModal.js';
import { buildTacticShareUrl, TACTICS_STORAGE_KEY, TACTICS_LIMIT } from '../codex/tacticShare.js';
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

type SpawnEdge = 'left' | 'top' | 'bottom' | 'right';

interface DeckEntry {
  kind: Types.UnitKind;
  count: number;
  icon: string;
  label: string;
  // Hero variant of a deck slot (PR D). When set, deploying this
  // entry spawns a hero unit (HERO_STATS_FIXED, aura buff) and the
  // card renders with a gold border so it reads as legendary. The
  // `kind` field stays a regular UnitKind sentinel so existing deck
  // code that keys off of `kind` still functions; sim deploy
  // checks heroKind first.
  heroKind?: Types.HeroKind;
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

// TACTICS_STORAGE_KEY + TACTICS_LIMIT now live in
// ../codex/tacticShare.ts so this file, main.ts, and any future
// writer share one source of truth. Imported above.
// First-run drill flag. Bumped whenever the drill steps change in a
// way that's worth re-teaching (e.g., adding a fourth step). Until
// the player completes the full drill, we re-show the coachmarks
// every time they enter RaidScene — that way a player who bails on
// step 1 still gets coached on the next attempt.
//
// v2 — drill expanded to teach split / ambush / dig as three discrete
// steps with mechanic explanations (the v1 drill only halo'd "Dig"
// once). Bumping the key replays the new walkthrough for everyone.
const COACHMARK_DONE_KEY = 'hive:coachmarks:raid:v2';

function shouldShowRaidCoachmarks(): boolean {
  try {
    return localStorage.getItem(COACHMARK_DONE_KEY) !== '1';
  } catch {
    return false; // private mode: don't nag
  }
}

function markRaidCoachmarksDone(): void {
  try {
    localStorage.setItem(COACHMARK_DONE_KEY, '1');
  } catch { /* ignore */ }
}
// Per-tactic point cap — matches the live-draw cap in pointermove. A
// tactic the player draws can't exceed it; any larger stored polyline
// is treated as malformed (corrupted localStorage) and dropped.
const TACTIC_POINTS_LIMIT = 32;

// Modifier bar layout dimensions — used by drawModifierBar() and
// layout() so both stay in sync. Changing the button width / gap in
// one place ripples through to the other automatically.
const MODIFIER_BAR_H = 44;
const MOD_BTN_W = 96;
const MOD_BTN_H = 32;
const MOD_BTN_GAP = 6;
const MOD_ACTION_BTN_W = 110;
const MOD_ACTION_GAP = 8;
const MODIFIER_KINDS: Array<Types.PathModifierKind | 'none'> = ['none', 'split', 'ambush', 'dig'];

function isValidPoint(v: unknown): v is { x: number; y: number } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { x: unknown }).x === 'number' &&
    typeof (v as { y: unknown }).y === 'number' &&
    Number.isFinite((v as { x: number }).x) &&
    Number.isFinite((v as { y: number }).y)
  );
}

function isValidTactic(t: unknown): t is SavedTactic {
  if (typeof t !== 'object' || t === null) return false;
  const r = t as Partial<SavedTactic>;
  if (typeof r.name !== 'string') return false;
  if (typeof r.unitKind !== 'string') return false;
  if (!Array.isArray(r.pointsTile)) return false;
  if (r.pointsTile.length < 2) return false;
  if (r.pointsTile.length > TACTIC_POINTS_LIMIT) return false;
  if (!r.pointsTile.every(isValidPoint)) return false;
  if (
    r.spawnEdge !== 'left' &&
    r.spawnEdge !== 'top' &&
    r.spawnEdge !== 'bottom' &&
    r.spawnEdge !== 'right'
  )
    return false;
  if (r.modifier !== undefined) {
    const m = r.modifier as Partial<Types.PathModifier>;
    if (typeof m !== 'object' || m === null) return false;
    if (m.kind !== 'split' && m.kind !== 'ambush' && m.kind !== 'dig') return false;
    if (typeof m.pointIndex !== 'number') return false;
    if (m.pointIndex < 0 || m.pointIndex >= r.pointsTile.length) return false;
  }
  return true;
}

function loadSavedTactics(): SavedTactic[] {
  try {
    const raw = localStorage.getItem(TACTICS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Strict schema check — anything malformed is dropped silently so
    // a corrupted localStorage entry can't crash the scene during
    // deployTactic. Cap to TACTICS_LIMIT to bound panel size.
    const valid = parsed.filter(isValidTactic);
    return valid.slice(0, TACTICS_LIMIT);
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

// Coachmark copy for the three modifiers. Plain-language explanation
// of what the marker actually does in-sim — these mechanics aren't
// otherwise surfaced in the UI, so the tutorial is the only place a
// new player learns the difference between an ambush and a split.
const MODIFIER_TUTORIAL: Record<
  'split' | 'ambush' | 'dig',
  { title: string; body: string }
> = {
  split: {
    title: 'Try Split',
    body:
      'Half your swarm peels off at the marker to hit the nearest building; the other half keeps walking. Great for chipping a turret while the rest reaches the Queen.',
  },
  ambush: {
    title: 'Try Ambush',
    body:
      'Units pause for ~2 seconds at the marker. Use it to stagger waves so the second burst arrives just as defences trigger their reload.',
  },
  dig: {
    title: 'Try Dig',
    body:
      'Diggers and termites flip layer at the marker — slip past surface walls into the underground or pop up behind a turret line. The dual-layer hook only triggers on dig-capable units.',
  },
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

// Sentinel UnitKind used by hero deck entries. The sim's deploy
// system checks heroKind FIRST and never reads UNIT_STATS for hero
// units, so the sentinel is purely a structural placeholder for
// type-erased deck-pickling code that keys off `kind`.
const HERO_DECK_SENTINEL_KIND: Types.UnitKind = 'SoldierAnt';

// Hero icon mapping — matches the spriteKeys registered in
// client/src/assets/atlas.ts (HERO_SPRITE_KEYS).
const HERO_ICON: Record<Types.HeroKind, string> = {
  Mantis: 'hero-Mantis',
  HerculesBeetle: 'hero-HerculesBeetle',
  WaspQueen: 'hero-WaspQueen',
  StagBeetle: 'hero-StagBeetle',
};

const HERO_LABEL: Record<Types.HeroKind, string> = {
  Mantis: 'Mantis',
  HerculesBeetle: 'Hercules',
  WaspQueen: 'Wasp Q.',
  StagBeetle: 'Stag',
};

function buildDeck(
  attackerQueenLevel: number,
  donationInventory?: Record<string, number>,
  equippedHeroes?: readonly Types.HeroKind[],
): DeckEntry[] {
  const donations = donationInventory ?? {};
  const swarm = ALL_DECK
    .filter((d) => d.unlockQueenLevel <= attackerQueenLevel)
    .map((d) => {
      // Strip the gate field from the runtime deck entry — RaidScene
      // logic keys off of {kind, count, icon, label} only.
      const { unlockQueenLevel: _unlock, ...rest } = d;
      void _unlock;
      // Merge in any clanmate-donated units of this kind. Donations
      // ride on top of the base count so the player feels them as a
      // free bonus rather than a replacement budget.
      const donatedCount = donations[d.kind] ?? 0;
      if (donatedCount > 0) {
        return { ...rest, count: rest.count + donatedCount };
      }
      return rest;
    });

  // Append equipped heroes as additional deck cards, capped at 1
  // each (heroes are unique). Hero cards sort to the FRONT of the
  // deck so the player sees them first when scrolling — they're
  // the most powerful tools per raid.
  const heroes: DeckEntry[] = (equippedHeroes ?? []).map((kind) => ({
    kind: HERO_DECK_SENTINEL_KIND,
    count: 1,
    icon: HERO_ICON[kind],
    label: HERO_LABEL[kind],
    heroKind: kind,
  }));
  return [...heroes, ...swarm];
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
  // Previous-frame layer for each live unit. Used to detect the moment
  // a `dig` modifier flips a unit between surface (0) and underground
  // (1) so renderFrame can play the cinematic dive/emerge animation.
  private unitLastLayer = new Map<number, Types.Layer>();
  // Set of unit ids currently mid-dive — their sprite is hidden/shrunk
  // and we shouldn't apply normal tinting on them this frame. Cleared
  // when the emerge tween finishes.
  private unitDigPlaying = new Set<number>();
  // HUD badges showing the live count of attacker units per layer.
  // Drawn in drawHud(), updated in renderFrame().
  private layerBadgeSurface!: Phaser.GameObjects.Text;
  private layerBadgeUnderground!: Phaser.GameObjects.Text;
  // Per-render-frame SFX throttles. Reset at the top of renderFrame
  // so a swarm of overlapping events doesn't spam the WebAudio mixer.
  private buildingHitsThisFrame = 0;
  private unitDeathsThisFrame = 0;
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
  private modifierBarBg!: Phaser.GameObjects.Graphics;
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
  private saveTacticBg!: Phaser.GameObjects.Graphics;
  private saveTacticLabel!: Phaser.GameObjects.Text;
  private redoBtn!: Phaser.GameObjects.Container;
  private redoBg!: Phaser.GameObjects.Graphics;
  private redoLabel!: Phaser.GameObjects.Text;
  // First-run coachmark drill — see runCoachmarkDrill(). Each step
  // gates on the gameplay event it teaches (deck tap, deploy commit,
  // modifier toggle); the tracker advances when the relevant handler
  // fires the matching step name.
  private coachmarkStep:
    | 'deck'
    | 'spawn'
    | 'split'
    | 'ambush'
    | 'dig'
    | 'done' = 'done';
  private activeCoachmark: CoachmarkHandle | null = null;

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
    // Grass green so the area outside the bordered board reads as
    // continuous map (Clash style). COLOR.grassFillCss matches the
    // on-board grass fill drawBoard() paints inside the playfield.
    this.cameras.main.setBackgroundColor(COLOR.grassFillCss);
    fadeInScene(this);
    installSceneClickDebug(this);
    // Reset all per-run state. Scene instances are reused across raids,
    // so previous-run state must be cleared here or it'll leak.
    // Deck is filtered by the attacker's own Queen level — locked
    // kinds aren't shown at all. Matches CoC's barracks-gated card
    // roster and keeps raid UI uncluttered at low tiers.
    const initRuntime = this.registry.get('runtime') as HiveRuntime | undefined;
    this.attackerQueenLevel = queenLevelFromBase(initRuntime?.player?.base);
    // Pull the donation bank off the cached /me response so clanmate
    // gifts merge into the deck on raid start. The server zeroes it
    // on /raid/submit, so a successful raid empties the bank for
    // next time regardless of how many donated units were actually
    // deployed.
    const donationInventory = initRuntime?.player?.player.donationInventory ?? {};
    // Equipped heroes (PR D) ride into the deck as bonus cards
    // capped at 1 each, sorted to the front.
    const equippedHeroes = initRuntime?.player?.player.heroes?.equipped ?? [];
    this.deckEntries = buildDeck(this.attackerQueenLevel, donationInventory, equippedHeroes);
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
    this.unitLastLayer.clear();
    this.unitDigPlaying.clear();
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

    // Full-screen layout (Clash-of-Clans style): the board fills the
    // viewport top-to-bottom and the HUD floats overlaid on top. The
    // modifier bar + deck tray below are gameplay-critical chrome that
    // stays in fixed positions; layout() handles their reservations.
    // boardContainer is created BEFORE the HUD so HUD elements (added
    // later, with explicit DEPTHS.hud) render above. Position is
    // recomputed in layout() — (0, 0) is just a placeholder.
    this.boardContainer = this.add.container(0, 0).setDepth(DEPTHS.board);
    this.drawHud();
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

    // Coachmark drill — only on the first raid the player attempts.
    // Skipped entirely in replay mode (the player is watching, not
    // playing) and on any subsequent run after the drill completes.
    if (!this.replayContext && shouldShowRaidCoachmarks()) {
      this.coachmarkStep = 'deck';
      // Deferred so the deck tray's interactive cards have laid out.
      this.time.delayedCall(220, () => this.runCoachmarkStep());
    }

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
    // Clash-of-Clans-style overlay HUD: no full-width strip, just
    // floating elements (Home button, timer, badges, score/loot) that
    // sit above the board. Each HUD element gets DEPTHS.hud so it
    // renders above the boardContainer (DEPTHS.board).
    makeHiveButton(this, {
      x: 80,
      y: HUD_H / 2,
      width: 120,
      height: 36,
      label: '← Home',
      variant: 'ghost',
      fontSize: 13,
      onPress: () => fadeToScene(this, 'HomeScene'),
    }).container.setDepth(DEPTHS.hud);

    this.timerText = this.add
      .text(this.scale.width / 2, HUD_H / 2, '1:30', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '20px',
        color: '#ffd98a',
      })
      .setOrigin(0.5)
      .setDepth(DEPTHS.hud);

    // Layer activity badges. Live counters showing how many of the
    // attacker's units are on each layer right now. Drawn dim by
    // default and brighten when the corresponding layer is active.
    // Positioned to the immediate left of the timer in layout().
    this.layerBadgeSurface = this.add
      .text(0, 0, '☼ 0', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#9fc79a',
      })
      .setOrigin(1, 0.5)
      .setDepth(DEPTHS.hud);
    this.layerBadgeUnderground = this.add
      .text(0, 0, '⛏ 0', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#9fc79a',
      })
      .setOrigin(1, 0.5)
      .setDepth(DEPTHS.hud);

    this.starsText = this.add
      .text(this.scale.width - 16, HUD_H / 2 - 10, '★ 0', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '16px',
        color: '#ffd98a',
      })
      .setOrigin(1, 0.5)
      .setDepth(DEPTHS.hud);

    this.lootText = this.add
      .text(this.scale.width - 16, HUD_H / 2 + 10, 'loot: 0', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#c3e8b0',
      })
      .setOrigin(1, 0.5)
      .setDepth(DEPTHS.hud);

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
        .setAlpha(0.85)
        .setDepth(DEPTHS.hud);
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
    // Solid grass underlay — fully opaque so the painterly board
    // background sprite (which has brown earth patches) doesn't bleed
    // through behind the grid. Skipping the sprite entirely keeps the
    // board visually clean: green grass + grid + buildings, nothing
    // else.
    const grass = this.add.graphics();
    grass.setDepth(DEPTHS.boardUnder);
    grass.fillStyle(0x6cbf6a, 1);
    grass.fillRect(0, 0, BOARD_W, BOARD_H);

    // Per-tile grid box outlines — small green boxes so the player
    // can see the grid the buildings + units are aligned to. The old
    // continuous full-board lines at 0.15 alpha were nearly invisible
    // and didn't communicate "this is a grid". A 1 px stroke per cell
    // at 0.45 alpha is readable without competing with art.
    const grid = this.add.graphics();
    grid.lineStyle(1, 0x2d5e2a, 0.45);
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        grid.strokeRect(x * TILE + 0.5, y * TILE + 0.5, TILE - 1, TILE - 1);
      }
    }

    this.spawnZoneGraphics = this.add.graphics().setDepth(2);

    // Left spawn zone (2 tiles wide, full height)
    this.spawnZoneGraphics.fillStyle(0xc3e8b0, 0.09);
    this.spawnZoneGraphics.fillRect(0, 0, SPAWN_ZONE_W, BOARD_H);
    this.spawnZoneGraphics.lineStyle(3, 0xc3e8b0, 0.45);
    this.spawnZoneGraphics.strokeRect(0, 0, SPAWN_ZONE_W, BOARD_H);

    // Top spawn zone (excluding corners covered by left/right)
    this.spawnZoneGraphics.fillStyle(0xc3e8b0, 0.09);
    this.spawnZoneGraphics.fillRect(SPAWN_ZONE_W, 0, BOARD_W - SPAWN_ZONE_W * 2, SPAWN_ZONE_H);
    this.spawnZoneGraphics.lineStyle(3, 0xc3e8b0, 0.45);
    this.spawnZoneGraphics.strokeRect(SPAWN_ZONE_W, 0, BOARD_W - SPAWN_ZONE_W * 2, SPAWN_ZONE_H);

    // Bottom spawn zone (excluding corners covered by left/right)
    this.spawnZoneGraphics.fillStyle(0xc3e8b0, 0.09);
    this.spawnZoneGraphics.fillRect(SPAWN_ZONE_W, BOARD_H - SPAWN_ZONE_H, BOARD_W - SPAWN_ZONE_W * 2, SPAWN_ZONE_H);
    this.spawnZoneGraphics.lineStyle(3, 0xc3e8b0, 0.45);
    this.spawnZoneGraphics.strokeRect(SPAWN_ZONE_W, BOARD_H - SPAWN_ZONE_H, BOARD_W - SPAWN_ZONE_W * 2, SPAWN_ZONE_H);

    // Right spawn zone — full height, mirrors the left strip. Lets
    // attackers come at a defender's funnel from the far side too.
    this.spawnZoneGraphics.fillStyle(0xc3e8b0, 0.09);
    this.spawnZoneGraphics.fillRect(BOARD_W - SPAWN_ZONE_W, 0, SPAWN_ZONE_W, BOARD_H);
    this.spawnZoneGraphics.lineStyle(3, 0xc3e8b0, 0.45);
    this.spawnZoneGraphics.strokeRect(BOARD_W - SPAWN_ZONE_W, 0, SPAWN_ZONE_W, BOARD_H);

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

    const rightChevrons = [0, 1, 2].map((i) =>
      this.add
        .text(BOARD_W - SPAWN_ZONE_W / 2, 140 + i * 120, '<<<', {
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

    const allChevrons = [
      ...leftChevrons,
      ...topChevrons,
      ...bottomChevrons,
      ...rightChevrons,
    ];
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
      grass,
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
      spr.setOrigin(0.5, 0.5) /* center sprite within footprint cell so it never bleeds above the grid */;
      // Buildings render at exactly footprint × TILE so they fit
      // inside their grid cells. Three readable size tiers fall out
      // of the data: 2×2 chamber-class (QueenChamber, AcidSpitter,
      // SpiderNest), 1×1 default (turrets, walls, vaults), and the
      // 1×1 visually-tiny class (RootSnare with hp=1). Matches
      // HomeScene's grid-fit treatment so a building looks the same
      // size in editor + raid.
      spr.setDisplaySize(b.w * TILE, b.h * TILE);
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
      container.setInteractive(
        new Phaser.Geom.Rectangle(
          -DECK_CARD_W / 2,
          -DECK_CARD_H / 2,
          DECK_CARD_W,
          DECK_CARD_H,
        ),
        Phaser.Geom.Rectangle.Contains,
      );
      // Long-press → codex peek. A short tap still selects the card
      // (the existing behaviour). After ~350 ms of unmoved hold, we
      // open a read-only codex modal for the unit on the card so a
      // mid-raid player can refresh "what does FireAnt do?" without
      // leaving the scene. Pointerup with the timer still pending
      // counts as a tap; pointerout / pointermove cancel both paths.
      const cardKind = e.kind;
      let holdTimer: Phaser.Time.TimerEvent | null = null;
      let opened = false;
      const cancelHold = (): void => {
        if (holdTimer) {
          holdTimer.remove(false);
          holdTimer = null;
        }
      };
      container.on('pointerdown', () => {
        opened = false;
        cancelHold();
        holdTimer = this.time.delayedCall(350, () => {
          opened = true;
          haptic(15);
          openUnitInfoModal({ scene: this, kind: cardKind });
        });
      });
      container.on('pointerup', () => {
        const wasLongPress = opened;
        cancelHold();
        if (!wasLongPress) {
          this.selectDeckIndex(i);
        }
      });
      container.on('pointerout', cancelHold);
      container.on('pointerupoutside', cancelHold);

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
      // Right edge: x >= width - 2 tiles (mirrors left so the player
      // can flank from the far side; defender bases that funnel left-
      // to-right now get a real second axis of attack).
      if (local.x >= BOARD_W - SPAWN_ZONE_W) return 'right';
      // Top edge: y <= 2 tiles (excluding corners covered by left/right)
      if (
        local.y <= SPAWN_ZONE_H &&
        local.x > SPAWN_ZONE_W &&
        local.x < BOARD_W - SPAWN_ZONE_W
      )
        return 'top';
      // Bottom edge: y >= height - 2 tiles (excluding corners)
      if (
        local.y >= BOARD_H - SPAWN_ZONE_H &&
        local.x > SPAWN_ZONE_W &&
        local.x < BOARD_W - SPAWN_ZONE_W
      )
        return 'bottom';
      return null;
    };

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (!withinBoard(p.x, p.y)) return;
      if (this.state.outcome !== 'ongoing') return;
      if (this.currentDeckEntry().count <= 0) {
        haptic(25);
        return;
      }
      const edge = determineSpawnEdge(p.x, p.y);
      if (!edge) {
        this.deckHintText.setText('Start your drag from a glowing spawn edge (left, right, top, or bottom).');
        // Flash the spawn-zone graphics so the player can see WHERE
        // the legal start regions actually are. Pairs with a short
        // haptic buzz so the failure registers physically.
        this.flashSpawnZones();
        haptic(25);
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
      // Hero deployments are capped to 1 unit per drag (the sim
      // also enforces this; clamping client-side keeps the deck
      // count bookkeeping accurate so a 5-burst hero card doesn't
      // visually decrement to -4).
      const heroBurst = entry.heroKind ? 1 : burst;
      const input: Types.SimInput = {
        type: 'deployPath',
        tick: this.state.tick + 1,
        ownerSlot: 0,
        path: {
          pathId: 0,
          spawnLayer: 0,
          unitKind: entry.kind,
          count: heroBurst,
          points: tilePoints,
          ...(modifier ? { modifier } : {}),
          ...(entry.heroKind ? { heroKind: entry.heroKind } : {}),
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
      haptic(modifier ? [10, 6, 14] : 12);
      sfxDeploy();
      // Modifier-specific cue scheduled slightly after the deploy
      // whoof so the two cues read as a phrase, not a chord.
      if (modifier) {
        const delay = 90;
        if (modifier.kind === 'dig') this.time.delayedCall(delay, sfxDig);
        else if (modifier.kind === 'ambush') this.time.delayedCall(delay, sfxAmbush);
        else if (modifier.kind === 'split') this.time.delayedCall(delay, sfxSplit);
      }
      this.advanceCoachmark('spawn');

      // Confirm the commit visually: a brief scale-pulse on the
      // selected deck card so the player sees the count tick down
      // without staring at it, plus a slower fade on the trail with
      // a one-shot brighter overdraw so the pheromone path reads as
      // "yep, deployed" before it dissolves.
      const activeCard = this.deckContainers[this.selectedDeckIdx];
      if (activeCard) {
        // Pulse RELATIVE to the dynamic base scale — deckCardScale
        // drops to ~0.62 on phone-narrow viewports, so a hardcoded
        // absolute target would yank the card to ~2× its rest size.
        // Kill any in-flight tween + reset to base first so a rapid
        // double-deploy doesn't snap the card mid-yoyo.
        this.tweens.killTweensOf(activeCard);
        activeCard.setScale(this.deckCardScale);
        this.tweens.add({
          targets: activeCard,
          scale: this.deckCardScale * 1.12,
          duration: 110,
          ease: 'Cubic.easeOut',
          yoyo: true,
        });
      }
      // fade the committed trail (extended from 600 → 900 ms so the
      // player has a clearer beat to see what they drew)
      this.tweens.add({
        targets: this.trailGraphics,
        alpha: { from: 1, to: 0 },
        duration: 900,
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

  // ---------- First-run coachmark drill ----------
  //
  // Three guided steps that teach the genre-specific mechanics in
  // context: pick a unit (deck), drag from a glowing edge (path),
  // try the Dig modifier (cross-layer hook). Each step gates on the
  // gameplay event it teaches — the player can't skip ahead by
  // tapping a bubble. Persists 'done' to localStorage only after
  // step 3 completes; bailing out before then leaves the drill
  // armed for the next visit.

  private runCoachmarkStep(): void {
    if (!this.scene.isActive()) return;
    if (this.activeCoachmark) {
      this.activeCoachmark.complete();
      this.activeCoachmark = null;
    }
    if (this.coachmarkStep === 'deck') {
      const card = this.deckContainers[this.selectedDeckIdx];
      if (!card) return;
      const r = card.getBounds();
      this.activeCoachmark = showCoachmark({
        scene: this,
        target: { x: r.x, y: r.y, w: r.width, h: r.height },
        prefer: 'above',
        title: 'Pick your swarm',
        body: 'Tap any card to ready that unit. Each card shows the role and remaining count.',
      });
    } else if (this.coachmarkStep === 'spawn') {
      // Halo the spawn-zone label area in scene coordinates.
      const scaleX = this.boardContainer.scaleX || 1;
      const screenX = this.boardContainer.x;
      const screenY = this.boardContainer.y;
      const w = SPAWN_ZONE_W * scaleX;
      const h = (BOARD_H * scaleX) - 20;
      this.activeCoachmark = showCoachmark({
        scene: this,
        target: { x: screenX, y: screenY, w, h },
        prefer: 'below',
        title: 'Draw a path',
        body: 'Drag from a glowing edge into the base. Your swarm walks the trail you draw.',
      });
    } else if (
      this.coachmarkStep === 'split' ||
      this.coachmarkStep === 'ambush' ||
      this.coachmarkStep === 'dig'
    ) {
      const kind = this.coachmarkStep;
      const btn = this.modifierButtons.find((b) => b.kind === kind);
      if (!btn) {
        this.completeCoachmarkDrill();
        return;
      }
      const r = btn.container.getBounds();
      const copy = MODIFIER_TUTORIAL[kind];
      this.activeCoachmark = showCoachmark({
        scene: this,
        target: { x: r.x, y: r.y, w: r.width, h: r.height },
        prefer: 'below',
        title: copy.title,
        body: copy.body,
      });
    }
  }

  // Advance the drill when the gameplay event matching the current
  // step fires. Caller passes the step it just satisfied; if it
  // matches, we acknowledge and move on.
  private advanceCoachmark(
    satisfied:
      | 'deck'
      | 'spawn'
      | 'split'
      | 'ambush'
      | 'dig',
  ): void {
    if (this.coachmarkStep !== satisfied) return;
    if (this.activeCoachmark) {
      this.activeCoachmark.acknowledge();
      this.activeCoachmark = null;
    }
    let next: typeof this.coachmarkStep;
    if (satisfied === 'deck') {
      next = 'spawn';
    } else if (satisfied === 'spawn') {
      next = 'split';
    } else if (satisfied === 'split') {
      next = 'ambush';
    } else if (satisfied === 'ambush') {
      next = 'dig';
    } else {
      this.completeCoachmarkDrill();
      return;
    }
    this.coachmarkStep = next;
    this.time.delayedCall(420, () => this.runCoachmarkStep());
  }

  private completeCoachmarkDrill(): void {
    this.coachmarkStep = 'done';
    if (this.activeCoachmark) {
      this.activeCoachmark.complete();
      this.activeCoachmark = null;
    }
    markRaidCoachmarksDone();
  }

  // ---------- Path modifier toolbar + saved tactics ----------

  private drawModifierBar(): void {
    this.modifierBar = this.add.container(0, 0).setDepth(32);
    this.modifierBarBg = this.add.graphics();
    this.modifierBar.add(this.modifierBarBg);

    let cursorX = 0;
    for (const kind of MODIFIER_KINDS) {
      const containerBtn = this.add.container(cursorX, 0);
      const btnBg = this.add.graphics();
      const label = this.add
        .text(MOD_BTN_W / 2, MOD_BTN_H / 2, `${MODIFIER_GLYPH[kind]}  ${MODIFIER_LABEL[kind]}`, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '13px',
          color: '#e6f5d2',
        })
        .setOrigin(0.5);
      containerBtn.add([btnBg, label]);
      containerBtn.setSize(MOD_BTN_W, MOD_BTN_H);
      containerBtn.setInteractive(
        new Phaser.Geom.Rectangle(0, 0, MOD_BTN_W, MOD_BTN_H),
        Phaser.Geom.Rectangle.Contains,
      );
      containerBtn.on('pointerdown', () => this.setModifierMode(kind));
      this.modifierBar.add(containerBtn);
      this.modifierButtons.push({ kind, container: containerBtn, bg: btnBg, label });
      cursorX += MOD_BTN_W + MOD_BTN_GAP;
    }

    // Save & Tactics action buttons share the bar's right side.
    const saveContainer = this.add.container(cursorX + MOD_ACTION_GAP, 0);
    this.saveTacticBg = this.add.graphics();
    this.saveTacticLabel = this.add
      .text(MOD_ACTION_BTN_W / 2, MOD_BTN_H / 2, '★ Save', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#ffd98a',
      })
      .setOrigin(0.5);
    saveContainer.add([this.saveTacticBg, this.saveTacticLabel]);
    saveContainer.setSize(MOD_ACTION_BTN_W, MOD_BTN_H);
    saveContainer.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, MOD_ACTION_BTN_W, MOD_BTN_H),
      Phaser.Geom.Rectangle.Contains,
    );
    saveContainer.on('pointerdown', () => this.handleSaveTactic());
    this.modifierBar.add(saveContainer);
    this.saveTacticBtn = saveContainer;
    cursorX += MOD_ACTION_BTN_W + MOD_ACTION_GAP;

    // Redo — repeat the last path the player drew. Mobile users in
    // particular benefit from a "do that again" shortcut so they
    // don't have to re-trace identical lanes for follow-up bursts.
    const redoContainer = this.add.container(cursorX + MOD_ACTION_GAP, 0);
    this.redoBg = this.add.graphics();
    this.redoLabel = this.add
      .text(MOD_ACTION_BTN_W / 2, MOD_BTN_H / 2, '↺ Redo', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#c3e8b0',
      })
      .setOrigin(0.5);
    redoContainer.add([this.redoBg, this.redoLabel]);
    redoContainer.setSize(MOD_ACTION_BTN_W, MOD_BTN_H);
    redoContainer.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, MOD_ACTION_BTN_W, MOD_BTN_H),
      Phaser.Geom.Rectangle.Contains,
    );
    redoContainer.on('pointerdown', () => this.redoLastDraft());
    this.modifierBar.add(redoContainer);
    this.redoBtn = redoContainer;
    cursorX += MOD_ACTION_BTN_W + MOD_ACTION_GAP;

    const tacContainer = this.add.container(cursorX + MOD_ACTION_GAP, 0);
    const tacBg = this.add.graphics();
    const tacLabel = this.add
      .text(MOD_ACTION_BTN_W / 2, MOD_BTN_H / 2, '☰ Tactics', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#c3e8b0',
      })
      .setOrigin(0.5);
    tacContainer.add([tacBg, tacLabel]);
    tacContainer.setSize(MOD_ACTION_BTN_W, MOD_BTN_H);
    tacContainer.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, MOD_ACTION_BTN_W, MOD_BTN_H),
      Phaser.Geom.Rectangle.Contains,
    );
    tacContainer.on('pointerdown', () => this.toggleTacticsPanel());
    this.paintActionButton(tacBg, false);
    this.modifierBar.add(tacContainer);

    this.refreshModifierBar();
    this.refreshSaveTacticEnabled();
    this.refreshRedoEnabled();
  }

  private paintActionButton(bg: Phaser.GameObjects.Graphics, pressed: boolean): void {
    bg.clear();
    bg.fillStyle(pressed ? 0x2a4530 : 0x1a2b1a, 1);
    bg.lineStyle(2, COLOR.brassDeep, 1);
    bg.fillRoundedRect(0, 0, MOD_ACTION_BTN_W, MOD_BTN_H, 8);
    bg.strokeRoundedRect(0, 0, MOD_ACTION_BTN_W, MOD_BTN_H, 8);
  }

  private refreshModifierBar(): void {
    for (const b of this.modifierButtons) {
      const selected = b.kind === this.currentModifierMode;
      b.bg.clear();
      b.bg.fillStyle(selected ? 0x3a7f3a : 0x1a2b1a, 1);
      b.bg.lineStyle(2, selected ? 0xffd98a : COLOR.brassDeep, 1);
      b.bg.fillRoundedRect(0, 0, MOD_BTN_W, MOD_BTN_H, 8);
      b.bg.strokeRoundedRect(0, 0, MOD_BTN_W, MOD_BTN_H, 8);
      b.label.setColor(selected ? '#fff' : '#e6f5d2');
    }
  }

  private setModifierMode(kind: Types.PathModifierKind | 'none'): void {
    this.currentModifierMode = kind;
    this.refreshModifierBar();
    // Hint text explains what each modifier does on every toggle, not
    // just on first encounter, so a player who forgets can re-tap to
    // refresh the explanation.
    let hint: string;
    if (kind === 'none') {
      hint = 'Direct path — units walk straight through.';
    } else if (kind === 'split') {
      hint = 'Split armed — half the swarm peels off at midpoint to hit the nearest building.';
    } else if (kind === 'ambush') {
      hint = 'Ambush armed — units pause ~2s at midpoint so follow-up bursts catch up.';
    } else {
      hint = 'Dig armed — diggers/termites flip layer at midpoint (walls above, tunnels below).';
    }
    this.deckHintText.setText(hint);
    haptic(8);
    sfxModifierTick();
    // Steps 3–5 of the drill teach the three modifiers. Each is only
    // satisfied when the player toggles the matching button — partial
    // credit for picking a different modifier could let someone skip
    // ahead before they understand the mechanic the bubble explained.
    if (kind === 'split') {
      this.advanceCoachmark('split');
    } else if (kind === 'ambush') {
      this.advanceCoachmark('ambush');
    } else if (kind === 'dig') {
      this.advanceCoachmark('dig');
    }
  }

  // Brief brightening of the spawn-zone overlay when the player taps
  // outside a legal start region. The graphics live inside
  // boardContainer so this transform follows the board's scale on
  // mobile. Quick on, slow off so the eye catches the highlight.
  private flashSpawnZones(): void {
    if (!this.spawnZoneGraphics) return;
    this.tweens.killTweensOf(this.spawnZoneGraphics);
    this.spawnZoneGraphics.setAlpha(0.85);
    this.tweens.add({
      targets: this.spawnZoneGraphics,
      alpha: 0.28,
      duration: 480,
      ease: 'Sine.easeOut',
    });
    if (this.spawnZoneCue) {
      this.tweens.killTweensOf(this.spawnZoneCue);
      this.spawnZoneCue.setAlpha(1);
      this.tweens.add({
        targets: this.spawnZoneCue,
        alpha: 0.55,
        duration: 600,
        ease: 'Sine.easeOut',
      });
    }
  }

  // Redo: re-deploy the most recent path the player drew, including
  // its modifier. Costs another burst from the same deck slot. The
  // common shape with deployTactic comes from a shared sub-helper —
  // both routes funnel SimInputs through the same path so a single
  // change to the deploy schema covers them.
  private redoLastDraft(): void {
    if (!this.lastDraft) return;
    if (this.state.outcome !== 'ongoing') return;
    const idx = this.deckEntries.findIndex(
      (d) => d.kind === this.lastDraft!.unitKind && d.count > 0,
    );
    if (idx < 0) {
      this.deckHintText.setText(`No ${this.lastDraft.unitKind} left to repeat that path.`);
      haptic(25);
      return;
    }
    this.selectedDeckIdx = idx;
    haptic(12);
    this.deployTactic({
      name: 'Redo',
      unitKind: this.lastDraft.unitKind,
      pointsTile: this.lastDraft.pointsTile,
      ...(this.lastDraft.modifier ? { modifier: this.lastDraft.modifier } : {}),
      spawnEdge: this.lastDraft.spawnEdge,
    });
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
    const enabled = !!this.lastDraft;
    this.saveTacticBg.clear();
    this.saveTacticBg.fillStyle(enabled ? 0x3a3520 : 0x1a1a16, 1);
    this.saveTacticBg.lineStyle(2, enabled ? 0xffd98a : 0x554d2c, 1);
    this.saveTacticBg.fillRoundedRect(0, 0, MOD_ACTION_BTN_W, MOD_BTN_H, 8);
    this.saveTacticBg.strokeRoundedRect(0, 0, MOD_ACTION_BTN_W, MOD_BTN_H, 8);
    this.saveTacticLabel.setAlpha(enabled ? 1 : 0.45);
  }

  private refreshRedoEnabled(): void {
    if (!this.redoBg || !this.redoLabel) return;
    // Redo lights up only when there's a draft AND the matching deck
    // slot still has stock. Saves the player from pressing it just to
    // get a "no units left" buzz.
    const enabled =
      !!this.lastDraft &&
      this.deckEntries.some(
        (d) => d.kind === this.lastDraft!.unitKind && d.count > 0,
      );
    this.redoBg.clear();
    this.redoBg.fillStyle(enabled ? 0x223a23 : 0x161a16, 1);
    this.redoBg.lineStyle(2, enabled ? COLOR.brassDeep : 0x3a4a3a, 1);
    this.redoBg.fillRoundedRect(0, 0, MOD_ACTION_BTN_W, MOD_BTN_H, 8);
    this.redoBg.strokeRoundedRect(0, 0, MOD_ACTION_BTN_W, MOD_BTN_H, 8);
    this.redoLabel.setAlpha(enabled ? 1 : 0.45);
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
          .text(w / 2 - 116, rowH / 2, meta, {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '11px',
            color: '#9fc79a',
          })
          .setOrigin(0, 0.5);
        // Share — copy a deep-link URL with the tactic encoded into
        // the hash. Recipient's BootScene reads the hash on load and
        // imports the tactic into their saved set automatically.
        const shareBtn = this.add
          .text(w / 2 - 50, rowH / 2, '📋', {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '14px',
            color: '#c3e8b0',
          })
          .setOrigin(0.5, 0.5)
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', () => { void this.shareTactic(t); });
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
        row.add([rowBg, text, metaText, shareBtn, useBtn]);
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

  // Build a share URL for the tactic, write it to the clipboard, and
  // surface a confirmation toast. Falls back to inline display when
  // the clipboard API is unavailable (mostly older mobile WebViews
  // without a user-gesture-bound clipboard permission).
  private async shareTactic(t: SavedTactic): Promise<void> {
    // Pass the full current URL so buildTacticShareUrl can resolve
    // play.html relative to the deployed subpath (works under
    // /games/hive/ as well as the bare origin).
    const url = buildTacticShareUrl(window.location.href, {
      name: t.name,
      unitKind: t.unitKind,
      pointsTile: t.pointsTile,
      spawnEdge: t.spawnEdge,
      ...(t.modifier ? { modifier: t.modifier } : {}),
    });
    let copied = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(url);
        copied = true;
      }
    } catch {
      copied = false;
    }
    this.spawnDeployPopup(
      this.scale.width / 2,
      HUD_H + MODIFIER_BAR_H + 12,
      copied ? 'Link copied' : 'Copy this URL',
      1,
    );
    // If we couldn't copy, prompt() at least gives the player a way
    // to grab it manually. Skipped when the copy succeeded.
    if (!copied) {
      window.prompt('Copy and share this tactic URL:', url);
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
    this.advanceCoachmark('deck');
  }

  private redrawDeckCard(index: number): void {
    const container = this.deckContainers[index];
    const bgObj = container?.getAt(0) as Phaser.GameObjects.Graphics | undefined;
    const label = this.deckLabels[index];
    const entry = this.deckEntries[index];
    if (!container || !bgObj || !label || !entry) return;
    const selected = index === this.selectedDeckIdx;
    const depleted = entry.count <= 0;
    const isHero = !!entry.heroKind;
    bgObj.clear();
    // Heroes get a richer fill (gold-tinted) + a thicker brass
    // border so they read as legendary in the deck tray.
    bgObj.fillStyle(
      depleted ? 0x241d1d
        : selected ? 0x3a7f3a
        : isHero ? 0x3a2e10
        : 0x1a2b1a,
      1,
    );
    bgObj.lineStyle(
      isHero ? 4 : 3,
      depleted ? 0x5a4141
        : selected ? 0xffd98a
        : isHero ? 0xffd97a
        : 0x2c5a23,
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
    // Redo button mirrors deck stock for the last drafted unit, so
    // updating it on every deck refresh keeps the enabled state in
    // lockstep with what's actually deployable.
    this.refreshRedoEnabled();
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
        : 'All attacker units unlocked at your current colony level.',
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
    heroKind?: Types.HeroKind,
  ): Phaser.GameObjects.Image | Phaser.GameObjects.Sprite {
    // Heroes use a static sprite (PR D ships sprite art via the
    // admin tool; placeholder fallback in placeholders.ts draws a
    // brass disc with a halo). Heroes also render at 1.4× the
    // regular unit size so they read as legendary in a swarm.
    const HERO_SIZE = 44;
    const UNIT_SIZE = 32;
    if (heroKind) {
      return this.add
        .image(x, y, `hero-${heroKind}`)
        .setDisplaySize(HERO_SIZE, HERO_SIZE)
        .setOrigin(0.5, 0.7);
    }
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
        .setDisplaySize(UNIT_SIZE, UNIT_SIZE)
        .setOrigin(0.5, 0.7);
      spr.play(animKey);
      return spr;
    }
    return this.add
      .image(x, y, `unit-${kind}`)
      .setDisplaySize(UNIT_SIZE, UNIT_SIZE)
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
    // Reset SFX throttles. The hit thud is allowed to fire at most
    // twice per frame across the whole board so we never melt the
    // mix when a 5-unit burst spreads across multiple targets.
    this.buildingHitsThisFrame = 0;
    this.unitDeathsThisFrame = 0;

    // Pre-pass: tally where the attacker actually is right now. Used
    // both for the HUD layer badges (set later in the units pass) and
    // for the underground-reveal building tint computed below.
    let preSurface = 0;
    let preUnder = 0;
    for (const u of this.state.units) {
      if (u.owner !== 0 || u.hp <= 0) continue;
      if (u.layer === 0) preSurface++;
      else preUnder++;
    }
    const attackerOnLayer1 = preUnder > 0;
    const attackerOnLayer0 = preSurface > 0;

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
              sfxQueenDestroyed();
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
              sfxBuildingDestroyed();
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
        // Throttle the hit thuds with a per-frame budget so a 5-unit
        // burst against one building doesn't fire five overlapping
        // SFX in the same render tick.
        if (this.buildingHitsThisFrame < 2) {
          sfxBuildingHit();
          this.buildingHitsThisFrame++;
        }
      } else {
        // Layer-active reveal: a building on the attacker's CURRENT
        // layer reads as "in play" — full alpha, no tint. A building
        // on the inactive layer dims so the player understands it's
        // out of reach without a dig. Cross-layer buildings (`spans`
        // includes both) always read as in-play.
        const spansBoth = !!(b.spans && b.spans.includes(0) && b.spans.includes(1));
        const layerActive =
          spansBoth ||
          (b.layer === 0 && attackerOnLayer0) ||
          (b.layer === 1 && attackerOnLayer1);
        if (preSurface === 0 && preUnder === 0) {
          // Pre-deploy: keep all buildings visible at default alpha.
          spr.setAlpha(1);
        } else {
          spr.setAlpha(layerActive ? 1 : 0.55);
        }
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
    let surfaceCount = 0;
    let undergroundCount = 0;
    for (const u of this.state.units) {
      alive.add(u.id);
      if (u.owner === 0) {
        if (u.layer === 0) surfaceCount++;
        else undergroundCount++;
      }
      let spr = this.unitSprites.get(u.id);
      const x = Sim.toFloat(u.x) * TILE;
      const y = Sim.toFloat(u.y) * TILE;
      if (!spr) {
        spr = this.makeUnitSprite(u.kind, x, y, u.heroKind);
        this.boardContainer.add(spr);
        this.unitSprites.set(u.id, spr);
        this.unitLastLayer.set(u.id, u.layer);
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
      // Layer transition: a `dig` modifier just flipped this unit's
      // layer. Play the dive/emerge animation, mark it mid-dive so the
      // tint and alpha logic below leaves it alone, and queue it to
      // clear when the emerge tween completes.
      const prevLayer = this.unitLastLayer.get(u.id);
      if (prevLayer !== undefined && prevLayer !== u.layer) {
        this.playDigAnimation(spr, x, y, u.layer);
        this.unitDigPlaying.add(u.id);
      }
      this.unitLastLayer.set(u.id, u.layer);

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
      // While a dig animation is playing, leave alpha to the tween.
      // Otherwise apply the standard hp-based fade.
      if (!this.unitDigPlaying.has(u.id)) {
        spr.setAlpha(0.35 + 0.65 * hpFrac);
      }
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
      } else if (!this.unitDigPlaying.has(u.id)) {
        // Layer tint: underground attacker units carry a cool blue
        // wash so they read as "below the surface" at a glance. Only
        // apply when no other tint (hit flash) is active. Defender
        // units never live on layer 1 today, so this is attacker-only.
        if (u.owner === 0 && u.layer === 1) {
          spr.setTint(0xa8c6ff);
        } else {
          spr.clearTint();
        }
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
        if (this.unitDeathsThisFrame < 3) {
          sfxUnitDeath();
          this.unitDeathsThisFrame++;
        }
        spr.destroy();
        this.unitSprites.delete(id);
        this.unitLastHp.delete(id);
        this.unitLastPos.delete(id);
        this.unitLastLayer.delete(id);
        this.unitDigPlaying.delete(id);
      }
    }

    // Layer activity badges. Surface count brightens to gold when
    // anyone is up top; underground dims to a cool teal otherwise.
    if (this.layerBadgeSurface) {
      this.layerBadgeSurface.setText(`☼ ${surfaceCount}`);
      this.layerBadgeSurface.setColor(surfaceCount > 0 ? '#ffd98a' : '#54663f');
    }
    if (this.layerBadgeUnderground) {
      this.layerBadgeUnderground.setText(`⛏ ${undergroundCount}`);
      this.layerBadgeUnderground.setColor(undergroundCount > 0 ? '#a8c6ff' : '#3a4a55');
    }
  }

  // Dive/emerge animation played the moment a unit's layer flips
  // mid-raid (only the new `dig` path modifier triggers this today).
  // Tween the sprite down to a flat ellipse with falling alpha — that
  // reads as "burrowing into the ground" — then snap back and reverse
  // it for the emerge half. A dirt-puff is spawned at start and end so
  // there's a satisfying physical anchor on both sides of the flip.
  private playDigAnimation(
    spr: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite,
    x: number,
    y: number,
    newLayer: Types.Layer,
  ): void {
    const baseScaleX = spr.scaleX;
    const baseScaleY = spr.scaleY;
    // Dirt burst at the dig site — 8 particles for visual weight.
    this.spawnDebrisBurst(x, y + 2, 8);
    // Subtle camera nudge so the moment lands.
    this.cameras.main.shake(140, 0.0035);
    this.tweens.killTweensOf(spr);
    this.tweens.add({
      targets: spr,
      scaleY: baseScaleY * 0.18,
      scaleX: baseScaleX * 1.18,
      alpha: 0,
      duration: 180,
      ease: 'Sine.easeIn',
      onComplete: () => {
        // Mid-flip puff at the same spot — the world below is now in
        // play. Apply the new-layer tint immediately so the emerge
        // tween reveals the unit in its new colour.
        this.spawnDebrisBurst(x, y + 2, 6);
        if (this.unitSprites.has(this.unitIdForSprite(spr) ?? -1)) {
          spr.setTint(newLayer === 1 ? 0xa8c6ff : 0xffffff);
          if (newLayer === 0) spr.clearTint();
        }
        this.tweens.add({
          targets: spr,
          scaleY: baseScaleY,
          scaleX: baseScaleX,
          alpha: 1,
          duration: 200,
          ease: 'Sine.easeOut',
          onComplete: () => {
            const id = this.unitIdForSprite(spr);
            if (id !== null) this.unitDigPlaying.delete(id);
          },
        });
      },
    });
  }

  // Reverse-lookup unit id from a sprite. Cheap enough at sim scale
  // (≤30 units) that a Map walk beats maintaining a parallel index.
  private unitIdForSprite(
    spr: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite,
  ): number | null {
    for (const [id, candidate] of this.unitSprites) {
      if (candidate === spr) return id;
    }
    return null;
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
      else if (px >= BOARD_W - SPAWN_ZONE_W) edge = 'right';
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
      case 'right':
        startX = targetX + offset;
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
      // Pass the revenge target through so the server pins the
      // matchmaker on that defender. If the target is invalid (self,
      // shielded, base missing) the server falls through to random
      // matchmaking and the player still gets a fight.
      const match = await runtime.api.requestMatch(
        runtime.player?.player.trophies ?? 100,
        this.revengeContext?.defenderId,
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
        const prevSugar = runtime.player.player.sugar;
        const prevLeaf = runtime.player.player.leafBits;
        const prevMilk = runtime.player.player.aphidMilk;
        runtime.player.player.trophies = res.player.trophies;
        runtime.player.player.sugar = res.player.sugar;
        runtime.player.player.leafBits = res.player.leafBits;
        runtime.player.player.aphidMilk = res.player.aphidMilk;
        // Stash the delta so HomeScene can pulse the pills + float
        // a "+N" number on next entry. Even small/zero deltas are
        // recorded so HomeScene can decide which pills to animate.
        runtime.pendingResourceGain = {
          sugar: res.player.sugar - prevSugar,
          leafBits: res.player.leafBits - prevLeaf,
          aphidMilk: res.player.aphidMilk - prevMilk,
        };
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

    // 💬 Comment button — opens a tiny prompt-based comment flow
    // against /replay/:id/comments. Pragmatic v1: window.prompt is
    // ugly but works on every browser without dragging in a full
    // modal. A richer threaded-view UI can replace this once we know
    // the loop is used.
    const commentBtn = makeHiveButton(this, {
      x: center + 10 + 3 * 60 + 12,
      y: barY,
      width: 110,
      height: 32,
      label: '💬 Comment',
      variant: 'ghost',
      fontSize: 11,
      onPress: () => { void this.commentOnReplay(); },
    });
    this.replayControls.add(commentBtn.container);
  }

  // Quick comment flow on the replay we're currently watching. Shows
  // the latest 5 existing comments first (so the player has context
  // before adding their own), then a prompt for the new comment.
  private async commentOnReplay(): Promise<void> {
    if (!this.replayContext) return;
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    let preview = 'No comments yet — be the first.';
    try {
      const list = await runtime.api.replayComments(this.replayContext.id, 0, 5);
      if (list.comments.length > 0) {
        preview = list.comments
          .map((c) => `[${c.authorName}] ${c.content}`)
          .join('\n');
      }
    } catch {
      // best effort — fall through to the input prompt anyway
    }
    const draft = window.prompt(
      `Recent comments:\n${preview}\n\nAdd your own:`,
      '',
    );
    if (!draft || !draft.trim()) return;
    try {
      await runtime.api.replayCommentPost(this.replayContext.id, draft);
      this.spawnDeployPopup(this.scale.width / 2, HUD_H + MODIFIER_BAR_H + 12, 'Posted', 1);
    } catch (err) {
      this.spawnDeployPopup(
        this.scale.width / 2,
        HUD_H + MODIFIER_BAR_H + 12,
        `Comment failed: ${(err as Error).message}`,
        0,
      );
    }
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
    // Card grows another 56 px on both branches to seat a second
    // row of buttons (Raid again on top, Back/Share below). The
    // single-row layout pre-#102 left no room for the new CTAs.
    const cardH = isWin ? 346 : 296;
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
      haptic([40, 30, 60]);
      this.emitConfetti(cy - 8);
    } else {
      sfxDefeat();
      haptic([20, 60, 20]);
    }

    // Two-row action layout. Top row is the "next loop iteration"
    // CTAs (Raid again primary, Share replay on wins); bottom row
    // is the calmer Back-to-home. This keeps the most useful
    // forward-momentum action one tap away — players who just
    // 3-starred shouldn't have to detour through HomeScene to
    // start the next raid.
    const topRowY = isWin ? cy + 218 : cy + 168;
    const bottomRowY = topRowY + 54;
    const innerW = cardW - 32;
    const halfW = Math.min(180, Math.floor((innerW - 12) / 2));
    const halfSplit = halfW / 2 + 6;

    if (isWin) {
      // Top row — Raid again + Share replay (two equal halves).
      makeHiveButton(this, {
        x: this.scale.width / 2 - halfSplit,
        y: topRowY,
        width: halfW,
        height: 46,
        label: '⚔ Raid again',
        variant: 'primary',
        fontSize: 14,
        onPress: () => this.raidAgain(),
      }).container.setDepth(DEPTHS.resultContent);
      makeHiveButton(this, {
        x: this.scale.width / 2 + halfSplit,
        y: topRowY,
        width: halfW,
        height: 46,
        label: '📣 Share replay',
        variant: 'secondary',
        fontSize: 14,
        onPress: () => void this.shareOutcome(stars),
      }).container.setDepth(DEPTHS.resultContent);
    } else {
      // Loss — single Raid again CTA centered. The "Share" path
      // is hidden because there's nothing flashy to share, but the
      // forward-momentum button still ships.
      makeHiveButton(this, {
        x: this.scale.width / 2,
        y: topRowY,
        width: Math.min(220, innerW),
        height: 46,
        label: '⚔ Raid again',
        variant: 'primary',
        fontSize: 15,
        onPress: () => this.raidAgain(),
      }).container.setDepth(DEPTHS.resultContent);
    }

    // Bottom row — Back to home, in the calmer secondary variant.
    makeHiveButton(this, {
      x: this.scale.width / 2,
      y: bottomRowY,
      width: Math.min(220, innerW),
      height: 42,
      label: 'Back to home',
      variant: 'secondary',
      fontSize: 14,
      onPress: () => fadeToScene(this, 'HomeScene'),
    }).container.setDepth(DEPTHS.resultContent);
  }

  // "Raid again" CTA from the result screen. Re-enters RaidScene
  // with no prefilled context so matchmaking runs fresh — the
  // simplest way to ship the loop without keeping the post-result
  // UI alive while the next match resolves.
  private raidAgain(): void {
    this.registry.set('prefilledMatch', null);
    this.registry.set('replayContext', null);
    this.registry.set('revengeContext', null);
    fadeToScene(this, 'RaidScene');
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
    // Full-screen layout (Clash-of-Clans style). The HUD chips at the
    // top float as overlay cards above the board (no chrome strip),
    // so the board no longer reserves HUD_H. The modifier bar and
    // deck tray are gameplay-critical chrome that DO get reserved
    // because their interactive areas need stable, exclusive footprints.
    // Everything inside boardContainer (units, buildings, trail
    // graphics) scales together; pointer math unscales.
    //
    // Scale fits the available rect AND zooms up so the playfield
    // fills the viewport on desktop (the previous Math.min(..., 1)
    // cap stranded the board at 768x576 with grass on the sides).
    // Capped at 2.4x for ultra-wide / 4K so tiles don't get chunky.
    const deckLayout = this.deckLayoutMetrics();
    const availW = this.scale.width - 24;
    const availH = this.scale.height - MODIFIER_BAR_H - deckLayout.trayHeight - 40;
    const fit = Math.min(availW / BOARD_W, availH / BOARD_H);
    const scale = Math.min(2.4, fit);
    this.boardContainer.setScale(scale);
    const scaledW = BOARD_W * scale;
    const scaledH = BOARD_H * scale;
    const xOffset = Math.max(12, (this.scale.width - scaledW) / 2);
    const yOffset = MODIFIER_BAR_H + Math.max(8, (availH - scaledH) / 2);
    this.boardContainer.setPosition(xOffset, yOffset);

    // Modifier bar — positioned between HUD and the board. Width is
    // computed from the same MOD_* constants drawModifierBar uses, so
    // any future change to button sizes ripples through both places.
    // 3 action buttons today (Save / Redo / Tactics).
    if (this.modifierBar) {
      const modCount = MODIFIER_KINDS.length;
      const actionCount = 3;
      const groupW =
        modCount * MOD_BTN_W +
        (modCount - 1) * MOD_BTN_GAP +
        actionCount * (MOD_ACTION_GAP + MOD_ACTION_BTN_W);
      const startX = Math.max(12, (this.scale.width - groupW) / 2);
      this.modifierBar.setPosition(startX, HUD_H + 6);
      this.modifierBarBg.clear();
      this.modifierBarBg.fillStyle(0x0a120b, 0.6);
      this.modifierBarBg.fillRoundedRect(-12, -4, groupW + 24, 40, 10);
    }
    this.starsText.setX(this.scale.width - 16);
    this.lootText.setX(this.scale.width - 16);
    this.timerText.setX(this.scale.width / 2);
    // Layer badges sit immediately to the left of the centred timer.
    if (this.layerBadgeSurface) {
      this.layerBadgeSurface.setPosition(this.scale.width / 2 - 60, HUD_H / 2 - 10);
    }
    if (this.layerBadgeUnderground) {
      this.layerBadgeUnderground.setPosition(this.scale.width / 2 - 60, HUD_H / 2 + 10);
    }

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
