// First-run tutorial overlay. Vanilla DOM (not Phaser) because it's
// plain text + buttons and layering one over the canvas is simpler
// as a CSS overlay. Stored gate in localStorage so the user sees it
// exactly once — "Don't show again" is the default on the close
// button, with a secondary "Show tutorial" link added to the account
// chip menu so they can reopen it later.

const SEEN_KEY = 'hive.tutorialSeen';
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
  width: min(560px, 92vw);
  max-height: 90vh; overflow: auto;
  background: linear-gradient(180deg, #1b2c1c, #0f1b10);
  color: #e6f5d2;
  border: 1px solid #3d5e2a;
  border-radius: 16px;
  padding: 22px 26px 18px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
}
.hive-tutorial-card h1 {
  margin: 0 0 4px;
  font-size: 22px;
  color: #ffd98a;
  letter-spacing: 0.5px;
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

      <h2>The loop</h2>
      <ul>
        <li><b>Build</b> your base: tap an empty tile on the Home screen to place a building. Defensive kinds live on the <b>Surface</b>, economy + nursery belong <b>Underground</b>. Flip layers from the footer.</li>
        <li><b>Raid</b> another colony: tap <code>Raid a base →</code> to match against a player in your trophy range. Draw a pheromone path with your finger/mouse to deploy a unit along it.</li>
        <li><b>Climb</b> the ladder: 1–3 stars per raid. Trophies win. Lose raids = lose trophies + loot.</li>
      </ul>

      <h2>Arena & clans</h2>
      <ul>
        <li><code>⚔ Arena</code> — live PvP against another player on the same map.</li>
        <li><code>👥 Clan</code> — join or create one to chat + coordinate.</li>
        <li><code>⚙ Upgrades</code> — spend sugar & leaf to level your units.</li>
      </ul>

      <h2>Save your progress</h2>
      <p>You're playing as a guest. Tap the <code>guest ▾</code> chip in the top-left to register — progress carries over, and you can log in on any other device.</p>

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
