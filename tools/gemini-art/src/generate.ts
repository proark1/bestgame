#!/usr/bin/env node
// One-liner sprite pipeline: generate with Gemini, compress with sharp,
// write to client/public/assets/sprites/. Commit the result.
//
// Usage:
//   GEMINI_API_KEY=... pnpm --filter @hive/gemini-art generate
//   GEMINI_API_KEY=... pnpm --filter @hive/gemini-art generate -- --missing
//   GEMINI_API_KEY=... pnpm --filter @hive/gemini-art generate -- --format=png
//   GEMINI_API_KEY=... pnpm --filter @hive/gemini-art generate -- --quality=92 --max-dim=192
//   GEMINI_API_KEY=... pnpm --filter @hive/gemini-art generate -- --only=unit-SoldierAnt
//   GEMINI_API_KEY=... pnpm --filter @hive/gemini-art generate -- --force
//
// Caching is keyed on sha1(prompt + format + quality + maxDim). Changing
// any one of them invalidates the cache entry for that sprite.
//
// Pipeline per sprite:
//   1. Compose prompt (styleLock + subject description)
//   2. Call Gemini 2.5 Flash Image
//   3. sharp: resize (fit: inside) + encode to WebP or PNG
//   4. Write client/public/assets/sprites/<key>.<ext> + .sha1 sidecar
//   5. Clean up the sibling-extension file if it exists (so BootScene's
//      prefer-webp-then-png loader never sees two versions of the same key)

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

interface PromptsFile {
  styleLock: string;
  factions: Record<string, string>;
  units: Record<string, string>;
  buildings: Record<string, string>;
  // Heroes share the unit canvas (128x128) but live in their own bucket
  // so the admin Heroes tab and the CLI generator can both surface them
  // distinctly from the regular roster.
  heroes?: Record<string, string>;
  // Comic-strip story panels. Each key is the full sprite key (e.g.
  // `story-springs-1`) and the value is the per-panel prompt. Output
  // is a wide 1024x576 cinematic painterly illustration (opaque PNG
  // ok), so the unit-style sprite-atlas constraints don't apply.
  stories?: Record<string, string>;
}

interface StoryPanel {
  key: string;
  caption: string;
}
interface StoryGroup {
  id: string;
  title: string;
  subtitle: string;
  panels: StoryPanel[];
}
interface StoriesFile {
  stories: StoryGroup[];
}

interface Options {
  force: boolean;
  only: string | null;
  missing: boolean;
  format: 'webp' | 'png';
  quality: number;
  maxDim: number;
}

interface Job {
  name: string;
  prompt: string;
  kind: 'unit' | 'building' | 'hero' | 'story';
  // Per-job pixel cap. Story panels need ~1024 to look good; the
  // default --max-dim=256 would shrink them into thumbnails.
  maxDimOverride?: number;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const PROMPTS_PATH = join(__dirname, '..', 'prompts.json');
const STORIES_PATH = join(__dirname, '..', 'stories.json');
const OUTPUT_DIR = join(REPO_ROOT, 'client', 'public', 'assets', 'sprites');

const MODEL = process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MAX_CONCURRENCY = Number(process.env.GEMINI_CONCURRENCY ?? 3);

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    force: false,
    only: null,
    missing: false,
    format: 'webp',
    quality: 85,
    maxDim: 256,
  };
  for (const a of argv) {
    if (a === '--force') opts.force = true;
    else if (a === '--missing') opts.missing = true;
    else if (a.startsWith('--only=')) opts.only = a.slice('--only='.length);
    else if (a.startsWith('--format=')) {
      const f = a.slice('--format='.length);
      if (f !== 'webp' && f !== 'png') throw new Error('--format must be webp or png');
      opts.format = f;
    } else if (a.startsWith('--quality=')) {
      const q = Number(a.slice('--quality='.length));
      if (!(q > 0 && q <= 100)) throw new Error('--quality must be 1..100');
      opts.quality = q;
    } else if (a.startsWith('--max-dim=')) {
      const d = Number(a.slice('--max-dim='.length));
      if (!(d >= 32 && d <= 2048)) throw new Error('--max-dim must be 32..2048');
      opts.maxDim = d;
    } else if (a === '--help' || a === '-h') {
      console.log(HELP);
      process.exit(0);
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return opts;
}

const HELP = `Hive Wars sprite generator

Generates every sprite listed in prompts.json via Gemini, compresses
it with sharp, and writes it to client/public/assets/sprites/.
Cached: skipped when the prompt and compression options haven't
changed. Run after editing prompts.json or when you want fresh art.

Flags:
  --format=webp|png    output format (default: webp)
  --quality=N          compression quality 1..100 (default: 85)
  --max-dim=N          max pixel size per side, 32..2048 (default: 256)
  --missing            only generate sprites with no file on disk
  --only=KEY           regenerate just one sprite (e.g. unit-SoldierAnt)
  --force              ignore cache, regenerate even if identical
  -h, --help           this help

Env:
  GEMINI_API_KEY        required
  GEMINI_IMAGE_MODEL    override model (default: gemini-2.5-flash-image)
  GEMINI_CONCURRENCY    max parallel generations (default: 3)
`;

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(p: string): Promise<number | null> {
  try {
    return (await stat(p)).size;
  } catch {
    return null;
  }
}

async function generateOne(apiKey: string, prompt: string): Promise<Buffer> {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      temperature: 0.6,
    },
  };
  const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data?: string } }> };
    }>;
  };
  for (const p of json.candidates?.[0]?.content?.parts ?? []) {
    if (p.inlineData?.data) return Buffer.from(p.inlineData.data, 'base64');
  }
  throw new Error('Gemini returned no image data');
}

