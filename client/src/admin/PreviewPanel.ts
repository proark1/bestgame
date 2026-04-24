// Preview tab — groups the Menu UI sprite-keys by the scene they
// affect so an admin can see, in one place, every generated image a
// given screen renders and the toggle that turns it on/off. Each
// asset gets a thumbnail + an inline "Regenerate" button that defers
// to the standard SpriteCard flow so a tweaked look can be tried
// against that scene without leaving the Preview view.
//
// This isn't a live Phaser render — the client bundle keeps the game
// out of the admin bundle on purpose. The mockup block is a textual
// description + a strip of asset thumbnails so the admin can tell at
// a glance what art is actually wired into the scene.

import {
  fetchPrompts,
  fetchUiOverrideSettings,
  putUiOverrideSettings,
  saveSprite,
  updatePrompt,
  generateImages,
} from './api.js';
import { SpriteCard } from './SpriteCard.js';
import { compressBase64Image } from './compress.js';

// Scene → asset key mapping. The game scenes consume UI overrides in
// specific places; this table tells the Preview tab which keys are
// "owned" by which scene. Keep in sync with the actual scene files —
// a key listed here should really be consumed by that scene's code.
export interface PreviewScene {
  id: string;
  label: string;
  summary: string;
  assetKeys: string[];
}

