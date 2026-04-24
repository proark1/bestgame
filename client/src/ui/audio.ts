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
function tone(args: {
  freq: number;
  duration: number; // seconds
  type?: OscillatorType;
  gain?: number; // 0..1 relative to master
  sweepTo?: number; // if set, freq sweeps to this value over duration
  attack?: number;
  release?: number;
}): void {
  const c = ensureContext();
  if (!c || !master) return;
  const settings = getSettings();
  if (settings.muted) return;

  const osc = c.createOscillator();
  osc.type = args.type ?? 'sine';
  osc.frequency.value = args.freq;
  if (args.sweepTo !== undefined) {
    osc.frequency.linearRampToValueAtTime(
      args.sweepTo,
      c.currentTime + args.duration,
    );
  }
  const env = c.createGain();
  const peak = (args.gain ?? 0.5);
  const attack = Math.max(0.001, args.attack ?? 0.01);
  const release = Math.max(0.01, args.release ?? 0.08);
  env.gain.value = 0;
  env.gain.linearRampToValueAtTime(peak, c.currentTime + attack);
  env.gain.linearRampToValueAtTime(0, c.currentTime + args.duration + release);

  osc.connect(env);
  env.connect(master);
  osc.start();
  osc.stop(c.currentTime + args.duration + release + 0.02);
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
  // Two-note "chip" that reads as money coming in.
  tone({ freq: 720, duration: 0.06, type: 'triangle', gain: 0.25, release: 0.06 });
  setTimeout(
    () => tone({ freq: 960, duration: 0.07, type: 'triangle', gain: 0.22, release: 0.08 }),
    40,
  );
}
export function sfxUpgrade(): void {
  // Upward sweep — generic "level up" feel.
  tone({ freq: 440, sweepTo: 880, duration: 0.22, type: 'triangle', gain: 0.3, release: 0.1 });
}
export function sfxVictory(): void {
  // Three ascending notes.
  [523, 659, 784].forEach((f, i) => {
    setTimeout(
      () => tone({ freq: f, duration: 0.14, type: 'triangle', gain: 0.35, release: 0.12 }),
      i * 90,
    );
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