async function compress(
  raw: Buffer,
  opts: Pick<Options, 'format' | 'quality' | 'maxDim'>,
): Promise<Buffer> {
  const pipeline = sharp(raw).resize({
    width: opts.maxDim,
    height: opts.maxDim,
    fit: 'inside',
    withoutEnlargement: true,
  });
  if (opts.format === 'webp') {
    return await pipeline.webp({ quality: opts.quality, effort: 6 }).toBuffer();
  }
  // PNG path: preserve alpha, use palette when possible.
  return await pipeline
    .png({ compressionLevel: 9, palette: true, quality: opts.quality })
    .toBuffer();
}

function compose(
  styleLock: string,
  desc: string,
  kind: 'unit' | 'building' | 'hero',
): string {
  const size = kind === 'building' ? '192x192' : '128x128';
  return [
    `Subject: ${desc}.`,
    `Style: ${styleLock}`,
    `Canvas: ${size} pixels, transparent background (alpha), no border, no text, no watermark.`,
    `Composition: subject centered, single character/object only, facing viewer, small soft shadow directly below feet. Plenty of headroom.`,
    `Consistency: matches a shared cohesive game atlas — same outline thickness, same palette, same perspective as sibling sprites.`,
  ].join(' ');
}

// Story panels are cinematic comic-strip illustrations (1024x576),
// not sprite-atlas characters — strip the sprite-only constraints
// off the styleLock so the painter is free to use scenery, depth,
// and multi-character storytelling.
function composeStory(styleLock: string, desc: string): string {
  const visualStyle = (styleLock.split('128x128')[0] ?? styleLock).trim();
  return [
    `Subject: ${desc}`,
    `Style: ${visualStyle}`,
    `Camera: cinematic painterly comic-panel illustration. Wide 16:9 landscape framing with clear foreground / midground / background depth, dramatic directional lighting, atmospheric perspective. Multi-character scenes and storytelling are encouraged.`,
    `Delivery: 1024x576 PNG, opaque background fine. No text, no UI overlays, no logos, no captions, no watermarks, no borders, no signature.`,
  ].join(' ');
}