export const PREVIEW_SCENES: ReadonlyArray<PreviewScene> = [
  {
    id: 'boot',
    label: 'Boot splash',
    summary:
      'The loading screen shown while the sprite manifest resolves. ' +
      'If ui-logo is generated, the splash replaces the text title with the logo.',
    assetKeys: ['ui-logo', 'ui-panel-bg', 'ui-progress-bar-frame'],
  },
  {
    id: 'home',
    label: 'Home',
    summary:
      'Colony home screen. Players see resources + the board + nav. ' +
      'The logo shows in the top-left when its override is on; buttons + hud bg + board tiles reskin the chrome.',
    assetKeys: [
      'ui-logo',
      'ui-hud-bg',
      'ui-button-primary-bg',
      'ui-button-secondary-bg',
      'ui-panel-bg',
      'ui-board-tile-surface',
      'ui-resource-pill-honey',
      'ui-resource-pill-sugar',
      'ui-resource-pill-grubs',
      'ui-icon-building-frame',
    ],
  },
  {
    id: 'raid',
    label: 'Raid',
    summary:
      'Live raid scene. Draws a board + deck tray + result card on win/lose.',
    assetKeys: [
      'ui-board-tile-surface',
      'ui-panel-bg',
      'ui-button-primary-bg',
      'ui-button-secondary-bg',
      'ui-badge-victory',
      'ui-badge-defeat',
      'ui-progress-bar-frame',
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    summary:
      'Trading-card reference for every unit + building. The card frame is the main overridable asset.',
    assetKeys: ['ui-card-frame', 'ui-icon-unit-frame', 'ui-icon-building-frame'],
  },
  {
    id: 'clan',
    label: 'Clan / Wars',
    summary: 'Clan chat + wars scoreboard + attack CTA.',
    assetKeys: [
      'ui-hud-bg',
      'ui-panel-bg',
      'ui-button-primary-bg',
      'ui-button-secondary-bg',
    ],
  },
  {
    id: 'campaign',
    label: 'Campaign',
    summary: 'Seasonal chapter / mission list. Uses the shared scene chrome.',
    assetKeys: ['ui-hud-bg', 'ui-panel-bg', 'ui-button-primary-bg', 'ui-title-banner'],
  },
  {
    id: 'feed',
    label: 'Top Raids',
    summary: 'Replay feed with upvote / watch rows.',
    assetKeys: ['ui-hud-bg', 'ui-panel-bg', 'ui-button-primary-bg', 'ui-progress-bar-frame'],
  },
  {
    id: 'builder',
    label: 'Builders',
    summary: 'Builder queue countdown + skip buttons.',
    assetKeys: ['ui-hud-bg', 'ui-panel-bg', 'ui-button-primary-bg', 'ui-progress-bar-frame'],
  },
  {
    id: 'queen',
    label: 'Queen skins',
    summary: 'Cosmetic queen portraits picker. Uses the card frame + panel chrome.',
    assetKeys: ['ui-card-frame', 'ui-panel-bg', 'ui-button-primary-bg'],
  },
  {
    id: 'misc',
    label: 'Shared chrome',
    summary: 'Reusable UI chrome that appears on almost every screen.',
    assetKeys: [
      'ui-panel-bg',
      'ui-tooltip-bg',
      'ui-close-button',
      'ui-title-banner',
    ],
  },
];

// Paths to the saved sprites. Match BootScene's assetPath — the
// server serves whatever the admin generated under this exact
// filename, and the manifest chooses between .webp / .png. We try
// both and let the browser 404 the missing one invisibly.
function spriteUrl(key: string, ext: 'webp' | 'png' = 'webp'): string {
  return `/assets/sprites/${key}.${ext}`;
}

type Prompts = Awaited<ReturnType<typeof fetchPrompts>>;

interface PreviewContext {
  prompts: Prompts | null;
  overrides: Record<string, boolean>;
  getCompression: () => CompressOptions;
  root: HTMLElement;
  activeScene: string;
}

// Output-format preferences for the regenerate flow. Mirrors the
// shape exposed by main.ts::state.compression so callers can pass
// their existing cache directly.
export interface CompressOptions {
  format: 'webp' | 'png';
  quality: number;
  maxDim: number;
}

const STYLE_ID = 'hive-admin-preview';
const PREVIEW_TAB_STORAGE_KEY = 'hive.adminPreviewScene';

// Module-scope cache for prompts + overrides so flipping back to
// the Preview tab doesn't trigger a fresh network round-trip every
// time. The caller (main admin) owns the prompt cache already —
// renderPreviewPanel accepts it as `initialPrompts` so we skip the
// /admin/api/prompts fetch entirely when the caller has it. For
// overrides the admin didn't maintain a shared cache yet, so we
// memoize the first fetch here. Both fall through to a fetch if
// nothing was passed and the cache is empty.
let cachedOverrides: Record<string, boolean> | null = null;

export interface RenderPreviewOptions {
  initialPrompts?: Prompts | null;
  initialOverrides?: Record<string, boolean> | null;
  getCompression?: () => CompressOptions;
}

export function renderPreviewPanel(
  opts: RenderPreviewOptions = {},
): HTMLElement {
  ensureStyle();
  const wrap = document.createElement('section');
  wrap.className = 'preview-panel';
  const ctx: PreviewContext = {
    prompts: opts.initialPrompts ?? null,
    overrides: opts.initialOverrides ?? cachedOverrides ?? {},
    getCompression:
      opts.getCompression ??
      ((): CompressOptions => ({ format: 'webp', quality: 0.88, maxDim: 512 })),
    root: wrap,
    activeScene:
      localStorage.getItem(PREVIEW_TAB_STORAGE_KEY) ?? PREVIEW_SCENES[0]!.id,
  };
  if (opts.initialOverrides) cachedOverrides = opts.initialOverrides;

  // Paint immediately with whatever cached data we already have so
  // there's no blank frame on tab switches; hydrate() only fetches
  // the pieces we still need (prompts and/or overrides) and swaps
  // them in when they arrive.
  const havePrompts = ctx.prompts !== null;
  const haveOverrides = opts.initialOverrides != null || cachedOverrides != null;
  if (havePrompts || haveOverrides) renderAll(ctx);
  if (!havePrompts || !haveOverrides) void hydrate(ctx, { havePrompts, haveOverrides });

  return wrap;
}

async function hydrate(
  ctx: PreviewContext,
  already: { havePrompts: boolean; haveOverrides: boolean },
): Promise<void> {
  try {
    const promptsP = already.havePrompts ? null : fetchPrompts();
    const overridesP = already.haveOverrides ? null : fetchUiOverrideSettings();
    const [prompts, overrides] = await Promise.all([promptsP, overridesP]);
    if (prompts) ctx.prompts = prompts;
    if (overrides) {
      ctx.overrides = { ...overrides.values };
      cachedOverrides = ctx.overrides;
    }
  } catch (err) {
    renderMessage(ctx.root, `Failed to load preview data: ${(err as Error).message}`);
    return;
  }
  renderAll(ctx);
}

function renderMessage(parent: HTMLElement, msg: string): void {
  parent.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'meta';
  p.textContent = msg;
  parent.append(p);
}

function renderAll(ctx: PreviewContext): void {
  ctx.root.innerHTML = '';

  // Scene selector.
  const sceneTabs = document.createElement('div');
  sceneTabs.className = 'preview-scene-tabs';
  for (const s of PREVIEW_SCENES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = s.label;
    btn.className =
      'preview-scene-tab' + (s.id === ctx.activeScene ? ' is-active' : '');
    btn.addEventListener('click', () => {
      if (s.id === ctx.activeScene) return;
      ctx.activeScene = s.id;
      localStorage.setItem(PREVIEW_TAB_STORAGE_KEY, s.id);
      renderAll(ctx);
    });
    sceneTabs.append(btn);
  }
  ctx.root.append(sceneTabs);

  const scene = PREVIEW_SCENES.find((s) => s.id === ctx.activeScene);
  if (!scene) return;

  const stage = document.createElement('div');
  stage.className = 'preview-scene-stage';

  stage.append(buildMockup(scene));
  stage.append(buildAssetsList(ctx, scene));
  ctx.root.append(stage);
}

function buildMockup(scene: PreviewScene): HTMLElement {
  const mockup = document.createElement('div');
  mockup.className = 'preview-mockup';
  mockup.innerHTML = `
    <h3>${escapeHtml(scene.label)}</h3>
    <p>${escapeHtml(scene.summary)}</p>
  `;
  const thumbs = document.createElement('div');
  thumbs.className = 'preview-mockup-thumbs';
  for (const key of scene.assetKeys) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = key;
    // Try webp first; on error fall back to png. Older deploys may
    // only have one of the two.
    img.src = spriteUrl(key, 'webp');
    img.addEventListener('error', () => {
      if (img.dataset.pngTried === '1') return;
      img.dataset.pngTried = '1';
      img.src = spriteUrl(key, 'png');
    });
    thumbs.append(img);
  }
  mockup.append(thumbs);
  return mockup;
}

