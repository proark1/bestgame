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
import { CodexScene } from './scenes/CodexScene.js';
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

  // HiDPI strategy. We render the entire canvas at physical resolution
  // (logical × DPR) but keep the CSS box at logical size. Camera
  // projections still use logical coordinates, so:
  //   * pointer math stays identity (canvas CSS size == game size),
  //   * sprites, Graphics, and strokes rasterize at physical pixels,
  //   * the browser never has to bitmap-upscale the canvas, which was
  //     the "blurry/low-quality" look on Retina phones.
  // The previous attempt failed because it combined scale.zoom=DPR
  // with Scale.FIT; FIT already does its own CSS scaling, so the two
  // compounded and pointer coords drifted. With Scale.RESIZE + manual
  // backing-buffer override (see syncCanvasSize below) both layers
  // stay consistent.
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
      // No min dims: phone viewports (~375×667) get the game at
      // their native pixel density, not letterboxed behind a 768×820
      // clamp. Scenes handle narrow viewports by scaling the board
      // container down and stacking the footer into two rows — see
      // HomeScene.handleResize() + layoutFooter().
      // Max cap on ultra-wide monitors to keep texture cost finite.
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
      new CodexScene(),
    ],
  });
  // Runtime is attached to the game registry so scenes can pull it
  // without constructor wiring.
  game.registry.set('runtime', runtime);

  // Backing-buffer override. Phaser's Scale.RESIZE defaults to
  // canvas.width === game.scale.width (logical), which leaves HiDPI
  // upscaling to the browser's bitmap sampler — i.e. blurry on every
  // Retina phone/laptop. We override after every resize so:
  //   canvas.width / height      = logical × DPR  (physical pixels)
  //   canvas.style.width / height = logical       (CSS pixels)
  //   WebGL viewport             = physical       (via renderer.resize)
  //   camera projection          = logical        (Phaser default)
  // Pointer-to-game math stays identity because it's driven by CSS
  // size / camera size, both logical.
  const syncCanvasSize = (): void => {
    const c = game.canvas;
    if (!c) return;
    const logicalW = game.scale.width;
    const logicalH = game.scale.height;
    const physW = Math.max(1, Math.round(logicalW * dpr));
    const physH = Math.max(1, Math.round(logicalH * dpr));
    if (c.width !== physW || c.height !== physH) {
      game.renderer.resize(physW, physH);
    }
    c.style.width = `${logicalW}px`;
    c.style.height = `${logicalH}px`;
    c.style.transform = 'none';
    c.style.display = 'block';
  };
  syncCanvasSize();
  game.scale.on('resize', syncCanvasSize);

  // One-shot pointer diagnostic. Logs on the first pointerdown of a
  // session so a user who reports "clicks are offset by N cm" can
  // paste one console line and we can see canvas rect vs game coords
  // vs client coords side by side. Guarded via a query string so it
  // doesn't clutter prod consoles for everyone else.
  if (typeof window !== 'undefined' && window.location.search.includes('debug=pointer')) {
    let logged = false;
    window.addEventListener('pointerdown', (e: PointerEvent) => {
      if (logged) return;
      logged = true;
      const c = game.canvas;
      const rect = c.getBoundingClientRect();
      console.log('[hive-debug] first pointerdown', {
        client: { x: e.clientX, y: e.clientY },
        canvasRect: { top: rect.top, left: rect.left, w: rect.width, h: rect.height },
        canvasAttr: { w: c.width, h: c.height },
        gameScale: { w: game.scale.width, h: game.scale.height },
        dpr: window.devicePixelRatio,
        cssZoom: window.getComputedStyle(c).transform,
      });
    }, { capture: true });
  }

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
