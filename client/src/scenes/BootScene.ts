import Phaser from 'phaser';
import type { FBInstantBridge } from '../fbinstant/FBInstantBridge.js';
import {
  ALL_SPRITE_KEYS,
  WALK_CYCLE_FRAME_COUNT,
  WALK_CYCLE_FRAME_H,
  WALK_CYCLE_FRAME_W,
  WALK_CYCLE_FPS,
} from '../assets/atlas.js';
import { generateMissingPlaceholders } from '../assets/placeholders.js';

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

interface ManifestSheet {
  key: string;
  frames: number;
}

interface ManifestResponse {
  images: string[];
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
      (_key: string, _type: string, data: ManifestResponse) => {
        if (this.manifestQueued) return;
        this.manifestQueued = true;
        if (!data || !Array.isArray(data.images) || !Array.isArray(data.sheets)) {
          this.queueLegacyLoads();
          return;
        }
        this.manifest = data;
        this.queueManifestLoads(data);
      },
    );
  }

  private queueManifestLoads(m: ManifestResponse): void {
    const version = m.updatedAt || Date.now();
    const versioned = (path: string): string => `${path}?v=${version}`;

    // Admin saves default to WebP, but disk-mirror workflows may
    // produce PNG. Try WebP first under the canonical key; queue a
    // PNG sibling under a suffix so create() can promote it only if
    // the WebP didn't land. This is the same pre-manifest dance but
    // scoped to keys we actually expect to find — no more 404
    // storm on non-existent sprites.
    for (const key of m.images) {
      this.load.image(key, versioned(`assets/sprites/${key}.webp`));
      this.load.image(`${key}.png-fb`, versioned(`assets/sprites/${key}.png`));
    }

    const sheetFrameConfig: Phaser.Types.Loader.FileTypes.ImageFrameConfig = {
      frameWidth: WALK_CYCLE_FRAME_W,
      frameHeight: WALK_CYCLE_FRAME_H,
    };
    for (const sheet of m.sheets) {
      this.load.spritesheet(
        sheet.key,
        versioned(`assets/sprites/${sheet.key}.webp`),
        sheetFrameConfig,
      );
      this.load.spritesheet(
        `${sheet.key}.png-fb`,
        versioned(`assets/sprites/${sheet.key}.png`),
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
    const promoteFallback = (primary: string, fallback: string): void => {
      if (!this.textures.exists(primary) && this.textures.exists(fallback)) {
        const img = this.textures.get(fallback).getSourceImage() as
          | HTMLImageElement
          | HTMLCanvasElement;
        this.textures.addImage(primary, img as HTMLImageElement);
      }
      if (this.textures.exists(fallback)) this.textures.remove(fallback);
    };

    if (this.manifest) {
      for (const key of this.manifest.images) {
        promoteFallback(key, `${key}.png-fb`);
      }
      for (const sheet of this.manifest.sheets) {
        const primary = sheet.key;
        const fb = `${sheet.key}.png-fb`;
        if (!this.textures.exists(primary) && this.textures.exists(fb)) {
          const src = this.textures.get(fb).getSourceImage() as
            | HTMLImageElement
            | HTMLCanvasElement;
          this.textures.addSpriteSheet(primary, src as HTMLImageElement, {
            frameWidth: WALK_CYCLE_FRAME_W,
            frameHeight: WALK_CYCLE_FRAME_H,
          });
        }
        if (this.textures.exists(fb)) this.textures.remove(fb);

        const animKey = walkAnimKey(sheet.key);
        if (this.textures.exists(primary) && !this.anims.exists(animKey)) {
          this.anims.create({
            key: animKey,
            frames: this.anims.generateFrameNumbers(primary, {
              start: 0,
              end: WALK_CYCLE_FRAME_COUNT - 1,
            }),
            frameRate: WALK_CYCLE_FPS,
            repeat: -1,
          });
        }
      }
    } else {
      // Legacy-path WebP promotion under the `.webp` suffix.
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
    for (const key of this.textures.getTextureKeys()) {
      if (key === '__MISSING' || key === '__DEFAULT' || key === '__WHITE') continue;
      this.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR);
    }

    document.getElementById('boot-splash')?.remove();
    this.scene.start('HomeScene');
  }
}
