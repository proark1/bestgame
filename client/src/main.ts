import Phaser from 'phaser';
import { FBInstantBridge } from './fbinstant/FBInstantBridge.js';
import { BootScene } from './scenes/BootScene.js';
import { HomeScene } from './scenes/HomeScene.js';
import { RaidScene } from './scenes/RaidScene.js';

async function main(): Promise<void> {
  const fb = new FBInstantBridge();
  await fb.initialize(() => {});

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#0f1b10',
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: 16 * 48, // tiles × pixels
      height: 12 * 48,
    },
    render: { pixelArt: false, antialias: true },
    // No `physics` block — the shared deterministic sim is our physics;
    // Phaser's built-in physics would add weight and engine-dependent math.
    scene: [new BootScene(fb), new HomeScene(), new RaidScene()],
  });

  void game; // Game holds all its own references; variable kept for debuggability.
}

void main();
