// "While you were away" modal — surfaces defensive raids the player
// missed since their last home-screen visit. The single most
// addictive screen in mobile strategy games: combines emotional
// salience (you were attacked!), a watchable replay (the determinism
// payoff), and a one-tap REVENGE CTA that funnels players into the
// next raid. Top-10 audit #10.
//
// Drives off /player/raids (already populated from the raids table)
// + a localStorage `lastSeenAt` cursor — no server schema change.
// Shown at most once per session; the cursor is bumped to "now" on
// dismiss so re-opening the app doesn't re-show the same defenses.

import Phaser from 'phaser';
import type { HiveRuntime } from '../main.js';
import type { RaidHistoryEntry } from '../net/Api.js';
import { makeHiveButton } from './button.js';
import { drawPanel } from './panel.js';
import { crispText } from './text.js';
import { fadeToScene } from './transitions.js';
import {
  COLOR,
  DEPTHS,
  bodyTextStyle,
  displayTextStyle,
  labelTextStyle,
} from './theme.js';

const STORAGE_KEY = 'hive.whileAway.lastSeen';
const SHOWN_THIS_SESSION_KEY = 'hive.whileAway.shownThisSession';

function readLastSeen(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeLastSeen(ts: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(ts));
  } catch {
    // ignore quota
  }
}

