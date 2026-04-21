#!/usr/bin/env node
// Batch Gemini sprite generator.
//
// Calls the Gemini 2.5 Flash Image API (gemini-2.5-flash-image) with the
// style-locked prompts in prompts.json and writes one PNG per sprite into
// client/public/assets/sprites/. The client's BootScene picks them up
// automatically; if an expected sprite is missing, the game falls back
// to procedurally-drawn placeholders so nothing is ever broken-looking.
//
// Runs offline — not on CI. Gemini output is non-deterministic and we
// want the committed art to be exactly what humans reviewed.
//
// Usage:
//   GEMINI_API_KEY=... pnpm --filter @hive/gemini-art generate
//   GEMINI_API_KEY=... pnpm --filter @hive/gemini-art generate --force
//   GEMINI_API_KEY=... pnpm --filter @hive/gemini-art generate --only=unit-SoldierAnt
//
// Caching: each sprite's prompt is hashed; if the hash matches the one
// stored alongside the PNG, regeneration is skipped. Pass --force to
// ignore the cache.

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PromptsFile {
  styleLock: string;
  factions: Record<string, string>;
  units: Record<string, string>;
  buildings: Record<string, string>;
}

interface Job {
  name: string;
  prompt: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const PROMPTS_PATH = join(__dirname, '..', 'prompts.json');
const OUTPUT_DIR = join(REPO_ROOT, 'client', 'public', 'assets', 'sprites');

const MODEL = process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MAX_CONCURRENCY = Number(process.env.GEMINI_CONCURRENCY ?? 3);

function parseArgs(argv: string[]): { force: boolean; only: string | null } {
  let force = false;
  let only: string | null = null;
  for (const a of argv) {
    if (a === '--force') force = true;
    else if (a.startsWith('--only=')) only = a.slice('--only='.length);
  }
  return { force, only };
}

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

async function generateOne(apiKey: string, job: Job): Promise<Buffer> {
  const body = {
    contents: [{ role: 'user', parts: [{ text: job.prompt }] }],
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
    throw new Error(`Gemini ${res.status} for ${job.name}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }>;
      };
    }>;
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const data = p.inlineData?.data;
    if (data) return Buffer.from(data, 'base64');
  }
  throw new Error(`Gemini returned no image data for ${job.name}`);
}

async function runBatch(apiKey: string, jobs: Job[], force: boolean): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const work: Job[] = [];
  for (const j of jobs) {
    const pngPath = join(OUTPUT_DIR, `${j.name}.png`);
    const hashPath = join(OUTPUT_DIR, `${j.name}.sha1`);
    if (!force && (await exists(pngPath)) && (await exists(hashPath))) {
      const prev = (await readFile(hashPath, 'utf8')).trim();
      if (prev === sha1(j.prompt)) {
        console.log(`  cached  ${j.name}`);
        continue;
      }
    }
    work.push(j);
  }
  if (work.length === 0) {
    console.log('all sprites up to date.');
    return;
  }

  console.log(`generating ${work.length} sprite(s) with ${MODEL}`);
  let next = 0;
  let generated = 0;
  let failed = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(MAX_CONCURRENCY, work.length); w++) {
    workers.push(
      (async () => {
        while (next < work.length) {
          const job = work[next++]!;
          try {
            const png = await generateOne(apiKey, job);
            await writeFile(join(OUTPUT_DIR, `${job.name}.png`), png);
            await writeFile(
              join(OUTPUT_DIR, `${job.name}.sha1`),
              sha1(job.prompt) + '\n',
            );
            generated++;
            console.log(`  wrote   ${job.name}  (${png.length} B)`);
          } catch (err) {
            failed++;
            console.error(`  FAILED  ${job.name}: ${(err as Error).message}`);
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  console.log(`done: ${generated} generated, ${failed} failed, ${jobs.length - work.length} cached`);
  if (failed > 0) process.exit(1);
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      'GEMINI_API_KEY is required. Get one at https://aistudio.google.com/apikey',
    );
    process.exit(1);
  }
  const { force, only } = parseArgs(process.argv.slice(2));
  const prompts = JSON.parse(await readFile(PROMPTS_PATH, 'utf8')) as PromptsFile;

  const jobs: Job[] = [];
  for (const [name, desc] of Object.entries(prompts.units)) {
    jobs.push({
      name: `unit-${name}`,
      prompt: compose(prompts.styleLock, desc, 'unit'),
    });
  }
  for (const [name, desc] of Object.entries(prompts.buildings)) {
    jobs.push({
      name: `building-${name}`,
      prompt: compose(prompts.styleLock, desc, 'building'),
    });
  }

  const filtered = only ? jobs.filter((j) => j.name === only) : jobs;
  if (filtered.length === 0) {
    console.error(`no jobs matched --only=${only}`);
    process.exit(1);
  }
  await runBatch(apiKey, filtered, force);
}

function compose(styleLock: string, desc: string, kind: 'unit' | 'building'): string {
  const size = kind === 'unit' ? '128x128' : '192x192';
  return [
    `Subject: ${desc}.`,
    `Style: ${styleLock}`,
    `Canvas: ${size} pixels, transparent background (alpha), no border, no text, no watermark.`,
    `Composition: subject centered, single character/object only, facing viewer, small soft shadow directly below feet. Plenty of headroom.`,
    `Consistency: matches a shared cohesive game atlas — same outline thickness, same palette, same perspective as sibling sprites.`,
  ].join(' ');
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
