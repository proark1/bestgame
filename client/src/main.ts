import Phaser from 'phaser';
import { FBInstantBridge } from './fbinstant/FBInstantBridge.js';
import { BootScene } from './scenes/BootScene.js';
import { HomeScene } from './scenes/HomeScene.js';
import { RaidScene } from './scenes/RaidScene.js';
import { LeaderboardScene } from './scenes/LeaderboardScene.js';
import { RaidHistoryScene } from './scenes/RaidHistoryScene.js';
import { UpgradeScene } from './scenes/UpgradeScene.js';
import { ClanScene } from './scenes/ClanScene.js';
import { ArenaScene } from './scenes/ArenaScene.js';
import { AuthClient } from './net/Auth.js';
import { Api, type PlayerMeResponse } from './net/Api.js';

// Shared runtime bag. Scenes pull auth/api/playerState off of this
// registry via scene.registry.get('runtime'). Keeps the Phaser Game
// constructor free of dependency injection plumbing.
export interface HiveRuntime {
  fb: FBInstantBridge;
  auth: AuthClient;
  api: Api;
  player: PlayerMeResponse | null;
}

// Remove the HTML splash shown during initial JS load. Called from two
// places (after FB init, and from BootScene) so the splash never sticks
// if one path hangs — whichever runs first wins. Also clears the safety
// timer so it can't fire redundantly after a successful boot.
let splashTimer: ReturnType<typeof setTimeout> | undefined;

function dismissSplash(): void {
  if (splashTimer !== undefined) {
    clearTimeout(splashTimer);
    splashTimer = undefined;
  }
  document.getElementById('boot-splash')?.remove();
}

// Absolute safety net: no matter what, the splash disappears within 6s.
// If we hit this, something is wrong, but at least the user sees the page.
splashTimer = setTimeout(dismissSplash, 6000);

async function main(): Promise<void> {
  const fb = new FBInstantBridge();
  try {
    await fb.initialize(() => {});
  } catch (err) {
    // FBInstantBridge already catches internally; this is defensive.
    console.warn('boot: FB init threw', err);
  }

  const auth = new AuthClient();
  const api = new Api(auth);
  const runtime: HiveRuntime = { fb, auth, api, player: null };

  // Try to resume a cached session first; on any failure or first load,
  // mint a fresh guest session. If auth fails entirely (backend
  // misconfigured) the client still boots into a guest-local mode with
  // the hardcoded starter base. Scenes check runtime.player before
  // using it; null → fall back.
  try {
    auth.tryResume();
    if (!auth.token) {
      await auth.signInGuest();
    }
    runtime.player = await api.getPlayerMe();
  } catch (err) {
    console.warn('boot: auth/player failed, continuing guest-local', err);
  }

  // HiDPI: the previous version tried `scale.zoom = DPR` here to
  // render the whole canvas at physical resolution. That combined
  // badly with Scale.FIT — FIT already CSS-scales the canvas to the
  // viewport, and zoom multiplied the backing buffer on top, so
  // Phaser's pointer-to-game-coord conversion ended up off by
  // (1 - 1/zoom) of the screen position. In practice every click
  // landed above-and-left of the rendered thing it targeted: the
  // raid/arena drawn pheromone trail floated above the cursor, deck
  // cards ignored taps until you clicked just above them, etc.
  //
  // Canonical fix: render at logical resolution and accept that
  // sprites get browser-upscaled on Retina — still sharp-enough via
  // antialias: true, and pointers align exactly with visuals.
  // Text is the one thing that reads fuzzy under CSS upscale, so the
  // factory patch below keeps glyphs at DPR resolution — drawn at the
  // game's logical coordinates, so no pointer math breaks.
  const dpr = Math.min(Math.max(1, window.devicePixelRatio || 1), 2);

  // Phaser text glyphs rasterize at resolution=1 by default. Patching
  // the factory once so every scene.add.text(...) call across the app
  // automatically renders at DPR — no per-callsite changes needed.
  const _origTextFactory = Phaser.GameObjects.GameObjectFactory.prototype.text;
  Phaser.GameObjects.GameObjectFactory.prototype.text = function patched(
    this: Phaser.GameObjects.GameObjectFactory,
    x: number,
    y: number,
    text: string | string[],
    style?: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text {
    const t = _origTextFactory.call(this, x, y, text, style);
    t.setResolution(dpr);
    return t;
  };
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#0f1b10',
    scale: {
      // Scale.RESIZE instead of FIT: the canvas backing buffer
      // matches the parent #game div's size exactly, so one canvas
      // pixel == one CSS pixel. That eliminates the pointer/visual
      // offset class of bugs (FIT introduces a scale factor between
      // the two; any browser quirk in that conversion => off-click),
      // and the game actually fills the whole viewport instead of
      // being letterboxed into a fixed 768×816 window.
      //
      // Scenes read this.scale.width / this.scale.height for layout
      // positioning; a baseline MIN of 768×820 keeps ultra-tiny
      // viewports readable by letting Phaser scale the scene up.
      mode: Phaser.Scale.RESIZE,
      // Min dims prevent a phone portrait from collapsing scenes
      // into unreadable mush. Max dims keep a 4K monitor from
      // exploding texture budgets.
      min: { width: 768, height: 820 },
      max: { width: 2560, height: 1600 },
    },
    render: {
      pixelArt: false,
      antialias: true,
      // Bilinear filtering on downscaled sprites reads cleaner than
      // nearest-neighbor at the sizes we render; the game is flat
      // cartoon art, not pixel art.
      roundPixels: false,
    },
    // No `physics` block — the shared deterministic sim is our physics;
    // Phaser's built-in physics would add weight and engine-dependent math.
    scene: [
      new BootScene(fb),
      new HomeScene(),
      new RaidScene(),
      new LeaderboardScene(),
      new RaidHistoryScene(),
      new UpgradeScene(),
      new ClanScene(),
      new ArenaScene(),
    ],
  });
  // Runtime is attached to the game registry so scenes can pull it
  // without constructor wiring.
  game.registry.set('runtime', runtime);

  // Phaser initializes the renderer synchronously in the constructor on AUTO.
  // Dismiss the splash now; BootScene.create() will also dismiss as a
  // secondary guard in case the canvas isn't ready yet.
  dismissSplash();

  void game; // Game holds all its own references; variable kept for debuggability.
}

void main().catch((err) => {
  console.error('boot failed', err);
  dismissSplash();
  const el = document.createElement('div');
  // z-index above the splash (10) and any Phaser-managed DOM so the user
  // actually sees the error rather than a blank canvas.
  el.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#ffb0a0;font-family:system-ui;padding:20px;text-align:center;background:#0f1b10;z-index:100;';
  el.textContent = 'Sorry, Hive Wars failed to start. Please reload.';
  document.body.appendChild(el);
});