function shownThisSession(): boolean {
  // Session-local: sessionStorage clears when the tab is closed but
  // survives a route change inside the SPA. That's the right grain
  // — we want one show per launch, not one per app lifetime.
  try {
    return sessionStorage.getItem(SHOWN_THIS_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function markShownThisSession(): void {
  try {
    sessionStorage.setItem(SHOWN_THIS_SESSION_KEY, '1');
  } catch {
    /* ignore */
  }
}

export interface WhileAwayResult {
  shown: boolean;
  defenseCount: number;
}

// Fetch defenses, decide whether to show the modal, and (if so)
// open it on the given scene. Best-effort: any failure silently
// no-ops so a flaky network can't block the home screen.
export async function maybeShowWhileAway(
  scene: Phaser.Scene,
  runtime: HiveRuntime,
): Promise<WhileAwayResult> {
  if (shownThisSession()) return { shown: false, defenseCount: 0 };
  const lastSeen = readLastSeen();
  let raids: RaidHistoryEntry[] = [];
  try {
    raids = await runtime.api.getRaidHistory(20);
  } catch {
    return { shown: false, defenseCount: 0 };
  }
  // First-ever visit (no cursor): set the cursor without showing
  // anything. We don't want a brand-new player landing in a "you
  // were attacked 5 times!" modal that lists raids from before they
  // even installed this app.
  if (lastSeen === 0) {
    writeLastSeen(Date.now());
    markShownThisSession();
    return { shown: false, defenseCount: 0 };
  }
  const defenses = raids.filter(
    (r) => r.role === 'defender' && new Date(r.createdAt).getTime() > lastSeen,
  );
  if (defenses.length === 0) {
    writeLastSeen(Date.now());
    markShownThisSession();
    return { shown: false, defenseCount: 0 };
  }
  showWhileAwayModal(scene, runtime, defenses);
  return { shown: true, defenseCount: defenses.length };
}

function showWhileAwayModal(
  scene: Phaser.Scene,
  runtime: HiveRuntime,
  defenses: RaidHistoryEntry[],
): void {
  markShownThisSession();
  // Modal occupies the upper-middle of the viewport. Width caps at
  // 540 so it doesn't sprawl on tablets; height is row-driven.
  const W = Math.min(540, scene.scale.width - 32);
  const visible = defenses.slice(0, 3); // top 3 fits without scroll
  const rowH = 84;
  const padding = 18;
  const headerH = 70;
  const footerH = 56;
  const H = headerH + visible.length * (rowH + 8) + footerH + padding;
  const X = Math.round((scene.scale.width - W) / 2);
  const Y = Math.max(40, Math.round((scene.scale.height - H) / 2 - 20));

  // Backdrop scrim — taps outside the panel dismiss.
  const scrim = scene.add
    .rectangle(0, 0, scene.scale.width, scene.scale.height, 0x000000, 0.55)
    .setOrigin(0)
    .setDepth(DEPTHS.drawerBackdrop)
    .setInteractive();

  const panel = scene.add.graphics().setDepth(DEPTHS.drawer);
  drawPanel(panel, X, Y, W, H, {
    stroke: COLOR.red, strokeWidth: 3,
    highlight: 0xff9a80, highlightAlpha: 0.18,
    radius: 14, shadowOffset: 6, shadowAlpha: 0.4,
  });

  const headers: Phaser.GameObjects.GameObject[] = [];
  // Animated "WHILE YOU WERE AWAY" eyebrow.
  const eyebrow = crispText(
    scene, X + W / 2, Y + 18,
    'WHILE YOU WERE AWAY',
    labelTextStyle(11, '#ff9a80'),
  ).setOrigin(0.5).setDepth(DEPTHS.drawer + 1);
  scene.tweens.add({
    targets: eyebrow,
    alpha: { from: 0.5, to: 1 },
    duration: 700,
    yoyo: true,
    repeat: -1,
    ease: 'Sine.easeInOut',
  });
  headers.push(eyebrow);
  headers.push(
    crispText(
      scene, X + W / 2, Y + 40,
      defenses.length === 1
        ? `${defenses[0]!.opponentName} raided your hive.`
        : `${defenses.length} attacks on your hive.`,
      displayTextStyle(18, COLOR.textGold, 3),
    ).setOrigin(0.5).setDepth(DEPTHS.drawer + 1),
  );

  // Per-defense rows
  const rows: Phaser.GameObjects.GameObject[] = [];
  let cursorY = Y + headerH;
  for (const d of visible) {
    const rowX = X + padding;
    const rowW = W - padding * 2;
    const rowBg = scene.add.graphics().setDepth(DEPTHS.drawer + 1);
    drawPanel(rowBg, rowX, cursorY, rowW, rowH, {
      topColor: d.stars > 0 ? 0x3b1818 : 0x1f2148,
      botColor: 0x0c0e22,
      stroke: d.stars > 0 ? COLOR.red : COLOR.outline,
      strokeWidth: 1.5,
      highlight: d.stars > 0 ? 0xff9a80 : COLOR.greenHi,
      highlightAlpha: 0.12,
      radius: 10, shadowOffset: 2, shadowAlpha: 0.2,
    });
    rows.push(rowBg);

    rows.push(
      crispText(
        scene, rowX + 14, cursorY + 12,
        d.opponentName,
        displayTextStyle(15, COLOR.textGold, 2),
      ).setDepth(DEPTHS.drawer + 2),
    );
    const trophyStr =
      d.trophyDelta > 0 ? `+${d.trophyDelta}` : `${d.trophyDelta}`;
    rows.push(
      crispText(
        scene, rowX + 14, cursorY + 34,
        `${'★'.repeat(d.stars)}${'☆'.repeat(3 - d.stars)}   ${trophyStr} 🏆   ${d.sugarLooted} 🍬`,
        bodyTextStyle(12, COLOR.textOnDark),
      ).setDepth(DEPTHS.drawer + 2),
    );

    // Per-row Watch button — re-uses the same /replay/:id flow the
    // RaidHistoryScene uses.
    const watchBtn = makeHiveButton(scene, {
      x: rowX + rowW - 156,
      y: cursorY + rowH / 2,
      width: 88,
      height: 30,
      label: '▶ Replay',
      variant: 'secondary',
      fontSize: 11,
      onPress: () => {
        void watchDefense(scene, runtime, d);
      },
    });
    watchBtn.container.setDepth(DEPTHS.drawer + 2);
    rows.push(watchBtn.container);

    // Revenge — only when the attacker is a real player.
    if (d.opponentId) {
      const revengeBtn = makeHiveButton(scene, {
        x: rowX + rowW - 60,
        y: cursorY + rowH / 2,
        width: 110,
        height: 30,
        label: '⚔ Revenge',
        variant: 'danger',
        fontSize: 11,
        onPress: () => {
          scene.registry.set('revengeContext', { defenderId: d.opponentId });
          dismiss();
          fadeToScene(scene, 'RaidScene');
        },
      });
      revengeBtn.container.setDepth(DEPTHS.drawer + 2);
      rows.push(revengeBtn.container);
    }
    cursorY += rowH + 8;
  }

  // Footer — "see all" + dismiss
  const seeAllBtn = makeHiveButton(scene, {
    x: X + W / 2 - 80,
    y: Y + H - 24,
    width: 140,
    height: 34,
    label: 'See all defenses',
    variant: 'ghost',
    fontSize: 12,
    onPress: () => {
      dismiss();
      fadeToScene(scene, 'RaidHistoryScene');
    },
  });
  seeAllBtn.container.setDepth(DEPTHS.drawer + 2);
  const dismissBtn = makeHiveButton(scene, {
    x: X + W / 2 + 80,
    y: Y + H - 24,
    width: 140,
    height: 34,
    label: 'Got it',
    variant: 'primary',
    fontSize: 12,
    onPress: () => dismiss(),
  });
  dismissBtn.container.setDepth(DEPTHS.drawer + 2);

  const dismiss = (): void => {
    writeLastSeen(Date.now());
    scrim.destroy();
    panel.destroy();
    for (const o of [...headers, ...rows]) o.destroy();
    seeAllBtn.destroy();
    dismissBtn.destroy();
  };
  scrim.on('pointerdown', dismiss);
}

async function watchDefense(
  scene: Phaser.Scene,
  runtime: HiveRuntime,
  d: RaidHistoryEntry,
): Promise<void> {
  try {
    const full = await runtime.api.replay(d.id);
    scene.registry.set('replayContext', {
      id: full.replay.id,
      seed: full.replay.seed,
      baseSnapshot: full.replay.baseSnapshot,
      inputs: full.replay.inputs,
      replayName: full.replay.replayName,
      attackerName: full.replay.attackerName,
      defenderName: full.replay.defenderName,
    });
    fadeToScene(scene, 'RaidScene');
  } catch {
    // Best-effort; user can fall back to See All.
  }
}
