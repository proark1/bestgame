import Phaser from 'phaser';
import { crispText } from './text.js';
import { drawPanel } from './panel.js';
import { fadeToScene } from './transitions.js';
import { makeHiveButton } from './button.js';
import { COLOR, DEPTHS, displayTextStyle } from './theme.js';

// Shared helpers for the stickiness-feature scenes. Each of those
// scenes (campaign, clan wars, replay feed, queen skins, builder
// queue) shares the same "title bar + back button + scrollable body"
// skeleton — this module factors that so each scene file focuses on
// its domain logic instead of re-rolling the chrome.

export const SCENE_HUD_H = 56;

export function drawSceneAmbient(scene: Phaser.Scene): void {
  const g = scene.add.graphics().setDepth(DEPTHS.background);
  const top = 0x203224;
  const bot = 0x070d08;
  const bands = 18;
  for (let i = 0; i < bands; i++) {
    const t = i / (bands - 1);
    const r = Math.round(((top >> 16) & 0xff) + (((bot >> 16) & 0xff) - ((top >> 16) & 0xff)) * t);
    const gc = Math.round(((top >> 8) & 0xff) + (((bot >> 8) & 0xff) - ((top >> 8) & 0xff)) * t);
    const b = Math.round((top & 0xff) + ((bot & 0xff) - (top & 0xff)) * t);
    g.fillStyle((r << 16) | (gc << 8) | b, 1);
    g.fillRect(
      0,
      Math.floor((i * scene.scale.height) / bands),
      scene.scale.width,
      Math.ceil(scene.scale.height / bands) + 1,
    );
  }
  const glow = scene.add.graphics().setDepth(DEPTHS.ambient);
  glow.fillStyle(COLOR.brass, 0.05);
  glow.fillEllipse(
    scene.scale.width / 2,
    SCENE_HUD_H + 140,
    Math.min(820, scene.scale.width * 0.88),
    220,
  );
}

export function drawSceneHud(
  scene: Phaser.Scene,
  title: string,
  backSceneKey: string = 'HomeScene',
): void {
  const w = scene.scale.width;
  const hud = scene.add.graphics();
  drawPanel(hud, 0, 0, w, SCENE_HUD_H, {
    topColor: COLOR.bgPanelHi,
    botColor: COLOR.bgPanelLo,
    strokeWidth: 0,
    highlight: COLOR.brass,
    highlightAlpha: 0.12,
    radius: 0,
    shadowOffset: 0,
    shadowAlpha: 0,
  });
  hud.fillStyle(0x000000, 0.4);
  hud.fillRect(0, SCENE_HUD_H, w, 3);

  makeHiveButton(scene, {
    x: 72,
    y: SCENE_HUD_H / 2,
    width: 120,
    height: 36,
    label: '< Home',
    variant: 'ghost',
    fontSize: 13,
    onPress: () => fadeToScene(scene, backSceneKey),
  });

  crispText(
    scene,
    scene.scale.width / 2,
    SCENE_HUD_H / 2,
    title,
    displayTextStyle(20, COLOR.textGold, 4),
  ).setOrigin(0.5);
}

// Simple scrolling body container. Returns the container + a setter for
// the content height so the caller can cap scroll at the content end.
export function makeScrollBody(
  scene: Phaser.Scene,
  top = SCENE_HUD_H + 24,
): {
  container: Phaser.GameObjects.Container;
  setContentHeight(h: number): void;
} {
  const container = scene.add.container(0, top);
  let contentH = 0;
  let offset = 0;
  let dragStartY = 0;
  let dragStartOffset = 0;
  let dragging = false;

  const clamp = (raw: number): number => {
    const viewportH = scene.scale.height - top - 16;
    const minOffset = Math.min(0, viewportH - contentH);
    return Math.max(minOffset, Math.min(0, raw));
  };

  scene.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
    if (p.y < top) return;
    dragging = true;
    dragStartY = p.y;
    dragStartOffset = offset;
  });
  scene.input.on('pointermove', (p: Phaser.Input.Pointer) => {
    if (!dragging || !p.isDown) return;
    offset = clamp(dragStartOffset + (p.y - dragStartY));
    container.setY(top + offset);
  });
  scene.input.on('pointerup', () => {
    dragging = false;
  });
  scene.input.on(
    'wheel',
    (_p: Phaser.Input.Pointer, _obj: unknown[], _dx: number, dy: number) => {
      offset = clamp(offset - dy);
      container.setY(top + offset);
    },
  );

  return {
    container,
    setContentHeight(h: number): void {
      contentH = h;
      offset = clamp(offset);
      container.setY(top + offset);
    },
  };
}

export function formatCountdown(secondsRemaining: number): string {
  const s = Math.max(0, Math.floor(secondsRemaining));
  if (s <= 0) return 'Ready';
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}
