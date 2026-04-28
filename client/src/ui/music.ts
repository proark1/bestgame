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

// When the admin has generated a music track via the ElevenLabs Audio
// tab, the file lives at /audio/music-<scene>.mp3 and an entry shows
// up in /audio/manifest.json. Played as a looped buffer source through
// the shared busGain so the volume slider keeps working. Without an
// admin-published sample the scene stays silent — we no longer fall
// back to a procedural sine pad.
interface ActiveTrack {
  trackId: string;
  source: AudioBufferSourceNode;
  fadeGain: GainNode;
}

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

// ---- Scene track allowlist ----------------------------------------------
// Scenes opt in by name; setSceneTrack rejects anything else so a typo
// can't accidentally fetch a non-existent music file. Adding a new
// scene means appending its id here and (optionally) generating a
// matching `music-<id>` mp3 via the admin Audio panel.

const VALID_TRACKS: ReadonlySet<string> = new Set([
  'home',
  'raid',
  'arena',
  'clan',
]);

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
  if (active && active.trackId === trackId) return;
  if (!VALID_TRACKS.has(trackId)) return;
  const gen = ++trackGeneration;
  stopTrack(0.5);
  // Start the ElevenLabs-generated sample if one is published for this
  // scene (`music-<scene>` in the audio manifest). If not, the scene
  // stays silent until the admin generates an mp3 via the Audio panel.
  void tryStartSample(trackId, gen);
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
  active = { trackId, source, fadeGain };
  return true;
}

function stopTrack(fadeSec: number): void {
  if (!ctx || !active) return;
  const now = ctx.currentTime;
  active.fadeGain.gain.cancelScheduledValues(now);
  active.fadeGain.gain.linearRampToValueAtTime(0, now + fadeSec);
  const stopAt = now + fadeSec + 0.05;
  try { active.source.stop(stopAt); } catch { /* already stopped */ }
  active = null;
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
