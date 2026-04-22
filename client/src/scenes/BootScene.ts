import Phaser from 'phaser';
import type { FBInstantBridge } from '../fbinstant/FBInstantBridge.js';
import type { HiveRuntime } from '../main.js';
import {
  ALL_SPRITE_KEYS,
  WALK_CYCLE_FRAME_COUNT,
  WALK_CYCLE_FRAME_H,
  WALK_CYCLE_FRAME_W,
  WALK_CYCLE_FPS,
} from '../assets/atlas.js';
import { generateMissingPlaceholders } from '../assets/placeholders.js';
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
  constructor(private readonly fb: FBInstantBridge) {
    super('BootScene');
  }

  private manifest: ManifestResponse | null = null;
  private manifestQueued = false;

  preload(): void {
    this.load.on('progress', (p: number) => this.fb.setLoadingProgress(p));
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      // Manifest-fetch failure → queue the legacy every-key path so
      // the game still boots against an older server that doesn't
      // expose /api/sprites/manifest.
      if (file.key === MANIFEST_KEY) {
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
          this.queueLegacyLoads();
          return;
        }
        this.manifest = parsed;
        this.queueManifestLoads(parsed);
      },
    );
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

    const sheetFrameConfig: Phaser.Types.Loader.FileTypes.ImageFrameConfig = {
      frameWidth: WALK_CYCLE_FRAME_W,
      frameHeight: WALK_CYCLE_FRAME_H,
    };
    for (const sheet of m.sheets) {
      this.load.spritesheet(
        sheet.key,
        versioned(`assets/sprites/${sheet.key}.${sheet.ext}`),
        sheetFrameConfig,
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
    if (this.manifest) {
      // Manifest path: one URL per sprite, already loaded under the
      // canonical key. Nothing to promote. Just build the walk anims.
      for (const sheet of this.manifest.sheets) {
        const animKey = walkAnimKey(sheet.key);
        if (this.textures.exists(sheet.key) && !this.anims.exists(animKey)) {
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
        const glTexture = source.glTexture;
        if (!glTexture) continue;
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
        gl.bindTexture(gl.TEXTURE_2D, glTexture);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          gl.LINEAR_MIPMAP_LINEAR,
        );
      }
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
      this.scene.start('HomeScene');
    });
  }
}
