// Hive Wars admin panel — Gemini sprite generation, compression, and
// save. Vanilla TS + CSS, no React, no Phaser. Loaded from admin.html
// so the public game bundle stays lean.

import {
  downloadAllSprites,
  fetchAnimationSettings,
  fetchPrompts,
  fetchStatus,
  fetchUiOverrideSettings,
  generateImages,
  getToken,
  putAnimationSettings,
  putUiOverrideSettings,
  saveSprite,
  setToken,
  updatePrompt,
  type AnimationSettings,
  type PromptsFile,
  type UiOverrideSettings,
  type SpriteFile,
} from './api.js';
import { SpriteCard } from './SpriteCard.js';
import { compressBase64Image, humanBytes } from './compress.js';

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
  uiOverrides: UiOverrideSettings | null;
}

const state: AdminState = {
  prompts: null,
  files: [],
  cards: [],
  compression: { format: 'webp', quality: 0.85, maxDim: 256 },
  progressEl: null,
  animation: null,
  uiOverrides: null,
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
  try {
    state.uiOverrides = await fetchUiOverrideSettings();
  } catch (err) {
    console.warn('ui-overrides settings unreachable', err);
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
  root.append(renderUiOverridesPanel());

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

  const mk = (
    kind: 'unit' | 'building' | 'menuUi',
    baseName: string,
  ): SpriteCard => {
    // Menu UI keys already carry the 'ui-' prefix so the DB filename
    // and the Phaser texture key are the same string. Unit / building
    // keys follow the legacy `${kind}-${name}` scheme.
    const key = kind === 'menuUi' ? baseName : `${kind}-${baseName}`;
    const file = fileByKey.get(key);
    const ext = file ? (file.name.endsWith('.webp') ? 'webp' : 'png') : null;
    const bucket =
      kind === 'unit'
        ? 'units'
        : kind === 'building'
          ? 'buildings'
          : 'menuUi';
    const initialPrompt = state.prompts?.[bucket]?.[baseName] ?? '';
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
        await updatePrompt({ category: bucket, key: baseName, value });
        if (state.prompts) {
          if (!state.prompts[bucket]) state.prompts[bucket] = {};
          state.prompts[bucket]![baseName] = value;
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
  for (const u of MENU_UI_KEYS) {
    const card = mk('menuUi', u);
    state.cards.push(card);
    grid.append(card.root);
  }

  root.append(grid);
}

// Menu UI asset keys. Kept in sync with tools/gemini-art/prompts.json
// `menuUi` bucket and with UI_OVERRIDE_KEYS on the server. Each key
// is the exact DB filename (without extension), so once Gemini
// generates and the admin saves, the file at
// /assets/sprites/<key>.webp is what the game renders.
const MENU_UI_KEYS = [
  'ui-button-primary-bg',
  'ui-button-secondary-bg',
  'ui-panel-bg',
  'ui-hud-bg',
  'ui-title-banner',
  'ui-board-tile-surface',
];

function composePrompt(
  description: string,
  kind: 'unit' | 'building' | 'menuUi',
): string {
  const style = state.prompts?.styleLock ?? '';
  // Menu UI assets are larger and designed for 9-slice scaling —
  // the prompt shape differs enough that we route it through its
  // own composer instead of twisting the shared subject prompt.
  if (kind === 'menuUi') {
    return [
      `Subject: ${description}`,
      `Style: ${style}`,
      `Delivery: transparent PNG. No text, no icons, no logos, no border, no watermark. The asset must work as-is when composited over any in-game background.`,
    ].join(' ');
  }
  const size = kind === 'unit' ? '128x128' : '192x192';
  return [
    `Subject: ${description}.`,
    `Style: ${style}`,
    `Canvas: ${size} pixels, fully transparent background (RGBA alpha=0 outside the subject), no sky, no ground plane, no solid backdrop, no border, no text, no watermark.`,
    `Composition: subject centered, single character/object only, facing viewer, small soft shadow directly below feet. Plenty of headroom.`,
    `Consistency: matches a shared cohesive game atlas — same outline thickness, same palette, same perspective as sibling sprites.`,
  ].join(' ');
}

// Walk-cycle spritesheet geometry. Duplicated here (not imported from
// @hive/client/src/assets/atlas.ts) because the admin bundle is a
// separate Vite entry point that doesn't share the game's runtime
// code paths. Keep this block in sync if the strip layout ever
// changes — the server-side migration (frames CHECK 1..16) and the
// client loader both enforce the same shape.
const WALK_STRIP_WIDTH = 512;
const WALK_STRIP_HEIGHT = 128;
const WALK_STRIP_FRAME_COUNT = 4;

// Builds the Gemini prompt for a walk-cycle strip. The first line is
// the per-kind description from prompts.json `walkCycles`; the rest
// are deterministic constraints lifted out into one place so all
// three kinds share identical framing rules. Gemini performs much
// better when we restate "four equal-width frames, identical camera"
// three different ways — the model occasionally loses track of the
// frame-count constraint on long prompts, so the redundancy matters.
function composeWalkCyclePrompt(description: string): string {
  const style = state.prompts?.styleLock ?? '';
  return [
    `Subject: ${description}`,
    `Style: ${style}`,
    `Canvas: exactly ${WALK_STRIP_WIDTH}x${WALK_STRIP_HEIGHT} pixels, fully transparent background (RGBA alpha=0 outside the subject), no sky, no ground plane, no solid backdrop, no border, no text, no watermark.`,
    `Composition: one single horizontal spritesheet strip containing exactly ${WALK_STRIP_FRAME_COUNT} frames arranged left-to-right with no gutters between frames. Each frame is ${WALK_STRIP_HEIGHT}x${WALK_STRIP_HEIGHT} pixels and contains the same character at identical scale, identical camera angle, identical vertical position. Frames differ only in leg/wing pose through one looping cycle.`,
    `Consistency: matches a shared cohesive game atlas — same outline thickness, same palette, same perspective as the single-frame sibling sprite.`,
  ].join(' ');
}

// End-to-end: prompt → Gemini → compress to webp preserving 512×128
// → save with frames=${WALK_STRIP_FRAME_COUNT}. Caller is responsible
// for feedback/refresh; returns the saved path on success so bulk
// runners can tell completed kinds from skipped ones.
async function generateWalkCycle(
  kind: string,
  onProgress?: (note: string) => void,
): Promise<{ path: string; size: number }> {
  const bucket = state.prompts?.walkCycles;
  const description = bucket?.[kind];
  if (!description || description.trim() === '') {
    throw new Error(
      `no walkCycles prompt for ${kind} — add one to tools/gemini-art/prompts.json`,
    );
  }
  const fullPrompt = composeWalkCyclePrompt(description);

  onProgress?.(`${kind}: generating…`);
  const imgs = await generateImages({ prompt: fullPrompt, variants: 1 });
  const first = imgs[0];
  if (!first) throw new Error('Gemini returned no image');

  onProgress?.(`${kind}: compressing…`);
  // maxDimension = WALK_STRIP_WIDTH keeps the strip at 512×128 (or
  // shrinks proportionally if Gemini over-delivered). Quality a touch
  // higher than the 0.85 used for singleton sprites because frame
  // detail is divided by four — worth the extra bytes.
  const compressed = await compressBase64Image(first.data, first.mimeType, {
    format: 'webp',
    quality: 0.9,
    maxDimension: WALK_STRIP_WIDTH,
  });

  onProgress?.(`${kind}: saving…`);
  const res = await saveSprite({
    key: `unit-${kind}-walk`,
    data: compressed.base64,
    format: 'webp',
    frames: WALK_STRIP_FRAME_COUNT,
  });
  return res;
}

// Animation toggle + generation panel. One row per animated unit kind:
// checkbox toggles settings.values[kind]; a "Generate" button runs
// the full pipeline and updates the strip-ready badge. A top-level
// "Automate all missing" button iterates the kinds sequentially so
// the UI can show per-kind progress rather than a single hang.
function renderAnimationPanel(): HTMLElement {
  const card = document.createElement('section');
  card.className = 'admin-animation';
  const header = document.createElement('header');
  header.innerHTML = `
    <h2>Unit animations</h2>
    <small>One-click generate the walk-cycle strip, then toggle to see it in-game. Regenerates overwrite the existing strip.</small>
  `;
  card.append(header);

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

  const hasSheet = (kind: string): boolean =>
    state.files.some(
      (f) => f.name === `unit-${kind}-walk.webp` || f.name === `unit-${kind}-walk.png`,
    );

  // After any generation, refresh state.files from /admin/api/status
  // so the strip-ready badge flips to green without a full page
  // reload. Swallows errors: a stale status list is strictly cosmetic.
  const refreshFiles = async (): Promise<void> => {
    try {
      const s = await fetchStatus();
      state.files = s.files;
    } catch {
      // ignore — user can reload if the badge doesn't update
    }
  };

  // "Automate all missing" kicks off a sequential pass (parallel
  // would blow past Gemini's concurrent-request ceiling). Kinds with
  // a strip already on disk are regenerated only on explicit per-row
  // click; the bulk button is "missing only" by design so a slip of
  // the mouse doesn't clobber hand-picked variants.
  const headerActions = document.createElement('div');
  headerActions.className = 'admin-animation-header-actions';
  const automateAllBtn = document.createElement('button');
  automateAllBtn.className = 'btn accent';
  automateAllBtn.textContent = '⚡ Automate all missing';
  automateAllBtn.addEventListener('click', async () => {
    if (automateAllBtn.disabled) return;
    automateAllBtn.disabled = true;
    const missing = settings.kinds.filter((k) => !hasSheet(k));
    if (missing.length === 0) {
      statusToast('No missing walk strips — nothing to do', 'info');
      automateAllBtn.disabled = false;
      return;
    }
    let ok = 0;
    let fail = 0;
    for (const k of missing) {
      try {
        await generateWalkCycle(k, (note) => statusToast(note, 'info'));
        ok++;
      } catch (err) {
        statusToast(`${k}: ${(err as Error).message}`, 'error');
        fail++;
      }
    }
    await refreshFiles();
    statusToast(`Walk cycles: ${ok} saved, ${fail} failed`, fail === 0 ? 'success' : 'error');
    automateAllBtn.disabled = false;
    // Re-render the panel in place so the badges refresh (cheap: we
    // own the single <section>, just swap it for a new one).
    card.replaceWith(renderAnimationPanel());
  });
  headerActions.append(automateAllBtn);
  header.append(headerActions);

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

    const genBtn = document.createElement('button');
    genBtn.className = 'btn';
    genBtn.textContent = hasSheet(kind) ? 'Regenerate' : 'Generate';
    genBtn.addEventListener('click', async () => {
      if (genBtn.disabled) return;
      genBtn.disabled = true;
      const originalText = genBtn.textContent;
      try {
        const res = await generateWalkCycle(kind, (note) => {
          genBtn.textContent = note.replace(`${kind}: `, '');
        });
        statusToast(`Saved ${kind} walk strip (${humanBytes(res.size)})`, 'success');
        await refreshFiles();
        // Swap the whole panel so the status badge for every kind
        // reflects the new listing (cheaper than threading the
        // element refs around).
        card.replaceWith(renderAnimationPanel());
      } catch (err) {
        statusToast(`${kind}: ${(err as Error).message}`, 'error');
        genBtn.textContent = originalText;
        genBtn.disabled = false;
      }
    });

    row.append(checkbox, label, status, genBtn);

    // Preview + editor block lives on a second grid row, full-width,
    // so the top row stays compact. The preview only renders once a
    // strip is on disk; the editor is always available so an admin
    // can tweak the prompt before the first generate run.
    const detail = document.createElement('div');
    detail.className = 'admin-animation-detail';

    if (hasSheet(kind)) {
      detail.append(renderStripPreview(kind, state.files));
    } else {
      const empty = document.createElement('div');
      empty.className = 'admin-animation-preview-empty';
      empty.textContent = 'No walk strip yet — click Generate to create one.';
      detail.append(empty);
    }

    detail.append(renderPromptEditor(kind));

    row.append(detail);
    list.append(row);
  }
  card.append(list);
  return card;
}

// Static + animated preview of a walk strip. Two side-by-side views:
//  - The full 512x128 strip scaled to fit the panel, so the admin can
//    see each frame and catch geometry issues (e.g. Gemini shipped a
//    3-frame strip or stretched the character off-center).
//  - A 128x128 div with background-image = strip + a steps(4) CSS
//    animation on background-position-x. Shows the walk in motion
//    without needing Phaser to be running — exactly what the game will
//    render at 8 fps.
//
// URLs get a ?v=<mtime> cache-buster so immediately after a regenerate
// the browser fetches the new bytes instead of re-displaying the
// cached version.
function renderStripPreview(kind: string, files: SpriteFile[]): HTMLElement {
  const file = files.find(
    (f) => f.name === `unit-${kind}-walk.webp` || f.name === `unit-${kind}-walk.png`,
  );
  const wrap = document.createElement('div');
  wrap.className = 'admin-animation-preview';
  if (!file) {
    // Defensive: caller checks hasSheet() first, but if it drifts
    // we'd rather render a placeholder than throw.
    return wrap;
  }
  const url = `/assets/sprites/${file.name}?v=${file.mtime}`;

  const strip = document.createElement('img');
  strip.src = url;
  strip.className = 'admin-animation-preview-strip';
  strip.alt = `${kind} walk strip`;
  wrap.append(strip);

  const loop = document.createElement('div');
  loop.className = 'admin-animation-preview-loop';
  loop.style.backgroundImage = `url('${url}')`;
  loop.title = `${kind} — looping at 8 fps (matches in-game)`;
  wrap.append(loop);

  return wrap;
}

// Expandable prompt editor. Starts collapsed so the panel stays
// compact; the <summary> toggles an unobtrusive "Edit prompt" link.
// "Save prompt" persists to prompts.json; "Save & regenerate" does
// both in one click — the common workflow when iterating on a kind.
function renderPromptEditor(kind: string): HTMLElement {
  const details = document.createElement('details');
  details.className = 'admin-animation-editor';

  const summary = document.createElement('summary');
  summary.textContent = 'Tweak prompt';
  details.append(summary);

  const textarea = document.createElement('textarea');
  textarea.value = state.prompts?.walkCycles?.[kind] ?? '';
  textarea.placeholder =
    'Describe the walk cycle: character, perspective, frame-by-frame leg poses…';
  textarea.rows = 4;
  details.append(textarea);

  const actions = document.createElement('div');
  actions.className = 'admin-animation-editor-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn';
  saveBtn.textContent = 'Save prompt';
  saveBtn.addEventListener('click', async () => {
    await savePromptValue(kind, textarea.value, saveBtn);
  });

  const saveAndRegenBtn = document.createElement('button');
  saveAndRegenBtn.className = 'btn accent';
  saveAndRegenBtn.textContent = 'Save & regenerate';
  saveAndRegenBtn.addEventListener('click', async () => {
    if (saveAndRegenBtn.disabled) return;
    saveAndRegenBtn.disabled = true;
    const original = saveAndRegenBtn.textContent;
    try {
      await savePromptValue(kind, textarea.value, saveBtn);
      saveAndRegenBtn.textContent = 'Regenerating…';
      const res = await generateWalkCycle(kind);
      statusToast(`Saved ${kind} walk strip (${humanBytes(res.size)})`, 'success');
      // Refresh the whole panel so every badge + preview updates at
      // once — cheaper than threading per-element refs around.
      try {
        const s = await fetchStatus();
        state.files = s.files;
      } catch {
        // ignore
      }
      const newPanel = renderAnimationPanel();
      details.closest('.admin-animation')?.replaceWith(newPanel);
    } catch (err) {
      statusToast(`${kind}: ${(err as Error).message}`, 'error');
      saveAndRegenBtn.textContent = original;
      saveAndRegenBtn.disabled = false;
    }
  });

  actions.append(saveBtn, saveAndRegenBtn);
  details.append(actions);
  return details;
}

// Persist a walkCycles[kind] prompt edit + mirror it into local state
// so a subsequent generate uses the new value. Caller passes the save
// button to give inline "Saved" feedback without another toast.
async function savePromptValue(
  kind: string,
  value: string,
  feedbackBtn: HTMLButtonElement,
): Promise<void> {
  const original = feedbackBtn.textContent;
  feedbackBtn.disabled = true;
  feedbackBtn.textContent = 'Saving…';
  try {
    await updatePrompt({ category: 'walkCycles', key: kind, value });
    if (state.prompts) {
      if (!state.prompts.walkCycles) state.prompts.walkCycles = {};
      state.prompts.walkCycles[kind] = value;
    }
    feedbackBtn.textContent = 'Saved ✓';
    window.setTimeout(() => {
      feedbackBtn.textContent = original;
      feedbackBtn.disabled = false;
    }, 1200);
  } catch (err) {
    statusToast(`Save prompt failed: ${(err as Error).message}`, 'error');
    feedbackBtn.textContent = original;
    feedbackBtn.disabled = false;
    throw err;
  }
}

// UI-image-override toggles. Same shape as the animation panel: one
// row per known override key, a checkbox that PUTs the new map to
// /admin/api/settings/ui-overrides, and a status badge that tells
// the admin whether the corresponding image is actually present on
// disk. Flipping a toggle ON while the image is missing still saves
// the flag, but the in-game Graphics fallback keeps rendering.
function renderUiOverridesPanel(): HTMLElement {
  const card = document.createElement('section');
  card.className = 'admin-animation'; // reuse the animation panel styles
  const header = document.createElement('header');
  header.innerHTML = `
    <h2>Menu UI overrides</h2>
    <small>Generate a Menu UI asset above, then flip its switch here to replace the in-game Graphics fallback with the image. Toggle off to revert.</small>
  `;
  card.append(header);

  const settings = state.uiOverrides;
  if (!settings) {
    const msg = document.createElement('p');
    msg.className = 'admin-animation-empty';
    msg.textContent = 'UI override settings unreachable. Check the API/DB is up, then reload the admin.';
    card.append(msg);
    return card;
  }
  if (settings.dbPersistence === 'not-configured') {
    const msg = document.createElement('p');
    msg.className = 'admin-animation-warning';
    msg.textContent =
      "DATABASE_URL not configured — toggles below are read-only defaults and won't persist.";
    card.append(msg);
  }

  // "Image ready" = any on-disk file whose stem matches the key,
  // regardless of extension. The admin save pipeline writes one of
  // webp/png per key.
  const hasImage = (key: string): boolean =>
    state.files.some(
      (f) => f.name === `${key}.webp` || f.name === `${key}.png`,
    );

  const list = document.createElement('ul');
  list.className = 'admin-animation-list';
  for (const key of settings.keys) {
    const row = document.createElement('li');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = settings.values[key] ?? false;
    checkbox.id = `ui-override-${key}`;
    checkbox.disabled = settings.dbPersistence === 'not-configured';
    checkbox.addEventListener('change', async () => {
      const nextValues: Record<string, boolean> = { ...settings.values };
      nextValues[key] = checkbox.checked;
      try {
        const res = await putUiOverrideSettings(nextValues);
        settings.values = res.values;
        statusToast(
          `${key}: ${checkbox.checked ? 'image active' : 'Graphics fallback'}`,
          'success',
        );
      } catch (err) {
        checkbox.checked = !checkbox.checked;
        statusToast(`Could not save: ${(err as Error).message}`, 'error');
      }
    });

    const label = document.createElement('label');
    label.htmlFor = checkbox.id;
    label.textContent = key;

    const status = document.createElement('span');
    status.className = 'admin-animation-status';
    const ready = hasImage(key);
    status.textContent = ready ? 'image ready' : 'no image yet';
    status.dataset.hasSheet = ready ? '1' : '0';

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
