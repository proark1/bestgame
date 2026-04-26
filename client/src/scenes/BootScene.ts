import Phaser from 'phaser';
import type { HiveRuntime } from '../main.js';
import {
  ALL_SPRITE_KEYS,
  WALK_CYCLE_FRAME_COUNT,
  WALK_CYCLE_FRAME_H,
  WALK_CYCLE_FRAME_W,
  WALK_CYCLE_FPS,
} from '../assets/atlas.js';
import { generateMissingPlaceholders } from '../assets/placeholders.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { crispText } from '../ui/text.js';
import { COLOR, DEPTHS, bodyTextStyle, displayTextStyle, labelTextStyle } from '../ui/theme.js';
import { setUiOverrides } from '../ui/uiOverrides.js';

// BootScene — preloads only the sprite keys the server's
// /api/sprites/manifest actually advertises. Anything missing gets a
// procedural placeholder in create(), so a fresh deploy with no
// generated art still boots into a playable game.
//
// Previous implementation fetched the manifest from an async `init()`.
// Phaser's scene lifecycle does NOT await async init — it calls init()
// synchronously, so preload() fired while `manifest` was still null
// and the legacy every-key fallback queued ~46 404s per boot. Fix:
// load the manifest through Phaser's own Loader (which IS awaitable
// and naturally orders subsequent loads), then queue dependent loads
// from a `filecomplete-json-sprite-manifest` handler. Phaser extends
// the current loader pass when loads are queued from that callback,
// so create() still runs after every sprite has resolved (or 404'd).

const API_BASE: string =
  typeof import.meta.env.VITE_API_URL === 'string' && import.meta.env.VITE_API_URL
    ? import.meta.env.VITE_API_URL
    : '/api';

interface ManifestImage {
  key: string;
  ext: 'webp' | 'png';
}

interface ManifestSheet {
  key: string;
  frames: number;
  ext: 'webp' | 'png';
}

interface ManifestResponse {
  images: ManifestImage[];
  sheets: ManifestSheet[];
  updatedAt: number;
}

const MANIFEST_KEY = 'sprite-manifest';

function walkAnimKey(sheetKey: string): string {
  // Sheet keys are `unit-<Kind>-walk`; anim keys are `walk-<Kind>` so
  // scene callers can build them from just the kind name.
  const stripped = sheetKey.replace(/^unit-/, '').replace(/-walk$/, '');
  return `walk-${stripped}`;
}

// Manifest validator + shape-upgrader. The current server emits
// `{ key, ext }` objects per entry, but older deploys emitted plain
// `string[]` for images (with no ext info). Treat a string as
// `{ key: s, ext: 'webp' }` — the overwhelming default — so a split
// deploy (new client, old server) doesn't 404-spam while upgrading.
function parseManifest(raw: unknown): ManifestResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.images) || !Array.isArray(obj.sheets)) return null;
  const images: ManifestImage[] = [];
  for (const item of obj.images) {
    if (typeof item === 'string') {
      images.push({ key: item, ext: 'webp' });
    } else if (
      item &&
      typeof item === 'object' &&
      typeof (item as { key?: unknown }).key === 'string' &&
      ((item as { ext?: unknown }).ext === 'webp' ||
        (item as { ext?: unknown }).ext === 'png')
    ) {
      images.push({
        key: (item as ManifestImage).key,
        ext: (item as ManifestImage).ext,
      });
    }
  }
  const sheets: ManifestSheet[] = [];
  for (const item of obj.sheets) {
    if (!item || typeof item !== 'object') continue;
    const s = item as { key?: unknown; frames?: unknown; ext?: unknown };
    if (typeof s.key !== 'string' || typeof s.frames !== 'number') continue;
    const ext = s.ext === 'png' || s.ext === 'webp' ? s.ext : 'webp';
    sheets.push({ key: s.key, frames: s.frames, ext });
  }
  const updatedAt =
    typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now();
  return { images, sheets, updatedAt };
}

export class BootScene extends Phaser.Scene {
  private statusText!: Phaser.GameObjects.Text;
  // Title text rendered in drawLoadingScreen. Stashed on the instance
  // so create() can hide it and paint the generated `ui-logo` image
  // in its place once the texture is loaded.
  private titleText!: Phaser.GameObjects.Text;
  private titleCenter: { x: number; y: number } = { x: 0, y: 0 };
  private progressText!: Phaser.GameObjects.Text;
  private progressFill!: Phaser.GameObjects.Graphics;
  private progressTrack = { x: 0, y: 0, w: 0, h: 0 };

