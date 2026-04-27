// First-run tutorial overlay. Vanilla DOM (not Phaser) because it's
// plain text + buttons and layering one over the canvas is simpler
// as a CSS overlay. Stored gate in localStorage so the user sees it
// exactly once — "Don't show again" is the default on the close
// button, with a secondary "Show tutorial" link added to the account
// chip menu so they can reopen it later.

// Bumped when the tutorial copy materially changes. Returning
// players see the refreshed walkthrough once.
//
// v3 added an Economy section explaining what each resource is for
// + a Progression section showing what unlocks at colony levels
// 1–5, so a new player can see the loop and the long-term goal in
// one read.
const SEEN_KEY = 'hive.tutorialSeen.v3';
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
.hive-tutorial-flow {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin: 10px 0 4px;
}
.hive-tutorial-flow-step {
  background: rgba(255, 217, 138, 0.06);
  border: 1px solid rgba(255, 217, 138, 0.18);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11px;
  color: #cee1b4;
  text-align: center;
}
.hive-tutorial-flow-step b {
  color: #ffd98a;
  display: block;
  font-size: 12px;
  margin-bottom: 2px;
}
.hive-tutorial-resources {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
  margin: 8px 0 4px;
}
.hive-tutorial-res {
  background: rgba(0, 0, 0, 0.25);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11px;
  color: #cee1b4;
}
.hive-tutorial-res b {
  display: block;
  font-size: 13px;
  margin-bottom: 4px;
}
.hive-tutorial-res.sugar b { color: #ffd98a; }
.hive-tutorial-res.leaf b  { color: #c3e8b0; }
.hive-tutorial-res.milk b  { color: #e6d4ff; }
.hive-tutorial-tiers {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
  margin: 8px 0 4px;
}
.hive-tutorial-tier {
  background: rgba(255, 217, 138, 0.05);
  border: 1px solid rgba(255, 217, 138, 0.15);
  border-radius: 6px;
  padding: 6px 6px;
  font-size: 10px;
  text-align: center;
  color: #cee1b4;
}
.hive-tutorial-tier b {
  display: block;
  color: #ffd98a;
  font-size: 12px;
  margin-bottom: 2px;
}
@media (max-width: 520px) {
  .hive-tutorial-flow { grid-template-columns: repeat(2, 1fr); }
  .hive-tutorial-resources { grid-template-columns: 1fr; }
  .hive-tutorial-tiers { grid-template-columns: repeat(2, 1fr); }
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
      <div class="hive-tutorial-flow">
        <div class="hive-tutorial-flow-step"><b>1. Build</b>place defenses + producers</div>
        <div class="hive-tutorial-flow-step"><b>2. Raid</b>attack a rival, loot resources</div>
        <div class="hive-tutorial-flow-step"><b>3. Upgrade</b>spend loot on your colony</div>
        <div class="hive-tutorial-flow-step"><b>4. Climb</b>tier up, unlock new units</div>
      </div>

      <h2>Resources</h2>
      <div class="hive-tutorial-resources">
        <div class="hive-tutorial-res sugar"><b>Sugar</b>Spent on every building + colony tier-up. Earned from <code>Dew Collectors</code> and raid loot. Capped by <code>Sugar Vaults</code> — when the wallet hits the cap, production stops until you spend.</div>
        <div class="hive-tutorial-res leaf"><b>Leaf</b>Spent on unit upgrades + nurseries. Earned from <code>Larva Nurseries</code> and raid loot. Capped by nurseries.</div>
        <div class="hive-tutorial-res milk"><b>Aphid Milk</b>Premium currency. Earned three ways: <code>Aphid Farms</code> trickle slowly (colony 4+), <code>login streaks</code> reward 1–5 milk on day 5+, and <code>Campaign chapter</code> completions grant 1–5 milk per chapter. Spent to skip builder timers (1 milk per minute remaining) or unlock cosmetic Queen skins from the shop.</div>
      </div>
      <p style="font-size:12px;opacity:0.7;margin-top:4px">Production happens while you're away — when you come back, the harvest auto-credits up to 8 hours.</p>

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
        <li><code>⚔ Arena</code> — live PvP. <code>👥 Clan</code> — chat and donate units. <code>⚙ Upgrades</code> — spend leaf to level units.</li>
      </ul>

      <h2>Colony levels — what unlocks</h2>
      <p>Tap your Queen Chamber after a successful raid to spend sugar on a tier-up. Each tier raises building caps and unlocks new kinds:</p>
      <div class="hive-tutorial-tiers">
        <div class="hive-tutorial-tier"><b>L1</b>WorkerAnt, SoldierAnt, DirtDigger, Wasp</div>
        <div class="hive-tutorial-tier"><b>L2</b>+ FireAnt · Acid Spitter · Spore Tower · Tunnel Junction</div>
        <div class="hive-tutorial-tier"><b>L3</b>+ Termite · Dragonfly · Hidden Stinger · Root Snare</div>
        <div class="hive-tutorial-tier"><b>L4</b>+ Mantis · Spider Nest · Thorn Hedge · Aphid Farm</div>
        <div class="hive-tutorial-tier"><b>L5</b>+ Scarab · max wall + turret cap</div>
      </div>

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
