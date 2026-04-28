// Settings overlay. DOM-rendered (like the tutorial modal) so we
// don't have to lay out every control inside Phaser. Stores the
// toggles under localStorage keys so scenes can read them at any
// time without a central bus.
//
// Currently bundles:
//   • Sound: mute + master volume slider (see ui/audio.ts)
//   • Performance preset: low / medium / high. Consumers read
//     `getPerformancePreset()` and gate particle counts / ambient
//     motes / building idle tweens accordingly.
//   • Accessibility: text-size scale (1x / 1.25x / 1.5x) applied
//     via a document-level CSS var, and a color-blind palette
//     toggle consumers can opt into.

import { getSettings as getAudio, setSettings as setAudio } from './audio.js';
import { getMusicSettings, setMusicSettings } from './music.js';

const STYLE_ID = 'hive-settings-style';
const PERFORMANCE_KEY = 'hive.perfPreset';
const TEXT_SIZE_KEY = 'hive.textSize';
const COLORBLIND_KEY = 'hive.colorBlind';

export type PerformancePreset = 'low' | 'medium' | 'high';
export type TextSize = '1' | '1.25' | '1.5';

const CSS = `
.hive-settings-overlay {
  position: fixed; inset: 0;
  background: rgba(8, 14, 9, 0.82);
  backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
  z-index: 1002;
  font-family: 'Trebuchet MS', Verdana, sans-serif;
}
.hive-settings-card {
  width: min(440px, 92vw);
  max-height: 90vh; overflow: auto;
  background: linear-gradient(180deg, #243824 0%, #1b2c1c 35%, #0f1b10 100%);
  color: #f4e9cc;
  border: 3px solid #5c4020;
  border-radius: 18px;
  padding: 22px 24px 18px;
  box-shadow:
    inset 0 2px 0 rgba(255, 217, 138, 0.45),
    0 18px 48px rgba(0, 0, 0, 0.6);
}
.hive-settings-card h1 {
  margin: 0 0 4px;
  font-size: 22px;
  color: #ffe7b0;
  letter-spacing: 0.5px;
  text-shadow:
    -1px -1px 0 #0a120c, 1px -1px 0 #0a120c,
    -1px 1px 0 #0a120c,  1px 1px 0 #0a120c,
    0 3px 6px rgba(0, 0, 0, 0.7);
}
.hive-settings-card h2 {
  margin: 18px 0 8px;
  font-size: 12px;
  color: #ffd98a;
  text-transform: uppercase;
  letter-spacing: 1px;
}
.hive-settings-row {
  display: flex; align-items: center; gap: 12px;
  padding: 6px 0;
}
.hive-settings-row label {
  flex: 1; font-size: 14px;
}
.hive-settings-row input[type="range"] { flex: 1; max-width: 180px; }
.hive-settings-row input[type="checkbox"] { transform: scale(1.3); }
.hive-settings-row .seg {
  display: inline-flex; gap: 2px;
  background: rgba(0,0,0,0.35);
  border: 1px solid #2c5a23;
  border-radius: 8px; padding: 2px;
}
.hive-settings-row .seg button {
  background: transparent; color: #bad3a3; border: none;
  padding: 6px 10px; font-size: 12px; cursor: pointer;
  border-radius: 6px; font-family: inherit;
}
.hive-settings-row .seg button.is-active {
  background: rgba(255, 217, 138, 0.18); color: #ffd98a; font-weight: 700;
}
.hive-settings-actions {
  display: flex; gap: 8px; justify-content: flex-end;
  margin-top: 16px;
}
.hive-settings-actions button {
  background: #3d7a2c;
  color: #ecf7d4;
  border: 1px solid #0e2008;
  border-radius: 8px;
  padding: 10px 18px;
  font-family: inherit; font-size: 13px; font-weight: 600;
  cursor: pointer;
}
.hive-settings-actions button.ghost {
  background: #243824;
  color: #c3e8b0;
  border-color: #2c5a23;
}
`;

export function getPerformancePreset(): PerformancePreset {
  try {
    const v = localStorage.getItem(PERFORMANCE_KEY);
    if (v === 'low' || v === 'medium' || v === 'high') return v;
  } catch {
    // fall through
  }
  return 'high';
}

export function getTextSize(): TextSize {
  try {
    const v = localStorage.getItem(TEXT_SIZE_KEY);
    if (v === '1' || v === '1.25' || v === '1.5') return v;
  } catch {
    // fall through
  }
  return '1';
}

export function isColorBlindOn(): boolean {
  try {
    return localStorage.getItem(COLORBLIND_KEY) === '1';
  } catch {
    return false;
  }
}

// Apply any globally-relevant settings at boot so a reloaded page
// honors the user's last choice. Currently only text scale has a
// DOM effect worth setting here; audio + perf + color-blind are
// read where they're used.
export function applyGlobalSettings(): void {
  const size = getTextSize();
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--hive-text-scale', size);
  }
}

function ensureStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.append(el);
}

