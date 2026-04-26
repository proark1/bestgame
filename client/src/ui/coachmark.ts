import Phaser from 'phaser';

// Lightweight in-scene coachmark — a labelled bubble + bouncing arrow
// pointing at a target rectangle. Lives in screen-fixed coordinates
// at a high depth, on top of every other scene UI. Dismisses itself
// when the caller fires its `complete()` method (typically wired to
// the gameplay event the coachmark teaches: a card tap, a path
// commit, a modifier toggle). Strict single-coachmark policy — we
// never stack two on top of each other.
//
// Persistence is the caller's job. The util doesn't touch
// localStorage; it just builds Phaser objects and tears them down.

export interface CoachmarkTarget {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CoachmarkOptions {
  scene: Phaser.Scene;
  target: CoachmarkTarget;
  // Prefer 'above' or 'below' the target. The util re-routes if there
  // isn't enough room (e.g., target is at the top of the screen).
  prefer?: 'above' | 'below';
  title: string;
  body: string;
  // Auto-dismiss after this many ms. 0 = never (caller must call
  // complete()). Defaults to 0 because most coachmarks gate on a
  // gameplay event, not a timer.
  autoDismissMs?: number;
}

export interface CoachmarkHandle {
  complete: () => void;
  // Fires the brief "ack" pulse before destroy — caller can use
  // this when the player has done the thing the coachmark teaches.
  acknowledge: () => void;
}

const BUBBLE_W = 240;
const BUBBLE_H = 86;
const ARROW_SIZE = 14;
const DEPTH = 9001;

export function showCoachmark(opts: CoachmarkOptions): CoachmarkHandle {
  const { scene, target, title, body } = opts;
  const prefer = opts.prefer ?? 'above';

  const container = scene.add.container(0, 0).setDepth(DEPTH);

  // Halo — pulsing rectangle around the target so the eye snaps to
  // it. Drawn first so the bubble paints on top.
  const halo = scene.add.graphics();
  halo.lineStyle(3, 0xffd98a, 1);
  halo.strokeRoundedRect(target.x - 6, target.y - 6, target.w + 12, target.h + 12, 10);
  container.add(halo);
  scene.tweens.add({
    targets: halo,
    alpha: { from: 1, to: 0.35 },
    duration: 700,
    yoyo: true,
    repeat: -1,
    ease: 'Sine.easeInOut',
  });

  // Decide bubble placement so the arrow always points inward at
  // the target. If 'above' would clip the top, flip to 'below', and
  // vice versa.
  let placement = prefer;
  if (placement === 'above' && target.y - BUBBLE_H - ARROW_SIZE - 12 < 8) placement = 'below';
  if (placement === 'below' && target.y + target.h + BUBBLE_H + ARROW_SIZE + 12 > scene.scale.height - 8) placement = 'above';

  const bubbleX = Math.max(
    12,
    Math.min(scene.scale.width - BUBBLE_W - 12, target.x + target.w / 2 - BUBBLE_W / 2),
  );
  const bubbleY = placement === 'above'
    ? target.y - BUBBLE_H - ARROW_SIZE - 8
    : target.y + target.h + ARROW_SIZE + 8;

  const bg = scene.add.graphics();
  bg.fillStyle(0x162216, 0.96);
  bg.lineStyle(2, 0xffd98a, 1);
  bg.fillRoundedRect(bubbleX, bubbleY, BUBBLE_W, BUBBLE_H, 12);
  bg.strokeRoundedRect(bubbleX, bubbleY, BUBBLE_W, BUBBLE_H, 12);
  container.add(bg);

  // Arrow triangle pointing from the bubble toward the target.
  const arrow = scene.add.graphics();
  arrow.fillStyle(0xffd98a, 1);
  const arrowAnchorX = Math.max(
    bubbleX + 18,
    Math.min(bubbleX + BUBBLE_W - 18, target.x + target.w / 2),
  );
  if (placement === 'above') {
    arrow.fillTriangle(
      arrowAnchorX - ARROW_SIZE / 2, bubbleY + BUBBLE_H,
      arrowAnchorX + ARROW_SIZE / 2, bubbleY + BUBBLE_H,
      arrowAnchorX, bubbleY + BUBBLE_H + ARROW_SIZE,
    );
  } else {
    arrow.fillTriangle(
      arrowAnchorX - ARROW_SIZE / 2, bubbleY,
      arrowAnchorX + ARROW_SIZE / 2, bubbleY,
      arrowAnchorX, bubbleY - ARROW_SIZE,
    );
  }
  container.add(arrow);
  scene.tweens.add({
    targets: arrow,
    y: '+=4',
    duration: 480,
    yoyo: true,
    repeat: -1,
    ease: 'Sine.easeInOut',
  });

  const titleText = scene.add.text(bubbleX + 12, bubbleY + 10, title, {
    fontFamily: 'ui-monospace, monospace',
    fontSize: '13px',
    color: '#ffd98a',
    fontStyle: 'bold',
  });
  container.add(titleText);
  const bodyText = scene.add.text(bubbleX + 12, bubbleY + 32, body, {
    fontFamily: 'ui-monospace, monospace',
    fontSize: '12px',
    color: '#e6f5d2',
    wordWrap: { width: BUBBLE_W - 24 },
  });
  container.add(bodyText);

  let dismissed = false;
  let autoTimer: Phaser.Time.TimerEvent | null = null;

  const teardown = (): void => {
    if (dismissed) return;
    dismissed = true;
    if (autoTimer) {
      autoTimer.destroy();
      autoTimer = null;
    }
    scene.tweens.killTweensOf(halo);
    scene.tweens.killTweensOf(arrow);
    scene.tweens.add({
      targets: container,
      alpha: 0,
      duration: 220,
      onComplete: () => container.destroy(true),
    });
  };

  const acknowledge = (): void => {
    if (dismissed) return;
    // Quick green pulse on the halo so the player sees the action
    // registered, then teardown.
    halo.clear();
    halo.lineStyle(3, 0x9be0a8, 1);
    halo.strokeRoundedRect(target.x - 6, target.y - 6, target.w + 12, target.h + 12, 10);
    scene.tweens.killTweensOf(halo);
    scene.tweens.add({
      targets: container,
      alpha: { from: 1, to: 0 },
      duration: 280,
      delay: 120,
      onComplete: () => {
        teardown();
      },
    });
    dismissed = true;
  };

  if (opts.autoDismissMs && opts.autoDismissMs > 0) {
    autoTimer = scene.time.delayedCall(opts.autoDismissMs, teardown);
  }

  return { complete: teardown, acknowledge };
}
