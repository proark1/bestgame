// Hive Wars admin panel — Gemini sprite generation, compression, and
// save. Vanilla TS + CSS, no React, no Phaser. Loaded from admin.html
// so the public game bundle stays lean.

import {
  downloadAllSprites,
  fetchAnimationSettings,
  fetchPrompts,
  fetchStatus,
  getToken,
  putAnimationSettings,
  setToken,
  updatePrompt,
  type AnimationSettings,
  type PromptsFile,
  type SpriteFile,
} from './api.js';
import { SpriteCard } from './SpriteCard.js';
import { humanBytes } from './compress.js';

// Keep in sync with client/src/assets/atlas.ts UNIT_SPRITE_KEYS / BUILDING_SPRITE_KEYS.
const UNIT_KEYS = [
  'WorkerAnt',
  'SoldierAnt',
  'DirtDigger',
  'Forager',
  'Wasp',
  'HoneyTank',
  'ShieldBeetle',
  'BombBeetle',
  'Roller',
  'Jumper',
  'WebSetter',
  'Ambusher',
];
const BUILDING_KEYS = [
  'QueenChamber',
  'DewCollector',
  'MushroomTurret',
  'LeafWall',
  'PebbleBunker',
  'LarvaNursery',
  'SugarVault',
  'TunnelJunction',
  'DungeonTrap',
];

interface Compression {
  format: 'webp' | 'png';
  quality: number;
  maxDim: number;
}

interface AdminState {
  prompts: PromptsFile | null;
  files: SpriteFile[];
  cards: SpriteCard[];
  compression: Compression;
  progressEl: HTMLDivElement | null;
  animation: AnimationSettings | null;
}

const state: AdminState = {
  prompts: null,
  files: [],
  cards: [],
  compression: { format: 'webp', quality: 0.85, maxDim: 256 },
  progressEl: null,
  animation: null,
};

const root = document.getElementById('admin-root') as HTMLDivElement;
root.className = 'admin-root';

function statusToast(msg: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  let el = document.querySelector('.status') as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.className = 'status';
    document.body.append(el);
  }
  el.className = `status visible ${kind === 'info' ? '' : kind}`;
  el.textContent = msg;
  clearTimeout((statusToast as unknown as { _t?: number })._t);
  (statusToast as unknown as { _t?: number })._t = window.setTimeout(() => {
    el!.classList.remove('visible');
  }, 3000);
}

function showAuthModal(): void {
  const existing = document.querySelector('.auth-modal');
  if (existing) return;
  const modal = document.createElement('div');
  modal.className = 'auth-modal';
  modal.innerHTML = `
    <form class="auth-card" autocomplete="off">
      <h2>Hive Wars admin</h2>
      <p>Paste the ADMIN_TOKEN from your Railway deploy. The token is stored locally in this browser and sent as a bearer header.</p>
      <input type="password" name="token" placeholder="admin token" required autofocus />
      <button type="submit" class="btn accent">Unlock</button>
      <p><small>Running on localhost? Empty token is accepted.</small></p>
    </form>
  `;
  const form = modal.querySelector('form')!;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = form.querySelector('input[name=token]') as HTMLInputElement;
    setToken(input.value.trim());
    modal.remove();
    void bootstrap();
  });
  document.body.append(modal);
}

window.addEventListener('admin:unauthorized', () => {
  // api.ts dispatches this after a 401.
  statusToast('Admin token rejected — re-enter', 'error');
  showAuthModal();
});

async function bootstrap(): Promise<void> {
  root.innerHTML = '';
  try {
    const [statusRes, promptsRes] = await Promise.all([fetchStatus(), fetchPrompts()]);
    state.files = statusRes.files;
    state.prompts = promptsRes;
  } catch (err) {
    statusToast((err as Error).message, 'error');
    if ((err as Error).message === 'unauthorized') return;
    return;
  }
  // Animation settings are best-effort — the admin panel is still
  // usable without them (the rest of the sprite pipeline doesn't
  // depend on the toggle). If the DB is offline the server returns
  // the defaults with dbPersistence = 'not-configured'.
  try {
    state.animation = await fetchAnimationSettings();
  } catch (err) {
    console.warn('animation settings unreachable', err);
  }
  render();
}

