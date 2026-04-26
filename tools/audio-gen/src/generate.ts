// Generates a starter pack of WAV samples for the SFX keys
// audio.ts knows about. Pure Node — no Web Audio context needed —
// because PCM-encoded WAV is a small, well-documented byte format.
//
// We synthesize the same envelopes / oscillator shapes / noise
// bursts the runtime synth uses, then write them to disk. Once the
// files exist on disk + are listed in client/public/audio/manifest.
// json, BootScene's prewarmAudioAssets pre-decodes them and the
// runtime sfx*() functions play the samples instead of the synth.
//
// Honest scope: these are still synthesized cues, not professionally
// authored sound design. They're meaningfully richer than the
// runtime synth (longer envelopes, richer chords, real noise tails)
// and they prove the loader pipeline end-to-end. A sound designer
// can drop replacement WAVs into client/public/audio/ at any time —
// the manifest entry doesn't care which tool produced the file.
//
// Run with: pnpm --filter @hive/audio-gen run generate
// Output:   client/public/audio/<key>.wav + manifest.json

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SAMPLE_RATE = 22050; // 22.05 kHz keeps file sizes small;
                           // SFX top out around 8 kHz anyway.

interface Envelope {
  attack: number;   // seconds 0 → peak
  release: number;  // seconds peak → 0 after the body
  bodyDuration: number; // seconds the peak holds before release
}

interface ToneSpec {
  type: 'sine' | 'square' | 'triangle' | 'sawtooth';
  freq: number;
  freqEnd?: number;     // linear sweep target if set
  gain: number;         // 0..1 peak amplitude
  envelope: Envelope;
  startOffset?: number; // seconds, default 0
}

interface NoiseSpec {
  type: 'noise';
  centerHz: number;     // band-pass centre
  q: number;            // band-pass Q
  gain: number;
  envelope: Envelope;
  startOffset?: number;
}

type Layer = ToneSpec | NoiseSpec;

interface SampleSpec {
  key: string;          // matches the audio.ts dispatch key
  totalDuration: number;
  layers: Layer[];
  // 0..1 master gain applied on top of per-layer gain. Tweaked
  // per-key so loud cues don't clip the mix.
  masterGain?: number;
}

// ---- Synthesis primitives -------------------------------------------------

function tone(spec: ToneSpec, samples: Float32Array, totalDur: number): void {
  const start = Math.floor((spec.startOffset ?? 0) * SAMPLE_RATE);
  const dur = spec.envelope.attack + spec.envelope.bodyDuration + spec.envelope.release;
  const len = Math.min(samples.length - start, Math.floor(dur * SAMPLE_RATE));
  if (len <= 0) return;
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE;
    const tNorm = t / dur;
    // Linear sweep across the full envelope.
    const f = spec.freqEnd !== undefined
      ? spec.freq + (spec.freqEnd - spec.freq) * tNorm
      : spec.freq;
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    let v = 0;
    switch (spec.type) {
      case 'sine':     v = Math.sin(phase); break;
      case 'square':   v = Math.sin(phase) >= 0 ? 1 : -1; break;
      case 'triangle': v = (2 / Math.PI) * Math.asin(Math.sin(phase)); break;
      case 'sawtooth': {
        const cycle = (phase / (2 * Math.PI)) % 1;
        v = 2 * cycle - 1;
        break;
      }
    }
    const env = adsr(t, spec.envelope);
    samples[start + i]! += v * env * spec.gain;
  }
  void totalDur;
}

function noise(spec: NoiseSpec, samples: Float32Array, totalDur: number): void {
  const start = Math.floor((spec.startOffset ?? 0) * SAMPLE_RATE);
  const dur = spec.envelope.attack + spec.envelope.bodyDuration + spec.envelope.release;
  const len = Math.min(samples.length - start, Math.floor(dur * SAMPLE_RATE));
  if (len <= 0) return;
  // Cheap one-pole band-pass via two cascaded RC sections. Not as
  // sharp as a biquad but plenty for SFX tail flavour.
  const w0 = (2 * Math.PI * spec.centerHz) / SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * spec.q);
  // Standard biquad band-pass (constant-skirt-gain).
  const cosw = Math.cos(w0);
  const b0 = alpha;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE;
    const x = Math.random() * 2 - 1;
    const y = (b0 * x + 0 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x;
    y2 = y1; y1 = y;
    const env = adsr(t, spec.envelope);
    samples[start + i]! += y * env * spec.gain;
  }
  void totalDur;
}

function adsr(t: number, env: Envelope): number {
  if (t < env.attack) return t / env.attack;
  const releaseStart = env.attack + env.bodyDuration;
  if (t < releaseStart) return 1;
  const releaseT = t - releaseStart;
  if (releaseT >= env.release) return 0;
  return 1 - releaseT / env.release;
}

