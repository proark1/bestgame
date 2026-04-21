# @hive/gemini-art

One-command sprite pipeline for Hive Wars: generate every sprite listed
in `prompts.json` with Gemini 2.5 Flash Image, compress it with sharp,
and drop it into `client/public/assets/sprites/`. Runs offline (never
in CI — Gemini output isn't byte-stable).

## Quickstart

```sh
# Get a key at https://aistudio.google.com/apikey
export GEMINI_API_KEY=AIza...

# Generate everything (WebP q=85, max 256 px, cached)
pnpm --filter @hive/gemini-art generate

# Only what's missing on disk
pnpm --filter @hive/gemini-art generate -- --missing

# High-detail PNGs at 384 px for promo shots
pnpm --filter @hive/gemini-art generate -- --format=png --max-dim=384 --quality=95

# Regenerate just one slot
pnpm --filter @hive/gemini-art generate -- --only=unit-SoldierAnt

# Force full regeneration, discard cache
pnpm --filter @hive/gemini-art generate -- --force

# Parallel Gemini calls (default 3)
GEMINI_CONCURRENCY=5 pnpm --filter @hive/gemini-art generate
```

The output lands under `client/public/assets/sprites/<key>.<ext>` with
a `.sha1` sidecar (the prompt + compression signature — used for
cache-hit detection). The client's `BootScene` prefers `.webp`, falls
back to `.png`, and falls back to procedural placeholders.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--format=webp\|png` | `webp` | Output format |
| `--quality=N` | `85` | Encoder quality (1..100) |
| `--max-dim=N` | `256` | Max pixel size per side (32..2048) |
| `--missing` | off | Skip any sprite that already has a file |
| `--only=KEY` | — | Generate just one sprite (e.g. `unit-SoldierAnt`) |
| `--force` | off | Ignore the sha1 cache |

## Adding a sprite

1. Add `name: description` under `units` or `buildings` in `prompts.json`.
2. Add the sprite key to `client/src/assets/atlas.ts` so `BootScene`
   knows about it.
3. Run `pnpm --filter @hive/gemini-art generate -- --only=unit-<Name>`.
4. Commit the generated PNG/WebP + prompt change together.

## Style lock

All sprites inherit the single style prompt in `prompts.json`
(`styleLock`). Changing it is a deliberate atlas-wide refresh — follow
up with `--force` to regenerate every sprite in one pass.

## Admin panel alternative

Don't want to run a CLI? The game deploy serves a GUI at `/admin` that
wraps the same pipeline: generate, compress (WebP/PNG with quality
slider + max-dim), save, and `Download .zip` for a commit-ready
bundle. Requires `ADMIN_TOKEN` on Railway or loopback-only on local.
See the main README for details.
