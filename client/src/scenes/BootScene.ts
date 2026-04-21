import Phaser from 'phaser';
import type { FBInstantBridge } from '../fbinstant/FBInstantBridge.js';
import { ALL_SPRITE_KEYS, spritePath } from '../assets/atlas.js';
import { generateMissingPlaceholders } from '../assets/placeholders.js';

// BootScene loads any real Gemini-generated sprites from
// /assets/sprites/<key>.png, then bakes procedural placeholders for any
// slot that's still missing. This keeps the game visually complete
// whether or not the art pipeline has been run.

export class BootScene extends Phaser.Scene {
  constructor(private readonly fb: FBInstantBridge) {
    super('BootScene');
  }

  preload(): void {
    this.load.on('progress', (p: number) => this.fb.setLoadingProgress(p));

    // Treat per-file errors as "missing" and continue — they'll be
    // replaced by placeholders in create(). Without this, a single 404
    // would halt the loader.
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      // keep this at debug level; expected until the atlas is generated.
      console.debug('[boot] sprite missing, placeholder will draw:', file.key);
    });

    for (const key of ALL_SPRITE_KEYS) {
      this.load.image(key, spritePath(key));
    }
  }

  create(): void {
    generateMissingPlaceholders(this, ALL_SPRITE_KEYS);
    // Dismiss the HTML splash in case main.ts missed it (defense in depth).
    document.getElementById('boot-splash')?.remove();
    this.scene.start('HomeScene');
  }
}
