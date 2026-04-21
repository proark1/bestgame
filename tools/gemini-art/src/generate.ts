#!/usr/bin/env node
// Batch Gemini sprite generator. Reads prompts.json, composes per-sprite
// prompts with the global style lock, and calls the Gemini Image API.
//
// This script is NOT run in CI — Gemini outputs vary slightly across calls
// and we don't want art regenerated on every build. Run manually when the
// art set needs an update, review the output visually, then commit the
// atlas into the client bundle.
//
// Usage:
//   pnpm --filter @hive/gemini-art generate -- --out ../../client/public/assets
//
// Auth:
//   export GEMINI_API_KEY=...

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PromptsFile {
  styleLock: string;
  factions: Record<string, string>;
  units: Record<string, string>;
  buildings: Record<string, string>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is required');
    process.exit(1);
  }
  const promptsPath = join(__dirname, '..', 'prompts.json');
  const outDir = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]!
    : join(__dirname, '..', 'output');

  const prompts = JSON.parse(await readFile(promptsPath, 'utf8')) as PromptsFile;
  await mkdir(outDir, { recursive: true });

  const jobs: Array<{ name: string; prompt: string }> = [];
  for (const [name, desc] of Object.entries(prompts.units)) {
    jobs.push({
      name: `unit-${name}`,
      prompt: `${desc}. ${prompts.styleLock}`,
    });
  }
  for (const [name, desc] of Object.entries(prompts.buildings)) {
    jobs.push({
      name: `building-${name}`,
      prompt: `${desc}. ${prompts.styleLock}`,
    });
  }

  console.log(`Generating ${jobs.length} sprites → ${outDir}`);
  for (const job of jobs) {
    // Placeholder: real implementation calls the Gemini Image API endpoint
    // (models/imagen-3 or gemini-2.5-flash-image) with the prompt.
    // For the week-1 scaffold we just write the prompt to disk so the
    // pipeline wiring is verifiable without consuming API quota.
    await writeFile(
      join(outDir, `${job.name}.prompt.txt`),
      job.prompt + '\n',
      'utf8',
    );
    console.log(`  wrote ${job.name}.prompt.txt`);
  }
  console.log('Done. Run `pnpm atlas` next to pack sprites into an atlas.');
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
