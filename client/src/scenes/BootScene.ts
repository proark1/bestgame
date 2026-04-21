import Phaser from 'phaser';
import type { FBInstantBridge } from '../fbinstant/FBInstantBridge.js';
import {
  ALL_SPRITE_KEYS,
  ANIMATED_UNIT_KINDS,
  WALK_CYCLE_FRAME_COUNT,
  WALK_CYCLE_FRAME_H,
  WALK_CYCLE_FRAME_W,
  WALK_CYCLE_FPS,
} from '../assets/atlas.js';
import { generateMissingPlaceholders } from '../assets/placeholders.js';

// BootScene — tries the real Gemini-generated sprite for each key (WebP
// first for size, PNG as fallback), then bakes a procedural placeholder
// for any slot still missing. Also loads optional walk-cycle
// spritesheets for the animated units and registers a Phaser animation
// per kind so scenes can just `.play('walk-<Kind>')`.

function walkSheetKey(kind: string): string {
  return `unit-${kind}-walk`;
}
function walkAnimKey(kind: string): string {
  return `walk-${kind}`;
}

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

    // Walk-cycle spritesheets for the animated units. Same WebP-first /
    // PNG-fallback dance as the static sprites, but loaded as Phaser
    // spritesheets so the walk animation can cycle frames. `frameConfig`
    // is the same both times — frame geometry is fixed (see atlas.ts).
    const sheetFrameConfig: Phaser.Types.Loader.FileTypes.ImageFrameConfig = {
      frameWidth: WALK_CYCLE_FRAME_W,
      frameHeight: WALK_CYCLE_FRAME_H,
    };
    for (const kind of ANIMATED_UNIT_KINDS) {
      const key = walkSheetKey(kind);
      this.load.spritesheet(
        `${key}.webp`,
        `assets/sprites/${key}.webp`,
        sheetFrameConfig,
      );
      this.load.spritesheet(key, `assets/sprites/${key}.png`, sheetFrameConfig);
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

    // Same promotion for spritesheet variants. Can't reuse
    // addImage for a sheet (frames would be lost), so when only the
    // WebP variant loaded we rename it onto the canonical key via
    // `textures.addSpriteSheet` against the source image.
    for (const kind of ANIMATED_UNIT_KINDS) {
      const key = walkSheetKey(kind);
      const webpKey = `${key}.webp`;
      if (!this.textures.exists(key) && this.textures.exists(webpKey)) {
        const src = this.textures.get(webpKey).getSourceImage() as
          | HTMLImageElement
          | HTMLCanvasElement;
        this.textures.addSpriteSheet(key, src as HTMLImageElement, {
          frameWidth: WALK_CYCLE_FRAME_W,
          frameHeight: WALK_CYCLE_FRAME_H,
        });
      }
      if (this.textures.exists(webpKey)) this.textures.remove(webpKey);

      // Register the walk animation if the sheet loaded. When the file
      // doesn't exist yet (Gemini hasn't generated this one), skip —
      // scenes fall back to the static image in that case.
      const animKey = walkAnimKey(kind);
      if (this.textures.exists(key) && !this.anims.exists(animKey)) {
        this.anims.create({
          key: animKey,
          frames: this.anims.generateFrameNumbers(key, {
            start: 0,
            end: WALK_CYCLE_FRAME_COUNT - 1,
          }),
          frameRate: WALK_CYCLE_FPS,
          repeat: -1,
        });
      }
    }

    generateMissingPlaceholders(this, ALL_SPRITE_KEYS);

    document.getElementById('boot-splash')?.remove();
    this.scene.start('HomeScene');
  }
}
