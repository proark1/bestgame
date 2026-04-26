// First-run tutorial overlay. Vanilla DOM (not Phaser) because it's
// plain text + buttons and layering one over the canvas is simpler
// as a CSS overlay. Stored gate in localStorage so the user sees it
// exactly once — "Don't show again" is the default on the close
// button, with a secondary "Show tutorial" link added to the account
// chip menu so they can reopen it later.

// Bumped when the tutorial copy materially changes (e.g. adding the
// build → raid walkthrough + ambush/split/dig explanation). Returning
// players see the refreshed walkthrough once.
const SEEN_KEY = 'hive.tutorialSeen.v2';
const STYLE_ID = 'hive-tutorial-style';

const CSS = `
.hive-tutorial-overlay {
  position: fixed; inset: 0;
  background: rgba(8, 14, 9, 0.82);
  backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
  z-index: 1001;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.hive-tutorial-card {
  width: min(580px, 92vw);
  max-height: 90vh; overflow: auto;
  /* Deep-panel gradient + thick brass border to match the in-game
   * HUD panels. The inset box-shadow is a fake "inner highlight"
   * catching the eye along the top edge — same bevel trick Phaser's
   * panel helper uses. */
  background: linear-gradient(180deg, #243824 0%, #1b2c1c 35%, #0f1b10 100%);
  color: #f4e9cc;
  border: 3px solid #5c4020;
  border-radius: 18px;
  padding: 24px 28px 20px;
  box-shadow:
    inset 0 2px 0 rgba(255, 217, 138, 0.45),
    0 18px 48px rgba(0, 0, 0, 0.6);
}
.hive-tutorial-card h1 {
  margin: 0 0 4px;
  font-size: 26px;
  color: #ffe7b0;
  letter-spacing: 0.5px;
  /* Stroked-title effect without SVG: text-shadow in four directions
   * simulates an outline, and an inner drop shadow beneath adds depth. */
  text-shadow:
    -1px -1px 0 #0a120c,
    1px -1px 0 #0a120c,
    -1px 1px 0 #0a120c,
    1px 1px 0 #0a120c,
    0 3px 6px rgba(0, 0, 0, 0.7);
}
.hive-tutorial-card .hive-tutorial-sub {
  margin: 0 0 14px;
  font-size: 12px;
  color: #9bb88a;
  letter-spacing: 0.5px;
}
.hive-tutorial-card h2 {
  margin: 14px 0 4px;
  font-size: 13px;
  color: #ffd98a;
  text-transform: uppercase;
  letter-spacing: 1.5px;
}
.hive-tutorial-card p, .hive-tutorial-card ul {
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.55;
  color: #cee1b4;
}
.hive-tutorial-card ul {
  padding-left: 20px;
}
.hive-tutorial-card li { margin: 3px 0; }
.hive-tutorial-card code {
  background: rgba(255, 217, 138, 0.12);
  color: #ffd98a;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 12px;
}
.hive-tutorial-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 18px;
}
.hive-tutorial-btn {
  background: #ffd98a;
  color: #0f1b10;
  border: none;
  border-radius: 8px;
  padding: 10px 18px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.hive-tutorial-btn.ghost {
  background: transparent;
  color: #c3e8b0;
  border: 1px solid #3d5e2a;
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.append(el);
}

export function shouldShowTutorial(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== '1';
  } catch {
    return false; // Private mode / storage blocked — don't nag.
  }
}

export function openTutorial(opts: { force?: boolean; onClose?: () => void } = {}): () => void {
  ensureStyle();
  const overlay = document.createElement('div');
  overlay.className = 'hive-tutorial-overlay';
  overlay.innerHTML = `
    <section class="hive-tutorial-card" role="dialog" aria-label="How to play Hive Wars">
      <h1>Welcome to Hive Wars 🐜</h1>
      <p class="hive-tutorial-sub">A backyard colony-vs-colony strategy game. Build, raid, rank up.</p>

      <h2>1 · Build your base</h2>
      <ul>
        <li>Tap an empty tile on the Home screen to place a building. Each building snaps to the green grid — bigger kinds (Queen Chamber) take 2×2, the rest are 1×1.</li>
        <li>Defensive kinds live on the <b>Surface</b>; storage + nursery belong <b>Underground</b>. Flip layers from the footer.</li>
      </ul>

      <h2>2 · Raid an enemy</h2>
      <ul>
        <li>Tap <code>Raid a base →</code>. Pick a unit from the deck, then drag from a glowing edge into the base — your swarm walks the path you draw.</li>
        <li>Three <b>path markers</b> change how the swarm behaves at the midpoint:
          <ul>
            <li><b>Split</b> — half the swarm peels off to attack the nearest building; the rest keeps walking.</li>
            <li><b>Ambush</b> — units pause for ~2s so a follow-up burst catches up and they hit together.</li>
            <li><b>Dig</b> — diggers and termites flip layer (slip past walls or pop up under turrets).</li>
          </ul>
        </li>
        <li>The first time you raid, in-game bubbles will walk you through these one at a time on a starter enemy base.</li>
      </ul>

      <h2>3 · Climb</h2>
      <ul>
        <li>1–3 stars per raid. Trophies up, loot in. Losing raids costs trophies + loot.</li>
        <li><code>⚔ Arena</code> — live PvP. <code>👥 Clan</code> — chat and donate units. <code>⚙ Upgrades</code> — spend sugar & leaf to level units.</li>
      </ul>

      <h2>Save your progress</h2>
      <p>You're playing as a guest. Tap the <code>guest ▾</code> chip in the top-left to register — progress carries over to any device.</p>

      <div class="hive-tutorial-actions">
        <button type="button" class="hive-tutorial-btn ghost" data-act="later">Read later</button>
        <button type="button" class="hive-tutorial-btn" data-act="start">Let's play</button>
      </div>
    </section>
  `;
  document.body.append(overlay);

  const close = (markSeen: boolean): void => {
    if (markSeen) {
      try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore */ }
    }
    overlay.remove();
    opts.onClose?.();
  };
  overlay.querySelector('[data-act="start"]')?.addEventListener('click', () => close(true));
  overlay.querySelector('[data-act="later"]')?.addEventListener('click', () => close(false));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close(false);
  });

  void opts.force;
  return () => close(false);
}
