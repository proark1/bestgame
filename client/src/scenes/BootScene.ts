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

// BootScene — preloads real Gemini-generated sprites for the keys the
// server's manifest says actually exist, then bakes procedural
// placeholders for every slot still missing. The manifest fetch lets
// us skip the 20-file-fan-out-of-404s that flooded the devtools
// console on every boot before this change.
//
// If the manifest fetch fails (no network, old server), we fall back
// to the old "try every key, let 404s happen" behavior so the game
// still boots on a server that doesn't have the endpoint yet.

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

function walkAnimKey(kind: string): string {
  // Walk cycles use key `unit-<Kind>-walk`. The anim key mirrors that
  // minus the `unit-` prefix + `-walk` suffix for brevity at callers.
  const stripped = kind.replace(/^unit-/, '').replace(/-walk$/, '');
  return `walk-${stripped}`;
}

async function fetchManifest(): Promise<ManifestResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/sprites/manifest`);
    if (!res.ok) return null;
    return (await res.json()) as ManifestResponse;
  } catch {
    return null;
  }
}

export class BootScene extends Phaser.Scene {
  constructor(private readonly fb: FBInstantBridge) {
    super('BootScene');
  }

  private manifest: ManifestResponse | null = null;

  async init(): Promise<void> {
    // init() completes before preload() runs, so the manifest is in
    // hand by the time we queue loads. If it fails we leave
    // `this.manifest` null and preload falls back to the legacy
    // every-key loader.
    this.manifest = await fetchManifest();
  }

  preload(): void {
    this.load.on('progress', (p: number) => this.fb.setLoadingProgress(p));

    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      console.debug('[boot] sprite missing, placeholder will draw:', file.key);
    });

    const version = this.manifest?.updatedAt ?? Date.now();
    const versioned = (path: string): string => `${path}?v=${version}`;

    if (this.manifest) {
      // Modern path: load exactly what the manifest lists. The
      // WebP-first/PNG-fallback dance is no longer needed — the
      // manifest lists one format per key (whichever was saved), and
      // we probe the disk for the correct extension via a HEAD-free
      // shortcut: the admin pipeline always saves WebP, so we try
      // that first; if it's not present (e.g. a legacy PNG), the
      // singleton fallback load below recovers it.
      for (const key of this.manifest.images) {
        this.load.image(key, versioned(`assets/sprites/${key}.webp`));
        // Paired PNG fallback keyed under a suffix; promoted in
        // create() only when the primary didn't succeed.
        this.load.image(`${key}.png-fb`, versioned(`assets/sprites/${key}.png`));
      }
      for (const sheet of this.manifest.sheets) {
        const sheetFrameConfig: Phaser.Types.Loader.FileTypes.ImageFrameConfig = {
          frameWidth: WALK_CYCLE_FRAME_W,
          frameHeight: WALK_CYCLE_FRAME_H,
        };
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
      return;
    }

    // Legacy fallback: no manifest reachable. Try every key in both
    // formats — this is the pre-change behavior and will fire 404s
    // for missing sprites but still boots the game.
    for (const key of ALL_SPRITE_KEYS) {
      this.load.image(`${key}.webp`, `assets/sprites/${key}.webp`);
      this.load.image(key, `assets/sprites/${key}.png`);
    }
  }

  create(): void {
    // Promote PNG fallbacks when the primary WebP didn't land. Works
    // for both manifest and legacy paths because both use the same
    // suffix convention.
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
        // Promotion path for spritesheets preserves frame geometry by
        // re-adding as a spritesheet, not a plain image.
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

        // Register the walk animation if the sheet landed.
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
      // Legacy-path WebP promotion, same as before this PR.
      for (const key of ALL_SPRITE_KEYS) {
        promoteFallback(key, `${key}.webp`);
      }
    }

    generateMissingPlaceholders(this, ALL_SPRITE_KEYS);

    document.getElementById('boot-splash')?.remove();
    this.scene.start('HomeScene');
  }
}
