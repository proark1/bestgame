// Audio asset loader — pipeline for dropping real sample files into
// the SFX vocabulary without touching any caller code.
//
// The shipped game is synth-only because authoring sound design is a
// dedicated craft and out of scope for this codebase. But the
// existing tone()/chord()/noiseBurst() machinery in audio.ts has a
// natural fallback shape: every SFX has a stable string key, and if
// a real sample exists for that key we should play it; otherwise we
// fall back to the synth.
//
// This file owns the "is there a real sample for key X?" question.
// audio.ts asks via playSampleIfAvailable(); when no sample is
// registered the synth body of each SFX runs as today.
//
// Authoring path for a sound designer:
//   1. Drop a file at `client/public/audio/<key>.mp3` (or .wav).
//   2. Add the entry to `client/public/audio/manifest.json`:
//        [{ "key": "queenDestroyed", "src": "queenDestroyed.mp3", "gain": 0.6 }]
//   3. The pipeline preloads + decodes on app boot. From the next
//      sfxQueenDestroyed() call onward, the sample plays instead of
//      the synth fanfare. No code change needed.
//
// Manifest entries with missing files are dropped silently so a
// half-finished sound pack doesn't break boot.

export interface AudioAssetEntry {
  key: string;          // matches the SFX dispatch key (e.g. 'deploy')
  src: string;          // path relative to the manifest URL
  gain?: number;        // 0..1, defaults to 0.7 if absent
}

interface LoadedSample {
  buffer: AudioBuffer;
  gain: number;
}

const SAMPLE_REGISTRY: Map<string, LoadedSample> = new Map();
let prewarmStarted = false;

// Default location. Can be overridden by the caller (used in tests
// and could be used to point at a CDN later). Trailing slash so we
// can `${BASE}${entry.src}` without re-checking.
const DEFAULT_MANIFEST_URL = '/audio/manifest.json';
const DEFAULT_BASE = '/audio/';

// Eagerly fetch the manifest + decode every entry once at app boot.
// Idempotent (subsequent calls are no-ops). Failures are silent —
// the SFX functions auto-fall back to synth.
export async function prewarmAudioAssets(
  ctx: AudioContext,
  options: { manifestUrl?: string; baseUrl?: string } = {},
): Promise<void> {
  if (prewarmStarted) return;
  prewarmStarted = true;
  const manifestUrl = options.manifestUrl ?? DEFAULT_MANIFEST_URL;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE;
  let manifest: AudioAssetEntry[] = [];
  try {
    const res = await fetch(manifestUrl);
    if (!res.ok) return;
    const parsed = (await res.json()) as unknown;
    if (!Array.isArray(parsed)) return;
    manifest = parsed.filter(isValidEntry);
  } catch {
    // No manifest = no samples; SFX fall back to synth.
    return;
  }
  // Decode each entry in parallel; allMaybe so a single broken file
  // doesn't take down the rest of the pack.
  await Promise.all(
    manifest.map((entry) => loadOne(ctx, baseUrl, entry)),
  );
}

async function loadOne(
  ctx: AudioContext,
  baseUrl: string,
  entry: AudioAssetEntry,
): Promise<void> {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/${entry.src.replace(/^\/+/, '')}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const arr = await res.arrayBuffer();
    const buffer = await ctx.decodeAudioData(arr);
    SAMPLE_REGISTRY.set(entry.key, {
      buffer,
      gain: clampGain(entry.gain),
    });
  } catch {
    // Per-file decode failure: silently skip, the synth fallback
    // still runs.
  }
}

// Quick single-call dispatcher used by audio.ts at the top of each
// public SFX function. Returns true if a sample played (caller
// should NOT also play the synth fallback); false if the caller
// should run its synth body.
//
// We intentionally accept master + ctx here rather than re-importing
// them — keeps audioAssets.ts dependency-free and easier to test in
// isolation.
export function playSampleIfAvailable(
  key: string,
  ctx: AudioContext | null,
  master: GainNode | null,
  startTime?: number,
): boolean {
  if (!ctx || !master) return false;
  const sample = SAMPLE_REGISTRY.get(key);
  if (!sample) return false;
  const when = startTime ?? ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = sample.buffer;
  const env = ctx.createGain();
  env.gain.value = sample.gain;
  src.connect(env);
  env.connect(master);
  src.start(when);
  return true;
}

// Test / dev helper — exposed so a unit test can register a fake
// sample without spinning up a real AudioContext + manifest.
export function registerSampleForTest(
  key: string,
  buffer: AudioBuffer,
  gain = 0.7,
): void {
  SAMPLE_REGISTRY.set(key, { buffer, gain: clampGain(gain) });
}

export function resetAudioAssetsForTest(): void {
  SAMPLE_REGISTRY.clear();
  prewarmStarted = false;
}

export function isSampleAvailable(key: string): boolean {
  return SAMPLE_REGISTRY.has(key);
}

function clampGain(g: number | undefined): number {
  if (typeof g !== 'number' || !Number.isFinite(g)) return 0.7;
  if (g < 0) return 0;
  if (g > 1) return 1;
  return g;
}

function isValidEntry(v: unknown): v is AudioAssetEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Partial<AudioAssetEntry>;
  if (typeof e.key !== 'string' || e.key.length === 0) return false;
  if (typeof e.src !== 'string' || e.src.length === 0) return false;
  if (e.gain !== undefined && typeof e.gain !== 'number') return false;
  return true;
}
