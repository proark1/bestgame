import Phaser from 'phaser';

// Scene transitions — short camera fade to smooth the hard
// this.scene.start() cut. Keeps navigation feeling cohesive instead
// of jerking between scenes with different backgrounds. Duration is
// intentionally short (~180 ms) so the game stays snappy.
//
// Usage:
//   - Call `fadeInScene(this)` at the top of a scene's create().
//   - Replace `this.scene.start('HomeScene')` with
//     `fadeToScene(this, 'HomeScene')` anywhere navigation happens.
//
// Re-entrancy guard: if a fade is already in flight we drop the
// request. Without it, rapid-clicking a nav button queues multiple
// camerafadeoutcomplete callbacks and the wrong scene can win.

const DEFAULT_DURATION = 180;
const IN_FLIGHT_KEY = '__fadeInFlight';

export function fadeInScene(
  scene: Phaser.Scene,
  duration: number = DEFAULT_DURATION,
): void {
  // Phaser keeps a single instance per scene key and reuses it on
  // every start. The in-flight flag below is set on `fadeToScene`
  // and lives on the scene instance — without clearing it here, a
  // navigation that left this scene with the flag still raised
  // would short-circuit every subsequent fadeToScene() once the
  // player returns. Symptom: "second click on a menu item does
  // nothing until I reload."
  const sceneAny = scene as unknown as Record<string, unknown>;
  sceneAny[IN_FLIGHT_KEY] = false;
  // Same idea for the modal-active flag: a previous visit might
  // have shut down with a modal mid-close, leaving wireBoardTap
  // gated against any board interaction. Reset on every scene
  // entry so the new visit starts from a clean state.
  scene.data.set('modalActive', false);
  scene.data.set('modalClosedAt', 0);
  scene.cameras.main.fadeIn(duration, 0, 0, 0);
}

export function fadeToScene(
  scene: Phaser.Scene,
  nextKey: string,
  data?: object,
): void {
  // Avoid stacking multiple fade-out requests — see comment above.
  const sceneAny = scene as unknown as Record<string, unknown>;
  if (sceneAny[IN_FLIGHT_KEY]) return;
  sceneAny[IN_FLIGHT_KEY] = true;
  // Defence in depth: clear the flag on shutdown too, so a scene
  // that's started by some other path (this.scene.start with no
  // fadeInScene) still resets the latch the next time we navigate
  // away from it. fadeInScene above is the primary clear point;
  // this catches the rest.
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    sceneAny[IN_FLIGHT_KEY] = false;
  });
  scene.cameras.main.fadeOut(DEFAULT_DURATION, 0, 0, 0);
  scene.cameras.main.once(
    Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE,
    () => {
      if (data) scene.scene.start(nextKey, data);
      else scene.scene.start(nextKey);
    },
  );
}
