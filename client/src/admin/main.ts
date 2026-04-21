// Hive Wars admin panel — Gemini sprite generation, compression, and
// save. Vanilla TS + CSS, no React, no Phaser. Loaded from admin.html
// so the public game bundle stays lean.

import {
  fetchPrompts,
  fetchStatus,
  getToken,
  setToken,
  updatePrompt,
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
}

const state: AdminState = {
  prompts: null,
  files: [],
  cards: [],
  compression: { format: 'webp', quality: 0.85, maxDim: 256 },
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
  const genAllBtn = button('Generate all missing', 'btn accent', () =>
    void generateAllMissing(),
  );
  const viewBtn = button('Open game', 'btn', () => {
    window.location.href = '/';
  });
  const logoutBtn = button('Logout', 'btn ghost', () => {
    setToken('');
    window.location.reload();
  });
  actions.append(genAllBtn, viewBtn, logoutBtn);
  header.append(actions);
  root.append(header);

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
    `Canvas: ${size} pixels, transparent background (alpha), no border, no text, no watermark.`,
    `Composition: subject centered, single character/object only, facing viewer, small soft shadow directly below feet. Plenty of headroom.`,
    `Consistency: matches a shared cohesive game atlas — same outline thickness, same palette, same perspective as sibling sprites.`,
  ].join(' ');
}

async function generateAllMissing(): Promise<void> {
  const missing = state.cards.filter((c) =>
    !state.files.some((f) => f.name.replace(/\.(png|webp)$/i, '') === c.key),
  );
  if (missing.length === 0) {
    statusToast('No missing sprites — everything is generated.', 'success');
    return;
  }
  statusToast(`Generating ${missing.length} missing sprite(s)…`);
  // Serialize to avoid quota bursts. Gemini has per-minute limits; 1/sec
  // is conservative and keeps the UI responsive.
  for (const card of missing) {
    await card.generate();
  }
  statusToast(`Done.`, 'success');
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
