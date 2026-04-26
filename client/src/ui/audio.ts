// Lightweight WebAudio SFX module. No external files — every sound
// is synthesized from a short envelope on a plain OscillatorNode.
// Keeps the client bundle lean, avoids the asset pipeline cost, and
// lets the palette evolve without a new deploy. When the admin wants
// richer audio later, the same `play()` entry points stay; we just
// load `<audio>` files behind the same API.
//
// Volume + mute live in localStorage under a single JSON blob so the
// settings modal can read + write them in one round-trip and scenes
// see changes immediately (no signal bus needed — the getter reads
// on every call).

const STORAGE_KEY = 'hive.audioSettings';

export interface AudioSettings {
  muted: boolean;
  // 0..1 master volume applied to every SFX gain node.
  volume: number;
}

const DEFAULT_SETTINGS: AudioSettings = {
  muted: false,
  volume: 0.55,
};

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let cached: AudioSettings | null = null;

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = getSettings().volume;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}

// Browsers require a user gesture before AudioContext plays. Every
// tap calls this (defensive no-op if already running).
export function resumeAudio(): void {
  const c = ensureContext();
  if (!c) return;
  if (c.state === 'suspended') void c.resume();
}

export function getSettings(): AudioSettings {
  if (cached) return cached;
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cached = { ...DEFAULT_SETTINGS };
      return cached;
    }
    const parsed = JSON.parse(raw) as Partial<AudioSettings>;
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

export function setSettings(next: Partial<AudioSettings>): AudioSettings {
  const current = getSettings();
  cached = { ...current, ...next };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // ignore quota errors; in-memory cache still applies for this session
  }
  if (master) {
    master.gain.value = cached.muted ? 0 : cached.volume;
  }
  return cached;
}

// A short synthesized blip. Envelope-shaped so clicks don't pop.
// `startTime` defaults to "now" but sequences pass c.currentTime + offset
// so multi-note SFX stay sample-accurate even when the main thread jitters.
function tone(args: {
  freq: number;
  duration: number; // seconds
  type?: OscillatorType;
  gain?: number; // 0..1 relative to master
  sweepTo?: number; // if set, freq sweeps to this value over duration
  attack?: number;
  release?: number;
  startTime?: number;
}): void {
  const c = ensureContext();
  if (!c || !master) return;
  const settings = getSettings();
  if (settings.muted) return;

  const when = args.startTime ?? c.currentTime;
  const osc = c.createOscillator();
  osc.type = args.type ?? 'sine';
  osc.frequency.value = args.freq;
  if (args.sweepTo !== undefined) {
    osc.frequency.linearRampToValueAtTime(args.sweepTo, when + args.duration);
  }
  const env = c.createGain();
  const peak = args.gain ?? 0.5;
  const attack = Math.max(0.001, args.attack ?? 0.01);
  const release = Math.max(0.01, args.release ?? 0.08);
  env.gain.value = 0;
  env.gain.linearRampToValueAtTime(peak, when + attack);
  env.gain.linearRampToValueAtTime(0, when + args.duration + release);

  osc.connect(env);
  env.connect(master);
  osc.start(when);
  osc.stop(when + args.duration + release + 0.02);
}

// Singleton white-noise buffer reused across every noiseBurst() call.
// AudioBufferSourceNode reads the buffer immutably and is one-shot
// (start/stop), so concurrent bursts can safely share the same
// underlying samples — each gets its own filter + gain chain. This
// is materially cheaper than allocating + filling 11 kB of Float32
// on every building hit during a 5-unit burst.
let sharedNoiseBuffer: AudioBuffer | null = null;

function getSharedNoiseBuffer(c: AudioContext): AudioBuffer {
  if (sharedNoiseBuffer && sharedNoiseBuffer.sampleRate === c.sampleRate) {
    return sharedNoiseBuffer;
  }
  // 0.25 s of pre-baked white noise — long enough to cover any
  // single noise-burst SFX. Re-baked if the AudioContext sample
  // rate differs (some browsers vary on output device change).
  const sampleCount = Math.ceil(c.sampleRate * 0.25);
  const buffer = c.createBuffer(1, sampleCount, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) data[i] = Math.random() * 2 - 1;
  sharedNoiseBuffer = buffer;
  return buffer;
}

