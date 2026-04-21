import Phaser from 'phaser';
import { Sim, Types } from '@hive/shared';

// RaidScene — week-1 scaffold. Boots the shared deterministic sim against
// a hardcoded bot base and runs it to completion headlessly so we can
// confirm the sim is wired end-to-end from the client. Actual visual
// raid rendering (sprites, pheromone trail input, camera, VFX) lands
// in week 2.

const HARDCODED_BOT_BASE: Types.Base = {
  baseId: 'bot-0',
  ownerId: 'bot-0',
  faction: 'Ants',
  gridSize: { w: 16, h: 12 },
  resources: { sugar: 1200, leafBits: 300, aphidMilk: 0 },
  trophies: 80,
  version: 1,
  buildings: [
    {
      id: 'b-queen',
      kind: 'QueenChamber',
      anchor: { x: 7, y: 5, layer: 0 },
      footprint: { w: 2, h: 2 },
      spans: [0, 1],
      level: 1,
      hp: 800,
      hpMax: 800,
    },
    {
      id: 'b-turret-1',
      kind: 'MushroomTurret',
      anchor: { x: 3, y: 3, layer: 0 },
      footprint: { w: 1, h: 1 },
      level: 1,
      hp: 400,
      hpMax: 400,
    },
  ],
  tunnels: [],
};

export class RaidScene extends Phaser.Scene {
  constructor() {
    super('RaidScene');
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0f1b10');

    const cfg: Sim.SimConfig = {
      tickRate: 30,
      maxTicks: 2700,
      initialSnapshot: HARDCODED_BOT_BASE,
      seed: 0xc0ffee,
    };
    const state = Sim.createInitialState(cfg);

    // Fire one deploy at tick 10 as a smoke test.
    const path: Types.PheromonePath = {
      pathId: 0,
      spawnLayer: 0,
      unitKind: 'SoldierAnt',
      count: 6,
      points: [
        { x: Sim.fromInt(0), y: Sim.fromInt(1) },
        { x: Sim.fromInt(7), y: Sim.fromInt(5) },
      ],
    };
    const inputs: Types.SimInput[] = [
      { type: 'deployPath', tick: 10, ownerSlot: 0, path },
    ];
    const final = Sim.runReplay(state, cfg, inputs);
    const hash = Sim.hashToHex(Sim.hashSimState(final));

    this.add.text(
      24,
      24,
      [
        'RAID SMOKE TEST',
        `  outcome: ${final.outcome}`,
        `  tick:    ${final.tick}`,
        `  sugar:   ${final.attackerSugarLooted}`,
        `  leaf:    ${final.attackerLeafBitsLooted}`,
        `  hash:    ${hash}`,
        '',
        '[tap to return home]',
      ].join('\n'),
      {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '18px',
        color: '#c3e8b0',
        lineSpacing: 6,
      },
    );

    this.input.once('pointerdown', () => this.scene.start('HomeScene'));
  }
}