export function openSettings(): () => void {
  ensureStyle();
  const overlay = document.createElement('div');
  overlay.className = 'hive-settings-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  const card = document.createElement('div');
  card.className = 'hive-settings-card';
  overlay.append(card);

  card.innerHTML = '<h1>Settings</h1>';

  // Sound section ---------------------------------------------------------
  const sound = getAudio();
  card.insertAdjacentHTML('beforeend', '<h2>Sound</h2>');

  const muteRow = document.createElement('div');
  muteRow.className = 'hive-settings-row';
  muteRow.innerHTML = '<label>Mute all sounds</label>';
  const muteCb = document.createElement('input');
  muteCb.type = 'checkbox';
  muteCb.checked = sound.muted;
  muteCb.addEventListener('change', () => {
    setAudio({ muted: muteCb.checked });
  });
  muteRow.append(muteCb);
  card.append(muteRow);

  const volRow = document.createElement('div');
  volRow.className = 'hive-settings-row';
  volRow.innerHTML = '<label>SFX volume</label>';
  const vol = document.createElement('input');
  vol.type = 'range';
  vol.min = '0'; vol.max = '1'; vol.step = '0.05';
  vol.value = String(sound.volume);
  vol.addEventListener('input', () => {
    setAudio({ volume: Number(vol.value) });
  });
  volRow.append(vol);
  card.append(volRow);

  // Music — separate bus from SFX so a player can dial down the
  // ambient drone without losing combat cues.
  const music = getMusicSettings();
  const musicMuteRow = document.createElement('div');
  musicMuteRow.className = 'hive-settings-row';
  musicMuteRow.innerHTML = '<label>Mute music</label>';
  const musicMuteCb = document.createElement('input');
  musicMuteCb.type = 'checkbox';
  musicMuteCb.checked = music.muted;
  musicMuteCb.addEventListener('change', () => {
    setMusicSettings({ muted: musicMuteCb.checked });
  });
  musicMuteRow.append(musicMuteCb);
  card.append(musicMuteRow);

  const musicVolRow = document.createElement('div');
  musicVolRow.className = 'hive-settings-row';
  musicVolRow.innerHTML = '<label>Music volume</label>';
  const musicVol = document.createElement('input');
  musicVol.type = 'range';
  musicVol.min = '0'; musicVol.max = '1'; musicVol.step = '0.05';
  musicVol.value = String(music.volume);
  musicVol.addEventListener('input', () => {
    setMusicSettings({ volume: Number(musicVol.value) });
  });
  musicVolRow.append(musicVol);
  card.append(musicVolRow);

  // Performance section ---------------------------------------------------
  card.insertAdjacentHTML('beforeend', '<h2>Performance</h2>');
  const perfRow = document.createElement('div');
  perfRow.className = 'hive-settings-row';
  perfRow.innerHTML = '<label>Preset</label>';
  const seg = document.createElement('div');
  seg.className = 'seg';
  const presets: PerformancePreset[] = ['low', 'medium', 'high'];
  const currentPerf = getPerformancePreset();
  for (const p of presets) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p[0]!.toUpperCase() + p.slice(1);
    if (p === currentPerf) b.classList.add('is-active');
    b.addEventListener('click', () => {
      try { localStorage.setItem(PERFORMANCE_KEY, p); } catch { /* ignore */ }
      seg.querySelectorAll('button').forEach((el) => el.classList.remove('is-active'));
      b.classList.add('is-active');
    });
    seg.append(b);
  }
  perfRow.append(seg);
  card.append(perfRow);

  // Accessibility section -------------------------------------------------
  card.insertAdjacentHTML('beforeend', '<h2>Accessibility</h2>');
  const sizeRow = document.createElement('div');
  sizeRow.className = 'hive-settings-row';
  sizeRow.innerHTML = '<label>Text size</label>';
  const sizeSeg = document.createElement('div');
  sizeSeg.className = 'seg';
  const sizes: TextSize[] = ['1', '1.25', '1.5'];
  const currentSize = getTextSize();
  for (const s of sizes) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s + '×';
    if (s === currentSize) b.classList.add('is-active');
    b.addEventListener('click', () => {
      try { localStorage.setItem(TEXT_SIZE_KEY, s); } catch { /* ignore */ }
      sizeSeg.querySelectorAll('button').forEach((el) => el.classList.remove('is-active'));
      b.classList.add('is-active');
      applyGlobalSettings();
    });
    sizeSeg.append(b);
  }
  sizeRow.append(sizeSeg);
  card.append(sizeRow);

  const cbRow = document.createElement('div');
  cbRow.className = 'hive-settings-row';
  cbRow.innerHTML = '<label>Color-blind palette</label>';
  const cbCb = document.createElement('input');
  cbCb.type = 'checkbox';
  cbCb.checked = isColorBlindOn();
  cbCb.addEventListener('change', () => {
    try {
      localStorage.setItem(COLORBLIND_KEY, cbCb.checked ? '1' : '0');
    } catch {
      /* ignore */
    }
  });
  cbRow.append(cbCb);
  card.append(cbRow);

  // Actions ---------------------------------------------------------------
  const actions = document.createElement('div');
  actions.className = 'hive-settings-actions';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => overlay.remove());
  actions.append(closeBtn);
  card.append(actions);

  document.body.append(overlay);
  return (): void => overlay.remove();
}
