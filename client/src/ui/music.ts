// Procedural ambient music — a slow-moving sine pad shaped to fit
// behind UI without competing with the SFX layer. No audio files
// shipped; the entire track is synthesised from a handful of
// oscillator nodes routed through a shared LFO + per-scene chord
// shifts. Adds production-value perceived weight at zero asset
// cost, and degrades cleanly to silence when the user mutes music
// or the AudioContext isn't available.
//
// Settings live in localStorage under hive.musicSettings (separate
// blob from SFX so a player who wants quiet music + loud effects
// can have it). Volume slider lives in settingsModal alongside the
// existing SFX volume slider.

const STORAGE_KEY = 'hive.musicSettings';

export interface MusicSettings {
  muted: boolean;
  // 0..1 master volume on the music bus. Defaults conservative —
  // 0.18 is roughly bed-music level under the SFX layer at 0.55.
  volume: number;
}

const DEFAULT_SETTINGS: MusicSettings = {
  muted: false,
  volume: 0.18,
};

let cached: MusicSettings | null = null;

export function getMusicSettings(): MusicSettings {
  if (cached) return cached;
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cached = { ...DEFAULT_SETTINGS };
      return cached;
    }
    const parsed = JSON.parse(raw) as Partial<MusicSettings>;
    cached = {
      muted: typeof parsed.muted === 'boolean' ? parsed.muted : DEFAULT_SETTINGS.muted,
      volume:
        typeof parsed.volume === 'number'
          ? Math.max(0, Math.min(1, parsed.volume))
          : DEFAULT_SETTINGS.volume,
    };
    return cached;
  } catch {
    cached = { ...DEFAULT_SETTINGS };
    return cached;
  }
}

export function setMusicSettings(next: Partial<MusicSettings>): MusicSettings {
  const current = getMusicSettings();
  cached = { ...current, ...next };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    /* private mode */
  }
  applySettingsToActiveTrack();
  return cached;
}

// ---- Audio graph ---------------------------------------------------------

let ctx: AudioContext | null = null;
let busGain: GainNode | null = null;
let active: ActiveTrack | null = null;

interface ProceduralTrack {
  type: 'procedural';
  scene: TrackPreset;
  voices: OscillatorNode[];
  voiceGains: GainNode[];
  // Wall-clock when the chord progression last advanced; used by
  // the cross-fade scheduler to decide when the next chord is due.
  startedAt: number;
}

// When the admin has generated a music track via the ElevenLabs Audio
// tab, the file lives at /audio/music-<scene>.mp3 and an entry shows
// up in /audio/manifest.json. We prefer that over the procedural
// fallback so a real composition replaces the synth pad on the next
// scene swap. Played as a looped buffer source through the same
// busGain so the volume slider keeps working.
interface SampleTrack {
  type: 'sample';
  trackId: string;
  source: AudioBufferSourceNode;
  fadeGain: GainNode;
}

type ActiveTrack = ProceduralTrack | SampleTrack;

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    busGain = ctx.createGain();
    busGain.gain.value = effectiveVolume();
    busGain.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}

function effectiveVolume(): number {
  const s = getMusicSettings();
  return s.muted ? 0 : s.volume;
}

function applySettingsToActiveTrack(): void {
  if (!ctx || !busGain) return;
  // Smooth ramp so dragging the slider doesn't introduce zipper noise.
  const target = effectiveVolume();
  busGain.gain.cancelScheduledValues(ctx.currentTime);
  busGain.gain.linearRampToValueAtTime(target, ctx.currentTime + 0.08);
}

// ---- Track presets -------------------------------------------------------
// Each preset is a small chord progression with a tempo. Voice
// frequencies are computed from the root note + intervals; LFO
// shapes the chord cadence. Tuned so adjacent scenes feel related
// (same root family) but distinct enough that the player notices
// the music changing on transition.

interface ChordSpec {
  // Multiplier on root frequency for each voice. Three-voice triads
  // (root + third + fifth) read as full pads without a fourth voice
  // muddying the low end.
  ratios: number[];
}

interface TrackPreset {
  // Identifier used by setSceneTrack to decide whether a swap is
  // needed (same id = leave the current track running).
  id: string;
  rootHz: number;
  chords: ChordSpec[];
  // Seconds per chord. Long enough to feel like an underscore, not a
  // melodic phrase.
  chordHoldSec: number;
}

const TRACK_HOME: TrackPreset = {
  id: 'home',
  rootHz: 174.61, // F3 — warm, neutral
  chords: [
    { ratios: [1, 1.25, 1.5] },     // major triad (root, M3, P5)
    { ratios: [0.89, 1.12, 1.5] },  // sub-tonic, P4, P5 — gentle drift
    { ratios: [1, 1.2, 1.5] },      // minor triad (root, m3, P5)
  ],
  chordHoldSec: 18,
};