function buildAssetsList(ctx: PreviewContext, scene: PreviewScene): HTMLElement {
  const list = document.createElement('div');
  list.className = 'preview-assets';
  for (const key of scene.assetKeys) {
    list.append(buildAssetRow(ctx, key));
  }
  return list;
}

function buildAssetRow(ctx: PreviewContext, key: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'preview-asset';

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = key;
  img.src = spriteUrl(key, 'webp');
  img.addEventListener('error', () => {
    if (img.dataset.pngTried === '1') {
      img.alt = `${key} (not generated yet)`;
      return;
    }
    img.dataset.pngTried = '1';
    img.src = spriteUrl(key, 'png');
  });
  row.append(img);

  const mid = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = key;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const on = !!ctx.overrides[key];
  meta.textContent = on
    ? 'Override ON — the generated image is shown in-game.'
    : 'Override OFF — the Graphics fallback is shown in-game.';
  mid.append(name, meta);
  row.append(mid);

  // Controls: toggle + regenerate.
  const controls = document.createElement('div');
  controls.className = 'controls';

  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'preview-toggle';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = on;
  cb.addEventListener('change', async () => {
    const next = { ...ctx.overrides, [key]: cb.checked };
    try {
      await putUiOverrideSettings(next);
      ctx.overrides = next;
      meta.textContent = cb.checked
        ? 'Override ON — the generated image is shown in-game.'
        : 'Override OFF — the Graphics fallback is shown in-game.';
    } catch (err) {
      cb.checked = !cb.checked;
      alert(`Toggle failed: ${(err as Error).message}`);
    }
  });
  toggleLabel.append(cb, document.createTextNode('Override'));
  controls.append(toggleLabel);

  const regenBtn = document.createElement('button');
  regenBtn.type = 'button';
  regenBtn.className = 'btn';
  regenBtn.textContent = 'Regenerate';
  regenBtn.addEventListener('click', () => {
    openRegenerateDialog(ctx, key, img);
  });
  controls.append(regenBtn);

  row.append(controls);
  return row;
}