function render(): void {
  root.innerHTML = '';

  // -- Header ---------------------------------------------------------------
  const header = document.createElement('header');
  header.className = 'admin-header';
  header.innerHTML = `
    <div>
      <h1>Hive Wars · Admin</h1>
      <small>Gemini sprite generation · ${state.files.length} file(s) on disk</small>
    </div>
  `;
  const actions = document.createElement('div');
  actions.className = 'actions';
  const automateBtn = button('⚡ Automate all missing', 'btn accent', () =>
    void automateAllMissing(),
  );
  const genAllBtn = button('Generate (review)', 'btn', () =>
    void generateAllMissing(),
  );
  const downloadZipBtn = button('Download .zip', 'btn', () =>
    void downloadZip(),
  );
  const viewBtn = button('Open game', 'btn ghost', () => {
    window.location.href = '/';
  });
  const logoutBtn = button('Logout', 'btn ghost', () => {
    setToken('');
    window.location.reload();
  });
  actions.append(automateBtn, genAllBtn, downloadZipBtn, viewBtn, logoutBtn);
  header.append(actions);
  root.append(header);

  root.append(renderGuide());
  // The animation panel is compact and useful in both states: whether
  // the admin toggles the feature, or just wants to confirm that
  // three walk-cycle strips are on disk. Rendered unconditionally;
  // it gracefully handles the "no walk sheet yet" case inline.
  root.append(renderAnimationPanel());

  // Slim progress bar tucked under the header — hidden until a batch is
  // running. Lives in the DOM permanently so state.progressEl is always
  // a valid reference for the handler.
  const progress = document.createElement('div');
  progress.className = 'progress';
  progress.hidden = true;
  progress.innerHTML = '<div class="progress-bar"></div><span class="progress-label"></span>';
  root.append(progress);
  state.progressEl = progress;

  // -- Toolbar --------------------------------------------------------------
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';

  const fmtLabel = document.createElement('label');
  fmtLabel.innerHTML = `<span>format</span>`;
  const fmtSel = document.createElement('select');
  for (const f of ['webp', 'png']) {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f.toUpperCase();
    fmtSel.append(opt);
  }
  fmtSel.value = state.compression.format;
  fmtSel.addEventListener('change', () => {
    state.compression.format = fmtSel.value as 'webp' | 'png';
  });
  fmtLabel.append(fmtSel);

  const qLabel = document.createElement('label');
  qLabel.innerHTML = `<span>quality</span>`;
  const qInput = document.createElement('input');
  qInput.type = 'range';
  qInput.min = '0.4';
  qInput.max = '1';
  qInput.step = '0.05';
  qInput.value = String(state.compression.quality);
  const qVal = document.createElement('span');
  qVal.textContent = qInput.value;
  qInput.addEventListener('input', () => {
    state.compression.quality = Number(qInput.value);
    qVal.textContent = qInput.value;
  });
  qLabel.append(qInput, qVal);

  const dLabel = document.createElement('label');
  dLabel.innerHTML = `<span>max dim (px)</span>`;
  const dInput = document.createElement('input');
  dInput.type = 'number';
  dInput.min = '64';
  dInput.max = '1024';
  dInput.step = '32';
  dInput.value = String(state.compression.maxDim);
  dInput.addEventListener('change', () => {
    state.compression.maxDim = Math.max(64, Math.min(1024, Number(dInput.value) || 256));
    dInput.value = String(state.compression.maxDim);
  });
  dLabel.append(dInput);

  toolbar.append(fmtLabel, qLabel, dLabel);

  // Summary counters
  const summary = document.createElement('label');
  summary.style.marginLeft = 'auto';
  const totalSize = state.files.reduce((acc, f) => acc + f.size, 0);
  summary.innerHTML = `<span style="color: var(--text)">${state.files.length} saved · ${humanBytes(
    totalSize,
  )}</span>`;
  toolbar.append(summary);

  root.append(toolbar);

  // -- Style-lock editor ----------------------------------------------------
  const styleBox = document.createElement('div');
  styleBox.className = 'style-lock';
  styleBox.innerHTML = `<h3>Global style lock (applied to every sprite)</h3>`;
  const styleTxt = document.createElement('textarea');
  styleTxt.value = state.prompts?.styleLock ?? '';
  styleTxt.addEventListener('change', async () => {
    try {
      await updatePrompt({ category: 'styleLock', value: styleTxt.value });
      if (state.prompts) state.prompts.styleLock = styleTxt.value;
      statusToast('Style lock saved', 'success');
    } catch (err) {
      statusToast((err as Error).message, 'error');
    }
  });
  styleBox.append(styleTxt);
  root.append(styleBox);

  // -- Sprite grid ----------------------------------------------------------
  const grid = document.createElement('div');
  grid.className = 'grid';
  state.cards = [];

  const fileByKey = new Map<string, SpriteFile>();
  for (const f of state.files) {
    const base = f.name.replace(/\.(png|webp)$/i, '');
    fileByKey.set(base, f);
  }

  const mk = (kind: 'unit' | 'building', baseName: string): SpriteCard => {
    const key = `${kind}-${baseName}`;
    const file = fileByKey.get(key);
    const ext = file ? (file.name.endsWith('.webp') ? 'webp' : 'png') : null;
    const initialPrompt =
      state.prompts?.[kind === 'unit' ? 'units' : 'buildings']?.[baseName] ?? '';
    return new SpriteCard({
      key,
      initialPrompt,
      fileMeta: {
        exists: !!file,
        size: file?.size ?? 0,
        ext,
      },
      composePrompt: (desc) => composePrompt(desc, kind),
      getCompression: () => state.compression,
      onPromptSave: async (value) => {
        await updatePrompt({
          category: kind === 'unit' ? 'units' : 'buildings',
          key: baseName,
          value,
        });
        if (state.prompts) {
          const bucket = kind === 'unit' ? state.prompts.units : state.prompts.buildings;
          bucket[baseName] = value;
        }
      },
      onSaved: () => {},
      showStatus: statusToast,
    });
  };

  for (const u of UNIT_KEYS) {
    const card = mk('unit', u);
    state.cards.push(card);
    grid.append(card.root);
  }
  for (const b of BUILDING_KEYS) {
    const card = mk('building', b);
    state.cards.push(card);
    grid.append(card.root);
  }

  root.append(grid);
}

