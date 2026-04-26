# Hive Wars audio assets

This directory is the drop zone for real audio samples that override the
synth fallback in `client/src/ui/audio.ts`.

## Why we have this

The codebase ships synth-only — every SFX is built from `OscillatorNode`s and
filtered noise bursts in `audio.ts`. That keeps the bundle lean and lets the
team iterate on sound design without a deploy.

When you have actual recorded / authored samples, drop them here and the
SFX pipeline picks them up automatically. There is no code change needed in
`audio.ts` — every public `sfxX()` function already checks for a registered
sample first and falls back to synth on miss.

## Adding a sample

1. Drop the file in this directory. WAV or MP3, mono or stereo, ≤ 1 s
   recommended. The HUD doesn't ducking-mix anything so keep peak-normalised
   loudness conservative.
2. Add an entry to `manifest.json`:

   ```json
   [
     { "key": "queenDestroyed", "src": "queenDestroyed.mp3", "gain": 0.7 },
     { "key": "deploy",         "src": "deploy.wav",         "gain": 0.85 }
   ]
   ```

   - `key` — must match the SFX dispatcher key. The full list of keys is in
     [`audio.ts`](../../src/ui/audio.ts) (search for `playSampleOrSynth(`).
   - `src` — file name relative to this directory.
   - `gain` — optional 0..1, defaults to 0.7. The master volume + mute slider
     in `audio.ts` still applies on top of this.

3. Reload the client. `prewarmAudioAssets` in `audioAssets.ts` fetches the
   manifest and decodes every entry on boot.

## Keys recognised by `audio.ts`

UI: `click`, `hover`, `earn`, `upgrade`, `victory`, `defeat`, `error`, `notify`.

Raid: `deploy`, `dig`, `ambush`, `split`, `modifierTick`, `buildingHit`,
`buildingDestroyed`, `queenDestroyed`, `unitDeath`.

A key without a matching `manifest.json` entry plays the synth fallback —
that's how the codebase ships today.

## Troubleshooting

- **Manifest 404** — silently skipped. SFX play synth.
- **File 404** for one entry — that one SFX falls back to synth, others load.
- **Decode error** (corrupt file, unsupported codec) — same: silent fallback.
- **Want to A/B?** Comment the entry out of the manifest array; refresh.