// Filtered noise burst — drives the "thunk" of an impact better than a
// pure tone. Re-uses a singleton white-noise buffer (see above) and
// allocates only the per-call source / filter / gain nodes that the
// WebAudio graph needs to mix overlapping bursts independently.
function noiseBurst(args: {
  centerHz: number;     // filter centre frequency
  q?: number;           // filter Q (sharper at higher Q)
  duration: number;     // seconds
  gain?: number;        // 0..1 relative to master
  attack?: number;
  release?: number;
  startTime?: number;
}): void {
  const c = ensureContext();
  if (!c || !master) return;
  if (getSettings().muted) return;

  const when = args.startTime ?? c.currentTime;
  const src = c.createBufferSource();
  src.buffer = getSharedNoiseBuffer(c);
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = args.centerHz;
  filter.Q.value = args.q ?? 4;
  const env = c.createGain();
  const peak = args.gain ?? 0.18;
  const attack = Math.max(0.001, args.attack ?? 0.005);
  const release = Math.max(0.01, args.release ?? 0.06);
  env.gain.value = 0;
  env.gain.linearRampToValueAtTime(peak, when + attack);
  env.gain.linearRampToValueAtTime(0, when + args.duration + release);

  src.connect(filter);
  filter.connect(env);
  env.connect(master);
  src.start(when);
  src.stop(when + args.duration + release + 0.05);
}

// Layered tone — fires multiple oscillators in parallel at related
// frequencies. The mix sounds richer than a single sine because the
// overtones interfere; a perfect-fifth pair (1× + 1.5×) is the
// cheapest way to get a "chord-y" feel. Useful for the tension and
// hero-moment cues.
function chord(args: {
  freq: number;
  duration: number;
  ratios?: number[];   // multipliers on freq; defaults to [1, 1.5]
  type?: OscillatorType;
  gain?: number;
  sweepTo?: number;
  attack?: number;
  release?: number;
  startTime?: number;
}): void {
  const c = ensureContext();
  if (!c) return;
  const ratios = args.ratios ?? [1, 1.5];
  const sweepRatio =
    args.sweepTo !== undefined ? args.sweepTo / args.freq : null;
  const baseGain = args.gain ?? 0.22;
  // Spread the gain over voices so the total perceived loudness
  // stays in the same ballpark as a single tone() call.
  const perVoice = baseGain / Math.max(1, ratios.length);
  const startTime = args.startTime ?? (c.currentTime);
  for (const r of ratios) {
    tone({
      freq: args.freq * r,
      duration: args.duration,
      ...(args.type !== undefined ? { type: args.type } : {}),
      gain: perVoice,
      ...(sweepRatio !== null
        ? { sweepTo: args.freq * r * sweepRatio }
        : {}),
      ...(args.attack !== undefined ? { attack: args.attack } : {}),
      ...(args.release !== undefined ? { release: args.release } : {}),
      startTime,
    });
  }
}

// Public sound vocabulary. Every call is safe from scene code —
// silent when no AudioContext, silent when muted, silent when the
// user hasn't gestured yet (since browsers hold off on any audio
// until they do).
export function sfxClick(): void {
  tone({ freq: 640, duration: 0.04, type: 'triangle', gain: 0.22, release: 0.04 });
}
export function sfxHover(): void {
  tone({ freq: 820, duration: 0.03, type: 'sine', gain: 0.08, release: 0.03 });
}
export function sfxEarn(): void {
  // Two-note "chip" that reads as money coming in. Scheduled on the
  // WebAudio clock so the second note's offset from the first is
  // immune to main-thread jitter / background-tab setTimeout throttling.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  tone({ freq: 720, duration: 0.06, type: 'triangle', gain: 0.25, release: 0.06, startTime: now });
  tone({ freq: 960, duration: 0.07, type: 'triangle', gain: 0.22, release: 0.08, startTime: now + 0.04 });
}
export function sfxUpgrade(): void {
  // Upward sweep — generic "level up" feel.
  tone({ freq: 440, sweepTo: 880, duration: 0.22, type: 'triangle', gain: 0.3, release: 0.1 });
}
export function sfxVictory(): void {
  // Three ascending notes scheduled on the WebAudio clock so the fanfare
  // stays crisp even if the main thread is busy running the win-card
  // celebration tween at the same moment.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  [523, 659, 784].forEach((f, i) => {
    tone({ freq: f, duration: 0.14, type: 'triangle', gain: 0.35, release: 0.12, startTime: now + i * 0.09 });
  });
}
export function sfxDefeat(): void {
  // Two descending low notes.
  tone({ freq: 220, sweepTo: 140, duration: 0.35, type: 'sawtooth', gain: 0.22, release: 0.2 });
}
export function sfxError(): void {
  tone({ freq: 200, duration: 0.1, type: 'square', gain: 0.15, release: 0.08 });
}
export function sfxNotify(): void {
  tone({ freq: 1080, duration: 0.08, type: 'sine', gain: 0.2, release: 0.1 });
}

// ---------- Raid-specific SFX vocabulary ----------
// The raid scene fires dozens of moments per second; each cue here is
// shaped for low-latency triggers and small spectral footprint so a
// burst of three units plus a turret salvo doesn't blow into mush.
// Tones are short and gain-conservative.

export function sfxDeploy(): void {
  // "Whoof" — descending chirp + a tiny noise puff so the cue lands
  // physical instead of pure-synth. Sweet spot is ~120 ms so the
  // sound clears before the modifier-specific cue 90 ms later.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  chord({
    freq: 540, sweepTo: 260, duration: 0.12, type: 'triangle',
    ratios: [1, 1.5], gain: 0.32, attack: 0.004, release: 0.08, startTime: now,
  });
  noiseBurst({ centerHz: 1400, q: 1.2, duration: 0.04, gain: 0.08, release: 0.04, startTime: now });
}

