#!/usr/bin/env node
// Dispatch to the right workspace based on HIVE_ROLE.
//
// The repo deploys two services — api and arena — from the same
// commit. Railway's per-service "Start Command" override isn't always
// exposed in the UI, so instead we keep railway.json's startCommand
// as a stable `pnpm start`, and toggle which process actually runs
// via an env var:
//
//   HIVE_ROLE=api      (default)  → runs @hive/api
//   HIVE_ROLE=arena              → runs @hive/arena
//
// This keeps both Railway projects using the same startCommand and
// makes misconfiguration loud: the boot log prints the resolved role,
// and an unknown role exits non-zero instead of silently booting the
// wrong service.

import { spawn } from 'node:child_process';

const role = (process.env.HIVE_ROLE ?? 'api').trim().toLowerCase();
const ROLES = {
  api: '@hive/api',
  arena: '@hive/arena',
};

const pkg = ROLES[role];
if (!pkg) {
  console.error(
    `[start] invalid HIVE_ROLE=${JSON.stringify(process.env.HIVE_ROLE)} — expected one of: ${Object.keys(ROLES).join(', ')}`,
  );
  process.exit(1);
}

console.log(`[start] HIVE_ROLE=${role} → ${pkg}`);
const child = spawn('pnpm', ['--filter', pkg, 'start'], { stdio: 'inherit' });

// Propagate the child's exit so Railway sees the right status. A
// missing exit code (child killed by signal) maps to 1 so the
// restart policy triggers instead of looking like a clean shutdown.
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[start] ${pkg} terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