function composePrompt(description: string, kind: 'unit' | 'building'): string {
  const style = state.prompts?.styleLock ?? '';
  const size = kind === 'unit' ? '128x128' : '192x192';
  return [
    `Subject: ${description}.`,
    `Style: ${style}`,
    `Canvas: ${size} pixels, fully transparent background (RGBA alpha=0 outside the subject), no sky, no ground plane, no solid backdrop, no border, no text, no watermark.`,
    `Composition: subject centered, single character/object only, facing viewer, small soft shadow directly below feet. Plenty of headroom.`,
    `Consistency: matches a shared cohesive game atlas — same outline thickness, same palette, same perspective as sibling sprites.`,
  ].join(' ');
}

// Animation toggle panel. One row per animated unit kind; each row has
// a checkbox that PUTs to /admin/api/settings/animation. Shows a badge
// when the walk spritesheet is missing from the on-disk listing so the
// admin knows to generate it before turning the toggle on.
function renderAnimationPanel(): HTMLElement {
  const card = document.createElement('section');
  card.className = 'admin-animation';
  card.innerHTML = `
    <header>
      <h2>Unit animations</h2>
      <small>Toggle the walk-cycle spritesheet per unit. Generate the strip with the Gemini walkCycles prompt; then flip the switch to see it in-game.</small>
    </header>
  `;
  const settings = state.animation;
  if (!settings) {
    const msg = document.createElement('p');
    msg.className = 'admin-animation-empty';
    msg.textContent =
      'Animation settings unreachable. Check the API/DB is up, then reload the admin.';
    card.append(msg);
    return card;
  }
  if (settings.dbPersistence === 'not-configured') {
    const msg = document.createElement('p');
    msg.className = 'admin-animation-warning';
    msg.textContent =
      'DATABASE_URL not configured — toggles below are read-only defaults and won\'t persist until the API is connected to Postgres.';
    card.append(msg);
  }

  // Helper: does a walk spritesheet exist for this kind, in any source?
  // The admin `files` list is a merged dist + public + db view, so one
  // lookup tells us whether the admin has saved a walk strip yet.
  const hasSheet = (kind: string): boolean =>
    state.files.some(
      (f) => f.name === `unit-${kind}-walk.webp` || f.name === `unit-${kind}-walk.png`,
    );

  const list = document.createElement('ul');
  list.className = 'admin-animation-list';
  for (const kind of settings.kinds) {
    const row = document.createElement('li');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = settings.values[kind] ?? true;
    checkbox.id = `anim-toggle-${kind}`;
    checkbox.disabled = settings.dbPersistence === 'not-configured';
    checkbox.addEventListener('change', async () => {
      const nextValues: Record<string, boolean> = { ...settings.values };
      nextValues[kind] = checkbox.checked;
      try {
        const res = await putAnimationSettings(nextValues);
        settings.values = res.values;
        statusToast(`Animation ${checkbox.checked ? 'on' : 'off'} for ${kind}`, 'success');
      } catch (err) {
        checkbox.checked = !checkbox.checked; // revert
        statusToast(`Could not save: ${(err as Error).message}`, 'error');
      }
    });
    const label = document.createElement('label');
    label.htmlFor = checkbox.id;
    label.textContent = kind;
    const status = document.createElement('span');
    status.className = 'admin-animation-status';
    status.textContent = hasSheet(kind) ? 'strip ready' : 'no strip generated yet';
    status.dataset.hasSheet = hasSheet(kind) ? '1' : '0';
    row.append(checkbox, label, status);
    list.append(row);
  }
  card.append(list);
  return card;
}