export function sfxDig(): void {
  // Subterranean thump — fundamental + sub-octave + a low-passed
  // dirt rumble. The sub adds the bass weight that a pure
  // sawtooth can't carry on small phone speakers.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  chord({
    freq: 110, sweepTo: 60, duration: 0.18, type: 'sawtooth',
    ratios: [0.5, 1], gain: 0.32, release: 0.14, startTime: now,
  });
  // Dirt scatter — band-passed noise low in the spectrum, fast
  // attack, longer release, mimics the granular crash sound of a
  // burrowing unit settling into a tunnel.
  noiseBurst({ centerHz: 240, q: 0.8, duration: 0.18, gain: 0.12, release: 0.16, startTime: now + 0.02 });
}

export function sfxAmbush(): void {
  // Held tension chord — minor-third pair so the interval reads as
  // unease rather than triumph. Long attack = "the swarm is
  // settling into position".
  chord({
    freq: 320, ratios: [1, 1.2], duration: 0.22, type: 'sine',
    gain: 0.22, attack: 0.06, release: 0.22,
  });
  // Soft hi-hat-ish noise tail to give the cue a textural top.
  noiseBurst({ centerHz: 5200, q: 6, duration: 0.04, gain: 0.04, release: 0.06 });
}

export function sfxSplit(): void {
  // Two-note fork that mimics a pair separating — third interval
  // and inverted attack so the second voice "answers" the first.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  tone({ freq: 760, duration: 0.06, type: 'triangle', gain: 0.18, release: 0.05, startTime: now });
  tone({ freq: 600, duration: 0.06, type: 'triangle', gain: 0.18, release: 0.05, startTime: now + 0.05 });
  // Glittery overtone so the cue reads as "magic", not "thump".
  tone({ freq: 1520, duration: 0.04, type: 'sine', gain: 0.06, release: 0.04, startTime: now + 0.025 });
}

export function sfxModifierTick(): void {
  // Tiny tick when toggling modifier mode — square + a tucked
  // higher harmonic so the click has bite without being loud.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  tone({ freq: 920, duration: 0.022, type: 'square', gain: 0.09, release: 0.03, startTime: now });
  tone({ freq: 1840, duration: 0.012, type: 'sine', gain: 0.04, release: 0.02, startTime: now });
}

export function sfxBuildingHit(): void {
  // Mid-low thud — short noise burst (the impact body) + a brief
  // square-wave click (the hit transient). Two voices read as a
  // physical impact; a single tone reads as a beep.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  noiseBurst({ centerHz: 380, q: 5, duration: 0.04, gain: 0.1, release: 0.05, startTime: now });
  tone({ freq: 180, sweepTo: 110, duration: 0.04, type: 'square', gain: 0.06, release: 0.04, startTime: now });
}

export function sfxBuildingDestroyed(): void {
  // Heavy crunch — sawtooth fundamental sweep, low sub-octave, and
  // a wide noise burst layered on top so the cue feels like
  // structural collapse rather than a single bass note.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  chord({
    freq: 200, sweepTo: 70, duration: 0.18, type: 'sawtooth',
    ratios: [0.5, 1], gain: 0.32, release: 0.18, startTime: now,
  });
  noiseBurst({ centerHz: 600, q: 1.2, duration: 0.16, gain: 0.14, release: 0.18, startTime: now + 0.02 });
}

export function sfxQueenDestroyed(): void {
  // Hero moment — three-note descending fanfare with a fifth
  // interval each, a noise crash on the first hit, and a long
  // ringing tail. Loud, but each voice is conservatively gained
  // so the sum stays under the master limit when the camera
  // flash and confetti fire on the same frame.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  const fundamentals = [600, 480, 320];
  fundamentals.forEach((f, i) => {
    chord({
      freq: f, ratios: [1, 1.5], duration: 0.22, type: 'sawtooth',
      gain: 0.34, release: 0.22, startTime: now + i * 0.1,
    });
  });
  noiseBurst({ centerHz: 800, q: 0.9, duration: 0.3, gain: 0.18, release: 0.3, startTime: now });
  // A long sub-rumble underneath the fanfare so the kill lands.
  tone({ freq: 70, duration: 0.5, type: 'sine', gain: 0.12, release: 0.4, startTime: now });
}

export function sfxUnitDeath(): void {
  // Tiny puff — sine + a barely-audible noise tail. Throttled at
  // call site so a wipeout can't melt the speaker.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  tone({ freq: 360, sweepTo: 140, duration: 0.05, type: 'sine', gain: 0.08, release: 0.05, startTime: now });
  noiseBurst({ centerHz: 1800, q: 4, duration: 0.04, gain: 0.04, release: 0.04, startTime: now });
}
