#!/usr/bin/env node
// Bundle-size budget check. Fails CI if the first-load bundle (initial HTML
// + initial JS chunk + critical CSS) exceeds the budget. Facebook Instant
// Games' hard cap is 5 MB. Our target is 2.5 MB; we fail at 2.8 MB to keep
// headroom.
//
// First-load = everything the browser must fetch before showing the home
// scene. Lazy-loaded chunks (arena, clan, raid) are counted separately.

import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DIST = new URL('../dist', import.meta.url).pathname;
const FIRST_LOAD_BUDGET_BYTES = 2_800_000; // 2.8 MB
const TOTAL_BUDGET_BYTES = 5_000_000; // 5 MB — FB Instant hard cap

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

function isInitialChunk(name) {
  // Anything not explicitly lazy-loaded ships in the first payload.
  // manualChunks in vite.config.ts emits names like 'arena-*.js' for lazy.
  return !/(arena|clan|raid)-[^/]+\.js$/.test(name);
}

const files = await walk(DIST);
let firstLoad = 0;
let total = 0;
const report = [];
for (const f of files) {
  const s = await stat(f);
  total += s.size;
  const name = f.replace(DIST + '/', '');
  const initial = isInitialChunk(name);
  if (initial) firstLoad += s.size;
  report.push({ name, size: s.size, initial });
}
report.sort((a, b) => b.size - a.size);

console.log('\nBundle report (sorted by size):');
for (const r of report) {
  const flag = r.initial ? '  [first-load]' : '  [lazy]     ';
  console.log(`  ${flag} ${String(r.size).padStart(8)}  ${r.name}`);
}
console.log('');
console.log(`First-load bytes: ${firstLoad.toLocaleString()} / ${FIRST_LOAD_BUDGET_BYTES.toLocaleString()} budget`);
console.log(`Total bytes:      ${total.toLocaleString()} / ${TOTAL_BUDGET_BYTES.toLocaleString()} FB Instant cap`);

let failed = false;
if (firstLoad > FIRST_LOAD_BUDGET_BYTES) {
  console.error(`\nFAIL: first-load bundle exceeds budget by ${(firstLoad - FIRST_LOAD_BUDGET_BYTES).toLocaleString()} bytes`);
  failed = true;
}
if (total > TOTAL_BUDGET_BYTES) {
  console.error(`\nFAIL: total bundle exceeds Facebook Instant cap by ${(total - TOTAL_BUDGET_BYTES).toLocaleString()} bytes`);
  failed = true;
}
if (failed) process.exit(1);
console.log('\nOK: within budget.');
