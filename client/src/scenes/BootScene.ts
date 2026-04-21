import Phaser from 'phaser';
import type { FBInstantBridge } from '../fbinstant/FBInstantBridge.js';

// BootScene — kicks off FB Instant SDK init, loads the minimum atlas
// needed to show HomeScene, then transitions. Everything heavier (arena,
// clan, raid replay) is lazy-loaded on demand.

export class BootScene extends Phaser.Scene {
  constructor(private readonly fb: FBInstantBridge) {
    super('BootScene');
  }

  preload(): void {
    // Placeholder — week-1 has no atlas yet. The Gemini pipeline in
    // tools/gemini-art/ emits `hive-atlas-v1.json` + `.webp` into
    // public/assets/; once those land this line becomes:
    //   this.load.atlas('hive', 'assets/hive-atlas-v1.webp',
    //                   'assets/hive-atlas-v1.json');
    this.load.on('progress', (p: number) => this.fb.setLoadingProgress(p));
  }

  async create(): Promise<void> {
    // Dismiss the HTML splash once Phaser is up and a scene is live.
    const splash = document.getElementById('boot-splash');
    if (splash) splash.remove();
    this.scene.start('HomeScene');
  }
}
