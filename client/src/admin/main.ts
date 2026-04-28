// Hive Wars admin panel — Gemini sprite generation, compression, and
// save. Vanilla TS + CSS, no React, no Phaser. Loaded from admin.html
// so the public game bundle stays lean.

import {
  createUser,
  deleteUser,
  downloadAllSprites,
  fetchAnimationSettings,
  fetchPrompts,
  fetchStatus,
  fetchStories,
  fetchUiOverrideSettings,
  generateImages,
  getToken,
  listUsers,
  putAnimationSettings,
  putUiOverrideSettings,
  saveSprite,
  setToken,
  updatePrompt,
  updateUser,
  type AdminUser,
  type AnimationSettings,
  type PromptsFile,
  type StoriesFile,
  type UiOverrideSettings,
  type SpriteFile,
} from './api.js';
import { removeBackground, removeNearWhite } from './removeBackground.js';
import { SpriteCard } from './SpriteCard.js';
import { compressBase64Image, humanBytes } from './compress.js';
import { renderPreviewPanel } from './PreviewPanel.js';
import { renderAudioPanel } from './AudioPanel.js';
import {
  BUILDING_SPRITE_KEYS,
  HERO_SPRITE_KEYS,
  UNIT_SPRITE_KEYS,
} from '../assets/atlas.js';
import {
  WALK_FRAME_COUNT,
  WALK_STRIP_WIDTH,
  composeWalkPosePrompt,
  composeWalkPoseVariationPrompt,
  compositeWalkStrip,
} from './walkCycle.js';
import { WalkCycleEditor } from './WalkCycleEditor.js';

// Source the admin sprite cards from the same manifest BootScene loads so
// new live roster entries cannot ship without showing up in the art tools.
const UNIT_KEYS = UNIT_SPRITE_KEYS.map((key) => key.replace(/^unit-/, ''));
const BUILDING_KEYS = BUILDING_SPRITE_KEYS.map((key) =>
  key.replace(/^building-/, ''),
);
const HERO_KEYS = HERO_SPRITE_KEYS.map((key) => key.replace(/^hero-/, ''));

interface Compression {
  format: 'webp' | 'png';
  quality: number;
  maxDim: number;
}

interface AdminState {
  prompts: PromptsFile | null;
  stories: StoriesFile | null;
  files: SpriteFile[];
  cards: SpriteCard[];
  compression: Compression;
  progressEl: HTMLDivElement | null;
  animation: AnimationSettings | null;
  uiOverrides: UiOverrideSettings | null;
  activeCategory: SpriteCategory;
}

