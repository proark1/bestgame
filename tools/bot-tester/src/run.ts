#!/usr/bin/env node
// Headless bot match runner. Used for balance testing: spawn N matches
// with varied bases, accumulate win/loss per faction, print histogram.
//
// Runs the shared sim directly — no server, no network. Because the sim
// is fully deterministic, results are reproducible given the same seed.

import { Sim, Types } from '@hive/shared';

interface Outcome {
  outcome: 'attackerWin' | 'defenderWin' | 'draw' | 'ongoing';
  ticks: number;
  sugarLooted: number;
  leafBitsLooted: number;
}

function pickInputs(seed: number): Types.SimInput[] {
  // Deterministic pseudo-script: every 30 ticks, deploy 4 soldier ants
  // toward the center. Keeps the simulator exercised without modeling
  // a full AI. Swap in a smarter scripted attacker once systems are richer.
  const inputs: Types.SimInput[] = [];
  const rng = new Sim.Rng(seed ^ 0x5a5a5a5a);
  for (let t = 10; t < 2700; t += 30 + (rng.nextIntBelow(20) - 10)) {
    inputs.push({
      type: 'deployPath',
      tick: t,
      ownerSlot: 0,
      path: {
        pathId: 0,
        spawnLayer: 0,
        unitKind: 'SoldierAnt',
        count: 4,
        points: [
          { x: Sim.fromInt(0), y: Sim.fromInt(rng.nextIntBelow(12)) },
          { x: Sim.fromInt(7), y: Sim.fromInt(5) },
        ],
      },
    });
  }
  return inputs;
}

function runOne(seed: number): Outcome {
  const base: Types.Base = {
    baseId: 'bot-' + seed,
    ownerId: 'bot',
    faction: 'Ants',
    gridSize: { w: 16, h: 12 },
    resources: { sugar: 1000, leafBits: 200, aphidMilk: 0 },
    trophies: 100,
    version: 1,
    tunnels: [],
    buildings: [
      {
        id: 'b-q',
        kind: 'QueenChamber',
        anchor: { x: 7, y: 5, layer: 0 },
        footprint: { w: 2, h: 2 },
        spans: [0, 1],
        level: 1,
        hp: 800,
        hpMax: 800,
      },
      {
        id: 'b-t',
        kind: 'MushroomTurret',
        anchor: { x: 3, y: 3, layer: 0 },
        footprint: { w: 1, h: 1 },
        level: 1,
        hp: 400,
        hpMax: 400,
      },
    ],
  };
  const cfg: Sim.SimConfig = { tickRate: 30, maxTicks: 2700, initialSnapshot: base, seed };
  const final = Sim.runReplay(Sim.createInitialState(cfg), cfg, pickInputs(seed));
  return {
    outcome: final.outcome,
    ticks: final.tick,
    sugarLooted: final.attackerSugarLooted,
    leafBitsLooted: final.attackerLeafBitsLooted,
  };
}

function main(): void {
  const n = Number(process.argv[2] ?? 100);
  const results: Record<Outcome['outcome'], number> = {
    attackerWin: 0,
    defenderWin: 0,
    draw: 0,
    ongoing: 0,
  };
  for (let i = 0; i < n; i++) {
    const out = runOne(0x11000 + i);
    results[out.outcome]++;
  }
  console.log(`Bot-tester ran ${n} matches:`);
  for (const k of Object.keys(results) as Array<Outcome['outcome']>) {
    const pct = ((results[k] / n) * 100).toFixed(1);
    console.log(`  ${k.padEnd(14)} ${results[k]} (${pct}%)`);
  }
  const winRate = (results.attackerWin / n) * 100;
  if (winRate > 55 || winRate < 45) {
    console.error(`WARN: attacker win rate ${winRate.toFixed(1)}% outside 45-55% band`);
    process.exitCode = 1;
  }
}

main();