const TRACK_RAID: TrackPreset = {
  id: 'raid',
  rootHz: 196.0, // G3 — slightly tense
  chords: [
    { ratios: [1, 1.2, 1.5] },        // minor triad
    { ratios: [1, 1.2, 1.6] },        // minor + dim 5th
    { ratios: [0.94, 1.18, 1.5] },    // tritone hint
  ],
  chordHoldSec: 12,
};

const TRACK_CLAN: TrackPreset = {
  id: 'clan',
  rootHz: 164.81, // E3 — soft, social
  chords: [
    { ratios: [1, 1.25, 1.5] },
    { ratios: [1.12, 1.33, 1.68] },   // step up — feels conversational
    { ratios: [1, 1.25, 1.5] },
  ],
  chordHoldSec: 24,
};

const TRACKS: Record<string, TrackPreset> = {
  home: TRACK_HOME,
  raid: TRACK_RAID,
  arena: TRACK_RAID, // arena reuses raid's tense palette
  clan: TRACK_CLAN,
};

// ---- Public API ----------------------------------------------------------

// Idempotent — call from each scene's create(). Swapping to the same
// track id is a no-op so the music streams across scene reloads of
// the same scene.
//
// The generation counter (`trackGeneration`) prevents a race condition
// when two setSceneTrack calls overlap. tryStartSample is async (it
// fetches and decodes), and a second call can fire before the first
// resolves; without the gen check we could end up with both a sample
// AND the procedural fallback playing simultaneously.
let trackGeneration = 0;

export function setSceneTrack(trackId: string): void {
  const c = ensureCtx();
  if (!c || !busGain) return;
  if (active && activeTrackId(active) === trackId) return;
  const preset = TRACKS[trackId];
  if (!preset) return;
  const gen = ++trackGeneration;
  stopTrack(0.5);
  // Try the ElevenLabs-generated sample first (`music-<scene>` in the
  // audio manifest). If that's absent the procedural pad covers the
  // gap so a fresh deploy without any music files still has bed
  // music.
  void tryStartSample(trackId, gen).then((started) => {
    // Superseded: another setSceneTrack ran while we were fetching.
    // Bail out — the newer call owns the active slot.
    if (gen !== trackGeneration) return;
    if (started) return;
    if (active) return;
    startTrack(preset);
  });
}

function activeTrackId(t: ActiveTrack): string {
  return t.type === 'procedural' ? t.scene.id : t.trackId;
}

export function stopMusic(): void {
  stopTrack(0.4);
}

// Browsers refuse to start an AudioContext until a user gesture.
// Scene code calls this from any pointerdown handler, defensively.
export function resumeMusic(): void {
  const c = ensureCtx();
  if (!c) return;
  if (c.state === 'suspended') void c.resume();
}

// ---- Internals -----------------------------------------------------------

function startTrack(preset: TrackPreset): void {
  const c = ensureCtx();
  if (!c || !busGain) return;
  const now = c.currentTime;
  const voices: OscillatorNode[] = [];
  const voiceGains: GainNode[] = [];
  // Three voice pad: each voice is a sine + slight detune so
  // overtones beat softly. Beating creates the "pad" feel that a
  // single oscillator can't.
  const initial = preset.chords[0]!;
  for (let i = 0; i < 3; i++) {
    const osc = c.createOscillator();
    osc.type = 'sine';
    const ratio = initial.ratios[i] ?? 1;
    osc.frequency.value = preset.rootHz * ratio;
    // Per-voice gain — middle voice loudest so the chord reads as
    // unison rather than wide harmony.
    const g = c.createGain();
    g.gain.value = i === 1 ? 0.5 : 0.32;
    osc.connect(g);
    g.connect(busGain);
    osc.start(now);
    voices.push(osc);
    voiceGains.push(g);
  }
  active = {
    type: 'procedural',
    scene: preset,
    voices,
    voiceGains,
    startedAt: now,
  };
  // Schedule the chord progression cross-fade loop. Each call
  // advances one chord and schedules the next via setTimeout — one
  // timer at a time so a fast scene-swap doesn't leak callbacks.
  scheduleNextChord(preset, 0);
}

// ElevenLabs-generated music sample loop. Cached per scene so a
// scene-swap-and-back doesn't re-fetch the file. The manifest is
// fetched lazily on first need and cached for the session — admin
// publishes via the Audio tab will only pick up after a reload,
// which matches the existing audioAssets prewarm contract.
//
// Decoded AudioBuffers are uncompressed PCM (~10 MB per minute of
// stereo @ 44.1kHz), so we cap the cache at SAMPLE_CACHE_MAX entries
// and evict in insertion order (Map iteration is insertion-order in
// JS). Today there are ~5 scenes that use music; the cap shields a
// future deploy that adds more scenes from unbounded memory growth.
const SAMPLE_CACHE_MAX = 4;
const SAMPLE_BUFFER_CACHE = new Map<string, AudioBuffer | null>();
function rememberSample(trackId: string, buf: AudioBuffer | null): void {
  if (SAMPLE_BUFFER_CACHE.has(trackId)) {
    SAMPLE_BUFFER_CACHE.delete(trackId);
  } else if (SAMPLE_BUFFER_CACHE.size >= SAMPLE_CACHE_MAX) {
    const oldest = SAMPLE_BUFFER_CACHE.keys().next().value;
    if (typeof oldest === 'string') SAMPLE_BUFFER_CACHE.delete(oldest);
  }
  SAMPLE_BUFFER_CACHE.set(trackId, buf);
}
let manifestPromise: Promise<Record<string, { src: string; gain?: number }>> | null = null;