async function runBatch(
  apiKey: string,
  jobs: Job[],
  opts: Options,
): Promise<{ generated: number; cached: number; failed: number; bytesWritten: number }> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const signature = (prompt: string): string =>
    sha1(`${prompt}|${opts.format}|${opts.quality}|${opts.maxDim}`);

  const work: Job[] = [];
  let cached = 0;
  for (const j of jobs) {
    const outPath = join(OUTPUT_DIR, `${j.name}.${opts.format}`);
    const sigPath = join(OUTPUT_DIR, `${j.name}.sha1`);
    if (opts.missing && (await exists(outPath))) {
      cached++;
      continue;
    }
    if (!opts.force && (await exists(outPath)) && (await exists(sigPath))) {
      const prev = (await readFile(sigPath, 'utf8')).trim();
      if (prev === signature(j.prompt)) {
        cached++;
        continue;
      }
    }
    work.push(j);
  }
  if (work.length === 0) {
    return { generated: 0, cached, failed: 0, bytesWritten: 0 };
  }

  console.log(
    `generating ${work.length} sprite(s) with ${MODEL} → ${opts.format.toUpperCase()} q${opts.quality} ≤${opts.maxDim}px`,
  );

  let next = 0;
  let generated = 0;
  let failed = 0;
  let bytesWritten = 0;

  const worker = async (): Promise<void> => {
    while (next < work.length) {
      const job = work[next++]!;
      try {
        const raw = await generateOne(apiKey, job.prompt);
        const jobOpts =
          job.maxDimOverride !== undefined
            ? { ...opts, maxDim: job.maxDimOverride }
            : opts;
        const out = await compress(raw, jobOpts);
        const outPath = join(OUTPUT_DIR, `${job.name}.${opts.format}`);
        const sigPath = join(OUTPUT_DIR, `${job.name}.sha1`);
        await writeFile(outPath, out);
        await writeFile(sigPath, signature(job.prompt) + '\n', 'utf8');

        // Remove the sibling-extension file so BootScene only loads one.
        const sibling = join(
          OUTPUT_DIR,
          `${job.name}.${opts.format === 'webp' ? 'png' : 'webp'}`,
        );
        try {
          await unlink(sibling);
        } catch {
          // not there
        }

        generated++;
        bytesWritten += out.length;
        const kb = (out.length / 1024).toFixed(1);
        const ratio = raw.length > 0 ? ((out.length / raw.length) * 100).toFixed(0) : '-';
        console.log(
          `  ✓ ${job.name.padEnd(28)} ${opts.format} ${kb.padStart(6)} KB  (${ratio}% of raw)`,
        );
      } catch (err) {
        failed++;
        console.error(`  ✗ ${job.name}: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENCY, work.length) }, worker),
  );

  return { generated, cached, failed, bytesWritten };
}

async function main(): Promise<void> {
  // Parse args first so --help works without requiring an API key.
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error(HELP);
    process.exit(2);
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is required. Get one at https://aistudio.google.com/apikey');
    process.exit(1);
  }

  const prompts = JSON.parse(await readFile(PROMPTS_PATH, 'utf8')) as PromptsFile;
  const jobs: Job[] = [];
  for (const [name, desc] of Object.entries(prompts.units)) {
    jobs.push({
      name: `unit-${name}`,
      prompt: compose(prompts.styleLock, desc, 'unit'),
      kind: 'unit',
    });
  }
  for (const [name, desc] of Object.entries(prompts.buildings)) {
    jobs.push({
      name: `building-${name}`,
      prompt: compose(prompts.styleLock, desc, 'building'),
      kind: 'building',
    });
  }
  for (const [name, desc] of Object.entries(prompts.heroes ?? {})) {
    jobs.push({
      name: `hero-${name}`,
      prompt: compose(prompts.styleLock, desc, 'hero'),
      kind: 'hero',
    });
  }
  // Story panels — keys are already prefixed with `story-` in the
  // bucket, so they're used as-is for the sprite filename. Override
  // the per-job size cap to 1024 so the cinematic 16:9 panels keep
  // their resolution even when the main pipeline runs at the default
  // 256 px sprite-atlas budget.
  for (const [key, desc] of Object.entries(prompts.stories ?? {})) {
    jobs.push({
      name: key,
      prompt: composeStory(prompts.styleLock, desc),
      kind: 'story',
      maxDimOverride: 1024,
    });
  }
  // stories.json is metadata — read it just to validate keys here so
  // a panel listed in stories.json without a matching prompt is loud.
  // Best-effort: the file is optional for backwards compatibility.
  try {
    const stories = JSON.parse(
      await readFile(STORIES_PATH, 'utf8'),
    ) as StoriesFile;
    const promptKeys = new Set(Object.keys(prompts.stories ?? {}));
    for (const story of stories.stories) {
      for (const panel of story.panels) {
        if (!promptKeys.has(panel.key)) {
          console.warn(
            `  ! stories.json lists "${panel.key}" but prompts.json has no entry`,
          );
        }
      }
    }
  } catch {
    // stories.json missing — that's OK, prompts.stories is the truth.
  }
  const filtered = opts.only ? jobs.filter((j) => j.name === opts.only) : jobs;
  if (filtered.length === 0) {
    console.error(`no jobs matched --only=${opts.only}`);
    process.exit(1);
  }

  const started = Date.now();
  const stats = await runBatch(apiKey, filtered, opts);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  const totalOnDisk =
    (
      await Promise.all(
        filtered.map(async (j) => {
          const s = await fileSize(join(OUTPUT_DIR, `${j.name}.${opts.format}`));
          return s ?? 0;
        }),
      )
    ).reduce((a, b) => a + b, 0);

  console.log('');
  console.log(`Sprites folder: ${OUTPUT_DIR}`);
  console.log(
    `Generated ${stats.generated} · Cached ${stats.cached} · Failed ${stats.failed} · ${(
      stats.bytesWritten / 1024
    ).toFixed(1)} KB written · ${secs}s`,
  );
  console.log(
    `Total ${filtered.length} sprite(s) on disk: ${(totalOnDisk / 1024).toFixed(1)} KB`,
  );
  if (stats.failed > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
