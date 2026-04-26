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
  // "Whoof" — a quick descending chirp that reads as "swarm released".
  // Slightly louder than sfxClick so the player feels the path commit
  // distinctly from the modifier-toggle ticks.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  tone({ freq: 540, sweepTo: 280, duration: 0.12, type: 'triangle', gain: 0.32, attack: 0.005, release: 0.08, startTime: now });
  tone({ freq: 720, duration: 0.05, type: 'sine', gain: 0.16, release: 0.05, startTime: now + 0.01 });
}

export function sfxDig(): void {
  // Subterranean thump + low rumble — the magic moment when a unit
  // flips layers via the dig modifier.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  tone({ freq: 110, sweepTo: 70, duration: 0.18, type: 'sawtooth', gain: 0.32, release: 0.12, startTime: now });
  tone({ freq: 240, sweepTo: 120, duration: 0.16, type: 'triangle', gain: 0.18, release: 0.1, startTime: now });
}

export function sfxAmbush(): void {
  // Held tension chord — pairs with the ambush pause animation.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  tone({ freq: 320, duration: 0.18, type: 'sine', gain: 0.18, attack: 0.04, release: 0.18, startTime: now });
  tone({ freq: 480, duration: 0.18, type: 'sine', gain: 0.12, attack: 0.04, release: 0.18, startTime: now });
}

export function sfxSplit(): void {
  // Two-note fork — left and right channels would land it but mono
  // is fine for v1.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  tone({ freq: 760, duration: 0.05, type: 'triangle', gain: 0.2, release: 0.05, startTime: now });
  tone({ freq: 580, duration: 0.05, type: 'triangle', gain: 0.2, release: 0.05, startTime: now + 0.04 });
}

export function sfxModifierTick(): void {
  // Tiny tick when toggling modifier mode — quieter than sfxClick so
  // it doesn't compete with the haptic buzz on the same moment.
  tone({ freq: 920, duration: 0.025, type: 'square', gain: 0.1, release: 0.03 });
}

export function sfxBuildingHit(): void {
  // Mid-low thud — fires every time a unit lands a hit on a building.
  // Conservative gain so the chorus of overlapping hits stays musical.
  tone({ freq: 180, sweepTo: 120, duration: 0.04, type: 'square', gain: 0.07, release: 0.04 });
}

export function sfxBuildingDestroyed(): void {
  // Heavy crunch — single building falling.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  tone({ freq: 200, sweepTo: 80, duration: 0.16, type: 'sawtooth', gain: 0.3, release: 0.14, startTime: now });
  tone({ freq: 90, duration: 0.08, type: 'sine', gain: 0.18, release: 0.1, startTime: now + 0.05 });
}

export function sfxQueenDestroyed(): void {
  // Hero moment — three-note descending fanfare flipping the
  // sfxVictory direction. Loud enough to land but not so loud it
  // clips if the camera flash sound from raid.ts also fires.
  const c = ensureContext();
  if (!c) return;
  const now = c.currentTime;
  [600, 480, 320].forEach((f, i) => {
    tone({ freq: f, duration: 0.18, type: 'sawtooth', gain: 0.34, release: 0.18, startTime: now + i * 0.1 });
  });
}

export function sfxUnitDeath(): void {
  // Tiny puff — every unit kill. Very quiet so a swarm wipeout
  // doesn't melt the speaker.
  tone({ freq: 360, sweepTo: 160, duration: 0.05, type: 'sine', gain: 0.08, release: 0.05 });
}
