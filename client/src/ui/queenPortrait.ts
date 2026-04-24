import Phaser from 'phaser';
import type { QueenSkinDef } from '../net/Api.js';
import { crispText } from './text.js';
import { drawPanel } from './panel.js';
import { COLOR, bodyTextStyle, labelTextStyle } from './theme.js';

// Queen portrait silhouette — used when the queen-<skin> sprite key
// isn't registered yet. Paints a stylized queen-ant profile in the
// skin's palette so the identity layer still reads before the real
// art pipeline ships queen portraits.
//
// Not a replacement for a portrait atlas — once BootScene loads
// queen-<id>.webp assets we'll swap to an Image. This ensures the
// picker, home chip, and prologue screen always have SOMETHING to
// render.

export function drawQueenSilhouette(
  scene: Phaser.Scene,
  x: number,
  y: number,
  radius: number,
  def: QueenSkinDef | null,
): Phaser.GameObjects.Container {
  const c = scene.add.container(x, y);
  const palette = def?.palette ?? { primary: 0xd9a05a, accent: 0x7a4a22, glow: 0xffe7b0 };

  // Generated portrait path: when the admin has created + loaded a
  // queen-<id> texture, render that instead of the silhouette. The
  // silhouette is the fallback chrome when art isn't ready yet.
  // Texture-name convention matches QueenSkin.portraitKey so adding
  // a new skin in queenSkins.ts + generating the art is a one-hop
  // wire-up, no extra lookup table to maintain.
  if (def && scene.textures.exists(def.portraitKey)) {
    const halo = scene.add.graphics();
    halo.fillStyle(palette.glow, 0.16);
    halo.fillCircle(0, 0, radius * 1.25);
    c.add(halo);
    const img = scene.add.image(0, 0, def.portraitKey);
    // Fit into a radius-sized circle while preserving aspect ratio.
    const src = img.texture.getSourceImage();
    const srcW = 'naturalWidth' in src ? src.naturalWidth : src.width;
    const srcH = 'naturalHeight' in src ? src.naturalHeight : src.height;
    const target = radius * 2;
    const scale = target / Math.max(1, Math.max(srcW, srcH));
    img.setDisplaySize(srcW * scale, srcH * scale);
    c.add(img);
    return c;
  }

  // Soft glow halo
  const halo = scene.add.graphics();
  halo.fillStyle(palette.glow, 0.16);
  halo.fillCircle(0, 0, radius * 1.25);
  c.add(halo);
  // Base plate
  const plate = scene.add.graphics();
  plate.fillStyle(palette.accent, 1);
  plate.fillCircle(0, 0, radius);
  plate.lineStyle(3, palette.glow, 0.8);
  plate.strokeCircle(0, 0, radius);
  c.add(plate);
  // Ant silhouette: abdomen, thorax, head
  const s = scene.add.graphics();
  s.fillStyle(palette.primary, 1);
  // Abdomen (bottom oval)
  s.fillEllipse(0, radius * 0.42, radius * 0.75, radius * 0.6);
  // Thorax (middle)
  s.fillEllipse(0, radius * 0.05, radius * 0.52, radius * 0.42);
  // Head (top)
  s.fillEllipse(0, -radius * 0.38, radius * 0.48, radius * 0.42);
  // Crown spikes
  s.fillStyle(palette.glow, 1);
  for (let i = -2; i <= 2; i++) {
    s.fillTriangle(
      i * radius * 0.12 - radius * 0.04,
      -radius * 0.58,
      i * radius * 0.12 + radius * 0.04,
      -radius * 0.58,
      i * radius * 0.12,
      -radius * 0.85,
    );
  }
  // Antennae
  s.lineStyle(2, palette.accent, 1);
  s.beginPath();
  s.moveTo(-radius * 0.1, -radius * 0.5);
  s.lineTo(-radius * 0.3, -radius * 0.75);
  s.moveTo(radius * 0.1, -radius * 0.5);
  s.lineTo(radius * 0.3, -radius * 0.75);
  s.strokePath();
  c.add(s);
  return c;
}

export function drawQueenCard(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  def: QueenSkinDef,
  ownedAndUnlocked: boolean,
  equipped: boolean,
): Phaser.GameObjects.Container {
  const h = 160;
  const c = scene.add.container(x, y);
  const bg = scene.add.graphics();
  drawPanel(bg, 0, 0, w, h, {
    topColor: equipped ? 0x2a3f2d : COLOR.bgCard,
    botColor: COLOR.bgInset,
    stroke: equipped ? COLOR.brassDeep : ownedAndUnlocked ? COLOR.outline : 0x1a1a1a,
    strokeWidth: equipped ? 3 : 2,
    highlight: equipped ? COLOR.brass : COLOR.greenHi,
    highlightAlpha: equipped ? 0.18 : ownedAndUnlocked ? 0.08 : 0.02,
    radius: 14,
    shadowOffset: 3,
    shadowAlpha: 0.22,
  });
  c.add(bg);

  const portrait = drawQueenSilhouette(scene, 52, h / 2, 40, def);
  if (!ownedAndUnlocked) {
    portrait.setAlpha(0.3);
  }
  c.add(portrait);

  c.add(
    crispText(scene, 110, 18, def.name, labelTextStyle(14, ownedAndUnlocked ? COLOR.textGold : COLOR.textDim))
      .setOrigin(0, 0),
  );
  c.add(
    crispText(scene, 110, 42, def.tagline, bodyTextStyle(11, COLOR.textMuted))
      .setOrigin(0, 0)
      .setWordWrapWidth(w - 130, true),
  );
  const unlockStr = describeUnlock(def);
  c.add(
    crispText(scene, 110, 92, unlockStr, bodyTextStyle(11, ownedAndUnlocked ? COLOR.textDim : COLOR.red as unknown as string))
      .setOrigin(0, 0)
      .setWordWrapWidth(w - 130, true),
  );
  if (equipped) {
    c.add(crispText(scene, w - 14, 14, 'EQUIPPED', labelTextStyle(10, COLOR.textGold)).setOrigin(1, 0));
  } else if (!ownedAndUnlocked) {
    c.add(crispText(scene, w - 14, 14, 'LOCKED', labelTextStyle(10, COLOR.textMuted)).setOrigin(1, 0));
  }
  return c;
}

function describeUnlock(def: QueenSkinDef): string {
  switch (def.unlock.kind) {
    case 'default':
      return 'Starter skin.';
    case 'trophies':
      return `Unlock by reaching ${def.unlock.threshold} trophies.`;
    case 'streak':
      return `Unlock by maintaining a ${def.unlock.day}-day login streak.`;
    case 'seasonXp':
      return `Unlock by earning ${def.unlock.xp} season XP.`;
    case 'chapter':
      return `Unlock by clearing chapter ${def.unlock.chapterId}.`;
    case 'shop':
      return `Purchase for ${def.unlock.aphidMilk} Aphid Milk (shop).`;
  }
}