function render(spec: SampleSpec): Float32Array {
  const samples = new Float32Array(Math.ceil(spec.totalDuration * SAMPLE_RATE));
  for (const layer of spec.layers) {
    if (layer.type === 'noise') noise(layer, samples, spec.totalDuration);
    else tone(layer, samples, spec.totalDuration);
  }
  // Apply master + soft clip so the mix can't overshoot 1.0.
  const m = spec.masterGain ?? 1;
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i]! * m;
    // tanh-ish soft clip — preserves peaks without harsh clicks.
    v = Math.tanh(v * 1.2);
    samples[i] = v;
  }
  return samples;
}

// PCM 16-bit little-endian WAV file. Standard RIFF header.
function encodeWav(samples: Float32Array): Buffer {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = SAMPLE_RATE * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);            // chunk size
  buffer.writeUInt16LE(1, 20);             // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34); // bits per sample
  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    buffer.writeInt16LE(Math.round(v * 0x7fff), 44 + i * 2);
  }
  return buffer;
}

// ---- Sample specs ---------------------------------------------------------

const SAMPLES: SampleSpec[] = [
  // UI — kept short and mid-bright so they punch through gameplay.
  {
    key: 'click',
    totalDuration: 0.08,
    masterGain: 0.55,
    layers: [
      { type: 'triangle', freq: 640, gain: 0.55,
        envelope: { attack: 0.003, bodyDuration: 0.01, release: 0.05 } },
      { type: 'sine', freq: 1280, gain: 0.2,
        envelope: { attack: 0.001, bodyDuration: 0.005, release: 0.04 } },
    ],
  },
  {
    key: 'hover',
    totalDuration: 0.06,
    masterGain: 0.35,
    layers: [
      { type: 'sine', freq: 820, gain: 0.4,
        envelope: { attack: 0.003, bodyDuration: 0.005, release: 0.03 } },
    ],
  },
  {
    key: 'earn',
    totalDuration: 0.18,
    masterGain: 0.6,
    layers: [
      { type: 'triangle', freq: 720, gain: 0.55,
        envelope: { attack: 0.003, bodyDuration: 0.05, release: 0.05 } },
      { type: 'triangle', freq: 960, gain: 0.5, startOffset: 0.04,
        envelope: { attack: 0.003, bodyDuration: 0.05, release: 0.06 } },
    ],
  },
  {
    key: 'upgrade',
    totalDuration: 0.32,
    masterGain: 0.65,
    layers: [
      { type: 'triangle', freq: 440, freqEnd: 880, gain: 0.6,
        envelope: { attack: 0.005, bodyDuration: 0.18, release: 0.1 } },
      { type: 'sine', freq: 880, gain: 0.25, startOffset: 0.05,
        envelope: { attack: 0.005, bodyDuration: 0.12, release: 0.1 } },
    ],
  },
  {
    key: 'victory',
    totalDuration: 0.55,
    masterGain: 0.6,
    layers: [
      { type: 'triangle', freq: 523, gain: 0.5,
        envelope: { attack: 0.005, bodyDuration: 0.1, release: 0.1 } },
      { type: 'triangle', freq: 659, gain: 0.5, startOffset: 0.1,
        envelope: { attack: 0.005, bodyDuration: 0.1, release: 0.1 } },
      { type: 'triangle', freq: 784, gain: 0.55, startOffset: 0.2,
        envelope: { attack: 0.005, bodyDuration: 0.12, release: 0.18 } },
    ],
  },
  {
    key: 'defeat',
    totalDuration: 0.55,
    masterGain: 0.5,
    layers: [
      { type: 'sawtooth', freq: 220, freqEnd: 140, gain: 0.5,
        envelope: { attack: 0.01, bodyDuration: 0.2, release: 0.25 } },
    ],
  },
  // Raid — punchier, layered tone + noise tail.
  {
    key: 'deploy',
    totalDuration: 0.16,
    masterGain: 0.55,
    layers: [
      { type: 'triangle', freq: 540, freqEnd: 260, gain: 0.55,
        envelope: { attack: 0.004, bodyDuration: 0.04, release: 0.1 } },
      { type: 'noise', centerHz: 1400, q: 1.2, gain: 0.18,
        envelope: { attack: 0.002, bodyDuration: 0.02, release: 0.05 } },
    ],
  },
  {
    key: 'dig',
    totalDuration: 0.28,
    masterGain: 0.7,
    layers: [
      { type: 'sawtooth', freq: 110, freqEnd: 60, gain: 0.55,
        envelope: { attack: 0.01, bodyDuration: 0.06, release: 0.18 } },
      { type: 'noise', centerHz: 240, q: 0.8, gain: 0.3, startOffset: 0.02,
        envelope: { attack: 0.005, bodyDuration: 0.06, release: 0.16 } },
    ],
  },
  {
    key: 'ambush',
    totalDuration: 0.32,
    masterGain: 0.45,
    layers: [
      { type: 'sine', freq: 320, gain: 0.45,
        envelope: { attack: 0.05, bodyDuration: 0.05, release: 0.22 } },
      { type: 'sine', freq: 384, gain: 0.4,
        envelope: { attack: 0.05, bodyDuration: 0.05, release: 0.22 } },
    ],
  },
  {
    key: 'split',
    totalDuration: 0.13,
    masterGain: 0.45,
    layers: [
      { type: 'triangle', freq: 760, gain: 0.45,
        envelope: { attack: 0.003, bodyDuration: 0.02, release: 0.05 } },
      { type: 'triangle', freq: 600, gain: 0.45, startOffset: 0.05,
        envelope: { attack: 0.003, bodyDuration: 0.02, release: 0.05 } },
    ],
  },
  {
    key: 'modifierTick',
    totalDuration: 0.05,
    masterGain: 0.3,
    layers: [
      { type: 'square', freq: 920, gain: 0.45,
        envelope: { attack: 0.001, bodyDuration: 0.005, release: 0.03 } },
    ],
  },
  {
    key: 'buildingHit',
    totalDuration: 0.1,
    masterGain: 0.5,
    layers: [
      { type: 'noise', centerHz: 380, q: 5, gain: 0.5,
        envelope: { attack: 0.003, bodyDuration: 0.01, release: 0.05 } },
      { type: 'square', freq: 180, freqEnd: 110, gain: 0.3,
        envelope: { attack: 0.002, bodyDuration: 0.01, release: 0.04 } },
    ],
  },
  {
    key: 'buildingDestroyed',
    totalDuration: 0.34,
    masterGain: 0.6,
    layers: [
      { type: 'sawtooth', freq: 200, freqEnd: 70, gain: 0.6,
        envelope: { attack: 0.005, bodyDuration: 0.06, release: 0.2 } },
      { type: 'noise', centerHz: 600, q: 1.2, gain: 0.4, startOffset: 0.02,
        envelope: { attack: 0.005, bodyDuration: 0.06, release: 0.2 } },
    ],
  },
  {
    key: 'queenDestroyed',
    totalDuration: 0.7,
    masterGain: 0.7,
    layers: [
      { type: 'sawtooth', freq: 600, gain: 0.5,
        envelope: { attack: 0.005, bodyDuration: 0.06, release: 0.18 } },
      { type: 'sawtooth', freq: 480, gain: 0.5, startOffset: 0.1,
        envelope: { attack: 0.005, bodyDuration: 0.06, release: 0.18 } },
      { type: 'sawtooth', freq: 320, gain: 0.5, startOffset: 0.2,
        envelope: { attack: 0.005, bodyDuration: 0.06, release: 0.22 } },
      { type: 'sine', freq: 70, gain: 0.4, startOffset: 0,
        envelope: { attack: 0.01, bodyDuration: 0.3, release: 0.3 } },
      { type: 'noise', centerHz: 800, q: 0.9, gain: 0.4, startOffset: 0,
        envelope: { attack: 0.005, bodyDuration: 0.1, release: 0.25 } },
    ],
  },
  {
    key: 'unitDeath',
    totalDuration: 0.1,
    masterGain: 0.4,
    layers: [
      { type: 'sine', freq: 360, freqEnd: 140, gain: 0.4,
        envelope: { attack: 0.002, bodyDuration: 0.01, release: 0.05 } },
      { type: 'noise', centerHz: 1800, q: 4, gain: 0.2,
        envelope: { attack: 0.002, bodyDuration: 0.01, release: 0.04 } },
    ],
  },
];

// ---- Build & write --------------------------------------------------------

function main(): void {
  // src/ → audio-gen/ → tools/ → repo root: three levels up.
  const root = resolve(import.meta.dirname ?? '.', '..', '..', '..');
  const outDir = join(root, 'client', 'public', 'audio');
  mkdirSync(outDir, { recursive: true });

  const manifest: Array<{ key: string; src: string; gain?: number }> = [];
  for (const spec of SAMPLES) {
    const samples = render(spec);
    const wav = encodeWav(samples);
    const filename = `${spec.key}.wav`;
    writeFileSync(join(outDir, filename), wav);
    manifest.push({ key: spec.key, src: filename });
    // eslint-disable-next-line no-console
    console.log(`✓ ${filename} (${(wav.length / 1024).toFixed(1)} KB, ${spec.totalDuration.toFixed(2)}s)`);
  }
  writeFileSync(
    join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  // eslint-disable-next-line no-console
  console.log(`\nWrote ${manifest.length} samples + manifest.json`);
}

main();