async function loadMusicManifest(): Promise<Record<string, { src: string; gain?: number }>> {
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    try {
      const res = await fetch('/audio/manifest.json');
      if (!res.ok) return {};
      const list = (await res.json()) as Array<{ key?: string; src?: string; gain?: number }>;
      const out: Record<string, { src: string; gain?: number }> = {};
      for (const e of list) {
        if (!e || typeof e.key !== 'string' || typeof e.src !== 'string') continue;
        if (!e.key.startsWith('music-')) continue;
        out[e.key] = { src: e.src, ...(typeof e.gain === 'number' ? { gain: e.gain } : {}) };
      }
      return out;
    } catch {
      return {};
    }
  })();
  return manifestPromise;
}

async function tryStartSample(trackId: string, gen: number): Promise<boolean> {
  const c = ctx;
  if (!c || !busGain) return false;
  const manifest = await loadMusicManifest();
  const entry = manifest[`music-${trackId}`];
  if (!entry) return false;
  let buffer = SAMPLE_BUFFER_CACHE.get(trackId);
  if (buffer === undefined) {
    try {
      const url = `/audio/${entry.src.replace(/^\/+/, '')}`;
      const res = await fetch(url);
      if (!res.ok) {
        rememberSample(trackId, null);
        return false;
      }
      const arr = await res.arrayBuffer();
      buffer = await c.decodeAudioData(arr);
      rememberSample(trackId, buffer);
    } catch {
      rememberSample(trackId, null);
      return false;
    }
  }
  if (!buffer) return false;
  // Generation guard: another setSceneTrack may have run while we were
  // fetching/decoding. If so, the caller's "started?" check will see
  // gen !== trackGeneration and bail out, but we also refuse to install
  // ourselves into `active` so we never overwrite a newer track.
  if (gen !== trackGeneration) return false;
  if (active) return false;

  const fadeGain = c.createGain();
  fadeGain.gain.value = 0;
  fadeGain.gain.linearRampToValueAtTime(
    Math.max(0, Math.min(1, entry.gain ?? 1)),
    c.currentTime + 0.4,
  );
  fadeGain.connect(busGain);
  const source = c.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(fadeGain);
  source.start(c.currentTime);
  active = { type: 'sample', trackId, source, fadeGain };
  return true;
}

function stopTrack(fadeSec: number): void {
  if (!ctx || !active) return;
  const now = ctx.currentTime;
  if (active.type === 'procedural') {
    for (const g of active.voiceGains) {
      g.gain.cancelScheduledValues(now);
      g.gain.linearRampToValueAtTime(0, now + fadeSec);
    }
    // Stop oscillators after the fade so the gain ramp completes.
    const stopAt = now + fadeSec + 0.05;
    for (const o of active.voices) {
      try { o.stop(stopAt); } catch { /* already stopped */ }
    }
  } else {
    active.fadeGain.gain.cancelScheduledValues(now);
    active.fadeGain.gain.linearRampToValueAtTime(0, now + fadeSec);
    const stopAt = now + fadeSec + 0.05;
    try { active.source.stop(stopAt); } catch { /* already stopped */ }
  }
  active = null;
}

let chordTimer: number | null = null;
function scheduleNextChord(preset: TrackPreset, chordIdx: number): void {
  if (chordTimer !== null) {
    clearTimeout(chordTimer);
    chordTimer = null;
  }
  const c = ctx;
  if (!c || !active || active.type !== 'procedural') return;
  const chord = preset.chords[chordIdx % preset.chords.length]!;
  // Cross-fade each voice's frequency over 4s so chord changes feel
  // like organic drift, not a step.
  const now = c.currentTime;
  for (let i = 0; i < active.voices.length; i++) {
    const ratio = chord.ratios[i] ?? 1;
    const target = preset.rootHz * ratio;
    active.voices[i]!.frequency.cancelScheduledValues(now);
    active.voices[i]!.frequency.linearRampToValueAtTime(target, now + 4);
  }
  chordTimer = window.setTimeout(
    () => scheduleNextChord(preset, chordIdx + 1),
    preset.chordHoldSec * 1000,
  );
}

// Pause music when the tab is hidden so the AudioContext doesn't
// keep voicing into a backgrounded mixer (some platforms throttle,
// others don't — being defensive saves battery either way).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) {
      void ctx.suspend();
    } else {
      void ctx.resume();
    }
  });
}