const GUIDE_OPEN_KEY = 'hivewars.admin.guide.open';

function renderGuide(): HTMLElement {
  const details = document.createElement('details');
  details.className = 'admin-guide';
  const stored = localStorage.getItem(GUIDE_OPEN_KEY);
  details.open = stored === null ? true : stored === '1';
  details.addEventListener('toggle', () => {
    localStorage.setItem(GUIDE_OPEN_KEY, details.open ? '1' : '0');
  });

  const summary = document.createElement('summary');
  summary.innerHTML = '<span>How to get sprites into the game</span><small>step-by-step</small>';
  details.append(summary);

  const ol = document.createElement('ol');
  const steps = [
    'Edit the <b>Global style lock</b> below so every sprite shares the same palette, outline, and perspective.',
    'For each card, write a short subject description in its text box — it auto-saves when you click away.',
    'Click <b>Generate</b> on a card (or <b>Generate (review)</b> to fill every missing sprite at once) and pick the best candidate thumbnail.',
    'Click <b>Remove BG</b> to knock out any leftover backdrop so the sprite is truly transparent. Check the checkerboard shows through.',
    'Click <b>Save</b> to write the image to <code>client/public/assets/sprites/</code> and the live <code>dist/</code> dir.',
    'Click <b>Download .zip</b>, extract into <code>client/public/assets/sprites/</code>, then <code>git add</code> and commit so the art survives the next deploy.',
    'Click <b>Open game</b> and verify the sprite renders cleanly on the terrain with no rectangular patch around it.',
  ];
  for (const html of steps) {
    const li = document.createElement('li');
    li.innerHTML = html;
    ol.append(li);
  }
  details.append(ol);

  return details;
}