  constructor() {
    super('BootScene');
  }

  private manifest: ManifestResponse | null = null;
  private manifestQueued = false;

  preload(): void {
    this.drawLoadingScreen();
    this.setLoadingStatus('Checking colony manifest...');
    this.updateLoadingProgress(0);
    this.load.on('progress', (p: number) => {
      this.updateLoadingProgress(p);
    });
    this.load.once('complete', () => {
      this.updateLoadingProgress(1);
      this.setLoadingStatus('Finalizing colony systems...');
    });
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      // Manifest-fetch failure → queue the legacy every-key path so
      // the game still boots against an older server that doesn't
      // expose /api/sprites/manifest.
      if (file.key === MANIFEST_KEY) {
        this.setLoadingStatus('Manifest unavailable - switching to fallback art pack.');
        if (!this.manifestQueued) {
          this.manifestQueued = true;
          this.queueLegacyLoads();
        }
        return;
      }
      console.debug('[boot] sprite missing, placeholder will draw:', file.key);
    });

    // Step 1: fetch the manifest. Phaser loads it into this.cache.json
    // under MANIFEST_KEY.
    this.load.json(MANIFEST_KEY, `${API_BASE}/sprites/manifest`);

    // Step 2: when the manifest lands, queue the exact sprites it
    // advertises. Queueing inside `filecomplete-json-*` extends the
    // current loader pass, so create() waits for them too.
    this.load.once(
      `filecomplete-json-${MANIFEST_KEY}`,
      (_key: string, _type: string, data: unknown) => {
        if (this.manifestQueued) return;
        this.manifestQueued = true;
        const parsed = parseManifest(data);
        if (!parsed) {
          this.setLoadingStatus('Manifest unreadable - loading fallback art pack.');
          this.queueLegacyLoads();
          return;
        }
        this.manifest = parsed;
        this.setLoadingStatus(
          `Loading ${parsed.images.length + parsed.sheets.length} colony assets...`,
        );
        this.queueManifestLoads(parsed);
      },
    );
  }

  private drawLoadingScreen(): void {
    const w = this.scale.width;
    const h = this.scale.height;

    const bg = this.add.graphics().setDepth(DEPTHS.background);
    const top = 0x203224;
    const mid = 0x142117;
    const bot = 0x060b07;
    const bands = 18;
    for (let i = 0; i < bands; i++) {
      const t = i / Math.max(1, bands - 1);
      const src = t < 0.62 ? top : mid;
      const dst = t < 0.62 ? mid : bot;
      const localT = t < 0.62 ? t / 0.62 : (t - 0.62) / 0.38;
      const r = Math.round(
        ((src >> 16) & 0xff) + (((dst >> 16) & 0xff) - ((src >> 16) & 0xff)) * localT,
      );
      const g = Math.round(
        ((src >> 8) & 0xff) + (((dst >> 8) & 0xff) - ((src >> 8) & 0xff)) * localT,
      );
      const b = Math.round((src & 0xff) + ((dst & 0xff) - (src & 0xff)) * localT);
      bg.fillStyle((r << 16) | (g << 8) | b, 1);
      bg.fillRect(0, Math.floor((i * h) / bands), w, Math.ceil(h / bands) + 1);
    }

    const glow = this.add.graphics().setDepth(DEPTHS.ambient);
    glow.fillStyle(COLOR.brass, 0.06);
    glow.fillEllipse(w / 2, h * 0.34, Math.min(760, w * 0.88), 220);
    glow.fillStyle(COLOR.greenHi, 0.07);
    glow.fillEllipse(w * 0.28, h - 110, 320, 130);
    glow.fillEllipse(w * 0.76, h - 80, 260, 110);

    const cardW = Math.min(520, w - 32);
    const cardH = 228;
    const cardX = (w - cardW) / 2;
    const cardY = Math.max(68, h * 0.5 - cardH / 2);

    const card = this.add.graphics();
    drawPanel(card, cardX, cardY, cardW, cardH, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.16,
      radius: 18,
      shadowOffset: 6,
      shadowAlpha: 0.34,
    });

    const pill = this.add.graphics();
    drawPill(pill, cardX + 18, cardY + 18, 92, 22, { brass: true });
    crispText(this, cardX + 64, cardY + 29, 'Live build', labelTextStyle(10, COLOR.textGold)).setOrigin(
      0.5,
      0.5,
    );

    this.titleText = crispText(
      this,
      w / 2,
      cardY + 54,
      'Hive Wars',
      displayTextStyle(32, COLOR.textGold, 5),
    ).setOrigin(0.5, 0.5);
    this.titleCenter = { x: w / 2, y: cardY + 54 };
    crispText(
      this,
      w / 2,
      cardY + 88,
      'Raising the colony and sharpening the battlefield...',
      bodyTextStyle(14, COLOR.textDim),
    ).setOrigin(0.5, 0.5);

    const trackX = cardX + 24;
    const trackY = cardY + 126;
    const trackW = cardW - 48;
    const trackH = 30;
    const track = this.add.graphics();
    drawPanel(track, trackX, trackY, trackW, trackH, {
      topColor: COLOR.bgInset,
      botColor: COLOR.bgDeep,
      stroke: COLOR.brassDeep,
      strokeWidth: 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.08,
      radius: 14,
      shadowOffset: 0,
      shadowAlpha: 0,
    });

    this.progressTrack = { x: trackX + 3, y: trackY + 3, w: trackW - 6, h: trackH - 6 };
    this.progressFill = this.add.graphics();
    this.progressText = crispText(
      this,
      cardX + cardW - 24,
      trackY - 18,
      '0%',
      labelTextStyle(11, COLOR.textMuted),
    ).setOrigin(1, 0.5);
    this.statusText = crispText(this, w / 2, trackY + 58, '', bodyTextStyle(13, COLOR.textPrimary)).setOrigin(
      0.5,
      0.5,
    );
    crispText(
      this,
      w / 2,
      trackY + 88,
      'Missing art falls back to procedural placeholders, so the game still boots cleanly.',
      bodyTextStyle(11, COLOR.textMuted),
    ).setOrigin(0.5, 0.5);

    this.tweens.add({
      targets: this.titleText,
      scale: { from: 1, to: 1.02 },
      duration: 1500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  private updateLoadingProgress(progress: number): void {
    const clamped = Phaser.Math.Clamp(progress, 0, 1);
    const fillW = Math.max(18, this.progressTrack.w * clamped);
    this.progressFill.clear();
    drawPanel(
      this.progressFill,
      this.progressTrack.x,
      this.progressTrack.y,
      fillW,
      this.progressTrack.h,
      {
        topColor: COLOR.brass,
        botColor: COLOR.goldLo,
        stroke: COLOR.brassDeep,
        strokeWidth: 1,
        highlight: COLOR.goldHi,
        highlightAlpha: 0.18,
        radius: 12,
        shadowOffset: 0,
        shadowAlpha: 0,
      },
    );
    this.progressText.setText(`${Math.round(clamped * 100)}%`);
  }

  private setLoadingStatus(text: string): void {
    this.statusText.setText(text);
  }

  private queueManifestLoads(m: ManifestResponse): void {
    const version = m.updatedAt || Date.now();
    const versioned = (path: string): string => `${path}?v=${version}`;

    // Load exactly the extension the server says exists on disk.
    // The manifest is the source of truth here — no try-both sibling
    // loads, no 404-per-sprite noise in the console.
    for (const img of m.images) {
      this.load.image(
        img.key,
        versioned(`assets/sprites/${img.key}.${img.ext}`),
      );
    }

    // Walk-cycle strips load as PLAIN IMAGES, not spritesheets, so a
    // corrupt / wrong-sized file on disk doesn't trip Phaser's
    // "SpriteSheet frame dimensions will result in zero frames"
    // warning (the loader fires it before any user code can guard).
    // create() inspects each loaded image's actual dimensions and
    // promotes it to a spritesheet via textures.addSpriteSheet ONLY
    // when it matches the expected geometry.
    for (const sheet of m.sheets) {
      this.load.image(
        sheet.key,
        versioned(`assets/sprites/${sheet.key}.${sheet.ext}`),
      );
    }
  }

  private queueLegacyLoads(): void {
    // No manifest (old server / network fail). Try every known key;
    // 404s are expected and handled by the placeholder generator.
    for (const key of ALL_SPRITE_KEYS) {
      this.load.image(`${key}.webp`, `assets/sprites/${key}.webp`);
      this.load.image(key, `assets/sprites/${key}.png`);
    }
  }

  create(): void {
    this.setLoadingStatus('Sharpening textures and preparing the colony...');
    this.updateLoadingProgress(1);
    if (this.manifest) {
      // Manifest path: one URL per sprite, already loaded under the
      // canonical key. Nothing to promote. Just build the walk anims.
      for (const sheet of this.manifest.sheets) {
        const animKey = walkAnimKey(sheet.key);
        if (!this.textures.exists(sheet.key) || this.anims.exists(animKey)) continue;
        // Defensive geometry check — if the on-disk file is corrupt
        // or got saved at the wrong size (e.g. an admin upload that
        // skipped the strip composite), Phaser would log noisy
        // "zero frames" / "Frame X not found" errors. We loaded the
        // sheet as a plain image (queueManifestLoads), so check the
        // natural dimensions before promoting to a spritesheet.
        const src = this.textures.get(sheet.key).getSourceImage() as
          | HTMLImageElement
          | HTMLCanvasElement;
        const minW = WALK_CYCLE_FRAME_W * WALK_CYCLE_FRAME_COUNT;
        if (!src || src.width < minW || src.height < WALK_CYCLE_FRAME_H) {
          // eslint-disable-next-line no-console
          console.warn(
            `[BootScene] skipping walk anim for ${sheet.key}: texture is ${src?.width ?? 0}×${src?.height ?? 0}, expected ≥${minW}×${WALK_CYCLE_FRAME_H}`,
          );
          continue;
        }
        // Promote the plain image to a spritesheet so anim frame
        // lookups work. Texture key stays the same — remove the
        // image entry first to avoid a duplicate-key warning.
        this.textures.remove(sheet.key);
        this.textures.addSpriteSheet(sheet.key, src as HTMLImageElement, {
          frameWidth: WALK_CYCLE_FRAME_W,
          frameHeight: WALK_CYCLE_FRAME_H,
        });
        this.anims.create({
          key: animKey,
          frames: this.anims.generateFrameNumbers(sheet.key, {
            start: 0,
            end: WALK_CYCLE_FRAME_COUNT - 1,
          }),
          frameRate: WALK_CYCLE_FPS,
          repeat: -1,
        });
      }
    } else {
      // Legacy fallback path (manifest fetch failed / old server). In
      // this branch we DID fire a try-both pair per key so promote any
      // webp load to the canonical key name.
      const promoteFallback = (primary: string, fallback: string): void => {
        if (!this.textures.exists(primary) && this.textures.exists(fallback)) {
          const img = this.textures.get(fallback).getSourceImage() as
            | HTMLImageElement
            | HTMLCanvasElement;
          this.textures.addImage(primary, img as HTMLImageElement);
        }
        if (this.textures.exists(fallback)) this.textures.remove(fallback);
      };
      for (const key of ALL_SPRITE_KEYS) {
        promoteFallback(key, `${key}.webp`);
      }
    }

    generateMissingPlaceholders(this, ALL_SPRITE_KEYS);

    // Every sprite — Gemini-generated, disk-committed, or procedural
    // placeholder — gets LINEAR filtering so downscaled sizes (units
    // rendered at 28 px, buildings at ~60 px from a 128 px source)
    // read smooth instead of jagged. Phaser's global antialias flag
    // governs the canvas context; this per-texture setting governs
    // the sampler used when the texture is drawn.
    //
    // Then we layer mipmaps on top for the large source textures.
    // Bilinear alone reads soft when you downscale 128 px → 48 px
    // (ratio 2.67) because it samples only 4 texels. Generating the
    // mip chain + LINEAR_MIPMAP_LINEAR has the GPU pick the right mip
    // level for the on-screen size and tri-linearly blend — which is
    // why downscaled building / unit sprites suddenly read sharp
    // instead of fuzzy on Retina displays.
    const renderer = this.game.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
    const gl: WebGLRenderingContext | null =
      'gl' in renderer && renderer.gl ? renderer.gl : null;
    for (const key of this.textures.getTextureKeys()) {
      if (key === '__MISSING' || key === '__DEFAULT' || key === '__WHITE') continue;
      const texture = this.textures.get(key);
      texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
      if (!gl) continue;
      for (const source of texture.source) {
        // In Phaser 3.60+, source.glTexture is a WebGLTextureWrapper,
        // not a raw WebGLTexture. Passing the wrapper to
        // gl.bindTexture silently emits INVALID_OPERATION — on some
        // mobile GPU drivers a flood of those errors during boot
        // stalls the whole page. Reach through .webGLTexture to get
        // the raw handle WebGL expects.
        const wrapper = source.glTexture as unknown as
          | { webGLTexture?: WebGLTexture | null }
          | null;
        const rawTex = wrapper?.webGLTexture ?? null;
        if (!rawTex) continue;
        const img = source.image as HTMLImageElement | HTMLCanvasElement;
        const w = 'naturalWidth' in img ? img.naturalWidth : img.width;
        const h = 'naturalHeight' in img ? img.naturalHeight : img.height;
        // Mipmaps in WebGL1 require power-of-2 on both axes; in
        // WebGL2 they're always allowed. Gate on POT to stay safe on
        // WebGL1 — a non-POT texture that gets generateMipmap'd
        // becomes invalid and samples as solid black. Almost every
        // sprite is 128 × 128, which IS POT.
        const isPot = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;
        if (!isPot(w) || !isPot(h)) continue;
        gl.bindTexture(gl.TEXTURE_2D, rawTex);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          gl.LINEAR_MIPMAP_LINEAR,
        );
      }
    }

    // Swap the splash title text for the generated logo image when it
    // loaded. We don't gate this on the ui-logo override flag because
    // the presence of the generated texture is itself proof the admin
    // wants the logo. The override flag only governs HomeScene's
    // top-left chrome, where the fallback text reads fine on its own.
    if (this.textures.exists('ui-logo')) {
      this.titleText.setVisible(false);
      const logo = this.add
        .image(this.titleCenter.x, this.titleCenter.y, 'ui-logo')
        .setOrigin(0.5, 0.5);
      // Fit width to the card's inner region + preserve aspect ratio.
      const source = logo.texture.getSourceImage();
      const srcW = 'naturalWidth' in source ? source.naturalWidth : source.width;
      const srcH = 'naturalHeight' in source ? source.naturalHeight : source.height;
      const targetW = Math.min(380, this.scale.width - 80);
      const scale = targetW / Math.max(1, srcW);
      logo.setDisplaySize(targetW, srcH * scale);
      this.tweens.add({
        targets: logo,
        scale: { from: logo.scale, to: logo.scale * 1.02 },
        duration: 1500,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    // Fetch admin UI-override flags before transitioning so HomeScene's
    // first paint uses the correct chrome (NineSlice images vs Graphics
    // fallback). Fire-and-forget on any failure — empty flags map =
    // today's Graphics rendering, which is the safe default.
    const rt = this.registry.get('runtime') as HiveRuntime | undefined;
    const fetchOverrides = rt?.api
      ? rt.api
          .getUiOverrideSettings()
          .then((v) => setUiOverrides(v))
          .catch(() => {
            // leave overrides empty → Graphics path
          })
      : Promise.resolve();

    void fetchOverrides.finally(() => {
      document.getElementById('boot-splash')?.remove();

      // Admin preview jump: when the admin Preview tab iframes the
      // game it appends `?previewScene=home` (or raid/codex/etc). We
      // honor that here and skip the tutorial/prologue routing so the
      // admin always lands on exactly the scene they picked — no
      // matter what tutorial state the guest account happens to be in.
      const previewScene = readPreviewSceneFromQuery();
      if (previewScene) {
        this.scene.start(previewScene);
        return;
      }

      // New players without tutorial progress land on the scripted
      // prologue — narrative hook before their first raid. Anyone
      // past stage 5 lands on Home as before.
      const tutorialStage = rt?.player?.player.tutorialStage ?? 100;
      this.scene.start(tutorialStage < 5 ? 'PrologueScene' : 'HomeScene');
    });
  }
}

// Whitelist of scene keys that `?previewScene=<id>` may jump to. We
// don't accept a raw scene name because typos or tampered URLs would
// otherwise throw inside Phaser's scene manager. Kept small + explicit
// so a new scene added to main.ts has to be opted-in here before the
// admin Preview iframe can render it.
const PREVIEW_SCENE_WHITELIST: Readonly<Record<string, string>> = {
  boot: 'BootScene',
  home: 'HomeScene',
  raid: 'RaidScene',
  codex: 'CodexScene',
  clan: 'ClanScene',
  clanwars: 'ClanWarsScene',
  campaign: 'CampaignScene',
  queen: 'QueenSkinScene',
  leaderboard: 'LeaderboardScene',
  quests: 'QuestsScene',
  builder: 'BuilderQueueScene',
  feed: 'ReplayFeedScene',
  arena: 'ArenaScene',
  defenderai: 'DefenderAIScene',
  history: 'RaidHistoryScene',
  upgrade: 'UpgradeScene',
  prologue: 'PrologueScene',
  misc: 'HomeScene',
};

function readPreviewSceneFromQuery(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const key = params.get('previewScene');
  if (!key) return null;
  const scene = PREVIEW_SCENE_WHITELIST[key.toLowerCase()];
  return scene ?? null;
}
