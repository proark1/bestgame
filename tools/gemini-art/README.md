# @hive/gemini-art

Offline Gemini 2.5 Flash Image pipeline for Hive Wars sprite generation.

## Why offline

Gemini image output isn't byte-stable across runs. We generate art once
locally, eyeball the results, then commit the PNGs under
`client/public/assets/sprites/`. CI never calls the API.

## Usage

```sh
# Get a key from https://aistudio.google.com/apikey
export GEMINI_API_KEY=AIza...

# Generate all sprites with change-detection caching
pnpm --filter @hive/gemini-art generate

# Force regeneration (ignores cache)
pnpm --filter @hive/gemini-art generate -- --force

# Regenerate a single sprite
pnpm --filter @hive/gemini-art generate -- --only=unit-SoldierAnt

# Run a few sprites in parallel
GEMINI_CONCURRENCY=5 pnpm --filter @hive/gemini-art generate
```

Outputs land in `client/public/assets/sprites/<sprite>.png` and the
client auto-loads them at boot. If a sprite is missing, the game falls
back to a procedural placeholder for that slot — no broken UI.

## Adding a sprite

1. Add a `name → description` entry under `units`/`buildings` in
   `prompts.json`.
2. Add the sprite key to the atlas manifest in
   `client/src/assets/atlas.ts` (so the boot loader and placeholder
   generator know about it).
3. Re-run `pnpm --filter @hive/gemini-art generate` to produce the PNG.
4. Commit the generated PNG along with the prompt change.

## Style lock

All sprites share the single style prompt in `prompts.json`
(`styleLock`). Changing it effectively resets the entire atlas look;
do so intentionally (e.g., a big visual refresh) and regenerate every
sprite in one pass with `--force`.

## Caching

Each generation writes both `<sprite>.png` and `<sprite>.sha1` (the
sha1 of the prompt). On re-runs, if the prompt hash matches, the PNG
is left alone. Change the `styleLock` or any per-sprite description
to invalidate individual entries.