// Minimal regenerate dialog — shows the existing prompt, a run
// button, and a preview of the new images. Saving promotes one to
// /assets/sprites/<key>.webp, same contract as the Sprites-tab
// SpriteCard uses.
function openRegenerateDialog(
  ctx: PreviewContext,
  key: string,
  thumb: HTMLImageElement,
): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'background:rgba(6,10,8,0.82)',
    'backdrop-filter:blur(4px)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'z-index:3000',
  ].join(';');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const card = document.createElement('div');
  card.style.cssText = [
    'width:min(620px,92vw)',
    'max-height:90vh',
    'overflow:auto',
    'background:var(--panel)',
    'color:var(--text)',
    'border:1px solid var(--border)',
    'border-radius:14px',
    'padding:20px',
    'font-family:var(--font)',
  ].join(';');
  overlay.append(card);

  const title = document.createElement('h3');
  title.style.margin = '0 0 6px';
  title.textContent = `Regenerate ${key}`;
  card.append(title);

  const existing = ctx.prompts?.menuUi?.[key] ?? '';
  const styleLock = ctx.prompts?.styleLock ?? '';
  const promptLabel = document.createElement('label');
  promptLabel.style.cssText = 'display:block;font-size:12px;color:var(--text-dim);margin-top:10px';
  promptLabel.textContent = 'Prompt';
  const promptBox = document.createElement('textarea');
  promptBox.value = existing;
  promptBox.style.cssText = 'width:100%;min-height:120px;margin-top:6px;padding:10px;font-family:var(--font);font-size:13px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px';
  card.append(promptLabel, promptBox);

  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;color:var(--text-dim);margin-top:10px';
  card.append(status);

  const resultsWrap = document.createElement('div');
  resultsWrap.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin-top:12px';
  card.append(resultsWrap);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:16px';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn ghost';
  cancelBtn.textContent = 'Close';
  cancelBtn.addEventListener('click', () => overlay.remove());
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn';
  saveBtn.textContent = 'Save prompt only';
  saveBtn.addEventListener('click', () => {
    void updatePrompt({ category: 'menuUi', key, value: promptBox.value }).then(() => {
      status.textContent = 'Prompt saved.';
      if (ctx.prompts) {
        ctx.prompts.menuUi = ctx.prompts.menuUi ?? {};
        ctx.prompts.menuUi[key] = promptBox.value;
      }
    }).catch((err: Error) => { status.textContent = `Save failed: ${err.message}`; });
  });
  const genBtn = document.createElement('button');
  genBtn.type = 'button';
  genBtn.className = 'btn primary';
  genBtn.textContent = 'Generate';
  genBtn.addEventListener('click', () => {
    const compression = ctx.getCompression();
    void runGeneration({
      prompt: [styleLock, promptBox.value].filter(Boolean).join('\n\n'),
      statusEl: status,
      resultsEl: resultsWrap,
      key,
      thumb,
      compression,
      onSaved: () => {
        // Update every thumbnail that renders this key — the row's
        // img, the mockup strip at the top of the stage, and any
        // other matching <img alt="key"> inside the Preview panel —
        // so the admin sees the new image land everywhere instantly
        // without a reload. Reset `pngTried` so the error listener
        // can fall back correctly if the new asset 404s.
        const newUrl = spriteUrl(key, compression.format) + `?v=${Date.now()}`;
        ctx.root.querySelectorAll(`img[alt="${key}"]`).forEach((el) => {
          const imgEl = el as HTMLImageElement;
          imgEl.dataset.pngTried = '';
          imgEl.src = newUrl;
        });
      },
    }).catch((err: Error) => {
      status.textContent = `Generate failed: ${err.message}`;
    });
  });
  actions.append(cancelBtn, saveBtn, genBtn);
  card.append(actions);

  document.body.append(overlay);
}

async function runGeneration(args: {
  prompt: string;
  statusEl: HTMLElement;
  resultsEl: HTMLElement;
  key: string;
  thumb: HTMLImageElement;
  compression: CompressOptions;
  onSaved: () => void;
}): Promise<void> {
  args.statusEl.textContent = 'Generating…';
  args.resultsEl.innerHTML = '';
  const images = await generateImages({ prompt: args.prompt, variants: 3 });
  args.statusEl.textContent = `Generated ${images.length}. Click one to save.`;
  const { format, quality, maxDim } = args.compression;
  for (const img of images) {
    const el = document.createElement('img');
    el.src = `data:${img.mimeType};base64,${img.data}`;
    el.style.cssText = 'width:140px;height:140px;object-fit:contain;background:var(--bg);border:1px solid var(--border);border-radius:8px;cursor:pointer';
    el.title = 'Click to save as the new ' + args.key;
    el.addEventListener('click', async () => {
      args.statusEl.textContent = 'Compressing + saving…';
      const compressed = await compressBase64Image(img.data, img.mimeType, {
        format,
        quality,
        maxDimension: maxDim,
      });
      await saveSprite({ key: args.key, data: compressed.base64, format });
      args.statusEl.textContent = 'Saved.';
      args.onSaved();
    });
    args.resultsEl.append(el);
  }
}

function ensureStyle(): void {
  // Styles are bundled via admin/styles.css so nothing dynamic to do
  // here — the helper stays in place so a later inline tweak has an
  // obvious hook. Using STYLE_ID to future-proof.
  void STYLE_ID;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Re-exports kept tidy so the main admin module only imports what it
// needs from here.
export type { PreviewContext };

// Unused helper keeps @ts-nocheck happy when SpriteCard is referenced
// elsewhere but not used on this path yet.
void SpriteCard;
