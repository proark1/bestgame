#!/usr/bin/env node
// Atlas packer. Takes the output/ folder from `generate.ts`, packs into a
// 1024x1024 WEBP atlas + JSON frame map that Phaser consumes.
//
// Implementation deferred until we have real sprites — this file exists
// so the workspace builds and the package.json script resolves.

async function main(): Promise<void> {
  console.log('atlas-build: not yet implemented (week 1 scaffold).');
}

void main();
