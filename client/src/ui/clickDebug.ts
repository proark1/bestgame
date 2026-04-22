// Click/pointer diagnostics. Three layers the user can enable from
// their browser console if clicks stop registering where they think
// they should:
//
//   localStorage.setItem('hive-debug-clicks', '1')   // enable
//   localStorage.removeItem('hive-debug-clicks')     // disable
//
// …or append `?debug=clicks` to the URL for a per-reload override.
// Intentionally default-OFF so production consoles stay quiet; when
// a user reports a click bug, the first ask is "flip this flag and
// paste the console output."
//
// Once on, three things happen:
//   1. Scene-level pointerdown handler attached in installSceneClickDebug
//      logs raw pointer coords, the canvas bounding rect, and the game
//      scale — so we can immediately tell CSS-vs-buffer misalignment
//      apart from per-button hit-area bugs.
//   2. Every HiveButton's pointerdown logs its label, world bounds,
//      hit-area state and the incoming pointer — so we can see which
//      button actually caught the click and whether its hit zone still
//      aligns with where the user clicked.
//   3. A tiny DOM overlay (bottom-right) shows the latest pointer's
//      game coords live, so a user can confirm that "the click that
//      just happened was at game(x=937, y=612)" without mousing off
//      the canvas to read the console.

export function isClickDebugEnabled(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    if (window.location.search.includes('debug=clicks')) return true;
    return window.localStorage?.getItem('hive-debug-clicks') === '1';
  } catch {
    // Some embedded browsers (FB Instant wrapper) throw on
    // localStorage access; a debug flag that crashes on read would
    // be worse than a missing one.
    return false;
  }
}

// Scene-level pointer logger. Attached once per Phaser.Scene; logs
// every pointerdown with coordinate systems side-by-side so we can
// spot canvas offset vs hit-area bugs at a glance. Safe to call
// multiple times per scene — guards via a data flag on the scene.
export function installSceneClickDebug(scene: Phaser.Scene): void {
  if (!isClickDebugEnabled()) return;
  const anyScene = scene as unknown as Record<string, unknown>;
  if (anyScene.__hiveClickDebugInstalled) return;
  anyScene.__hiveClickDebugInstalled = true;

  scene.input.on(
    'pointerdown',
    (pointer: Phaser.Input.Pointer, currentlyOver: Phaser.GameObjects.GameObject[]) => {
      const game = scene.game;
      const canvas = game.canvas;
      const rect = canvas?.getBoundingClientRect();
      // Label each hit game-object so we can tell what actually
      // caught the press. Most of ours are Zones without a name;
      // fall back to the constructor name + depth so the output
      // still disambiguates.
      const hits = currentlyOver.map((go) => {
        const namedGo = go as unknown as { name?: string; type?: string; depth?: number };
        return {
          name: namedGo.name || namedGo.type || 'unknown',
          depth: namedGo.depth ?? 0,
        };
      });
      const ev = pointer.event as MouseEvent | TouchEvent | undefined;
      const clientX = ev && 'clientX' in ev ? (ev as MouseEvent).clientX : null;
      const clientY = ev && 'clientY' in ev ? (ev as MouseEvent).clientY : null;
      console.log('[hive-click-debug] scene pointerdown', {
        scene: scene.scene.key,
        pointerGame: { x: pointer.x, y: pointer.y },
        pointerWorld: { x: pointer.worldX, y: pointer.worldY },
        client: { x: clientX, y: clientY },
        canvasRect: rect
          ? { top: rect.top, left: rect.left, w: rect.width, h: rect.height }
          : null,
        gameScale: { w: game.scale.width, h: game.scale.height },
        hitCount: hits.length,
        hits,
      });
    },
  );

  mountPointerOverlay();
}

// Tiny fixed-position overlay that shows the last pointer game coords.
// Makes it easy for the user to confirm what coordinates Phaser saw
// for the click they just made — no console-scrolling required.
let overlayMounted = false;

function mountPointerOverlay(): void {
  if (overlayMounted || typeof document === 'undefined') return;
  overlayMounted = true;
  const el = document.createElement('div');
  el.id = 'hive-click-debug-overlay';
  el.style.cssText = [
    'position:fixed',
    'right:8px',
    'bottom:8px',
    'z-index:9999',
    'padding:6px 10px',
    'background:rgba(15,27,16,0.85)',
    'color:#c3e8b0',
    'font:12px ui-monospace,monospace',
    'border:1px solid #3d5e2a',
    'border-radius:6px',
    'pointer-events:none',
    'max-width:80vw',
    'white-space:pre',
  ].join(';');
  el.textContent = 'click debug on\n(no click yet)';
  document.body.appendChild(el);

  window.addEventListener(
    'pointerdown',
    (e: PointerEvent) => {
      const canvas = document.querySelector('#game canvas') as HTMLCanvasElement | null;
      const rect = canvas?.getBoundingClientRect();
      const gameX = rect ? e.clientX - rect.left : e.clientX;
      const gameY = rect ? e.clientY - rect.top : e.clientY;
      el.textContent = [
        'click debug on',
        `client: ${e.clientX.toFixed(0)}, ${e.clientY.toFixed(0)}`,
        `game:   ${gameX.toFixed(0)}, ${gameY.toFixed(0)}`,
        `canvas: ${rect ? `${rect.width.toFixed(0)}x${rect.height.toFixed(0)}` : 'n/a'}`,
      ].join('\n');
    },
    { capture: true },
  );
}