const state: AdminState = {
  prompts: null,
  stories: null,
  files: [],
  cards: [],
  // Quality 0.85 was the historical default; bumped to 0.92 to
  // preserve the painterly carapace shading and the thin dark
  // outlines that read fuzzy after the in-game downscale.
  compression: { format: 'webp', quality: 0.92, maxDim: 256 },
  progressEl: null,
  animation: null,
  uiOverrides: null,
  activeCategory: 'units',
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
  el.innerHTML = '<button class="status-close" title="Dismiss">✕</button>';
  const span = document.createElement('span');
  span.textContent = msg;
  el.prepend(span);
  const closeBtn = el.querySelector('.status-close') as HTMLButtonElement;
  const dismissToast = () => el!.classList.remove('visible');
  closeBtn.addEventListener('click', dismissToast);
  clearTimeout((statusToast as unknown as { _t?: number })._t);
  (statusToast as unknown as { _t?: number })._t = window.setTimeout(dismissToast, 3000);
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
  // Story-strip metadata is a public endpoint — fetched alongside the
  // authed prompts so the Story tab can render its per-panel grouping.
  // Best-effort: a stale or missing stories.json shouldn't block the
  // rest of the admin panel from loading.
  try {
    state.stories = await fetchStories();
  } catch (err) {
    state.stories = null;
    statusToast(`Stories metadata unavailable: ${(err as Error).message}`, 'error');
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

// Active admin tab — persisted across reloads so an admin who pops
// over to the game and back keeps their place. Kept in localStorage
// (not the URL hash) because the admin is a single-page tool and we
// don't have routing; localStorage matches the existing token-stash
// pattern on this page.
type AdminTab = 'sprites' | 'users' | 'preview' | 'audio';
const TAB_STORAGE_KEY = 'hive.adminTab';
function readActiveTab(): AdminTab {
  const v = localStorage.getItem(TAB_STORAGE_KEY);
  if (v === 'users' || v === 'preview' || v === 'sprites' || v === 'audio') return v;
  return 'sprites';
}
function writeActiveTab(tab: AdminTab): void {
  localStorage.setItem(TAB_STORAGE_KEY, tab);
}

// Active sprite category filter — persisted for convenience
type SpriteCategory =
  | 'units'
  | 'buildings'
  | 'heroes'
  | 'story'
  | 'ui'
  | 'branding';
const CATEGORY_STORAGE_KEY = 'hive.spriteCategory';
function readActiveCategory(): SpriteCategory {
  const v = localStorage.getItem(CATEGORY_STORAGE_KEY);
  if (
    v === 'ui' ||
    v === 'branding' ||
    v === 'heroes' ||
    v === 'story' ||
    v === 'buildings'
  )
    return v;
  return 'units';
}
function writeActiveCategory(cat: SpriteCategory): void {
  localStorage.setItem(CATEGORY_STORAGE_KEY, cat);
}

function render(): void {
  root.innerHTML = '';

  // -- Header ---------------------------------------------------------------
  // The brand mark (`/units/logo-hivewars.svg`) ships with the static
  // public assets and is also what the landing page surfaces, so the
  // admin tool reads as part of the same product instead of a generic
  // text shell. Plain <img> rather than the admin-generated `ui-logo`
  // because that asset is byte-uploaded into the sprite store and
  // isn't always present locally.
  const header = document.createElement('header');
  header.className = 'admin-header';
  header.innerHTML = `
    <div class="admin-brand">
      <img class="admin-brand-logo" src="/units/logo-hivewars.svg" alt="Hive Wars" width="320" height="80" />
      <div>
        <h1>Hive Wars · Admin</h1>
        <small>Gemini sprite generation · ${state.files.length} file(s) on disk</small>
      </div>
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

  // -- Tabs -----------------------------------------------------------------
  // Sprites / Users / Preview. Sprites shows the sprite grid with category
  // filters and inline animation generation; Users owns login-account CRUD;
  // Preview groups UI overrides by the scene they affect.
  const activeTab = readActiveTab();
  const tabBar = document.createElement('nav');
  tabBar.className = 'admin-tabs';
  const tabDefs: ReadonlyArray<{ id: AdminTab; label: string }> = [
    { id: 'sprites', label: 'Sprites' },
    { id: 'audio',   label: 'Audio' },
    { id: 'users',   label: 'Users' },
    { id: 'preview', label: 'Preview' },
  ];
  for (const def of tabDefs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-tab' + (def.id === activeTab ? ' is-active' : '');
    btn.textContent = def.label;
    btn.addEventListener('click', () => {
      if (def.id === activeTab) return;
      writeActiveTab(def.id);
      render();
    });
    tabBar.append(btn);
  }
  root.append(tabBar);

  // Slim progress bar tucked under the header — hidden until a batch is
  // running. Lives in the DOM permanently so state.progressEl is always
  // a valid reference for the handler.
  const progress = document.createElement('div');
  progress.className = 'progress';
  progress.hidden = true;
  progress.innerHTML = '<div class="progress-bar"></div><span class="progress-label"></span>';
  root.append(progress);
  state.progressEl = progress;

  // Render just the active tab's content.
  if (activeTab === 'users') {
    root.append(renderUsersPanel());
    return;
  }
  if (activeTab === 'audio') {
    root.append(renderAudioPanel({ showStatus: statusToast }));
    return;
  }
  if (activeTab === 'preview') {
    // Pass the admin's cached state in so the Preview tab doesn't
    // re-fetch prompts / UI-override settings on every tab switch.
    // getCompression is a getter rather than a snapshot so the admin
    // can tweak the format/quality/maxDim sliders up top and the
    // very next Regenerate inside Preview picks up the new values.
    root.append(
      renderPreviewPanel({
        initialPrompts: state.prompts,
        getCompression: () => ({ ...state.compression }),
      }),
    );
    return;
  }

  // Sprites tab (default) — sprite grid with categories + inline animation.
  // renderSpritesTab() owns the toolbar, the category filter, the
  // sprite grid, the UI-overrides panel, and the animation panel —
  // every sub-control needed for sprite editing. The style-lock
  // editor below is a sibling at the render() level rather than
  // inside renderSpritesTab so future tabs (Preview, Users) can
  // share or hide it without touching the sprite tab body.
  root.append(renderSpritesTab());

  // -- Style-lock editor ----------------------------------------------------
  // The textarea's native `change` event only fires on blur, which isn't
  // discoverable on mobile (blur happens silently when the keyboard
  // dismisses) and doesn't give any visible feedback that the text will
  // persist. The explicit Save button below is the obvious way to commit
  // changes; the dirty indicator tells the admin when something is
  // pending so they don't navigate away thinking everything's saved.
  const styleBox = document.createElement('div');
  styleBox.className = 'style-lock';
  const styleHead = document.createElement('div');
  styleHead.className = 'style-lock-head';
  styleHead.innerHTML = `<h3>Global style lock (applied to every sprite)</h3>`;
  const styleDirty = document.createElement('span');
  styleDirty.className = 'style-lock-dirty';
  styleDirty.textContent = '';
  styleHead.append(styleDirty);
  styleBox.append(styleHead);

  const styleTxt = document.createElement('textarea');
  const initialStyle = state.prompts?.styleLock ?? '';
  styleTxt.value = initialStyle;
  let lastSavedStyle = initialStyle;

  const styleActions = document.createElement('div');
  styleActions.className = 'style-lock-actions';
  const styleSave = document.createElement('button');
  styleSave.className = 'btn primary';
  styleSave.textContent = 'Save style lock';
  styleSave.disabled = true;
  const styleRevert = document.createElement('button');
  styleRevert.className = 'btn ghost';
  styleRevert.textContent = 'Revert';
  styleRevert.disabled = true;
  styleActions.append(styleSave, styleRevert);

  const refreshStyleDirty = (): void => {
    const dirty = styleTxt.value !== lastSavedStyle;
    styleDirty.textContent = dirty ? 'unsaved changes' : '';
    styleSave.disabled = !dirty;
    styleRevert.disabled = !dirty;
  };

  styleTxt.addEventListener('input', refreshStyleDirty);

  // Guard: the Save button's click can follow the textarea's blur/
  // `change` event when the user clicks directly from the textarea
  // onto the button. Without this, saveStyleLock would run twice in
  // quick succession. A simple in-flight flag is enough — we don't
  // need queueing since the second caller's payload is identical.
  let styleSaving = false;

  const saveStyleLock = async (): Promise<void> => {
    if (styleSaving) return;
    styleSaving = true;
    const value = styleTxt.value;
    styleSave.disabled = true;
    styleRevert.disabled = true;
    styleSave.textContent = 'Saving…';
    try {
      await updatePrompt({ category: 'styleLock', value });
      if (state.prompts) state.prompts.styleLock = value;
      lastSavedStyle = value;
      statusToast('Style lock saved', 'success');
    } catch (err) {
      statusToast((err as Error).message, 'error');
    } finally {
      styleSave.textContent = 'Save style lock';
      styleSaving = false;
      refreshStyleDirty();
    }
  };

  styleSave.addEventListener('click', () => {
    void saveStyleLock();
  });
  // Revert needs to win against the textarea's blur-save. Without
  // this mousedown preventDefault, clicking Revert from inside the
  // textarea fires blur first → `change` → saveStyleLock() captures
  // the dirty value and saves it before the click handler gets to
  // run. preventDefault on mousedown keeps focus on the textarea,
  // so blur (and the save) never fire; click still runs normally.
  styleRevert.addEventListener('mousedown', (e) => e.preventDefault());
  styleRevert.addEventListener('click', () => {
    if (styleSaving) return;
    styleTxt.value = lastSavedStyle;
    refreshStyleDirty();
  });
  // Keep the implicit blur-save behaviour so typing + tabbing away still
  // persists (useful on desktop when the admin forgets to click Save).
  styleTxt.addEventListener('change', () => {
    if (styleTxt.value !== lastSavedStyle) void saveStyleLock();
  });

  styleBox.append(styleTxt, styleActions);
  root.append(styleBox);
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
  // Phase-1 additions: admin gen + override toggle are wired; the
  // in-game consumers (HUD pills, portrait frames, victory/defeat
  // overlays, tooltip bg, close button, progress-bar frame) land
  // in a follow-up. Until then the Graphics/CSS fallback still
  // renders, so nothing regresses by default.
  'ui-resource-pill-honey',
  'ui-resource-pill-sugar',
  'ui-resource-pill-grubs',
  // Resource ICON sprites — the small glyphs that sit at the left
  // end of each HUD resource pill. atlas.ts (UI_SPRITE_KEYS)
  // already loads these; without them registered here the admin
  // sprite tab couldn't generate them and HomeScene fell back to
  // the procedural placeholder forever.
  'ui-resource-sugar',
  'ui-resource-leaf',
  'ui-resource-milk',
  // Harvest-ready chips that float over producer buildings when
  // offline production has banked. HomeScene picks the right one
  // based on each producer's dominant pending bucket; admin
  // generates the matching art the same way as other ui-* keys.
  'ui-harvest-sugar',
  'ui-harvest-leaf',
  'ui-harvest-milk',
  'ui-icon-unit-frame',
  'ui-icon-building-frame',
  'ui-badge-victory',
  'ui-badge-defeat',
  'ui-progress-bar-frame',
  'ui-tooltip-bg',
  'ui-close-button',
  'ui-card-frame',
  // Logo wordmark. Shown on boot splash + HomeScene top-left when
  // generated AND the `ui-logo` override flag is flipped on.
  'ui-logo',
  // Landing-page hero banner. Wide cinematic illustration shown above
  // the fold on /index.html. The `landing-` key prefix routes through
  // a different prompt composer (cinematic perspective + depth) so it
  // doesn't get the flat-2D, head-on UI-chrome constraint.
  'landing-hero',
  // Wide promo banner shown in the landing page Store / Discover
  // section. Same cinematic prompt path as `landing-hero`. Lives on
  // the Logo & Branding admin tab even though the key starts with
  // `ui-` so the operator sees every piece of marketing art in one
  // place; the BRANDING_EXPLICIT_KEYS list below opts it in.
  'ui-discover-banner',
  // Queen-skin portraits. Admin can generate + toggle each one;
  // the Queen picker + HomeScene identity chip render the image
  // when present and fall back to a tinted silhouette otherwise.
  // Keep in sync with server/api/src/game/queenSkins.ts.
  'queen-default',
  'queen-obsidian',
  'queen-honeydew',
  'queen-frost',
  'queen-ember',
  'queen-verdant',
  'queen-silver',
];

// Keys that belong on the Logo & Branding tab even when they don't
// match the `landing-` / `queen-` prefix convention. Add new
// marketing-art keys here so they show up next to landing-hero
// instead of getting hidden inside the generic UI grid.
const BRANDING_EXPLICIT_KEYS: ReadonlySet<string> = new Set([
  'ui-logo',
  'ui-discover-banner',
]);

function isBrandingKey(key: string): boolean {
  return (
    key.startsWith('landing-') ||
    key.startsWith('queen-') ||
    BRANDING_EXPLICIT_KEYS.has(key)
  );
}

function composePrompt(
  description: string,
  kind: 'unit' | 'building' | 'hero' | 'story' | 'menuUi',
  key?: string,
): string {
  const style = state.prompts?.styleLock ?? '';
  // Landing-page art (key prefix `landing-`) is cinematic illustration,
  // not UI chrome — it would look dead if forced into the flat-2D /
  // head-on / no-characters constraints of the menuUi composer below.
  // Routed through its own branch so the painter is free to use
  // perspective, characters, and full-bleed framing.
  if (kind === 'menuUi' && key && (key.startsWith('landing-') || key === 'ui-discover-banner')) {
    // The global style lock ends with sprite-only technical constraints
    // ("128x128 transparent PNG, subject fills ~85%, no background, …")
    // that directly contradict the wide opaque hero brief below. Slice
    // those off so only the *visual* part of the style lock (palette,
    // lighting, outlines, painterly direction) reaches the model — the
    // delivery section in this branch owns size + transparency.
    const visualStyle = (style.split('128x128')[0] ?? style).trim();
    return [
      `Subject: ${description}`,
      `Style: ${visualStyle}`,
      `Camera: cinematic painterly hero illustration. Wide landscape framing with clear foreground / midground / background depth, dramatic directional lighting, atmospheric perspective. Characters and scenery are encouraged.`,
      `Delivery: full-bleed PNG, opaque background is fine (the page crops it inside a rounded card). No text, no UI overlays, no logos, no watermarks, no borders, no signature.`,
    ].join(' ');
  }
  // Comic-strip story panels follow the same cinematic shape as the
  // landing-hero painting but at a 16:9 panel size (1024x576). Same
  // styleLock-without-sprite-constraints trick as the landing branch
  // so the painter has license to use scenery, characters, depth.
  if (kind === 'story') {
    const visualStyle = (style.split('128x128')[0] ?? style).trim();
    return [
      `Subject: ${description}`,
      `Style: ${visualStyle}`,
      `Camera: cinematic painterly comic-panel illustration. Wide 16:9 landscape framing with clear foreground / midground / background depth, dramatic directional lighting, atmospheric perspective. Multi-character scenes and storytelling are encouraged.`,
      `Delivery: 1024x576 PNG, opaque background is fine (panels sit inside a rounded card on the landing page). No text, no UI overlays, no logos, no captions, no watermarks, no borders, no signature.`,
    ].join(' ');
  }
  // Menu UI assets are larger and designed for 9-slice scaling —
  // the prompt shape differs enough that we route it through its
  // own composer instead of twisting the shared subject prompt.
  // Straight-on / flat-2D is enforced at the composer level too so
  // even older prompts.json entries that don't yet mention "flat"
  // still come out axis-aligned.
  if (kind === 'menuUi') {
    return [
      `Subject: ${description}`,
      `Style: ${style}`,
      `Camera: strictly head-on, flat 2D, zero perspective, zero tilt, zero isometric angle, zero foreshortening. The asset must read as axis-aligned (rectangles stay rectangles, banners stay symmetrical). Any sense of depth comes from painted lighting only, never from camera angle.`,
      `Delivery: transparent PNG. No text, no icons, no logos, no border, no watermark. The asset must work as-is when composited over any in-game background.`,
    ].join(' ');
  }
  // Heroes share the 128x128 sprite canvas with units (HERO_SPRITE_KEYS
  // ships hero-<Kind>.png at the same dimensions as unit-<Kind>.png).
  // Buildings are the only category that wants the larger 192x192 canvas.
  const size = kind === 'building' ? '192x192' : '128x128';
  return [
    `Subject: ${description}.`,
    `Style: ${style}`,
    `Canvas: ${size} pixels, fully transparent background (RGBA alpha=0 outside the subject), no sky, no ground plane, no solid backdrop, no border, no text, no watermark.`,
    `Composition: subject centered, single character/object only, facing viewer, small soft shadow directly below feet. Plenty of headroom.`,
    `Consistency: matches a shared cohesive game atlas — same outline thickness, same palette, same perspective as sibling sprites.`,
  ].join(' ');
}

// Walk-cycle geometry + prompt composers live in ./walkCycle.ts so
// the per-pose editor can share them with the bulk generator.

// Animation generation (Animations tab): reuses existing sprite + generates variation.
// Fetches the already-generated sprite, uses it as frame 1, generates a
// pose variation as frame 2, then composites into a 256×128 strip.
async function generateAnimationFromSprite(
  kind: string,
  onProgress?: (note: string) => void,
): Promise<{ path: string; size: number }> {
  const bucket = state.prompts?.walkCycles;
  const poseB = bucket?.[`${kind}_poseB`];
  if (!poseB || poseB.trim() === '') {
    throw new Error(
      `no walkCycles prompt for ${kind}_poseB — add to tools/gemini-art/prompts.json`,
    );
  }

  onProgress?.(`${kind}: fetching sprite…`);
  // Find the existing sprite in our file list
  const spriteFile = state.files.find(
    (f) => f.name === `unit-${kind}.webp` || f.name === `unit-${kind}.png`,
  );
  if (!spriteFile) {
    throw new Error(`no sprite found for unit-${kind} — generate it first in Sprites tab`);
  }

  // Fetch the sprite from the server and convert to base64
  const spriteResp = await fetch(`/assets/sprites/${spriteFile.name}`);
  if (!spriteResp.ok) throw new Error(`failed to fetch sprite: ${spriteResp.statusText}`);
  const spriteBlob = await spriteResp.blob();

  // Convert blob to base64 directly (skip data URL prefix)
  const buffer = await spriteBlob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const spriteBase64 = btoa(binary);

  // Determine MIME type from file extension
  const mimeType = spriteFile.name.endsWith('.webp') ? 'image/webp' : 'image/png';

  onProgress?.(`${kind}: generating variation (frame 2)…`);
  const imgsB = await generateImages({
    prompt: composeWalkPoseVariationPrompt(poseB),
    variants: 1,
    referenceImages: [{ mimeType, data: spriteBase64 }],
  });
  const b = imgsB[0];
  if (!b) throw new Error('Gemini returned no image for frame 2');

  // Automatically remove background from frame 2 to match frame 1.
  // Only background removal; gray-filler cleanup skipped to preserve
  // intentional light details (pale wing edges, highlights).
  onProgress?.(`${kind}: cleaning frame 2 (removing background)…`);
  const bCleaned = await removeBackground(b.data, b.mimeType);

  // Convert both frames to GeminiImage format for compositing.
  // Frame 1 (sprite) stays as-is; frame 2 is now cleaned of backdrop.
  onProgress?.(`${kind}: compositing strip…`);
  const frameA: typeof b = { mimeType, data: spriteBase64 };
  const frameB: typeof b = { mimeType: 'image/png', data: bCleaned.base64 };
  const stripPng = await compositeWalkStrip([frameA, frameB]);

  onProgress?.(`${kind}: compressing…`);
  const compressed = await compressBase64Image(stripPng, 'image/png', {
    format: state.compression.format,
    quality: Math.max(0.85, state.compression.quality), // minimum 0.85 for animation clarity
    maxDimension: state.compression.maxDim,
  });

  onProgress?.(`${kind}: saving…`);
  const res = await saveSprite({
    key: `unit-${kind}-walk`,
    data: compressed.base64,
    format: state.compression.format,
    frames: 2,
  });
  return res;
}

// End-to-end: generate pose A first, then pose B with pose A attached
// as a reference image so Gemini sees the exact character/palette/
// camera and can change ONLY the legs (or wings) → composite side-by-
// side into a 256×128 strip → compress to webp → save with frames=2.
//
// Earlier revisions fired both poses in parallel with text-only
// prompts, but the two images came back with slightly different body
// proportions, face details, and even palette — visible jitter
// between frames that ruined the walk illusion. Sequential with a
// reference image costs one extra round-trip but produces
// dramatically more consistent output.
async function generateWalkCycle(
  kind: string,
  onProgress?: (note: string) => void,
): Promise<{ path: string; size: number }> {
  const bucket = state.prompts?.walkCycles;
  const poseA = bucket?.[`${kind}_poseA`];
  const poseB = bucket?.[`${kind}_poseB`];
  if (!poseA || poseA.trim() === '' || !poseB || poseB.trim() === '') {
    throw new Error(
      `no walkCycles prompts for ${kind} — add ${kind}_poseA and ${kind}_poseB to tools/gemini-art/prompts.json`,
    );
  }

  const styleLock = state.prompts?.styleLock ?? '';

  onProgress?.(`${kind}: generating pose A…`);
  const imgsA = await generateImages({
    prompt: composeWalkPosePrompt(poseA, styleLock),
    variants: 1,
  });
  const a = imgsA[0];
  if (!a) throw new Error('Gemini returned no image for pose A');

  onProgress?.(`${kind}: generating pose B (with pose A as reference)…`);
  const imgsB = await generateImages({
    prompt: composeWalkPoseVariationPrompt(poseB),
    variants: 1,
    referenceImages: [a],
  });
  const b = imgsB[0];
  if (!b) throw new Error('Gemini returned no image for pose B');

  // Automatically remove background from both poses to ensure clean animation.
  // Only background removal; gray-filler cleanup skipped to preserve
  // intentional light details (pale wing edges, highlights).
  onProgress?.(`${kind}: cleaning pose A (removing background)…`);
  const aCleaned = await removeBackground(a.data, a.mimeType);

  onProgress?.(`${kind}: cleaning pose B (removing background)…`);
  const bCleaned = await removeBackground(b.data, b.mimeType);

  // Convert both poses to GeminiImage format with cleaned data
  const aFrame: typeof a = { mimeType: 'image/png', data: aCleaned.base64 };
  const bFrame: typeof b = { mimeType: 'image/png', data: bCleaned.base64 };

  onProgress?.(`${kind}: compositing strip…`);
  const stripPng = await compositeWalkStrip([aFrame, bFrame]);

  onProgress?.(`${kind}: compressing…`);
  // Use global sprite compression settings; ensure quality high enough for animation detail
  const compressed = await compressBase64Image(stripPng, 'image/png', {
    format: state.compression.format,
    quality: Math.max(0.85, state.compression.quality), // minimum 0.85 for leg/wing movement clarity
    maxDimension: state.compression.maxDim,
  });

  onProgress?.(`${kind}: saving…`);
  const res = await saveSprite({
    key: `unit-${kind}-walk`,
    data: compressed.base64,
    format: 'webp',
    frames: WALK_FRAME_COUNT,
  });
  return res;
}

// Animation toggle + generation panel. One row per animated unit kind:
// Sprites tab with category filtering and inline animation generation.
// Renders the sprite grid for the selected category (Units, UI, Logo/Branding).
function renderSpritesTab(): HTMLElement {
  const root = document.createElement('div');
  root.className = 'sprites-tab-wrapper';

  // Category selector
  const categoryBar = document.createElement('div');
  categoryBar.className = 'category-bar';
  const categories: Array<{ id: SpriteCategory; label: string }> = [
    { id: 'units', label: 'Units' },
    { id: 'buildings', label: 'Buildings' },
    { id: 'heroes', label: 'Heroes' },
    { id: 'story', label: 'Story' },
    { id: 'ui', label: 'UI Elements' },
    { id: 'branding', label: 'Logo & Branding' },
  ];
  for (const cat of categories) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'category-btn' + (cat.id === state.activeCategory ? ' is-active' : '');
    btn.textContent = cat.label;
    btn.addEventListener('click', () => {
      state.activeCategory = cat.id;
      writeActiveCategory(cat.id);
      render();
    });
    categoryBar.append(btn);
  }
  root.append(categoryBar);

  root.append(renderGuide());
  root.append(renderUiOverridesPanel());

  // -- Toolbar for global sprite compression settings
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
  root.append(toolbar);

  // -- Sprite grid
  const grid = document.createElement('div');
  grid.className = 'grid';
  state.cards = [];

  const fileByKey = new Map<string, SpriteFile>();
  for (const f of state.files) {
    const base = f.name.replace(/\.(png|webp)$/i, '');
    fileByKey.set(base, f);
  }

  // Live scan of state.files, NOT the cached fileByKey snapshot —
  // after a Generate animation refreshes state.files via
  // fetchStatus(), the card's hasAnimation() callback needs to see
  // the freshly-saved walk strip on the next renderAnimationPanel
  // call. fileByKey is built once at renderSpritesTab() entry and
  // would otherwise stay stale until a hard reload.
  //
  // Compares the two known filename forms directly (lowercased) so
  // the inner loop allocates nothing — a regex .replace() per file
  // per call adds up across the whole sprite grid.
  const hasAnimationFile = (kind: string): boolean => {
    const exact = `unit-${kind}-walk`.toLowerCase();
    return state.files.some((f) => {
      const name = f.name.toLowerCase();
      return name === `${exact}.webp` || name === `${exact}.png`;
    });
  };

  const mk = (
    kind: 'unit' | 'building' | 'hero' | 'story' | 'menuUi',
    baseName: string,
  ): SpriteCard => {
    // Story panel keys (e.g. `story-springs-1`) and menuUi keys
    // (e.g. `landing-hero`) already include their category prefix —
    // unit/building/hero keys are stored bare in the atlas and get
    // prefixed here so the sprite filename matches the manifest.
    const key =
      kind === 'menuUi' || kind === 'story' ? baseName : `${kind}-${baseName}`;
    const file = fileByKey.get(key);
    const ext = file ? (file.name.endsWith('.webp') ? 'webp' : 'png') : null;
    const bucket =
      kind === 'unit'
        ? 'units'
        : kind === 'building'
          ? 'buildings'
          : kind === 'hero'
            ? 'heroes'
            : kind === 'story'
              ? 'stories'
              : 'menuUi';
    const initialPrompt = state.prompts?.[bucket]?.[baseName] ?? '';
    const opts: import('./SpriteCard.js').SpriteCardOptions = {
      key,
      initialPrompt,
      fileMeta: {
        exists: !!file,
        size: file?.size ?? 0,
        ext,
      },
      composePrompt: (desc) => composePrompt(desc, kind, key),
      getCompression: () => state.compression,
      onPromptSave: async (value) => {
        await updatePrompt({ category: bucket, key: baseName, value });
        if (state.prompts) {
          if (!state.prompts[bucket]) state.prompts[bucket] = {};
          state.prompts[bucket]![baseName] = value;
        }
      },
      onSaved: async () => {
        // Refresh the global file list so hasAnimationFile() (and any
        // other status indicator) reflects the just-saved sprite.
        try {
          const s = await fetchStatus();
          state.files = s.files;
        } catch {
          // ignore — non-fatal, the next render will refetch
        }
      },
      showStatus: statusToast,
    };
    // Only unit sprites get inline animation support — buildings,
    // UI elements, and branding don't animate.
    if (kind === 'unit') {
      const poseBKey = `${baseName}_poseB`;
      opts.animation = {
        hasAnimation: () => hasAnimationFile(baseName),
        onGenerate: async (onProgress: (note: string) => void) => {
          await generateAnimationFromSprite(baseName, onProgress);
          // Refresh files so the status badge updates
          try {
            const s = await fetchStatus();
            state.files = s.files;
          } catch {
            // ignore — cosmetic
          }
        },
        // Surface the per-unit variation prompt directly inside the
        // SpriteCard's animation panel so the admin can tweak it
        // before clicking Generate without opening the WalkCycleEditor.
        getPoseBPrompt: () =>
          state.prompts?.walkCycles?.[poseBKey] ?? '',
        setPoseBPrompt: async (value: string) => {
          // Update local state EAGERLY — generateAnimationFromSprite
          // reads state.prompts.walkCycles[poseBKey] synchronously,
          // so if the admin clicks Generate immediately after editing
          // the textarea (without waiting for the server roundtrip),
          // we want the in-flight generate to see their new prompt
          // rather than the stale one from the server.
          if (state.prompts) {
            if (!state.prompts.walkCycles) state.prompts.walkCycles = {};
            state.prompts.walkCycles[poseBKey] = value;
          }
          await updatePrompt({
            category: 'walkCycles',
            key: poseBKey,
            value,
          });
        },
      };
    }
    return new SpriteCard(opts);
  };

  // Render sprites for active category
  if (state.activeCategory === 'units') {
    for (const u of UNIT_KEYS) {
      const card = mk('unit', u);
      state.cards.push(card);
      grid.append(card.root);
    }
  } else if (state.activeCategory === 'buildings') {
    for (const b of BUILDING_KEYS) {
      const card = mk('building', b);
      state.cards.push(card);
      grid.append(card.root);
    }
  } else if (state.activeCategory === 'heroes') {
    for (const h of HERO_KEYS) {
      const card = mk('hero', h);
      state.cards.push(card);
      grid.append(card.root);
    }
  } else if (state.activeCategory === 'story') {
    // Story tab is structurally different from the others — panels are
    // grouped by the story they belong to (title + subtitle banner)
    // before the panel cards. The grid CSS still applies inside each
    // story group; the wrapper here provides the per-story headers.
    if (!state.stories || state.stories.stories.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent =
        'No stories defined yet. Add them to tools/gemini-art/stories.json.';
      grid.append(empty);
    } else {
      for (const story of state.stories.stories) {
        const header = document.createElement('div');
        header.className = 'story-group-header';
        const title = document.createElement('h3');
        title.className = 'story-group-title';
        title.textContent = story.title;
        const subtitle = document.createElement('p');
        subtitle.className = 'story-group-subtitle';
        subtitle.textContent = story.subtitle;
        header.append(title, subtitle);
        grid.append(header);
        for (const panel of story.panels) {
          const card = mk('story', panel.key);
          // Surface the human caption above the prompt textarea so the
          // admin can see which story beat each card represents without
          // cross-referencing stories.json.
          const captionEl = document.createElement('div');
          captionEl.className = 'story-panel-caption';
          captionEl.textContent = panel.caption;
          card.root.prepend(captionEl);
          state.cards.push(card);
          grid.append(card.root);
        }
      }
    }
  } else if (state.activeCategory === 'ui') {
    for (const u of MENU_UI_KEYS.filter(k => !isBrandingKey(k))) {
      const card = mk('menuUi', u);
      state.cards.push(card);
      grid.append(card.root);
    }
  } else if (state.activeCategory === 'branding') {
    // Logo and branding: landing/marketing art + queen skins.
    const brandingKeys = MENU_UI_KEYS.filter(isBrandingKey);
    for (const k of brandingKeys) {
      const card = mk('menuUi', k);
      state.cards.push(card);
      grid.append(card.root);
    }
  }

  root.append(grid);
  return root;
}

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

    // Per-pose editor — two preview columns, per-pose prompts +
    // regenerate + Remove BG + Remove grays + Save strip. Closes
    // the old "Tweak prompt" <details> into a first-class card.
    detail.append(
      new WalkCycleEditor({
        kind,
        getPrompts: () => state.prompts,
        setPromptInState: (promptKey, value) => {
          if (!state.prompts) return;
          if (!state.prompts.walkCycles) state.prompts.walkCycles = {};
          state.prompts.walkCycles[promptKey] = value;
        },
        getStyleLock: () => state.prompts?.styleLock ?? '',
        getFiles: () => state.files,
        showStatus: statusToast,
        onStripSaved: async () => {
          await refreshFiles();
          card.replaceWith(renderAnimationPanel());
        },
      }).root,
    );

    row.append(detail);
    list.append(row);
  }
  card.append(list);
  return card;
}

// Static + animated preview of a walk strip. Two side-by-side views:
//  - The full 256x128 strip scaled to fit the panel, so the admin can
//    see each pose and catch geometry issues (e.g. one half is empty,
//    or the character shifted between poses).
//  - A 96x96 div with background-image = strip + a steps(2) CSS
//    animation on background-position-x. Shows the walk in motion
//    without needing Phaser to be running — exactly what the game
//    renders at WALK_CYCLE_FPS = 6.
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
  loop.title = `${kind} — looping at 6 fps (matches in-game)`;
  wrap.append(loop);

  return wrap;
}

// Per-pose prompt editor + regenerate + BG/grays cleanup lives in
// ./WalkCycleEditor.ts. It replaces the old collapsed "Tweak
// prompts" <details> block with a first-class two-column card.

// UI-image-override toggles. Same shape as the animation panel: one
// row per known override key, a checkbox that PUTs the new map to
// /admin/api/settings/ui-overrides, and a status badge that tells
// the admin whether the corresponding image is actually present on
// disk. Flipping a toggle ON while the image is missing still saves
// the flag, but the in-game Graphics fallback keeps rendering.
// Persistence key for the collapse state of the menu-UI overrides
// panel. Mirrors GUIDE_OPEN_KEY so both top-level admin sections
// remember whether the user wants them folded out of the way.
const UI_OVERRIDES_OPEN_KEY = 'admin:ui-overrides-open';

function renderUiOverridesPanel(): HTMLElement {
  // Outer <details> so the panel can be collapsed like the "How to
  // get sprites into the game" box above. Persists open/closed via
  // localStorage so reloading doesn't unfold it every time.
  const details = document.createElement('details');
  details.className = 'admin-animation admin-ui-overrides';
  const stored = localStorage.getItem(UI_OVERRIDES_OPEN_KEY);
  details.open = stored === null ? true : stored === '1';
  details.addEventListener('toggle', () => {
    localStorage.setItem(UI_OVERRIDES_OPEN_KEY, details.open ? '1' : '0');
  });

  const summary = document.createElement('summary');
  summary.innerHTML = '<span>Menu UI overrides</span><small>flip switches to replace in-game Graphics fallbacks</small>';
  details.append(summary);

  // Inner card holds the rest of the panel content; renamed from the
  // previous outer <section> so the existing layout/styles still
  // apply unchanged. The original <header>/<small>/bulk-controls/
  // checklist tree below is appended into `card`.
  const card = document.createElement('div');
  card.className = 'admin-ui-overrides-body';
  const header = document.createElement('header');
  const headerText = document.createElement('div');
  headerText.innerHTML = `
    <small>Generate a Menu UI asset above, then flip its switch here to replace the in-game Graphics fallback with the image. Toggle off to revert. Use Enable all / Disable all to flip every slot at once.</small>
  `;
  header.append(headerText);

  const settings = state.uiOverrides;
  if (!settings) {
    card.append(header);
    const msg = document.createElement('p');
    msg.className = 'admin-animation-empty';
    msg.textContent = 'UI override settings unreachable. Check the API/DB is up, then reload the admin.';
    card.append(msg);
    return card;
  }

  // Bulk controls — flip every key to the same value in one PUT.
  // Sending the payload in one request (not N) keeps things atomic:
  // either all values update or none do.
  const bulk = document.createElement('div');
  bulk.className = 'admin-animation-header-actions';
  const enableAllBtn = document.createElement('button');
  enableAllBtn.className = 'btn';
  enableAllBtn.textContent = 'Enable all';
  const disableAllBtn = document.createElement('button');
  disableAllBtn.className = 'btn ghost';
  disableAllBtn.textContent = 'Disable all';
  bulk.append(enableAllBtn, disableAllBtn);
  header.append(bulk);
  card.append(header);

  if (settings.dbPersistence === 'not-configured') {
    const msg = document.createElement('p');
    msg.className = 'admin-animation-warning';
    msg.textContent =
      "DATABASE_URL not configured — toggles below are read-only defaults and won't persist.";
    card.append(msg);
    enableAllBtn.disabled = true;
    disableAllBtn.disabled = true;
  }

  // "Image ready" = any on-disk file whose stem matches the key,
  // regardless of extension. The admin save pipeline writes one of
  // webp/png per key.
  const hasImage = (key: string): boolean =>
    state.files.some(
      (f) => f.name === `${key}.webp` || f.name === `${key}.png`,
    );

  // Track each row's checkbox so Enable/Disable all can sync the UI
  // after the server round-trip. Kept as a local map instead of a
  // module-level state so re-rendering the panel starts fresh.
  const rowCheckboxes = new Map<string, HTMLInputElement>();

  const applyBulk = async (next: boolean): Promise<void> => {
    const nextValues: Record<string, boolean> = {};
    for (const key of settings.keys) nextValues[key] = next;
    const prevLabels = { enable: enableAllBtn.textContent, disable: disableAllBtn.textContent };
    enableAllBtn.disabled = true;
    disableAllBtn.disabled = true;
    (next ? enableAllBtn : disableAllBtn).textContent = 'Saving…';
    try {
      const res = await putUiOverrideSettings(nextValues);
      settings.values = res.values;
      for (const [key, cb] of rowCheckboxes) {
        cb.checked = res.values[key] ?? false;
      }
      statusToast(
        next ? 'All UI overrides enabled' : 'All UI overrides disabled',
        'success',
      );
    } catch (err) {
      statusToast(`Could not save: ${(err as Error).message}`, 'error');
    } finally {
      enableAllBtn.disabled = false;
      disableAllBtn.disabled = false;
      enableAllBtn.textContent = prevLabels.enable ?? 'Enable all';
      disableAllBtn.textContent = prevLabels.disable ?? 'Disable all';
    }
  };
  enableAllBtn.addEventListener('click', () => void applyBulk(true));
  disableAllBtn.addEventListener('click', () => void applyBulk(false));

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
    rowCheckboxes.set(key, checkbox);

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
  details.append(card);
  return details;
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

// Users section: a searchable table of login accounts with add /
// edit / delete actions. The panel owns its own local state (user
// list + search query) so typing in a row doesn't trigger a full
// admin re-render on every keystroke — `onSaveUser` reads draft
// values directly from the row's <input> elements at submit time.
//
// DB-unconnected deploys silently show an empty table — the server
// returns 503 on every call, which surfaces as a toast via the
// error handler in api.ts.
interface UsersPanelState {
  users: AdminUser[];
  total: number;
  q: string;
  // The panel root so async refreshes can replace content in place.
  root?: HTMLElement;
}
const usersPanelState: UsersPanelState = {
  users: [],
  total: 0,
  q: '',
};

function renderUsersPanel(): HTMLElement {
  const card = document.createElement('section');
  card.className = 'admin-users';
  usersPanelState.root = card;

  const header = document.createElement('header');
  header.innerHTML = `
    <h2>Users</h2>
    <small>Create, edit, or remove login accounts. Passwords are hashed server-side (scrypt) — admins never see plaintext.</small>
  `;
  card.append(header);

  // Search box.
  const searchRow = document.createElement('div');
  searchRow.className = 'admin-users-search';
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Filter by username or email…';
  searchInput.value = usersPanelState.q;
  searchInput.addEventListener('input', () => {
    usersPanelState.q = searchInput.value;
    // Debounce with a single timer stored on the input itself. Keeps
    // us from firing a GET per keystroke; 200ms feels snappy.
    const existing = (searchInput as HTMLInputElement & { _t?: number })._t;
    if (existing !== undefined) window.clearTimeout(existing);
    (searchInput as HTMLInputElement & { _t?: number })._t = window.setTimeout(
      () => void refreshUsers(),
      200,
    );
  });
  searchRow.append(searchInput);
  const refreshBtn = button('Refresh', 'btn ghost', () => void refreshUsers());
  searchRow.append(refreshBtn);
  card.append(searchRow);

  // "Add user" form.
  const addForm = document.createElement('form');
  addForm.className = 'admin-users-add';
  addForm.innerHTML = `
    <input name="username" placeholder="username" required autocomplete="off" />
    <input name="email" type="email" placeholder="email (optional)" autocomplete="off" />
    <input name="password" type="password" placeholder="password (8+ chars)" required autocomplete="new-password" />
    <button type="submit" class="btn accent">Add user</button>
  `;
  addForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void onAddUserSubmit(addForm);
  });
  card.append(addForm);

  // Results table.
  const tableWrap = document.createElement('div');
  tableWrap.className = 'admin-users-table';
  card.append(tableWrap);

  // First paint + async load.
  drawUsersTable(tableWrap);
  void refreshUsers();

  return card;
}

async function refreshUsers(): Promise<void> {
  try {
    const res = await listUsers({ limit: 100, q: usersPanelState.q });
    usersPanelState.users = res.users;
    usersPanelState.total = res.total;
    const tableWrap = usersPanelState.root?.querySelector(
      '.admin-users-table',
    ) as HTMLElement | null;
    if (tableWrap) drawUsersTable(tableWrap);
  } catch (err) {
    statusToast((err as Error).message, 'error');
  }
}

function drawUsersTable(container: HTMLElement): void {
  container.innerHTML = '';
  if (usersPanelState.users.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'admin-users-empty';
    empty.textContent =
      usersPanelState.q
        ? `No users match "${usersPanelState.q}".`
        : 'No users yet — use the form above to create one.';
    container.append(empty);
    return;
  }

  const table = document.createElement('table');
  table.innerHTML = `
    <thead>
      <tr>
        <th>Username</th>
        <th>Email</th>
        <th>Password</th>
        <th>Linked player</th>
        <th>Sugar</th>
        <th>Leaf</th>
        <th>Milk</th>
        <th>Trophies</th>
        <th>Last login</th>
        <th></th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');
  for (const u of usersPanelState.users) {
    tbody.append(userRow(u));
  }
  table.append(tbody);
  container.append(table);

  const meta = document.createElement('p');
  meta.className = 'admin-users-meta';
  meta.textContent = `${usersPanelState.users.length} of ${usersPanelState.total} user(s)`;
  container.append(meta);
}

function userRow(u: AdminUser): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.dataset.userId = u.id;

  // Each row's draft values live in the <input>s themselves — onSaveUser
  // reads current DOM values at submit time and diffs against the
  // server-side snapshot in usersPanelState.users. No extra state map
  // needed; keystrokes are free.
  const usernameCell = document.createElement('td');
  const usernameInput = document.createElement('input');
  usernameInput.value = u.username;
  usernameCell.append(usernameInput);

  const emailCell = document.createElement('td');
  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.value = u.email ?? '';
  emailInput.placeholder = '—';
  emailCell.append(emailInput);

  const pwCell = document.createElement('td');
  const pwInput = document.createElement('input');
  pwInput.type = 'password';
  pwInput.placeholder = 'Leave blank to keep';
  pwInput.autocomplete = 'new-password';
  pwCell.append(pwInput);

  const playerCell = document.createElement('td');
  playerCell.textContent = u.displayName ?? '—';

  // Resource inputs. Pre-filled with the current values so the
  // admin can see what the player has and edit in place. Disabled
  // when no players row is linked yet — the server returns 400
  // in that case anyway, so blocking here is a clearer affordance.
  const noPlayer = u.playerId === null;
  const mkResourceInput = (
    value: number | null,
    placeholder: string,
  ): HTMLInputElement => {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '1';
    input.style.width = '88px';
    input.placeholder = placeholder;
    input.value = value === null ? '' : String(value);
    input.disabled = noPlayer;
    if (noPlayer) {
      input.title = 'No player row linked — user must sign in once first';
    }
    return input;
  };
  const sugarCell = document.createElement('td');
  const sugarInput = mkResourceInput(u.sugar, '—');
  sugarCell.append(sugarInput);
  const leafCell = document.createElement('td');
  const leafInput = mkResourceInput(u.leafBits, '—');
  leafCell.append(leafInput);
  const milkCell = document.createElement('td');
  const milkInput = mkResourceInput(u.aphidMilk, '—');
  milkCell.append(milkInput);
  const trophyCell = document.createElement('td');
  const trophyInput = mkResourceInput(u.trophies, '—');
  trophyCell.append(trophyInput);

  const lastCell = document.createElement('td');
  lastCell.textContent = u.lastLoginAt
    ? new Date(u.lastLoginAt).toLocaleString()
    : 'never';

  const actionsCell = document.createElement('td');
  actionsCell.className = 'admin-users-actions';
  const saveBtn = button('Save', 'btn', () =>
    void onSaveUser(u.id, {
      username: usernameInput,
      email: emailInput,
      password: pwInput,
      sugar: sugarInput,
      leaf: leafInput,
      milk: milkInput,
      trophies: trophyInput,
    }),
  );
  const deleteBtn = button('Delete', 'btn danger', () => void onDeleteUser(u));
  actionsCell.append(saveBtn, deleteBtn);

  tr.append(
    usernameCell,
    emailCell,
    pwCell,
    playerCell,
    sugarCell,
    leafCell,
    milkCell,
    trophyCell,
    lastCell,
    actionsCell,
  );
  return tr;
}

async function onAddUserSubmit(form: HTMLFormElement): Promise<void> {
  const fd = new FormData(form);
  const username = String(fd.get('username') ?? '').trim();
  const email = String(fd.get('email') ?? '').trim();
  const password = String(fd.get('password') ?? '');
  try {
    const res = await createUser({
      username,
      email: email || null,
      password,
    });
    statusToast(`Created user ${res.user.username}`, 'success');
    form.reset();
    await refreshUsers();
  } catch (err) {
    statusToast((err as Error).message, 'error');
  }
}

async function onSaveUser(
  id: string,
  inputs: {
    username: HTMLInputElement;
    email: HTMLInputElement;
    password: HTMLInputElement;
    sugar: HTMLInputElement;
    leaf: HTMLInputElement;
    milk: HTMLInputElement;
    trophies: HTMLInputElement;
  },
): Promise<void> {
  // Only send fields that actually changed. Username and email are
  // compared to the table's current row; password is only sent when
  // the admin types something, matching the "leave blank to keep"
  // hint on the input. Resource inputs compare numerically so a
  // leading zero or extra whitespace doesn't trigger a no-op write.
  const existing = usersPanelState.users.find((u) => u.id === id);
  if (!existing) return;
  const patch: {
    username?: string;
    email?: string | null;
    password?: string;
    sugar?: number;
    leafBits?: number;
    aphidMilk?: number;
    trophies?: number;
  } = {};
  if (inputs.username.value !== existing.username) {
    patch.username = inputs.username.value;
  }
  const newEmail = inputs.email.value.trim();
  if (newEmail !== (existing.email ?? '')) {
    patch.email = newEmail === '' ? null : newEmail;
  }
  if (inputs.password.value.length > 0) {
    patch.password = inputs.password.value;
  }
  // Resource diff. Empty string means "unchanged" — we don't
  // interpret it as zero, which would silently nuke a player's
  // wallet on save. NaN / non-finite from a malformed input
  // similarly skipped; the server will 400 anything else.
  const resourceField = (
    raw: string,
    current: number | null,
  ): number | undefined => {
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return undefined;
    if (current !== null && n === current) return undefined;
    return n;
  };
  const sugar = resourceField(inputs.sugar.value, existing.sugar);
  if (sugar !== undefined) patch.sugar = sugar;
  const leaf = resourceField(inputs.leaf.value, existing.leafBits);
  if (leaf !== undefined) patch.leafBits = leaf;
  const milk = resourceField(inputs.milk.value, existing.aphidMilk);
  if (milk !== undefined) patch.aphidMilk = milk;
  const trophies = resourceField(inputs.trophies.value, existing.trophies);
  if (trophies !== undefined) patch.trophies = trophies;

  if (Object.keys(patch).length === 0) {
    statusToast('Nothing changed', 'info');
    return;
  }
  try {
    await updateUser(id, patch);
    statusToast('User updated', 'success');
    await refreshUsers();
  } catch (err) {
    statusToast((err as Error).message, 'error');
  }
}

async function onDeleteUser(u: AdminUser): Promise<void> {
  const label = u.email ? `${u.username} (${u.email})` : u.username;
  if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
  try {
    await deleteUser(u.id);
    statusToast(`Deleted ${u.username}`, 'success');
    await refreshUsers();
  } catch (err) {
    statusToast((err as Error).message, 'error');
  }
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