function missingCards(): SpriteCard[] {
  return state.cards.filter(
    (c) => !state.files.some((f) => f.name.replace(/\.(png|webp)$/i, '') === c.key),
  );
}

async function generateAllMissing(): Promise<void> {
  const missing = missingCards();
  if (missing.length === 0) {
    statusToast('No missing sprites — everything is generated.', 'success');
    return;
  }
  statusToast(`Generating ${missing.length} missing sprite(s)…`);
  setProgress(0, missing.length, 'Generating');
  // Serialize to avoid quota bursts. Gemini has per-minute limits; 1/sec
  // is conservative and keeps the UI responsive.
  for (let i = 0; i < missing.length; i++) {
    setProgress(i, missing.length, `Generating ${missing[i]!.key}`);
    await missing[i]!.generate();
  }
  clearProgress();
  statusToast(`Done. Pick a candidate per card, then Save.`, 'success');
}

async function automateAllMissing(): Promise<void> {
  const missing = missingCards();
  if (missing.length === 0) {
    statusToast('Nothing to do — every sprite already has a saved image.', 'success');
    return;
  }
  if (
    !confirm(
      `Automate ${missing.length} sprite(s)? Each call uses Gemini quota and ` +
        `auto-saves the first candidate at the current compression settings ` +
        `(${state.compression.format.toUpperCase()}, q=${state.compression.quality}, ` +
        `max ${state.compression.maxDim}px).`,
    )
  ) {
    return;
  }
  setProgress(0, missing.length, 'Automating');
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < missing.length; i++) {
    const card = missing[i]!;
    setProgress(i, missing.length, `Automating ${card.key}`);
    const success = await card.automate();
    if (success) ok++;
    else failed++;
  }
  clearProgress();
  // Refresh file listing so the cards' meta blocks reflect the new saves.
  try {
    const s = await fetchStatus();
    state.files = s.files;
  } catch {
    // non-fatal
  }
  if (failed === 0 && ok > 0) {
    statusToast(
      `Automated ${ok} sprite(s). Downloading .zip for commit…`,
      'success',
    );
    try {
      await downloadAllSprites();
      statusToast(
        'Extract the zip into client/public/assets/sprites/ and commit.',
        'success',
      );
    } catch (err) {
      statusToast(
        `auto-zip failed: ${(err as Error).message} — click Download .zip manually`,
        'error',
      );
    }
  } else {
    statusToast(
      failed === 0
        ? `Nothing generated (cache hits).`
        : `Automated ${ok} / failed ${failed}. See individual cards for details.`,
      failed === 0 ? 'info' : 'error',
    );
  }
}

async function downloadZip(): Promise<void> {
  try {
    statusToast('Packaging zip…');
    await downloadAllSprites();
    statusToast('Zip downloaded. Extract into client/public/assets/sprites/ and commit.', 'success');
  } catch (err) {
    statusToast(`zip failed: ${(err as Error).message}`, 'error');
  }
}

function setProgress(done: number, total: number, label: string): void {
  const el = state.progressEl;
  if (!el) return;
  el.hidden = false;
  const bar = el.querySelector('.progress-bar') as HTMLDivElement;
  const txt = el.querySelector('.progress-label') as HTMLSpanElement;
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  bar.style.width = `${pct}%`;
  txt.textContent = `${label} — ${done} / ${total}`;
}

function clearProgress(): void {
  const el = state.progressEl;
  if (!el) return;
  setTimeout(() => {
    el.hidden = true;
  }, 400);
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// Bootstrap: auth-gate if no token, otherwise fetch and render.
if (!getToken()) {
  // Try one unauthenticated call — if loopback, it'll succeed.
  fetchStatus()
    .then(() => bootstrap())
    .catch(() => showAuthModal());
} else {
  void bootstrap();
}
