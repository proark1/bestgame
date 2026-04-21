import Phaser from 'phaser';
import type { FBInstantBridge } from '../fbinstant/FBInstantBridge.js';
import { ALL_SPRITE_KEYS } from '../assets/atlas.js';
import { generateMissingPlaceholders } from '../assets/placeholders.js';

// BootScene — tries the real Gemini-generated sprite for each key (WebP
// first for size, PNG as fallback), then bakes a procedural placeholder
// for any slot still missing. Keeps the game visually complete whether
// or not the admin has generated art yet.

export class BootScene extends Phaser.Scene {
  constructor(private readonly fb: FBInstantBridge) {
    super('BootScene');
  }

  preload(): void {
    this.load.on('progress', (p: number) => this.fb.setLoadingProgress(p));

    // Individual-file errors: don't halt the loader — the missing sprite
    // just gets a procedural placeholder in create(). Expected until
    // an admin runs Gemini generation for every slot.
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      console.debug('[boot] sprite missing, placeholder will draw:', file.key);
    });

    // For each key, we kick off TWO loads: a WebP under "<key>.webp" and a
    // PNG under "<key>" itself. The first to succeed wins by texture-key
    // resolution order: if the .webp variant loads, it registers under
    // the suffixed key and we copy it onto the canonical key in create().
    // That way Phaser's texture cache keeps one entry per sprite and
    // scene rendering never needs to branch on format.
    for (const key of ALL_SPRITE_KEYS) {
      this.load.image(`${key}.webp`, `assets/sprites/${key}.webp`);
      this.load.image(key, `assets/sprites/${key}.png`);
    }
  }

  create(): void {
    // Promote WebP-loaded textures to the canonical key when the PNG
    // sibling didn't load. Destroy the .webp alias afterward to keep
    // the texture cache tidy.
    for (const key of ALL_SPRITE_KEYS) {
      const webpKey = `${key}.webp`;
      if (!this.textures.exists(key) && this.textures.exists(webpKey)) {
        const img = this.textures.get(webpKey).getSourceImage() as
          | HTMLImageElement
          | HTMLCanvasElement;
        this.textures.addImage(key, img as HTMLImageElement);
      }
      if (this.textures.exists(webpKey)) this.textures.remove(webpKey);
    }

    generateMissingPlaceholders(this, ALL_SPRITE_KEYS);

    document.getElementById('boot-splash')?.remove();
    this.scene.start('HomeScene');
  }
}
