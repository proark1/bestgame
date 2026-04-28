// Drifting motes — a soft golden particle layer that floats across the
// scene's backdrop. Adds "alive feel" without requiring sprite art:
// the motes are pure procedural circles, baked once per scene from a
// 1×1 white texture. Same trick used in Royal Match / Sky CotL.
//
// Usage: call attachAmbientMotes(scene) once per scene during create,
// after drawAmbient() but before any board content is added (so motes
// sit between the gradient and the playfield).

import Phaser from 'phaser';
import { COLOR, DEPTHS } from './theme.js';

const MOTE_TEXTURE_KEY = 'ambient-mote';

function ensureMoteTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists(MOTE_TEXTURE_KEY)) return;
  // 16-pixel soft white disc — radial gradient via concentric circles
  // since Phaser Graphics doesn't expose true radial fills. Three
  // bands give a smooth-enough falloff at this size.
  const g = scene.add.graphics().setVisible(false);
  g.fillStyle(0xffffff, 0.18);
  g.fillCircle(8, 8, 8);
  g.fillStyle(0xffffff, 0.32);
  g.fillCircle(8, 8, 5);
  g.fillStyle(0xffffff, 0.85);
  g.fillCircle(8, 8, 2);
  g.generateTexture(MOTE_TEXTURE_KEY, 16, 16);
  g.destroy();
}

export interface AmbientMotesOptions {
  // Approximate density. Default = 1 mote per 28k square pixels, so a
  // 1280×720 viewport gets ~33 motes — visible but not busy.
  density?: number;
  // Tint applied to motes. Defaults to a warm cream so they read as
  // sun-shafts over green or pastel scene backdrops.
  tint?: number;
  // 0..1 — how visible the motes are at peak. Default 0.32.
  alpha?: number;
}

// Returns the emitter so callers can pause/resume on scene events.
export function attachAmbientMotes(
  scene: Phaser.Scene,
  opts: AmbientMotesOptions = {},
): Phaser.GameObjects.Particles.ParticleEmitter {
  ensureMoteTexture(scene);
  const w = scene.scale.width;
  const h = scene.scale.height;
  const density = opts.density ?? 1 / 28000;
  const targetCount = Math.max(8, Math.min(60, Math.round(w * h * density)));
  const emitter = scene.add
    .particles(0, 0, MOTE_TEXTURE_KEY, {
      // Spawn anywhere in the viewport — RandomZone with a Rectangle
      // gives uniform coverage. Y velocity slightly negative so motes
      // drift upward, mimicking pollen + warm air.
      x: { min: 0, max: w },
      y: { min: 0, max: h },
      lifespan: { min: 7000, max: 14000 },
      // Tiny range of velocities so individual motes drift at slightly
      // different speeds — reads as "wind" rather than "uniform scroll".
      speedX: { min: -8, max: 8 },
      speedY: { min: -16, max: -4 },
      scale: { start: 0.4, end: 1.05, ease: 'Sine.easeOut' },
      alpha: { start: 0, end: 0, ease: (t: number) => Math.sin(t * Math.PI) * (opts.alpha ?? 0.32) },
      tint: opts.tint ?? COLOR.warmGlow,
      // Frequency tuned so the steady-state population matches
      // targetCount: total = lifespan / frequency, so frequency =
      // lifespan / count. We use the midpoint lifespan (10500ms).
      frequency: Math.max(120, Math.round(10_500 / targetCount)),
      blendMode: 'ADD',
    })
    .setDepth(DEPTHS.ambientParticles);

  // Seed the layer with `targetCount` motes already in flight so
  // there isn't a cold-start frame where the scene looks empty.
  for (let i = 0; i < targetCount; i++) {
    emitter.emitParticleAt(Math.random() * w, Math.random() * h);
  }

  // Skip dynamic resize handling for the spawn range — the typings on
  // setX/setY don't accept an emit-op range, and mobile rotation
  // feathers in new motes within ~10s anyway as old ones expire.
  scene.events.once('shutdown', () => {
    emitter.destroy();
  });
  return emitter;
}
