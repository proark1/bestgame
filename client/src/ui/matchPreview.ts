// Match-preview overlay — shown when the player taps "Raid" so they
// can see the opponent's name, trophy count, and a tiny base
// thumbnail before committing. Pairs with a "Find another" button
// that re-rolls matchmaking, and a "Begin raid" button that funnels
// into RaidScene with the match pre-stamped on the registry.
//
// Uses a DOM modal layered above the canvas — keeps the matchmaking
// thumbnail rendering off the Phaser scene graph (which is busy
// running HomeScene's animations) and lets us re-style the modal
// without scene-graph plumbing.

import type { Types } from '@hive/shared';
import type { HiveRuntime } from '../main.js';
import type { MatchResponse } from '../net/Api.js';
import { fadeToScene } from './transitions.js';
import type Phaser from 'phaser';

export async function openMatchPreview(
  scene: Phaser.Scene,
  runtime: HiveRuntime,
): Promise<void> {
  const trophies = runtime.player?.player.trophies ?? 100;
  const overlay = document.createElement('div');
  overlay.className = 'hive-match-preview';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 999;
    background: rgba(12, 14, 34, 0.78);
    display: flex; align-items: center; justify-content: center;
    font-family: 'Trebuchet MS', Verdana, sans-serif;
  `;
  const card = document.createElement('div');
  card.style.cssText = `
    background: linear-gradient(180deg, #fff4f6 0%, #ede4f7 100%);
    border: 3px solid #c99b3a;
    border-radius: 16px;
    padding: 22px;
    width: min(92vw, 420px);
    box-shadow: 0 12px 32px rgba(0,0,0,0.5);
    text-align: center;
    color: #1f2148;
  `;
  card.innerHTML = `
    <div style="font: bold 11px/1 'Arial Black', sans-serif; color: #e8884d; letter-spacing: 1.2px;">
      MATCHMAKING
    </div>
    <div class="hive-mp-status" style="margin-top: 14px; font: bold 18px/1.2 'Arial Black', sans-serif;">
      Finding an opponent…
    </div>
    <div class="hive-mp-thumb" style="margin: 18px auto; width: 200px; height: 150px;
         background: #b6e6c0; border: 2px solid #4d9b5c; border-radius: 10px;
         position: relative; overflow: hidden;"></div>
    <div class="hive-mp-info" style="font-size: 13px; color: #4a4d72; min-height: 38px;"></div>
    <div class="hive-mp-buttons" style="margin-top: 16px; display: flex; gap: 10px; justify-content: center;"></div>
  `;
  overlay.append(card);
  document.body.append(overlay);

  const statusEl = card.querySelector('.hive-mp-status') as HTMLElement;
  const thumbEl = card.querySelector('.hive-mp-thumb') as HTMLElement;
  const infoEl = card.querySelector('.hive-mp-info') as HTMLElement;
  const buttonsEl = card.querySelector('.hive-mp-buttons') as HTMLElement;

  const teardown = (): void => {
    overlay.remove();
  };

  let match: MatchResponse | null = null;

  const fetchMatch = async (): Promise<void> => {
    statusEl.textContent = 'Finding an opponent…';
    thumbEl.innerHTML = '';
    infoEl.textContent = '';
    buttonsEl.innerHTML = '';
    try {
      match = await runtime.api.requestMatch(trophies);
      renderMatch();
    } catch {
      statusEl.textContent = 'No match available right now.';
      infoEl.textContent = 'Try again in a moment.';
      renderRetryButton();
    }
  };

  const renderMatch = (): void => {
    if (!match) return;
    statusEl.textContent = match.opponent.displayName;
    infoEl.innerHTML = `
      <div style="margin-top: 4px;">🏆 ${match.opponent.trophies}</div>
      <div style="margin-top: 4px; font-size: 11px; color: #6e7196;">
        ${match.baseSnapshot.buildings.length} buildings
      </div>
    `;
    drawBaseThumb(thumbEl, match.baseSnapshot);
    buttonsEl.innerHTML = '';
    const findBtn = makeBtn('Find another', '#fff8ec', '#1f2148');
    findBtn.onclick = () => void fetchMatch();
    const goBtn = makeBtn('⚔ Begin raid', '#ee5e7c', '#fff8ec');
    goBtn.onclick = () => {
      if (!match) return;
      scene.registry.set('prefilledMatch', match);
      teardown();
      fadeToScene(scene, 'RaidScene');
    };
    const cancelBtn = makeBtn('Cancel', 'transparent', '#1f2148');
    cancelBtn.onclick = teardown;
    buttonsEl.append(cancelBtn, findBtn, goBtn);
  };

  const renderRetryButton = (): void => {
    buttonsEl.innerHTML = '';
    const cancelBtn = makeBtn('Close', 'transparent', '#1f2148');
    cancelBtn.onclick = teardown;
    const retryBtn = makeBtn('Retry', '#ee5e7c', '#fff8ec');
    retryBtn.onclick = () => void fetchMatch();
    buttonsEl.append(cancelBtn, retryBtn);
  };

  await fetchMatch();
}

function makeBtn(label: string, bg: string, color: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.style.cssText = `
    appearance: none; cursor: pointer;
    border: 2px solid ${bg === 'transparent' ? '#b8a285' : 'rgba(0,0,0,0.18)'};
    border-radius: 10px;
    background: ${bg};
    color: ${color};
    font: bold 13px/1 'Arial Black', sans-serif;
    padding: 10px 14px;
  `;
  return b;
}

// Render a small static base thumbnail by drawing a coloured pip per
// building onto an absolutely-positioned div grid. No canvas =
// trivially crisp on retina + zero atlas plumbing.
function drawBaseThumb(host: HTMLElement, base: Types.Base): void {
  host.innerHTML = '';
  const w = 200;
  const h = 150;
  const cellW = w / base.gridSize.w;
  const cellH = h / base.gridSize.h;
  for (const b of base.buildings) {
    const tile = document.createElement('div');
    const col = colourForKind(b.kind);
    // Q-marker for the queen so the eye finds it instantly.
    const isQueen = b.kind === 'QueenChamber';
    tile.style.cssText = `
      position: absolute;
      left: ${b.anchor.x * cellW}px;
      top: ${b.anchor.y * cellH}px;
      width: ${b.footprint.w * cellW - 1}px;
      height: ${b.footprint.h * cellH - 1}px;
      background: ${col};
      border: 1px solid rgba(0,0,0,0.24);
      border-radius: 2px;
      ${isQueen ? 'box-shadow: 0 0 6px rgba(255, 200, 80, 0.9);' : ''}
    `;
    host.append(tile);
  }
}

function colourForKind(kind: string): string {
  // Coarse role colouring — turret-y red, storage-y gold, walls
  // brown, queen bright gold, everything else olive. Players read
  // the cluster shape to pick a target, so per-building accuracy
  // matters less than role distinction.
  if (kind === 'QueenChamber') return '#ffd76b';
  if (kind === 'MushroomTurret' || kind === 'AcidSpitter' || kind === 'SporeTower' || kind === 'HiddenStinger')
    return '#ff7a92';
  if (kind === 'SugarVault' || kind === 'LeafSilo' || kind === 'MilkPot') return '#fdcd6a';
  if (kind === 'LeafWall' || kind === 'ThornHedge' || kind === 'PebbleBunker') return '#8a5a3b';
  if (kind === 'DewCollector' || kind === 'LarvaNursery' || kind === 'AphidFarm') return '#9be0a8';
  if (kind === 'TunnelJunction') return '#9cdaef';
  if (kind === 'SpiderNest') return '#a78ad8';
  return '#6e7196';
}
