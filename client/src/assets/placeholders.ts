import Phaser from 'phaser';

// Procedural placeholder sprites — drawn to a hidden Graphics object,
// then baked into a texture under the expected key. These hold the game
// together visually before the Gemini-generated atlas lands in
// client/public/assets/sprites/. The matching color palette and outline
// weight approximate the styleLock in tools/gemini-art/prompts.json, so
// the look is coherent.

const UNIT_SIZE = 128;
const BUILDING_SIZE = 192;
const UI_SIZE = 96;
const OUTLINE = 0x1a1208; // near-black warm brown
const OUTLINE_W = 4;

// Faction palettes — warm, saturated, pastel-ish. Keep these in sync
// with prompts.json factions for visual continuity when real art lands.
const PALETTE = {
  ant: { body: 0xb8502b, accent: 0xf2d06b, belly: 0xd98b4a },
  bee: { body: 0xf5c84c, accent: 0x1a1208, belly: 0xffe799 },
  beetle: { body: 0x3a8c8c, accent: 0x6fd0d0, belly: 0x88e2e2 },
  spider: { body: 0x6b3ea8, accent: 0x9bd957, belly: 0x8d5ec9 },
  neutral: { body: 0xb2d69b, accent: 0x1a1208, belly: 0xc6e8b2 },
  turret: { body: 0xd94c4c, accent: 0xfff3d6, belly: 0xe6a8a8 },
  wood: { body: 0x8a5a3b, accent: 0xf2d06b, belly: 0xa97856 },
  stone: { body: 0x808a7a, accent: 0x3a3f37, belly: 0x9aa394 },
  leaf: { body: 0x5ba445, accent: 0x3a6a2a, belly: 0x7ac15f },
  sugar: { body: 0xfae0a3, accent: 0xd98b4a, belly: 0xfff6d4 },
  earth: { body: 0x6a4428, accent: 0x3a2410, belly: 0x8a5a3b },
  dew: { body: 0x9ad4e8, accent: 0x4a7e95, belly: 0xc4e7f2 },
  queen: { body: 0xe8b84a, accent: 0xd94c4c, belly: 0xf2d06b },
};

type Pal = typeof PALETTE.ant;

function makeGraphics(scene: Phaser.Scene): Phaser.GameObjects.Graphics {
  // Off-screen graphics — generateTexture does the bake, then destroy.
  return scene.add.graphics({ x: 0, y: 0 }).setVisible(false);
}

function bake(
  scene: Phaser.Scene,
  key: string,
  size: number,
  draw: (g: Phaser.GameObjects.Graphics) => void,
): void {
  if (scene.textures.exists(key)) return; // real atlas already loaded
  const g = makeGraphics(scene);
  draw(g);
  g.generateTexture(key, size, size);
  g.destroy();
}

// -- Unit placeholders ------------------------------------------------------

function drawBug(g: Phaser.GameObjects.Graphics, pal: Pal, accent: () => void): void {
  const cx = UNIT_SIZE / 2;
  const cy = UNIT_SIZE / 2 + 6;
  // drop shadow
  g.fillStyle(0x000000, 0.22);
  g.fillEllipse(cx, UNIT_SIZE - 18, 64, 14);
  // body (plump rounded rectangle approximated with ellipse)
  g.fillStyle(pal.belly, 1);
  g.fillEllipse(cx, cy + 8, 72, 56);
  g.fillStyle(pal.body, 1);
  g.fillEllipse(cx, cy, 84, 64);
  g.lineStyle(OUTLINE_W, OUTLINE, 1);
  g.strokeEllipse(cx, cy, 84, 64);
  // head
  g.fillStyle(pal.body, 1);
  g.fillCircle(cx, cy - 40, 22);
  g.lineStyle(OUTLINE_W, OUTLINE, 1);
  g.strokeCircle(cx, cy - 40, 22);
  // eyes
  g.fillStyle(OUTLINE, 1);
  g.fillCircle(cx - 8, cy - 42, 4);
  g.fillCircle(cx + 8, cy - 42, 4);
  g.fillStyle(0xffffff, 1);
  g.fillCircle(cx - 9, cy - 43, 1.5);
  g.fillCircle(cx + 7, cy - 43, 1.5);
  // accent (per-kind)
  accent();
  // 6 little legs
  g.lineStyle(OUTLINE_W, OUTLINE, 1);
  for (let i = 0; i < 3; i++) {
    const y = cy - 10 + i * 14;
    g.beginPath();
    g.moveTo(cx - 38, y);
    g.lineTo(cx - 54, y + 10);
    g.strokePath();
    g.beginPath();
    g.moveTo(cx + 38, y);
    g.lineTo(cx + 54, y + 10);
    g.strokePath();
  }
}

function drawWings(g: Phaser.GameObjects.Graphics): void {
  g.fillStyle(0xffffff, 0.6);
  g.lineStyle(2, OUTLINE, 1);
  g.fillEllipse(UNIT_SIZE / 2 - 26, UNIT_SIZE / 2 - 12, 36, 22);
  g.strokeEllipse(UNIT_SIZE / 2 - 26, UNIT_SIZE / 2 - 12, 36, 22);
  g.fillEllipse(UNIT_SIZE / 2 + 26, UNIT_SIZE / 2 - 12, 36, 22);
  g.strokeEllipse(UNIT_SIZE / 2 + 26, UNIT_SIZE / 2 - 12, 36, 22);
}

function drawUnit(scene: Phaser.Scene, key: string): void {
  bake(scene, key, UNIT_SIZE, (g) => {
    const cx = UNIT_SIZE / 2;
    const cy = UNIT_SIZE / 2 + 6;
    switch (key) {
      case 'unit-WorkerAnt':
        drawBug(g, PALETTE.ant, () => {
          // tiny leaf on back
          g.fillStyle(PALETTE.leaf.body, 1);
          g.lineStyle(3, OUTLINE, 1);
          g.fillEllipse(cx, cy - 18, 28, 14);
          g.strokeEllipse(cx, cy - 18, 28, 14);
        });
        break;
      case 'unit-SoldierAnt':
        drawBug(g, PALETTE.ant, () => {
          // mandibles as two triangles
          g.fillStyle(OUTLINE, 1);
          g.fillTriangle(cx - 18, cy - 52, cx - 6, cy - 62, cx - 10, cy - 46);
          g.fillTriangle(cx + 18, cy - 52, cx + 6, cy - 62, cx + 10, cy - 46);
        });
        break;
      case 'unit-DirtDigger':
        drawBug(g, PALETTE.earth, () => {
          // oversized front claws
          g.fillStyle(PALETTE.stone.body, 1);
          g.lineStyle(3, OUTLINE, 1);
          g.fillCircle(cx - 36, cy + 8, 10);
          g.strokeCircle(cx - 36, cy + 8, 10);
          g.fillCircle(cx + 36, cy + 8, 10);
          g.strokeCircle(cx + 36, cy + 8, 10);
        });
        break;
      case 'unit-Forager':
        drawBug(g, PALETTE.bee, () => {
          drawWings(g);
          // stripes
          g.fillStyle(OUTLINE, 1);
          g.fillRect(cx - 20, cy + 0, 40, 5);
          g.fillRect(cx - 16, cy + 12, 32, 5);
        });
        break;
      case 'unit-Wasp':
        drawBug(g, PALETTE.bee, () => {
          drawWings(g);
          // bandit mask
          g.fillStyle(OUTLINE, 1);
          g.fillRect(cx - 16, cy - 46, 32, 8);
          // stinger
          g.fillTriangle(cx, cy + 36, cx - 6, cy + 28, cx + 6, cy + 28);
        });
        break;
      case 'unit-HoneyTank':
        drawBug(g, PALETTE.bee, () => {
          // honeycomb plates
          g.fillStyle(PALETTE.wood.accent, 1);
          g.lineStyle(2, OUTLINE, 1);
          for (let r = 0; r < 2; r++)
            for (let c = -1; c <= 1; c++) {
              const hx = cx + c * 18;
              const hy = cy + 4 + r * 16;
              g.fillCircle(hx, hy, 6);
              g.strokeCircle(hx, hy, 6);
            }
        });
        break;
      case 'unit-ShieldBeetle':
        drawBug(g, PALETTE.beetle, () => {
          // shield overlay
          g.fillStyle(PALETTE.stone.body, 1);
          g.lineStyle(3, OUTLINE, 1);
          g.fillRoundedRect(cx - 32, cy - 14, 64, 34, 10);
          g.strokeRoundedRect(cx - 32, cy - 14, 64, 34, 10);
          g.fillStyle(OUTLINE, 1);
          g.fillRect(cx - 1, cy - 10, 2, 26);
          g.fillRect(cx - 26, cy + 1, 52, 2);
        });
        break;
      case 'unit-BombBeetle':
        drawBug(g, PALETTE.beetle, () => {
          // dandelion puff above
          g.fillStyle(0xffffff, 0.92);
          g.lineStyle(2, OUTLINE, 1);
          g.fillCircle(cx, cy - 60, 16);
          g.strokeCircle(cx, cy - 60, 16);
        });
        break;
      case 'unit-Roller':
        drawBug(g, PALETTE.beetle, () => {
          // dew droplet it's rolling
          g.fillStyle(PALETTE.dew.body, 1);
          g.lineStyle(3, OUTLINE, 1);
          g.fillCircle(cx + 38, cy + 20, 16);
          g.strokeCircle(cx + 38, cy + 20, 16);
        });
        break;
      case 'unit-Jumper':
        drawBug(g, PALETTE.spider, () => {
          // alert eyes — two extra smaller eyes
          g.fillStyle(OUTLINE, 1);
          g.fillCircle(cx - 14, cy - 34, 3);
          g.fillCircle(cx + 14, cy - 34, 3);
        });
        break;
      case 'unit-WebSetter':
        drawBug(g, PALETTE.spider, () => {
          // silvery web lines trailing
          g.lineStyle(2, 0xe2e8ec, 1);
          g.lineBetween(cx - 60, cy + 40, cx - 20, cy + 10);
          g.lineBetween(cx + 60, cy + 40, cx + 20, cy + 10);
          g.lineBetween(cx - 60, cy + 40, cx + 60, cy + 40);
        });
        break;
      case 'unit-Ambusher':
        drawBug(g, PALETTE.spider, () => {
          // half-hidden leaf on top
          g.fillStyle(PALETTE.leaf.body, 1);
          g.lineStyle(3, OUTLINE, 1);
          g.slice(cx, cy - 42, 36, Phaser.Math.DegToRad(200), Phaser.Math.DegToRad(340), false);
          g.fillPath();
          g.strokePath();
        });
        break;
      case 'unit-FireAnt':
        drawBug(g, PALETTE.turret, () => {
          // flame crest on the head
          g.fillStyle(0xffb347, 1);
          g.lineStyle(3, OUTLINE, 1);
          g.fillTriangle(cx - 10, cy - 56, cx + 10, cy - 56, cx, cy - 78);
          g.strokeTriangle(cx - 10, cy - 56, cx + 10, cy - 56, cx, cy - 78);
          g.fillStyle(0xffe799, 1);
          g.fillTriangle(cx - 4, cy - 58, cx + 4, cy - 58, cx, cy - 70);
        });
        break;
      case 'unit-Termite':
        drawBug(g, PALETTE.sugar, () => {
          // pale body + oversized mandibles (gnaws buildings)
          g.fillStyle(OUTLINE, 1);
          g.fillTriangle(cx - 22, cy - 48, cx - 2, cy - 60, cx - 6, cy - 42);
          g.fillTriangle(cx + 22, cy - 48, cx + 2, cy - 60, cx + 6, cy - 42);
        });
        break;
      case 'unit-Dragonfly':
        drawBug(g, PALETTE.dew, () => {
          drawWings(g);
          // elongated tail
          g.fillStyle(PALETTE.dew.body, 1);
          g.lineStyle(3, OUTLINE, 1);
          g.fillRoundedRect(cx - 6, cy + 20, 12, 36, 4);
          g.strokeRoundedRect(cx - 6, cy + 20, 12, 36, 4);
        });
        break;
      case 'unit-Mantis':
        drawBug(g, PALETTE.leaf, () => {
          // raptorial forelegs
          g.lineStyle(6, PALETTE.leaf.accent, 1);
          g.lineBetween(cx - 30, cy + 4, cx - 54, cy - 28);
          g.lineBetween(cx + 30, cy + 4, cx + 54, cy - 28);
          g.lineStyle(4, OUTLINE, 1);
          g.lineBetween(cx - 54, cy - 28, cx - 44, cy - 42);
          g.lineBetween(cx + 54, cy - 28, cx + 44, cy - 42);
        });
        break;
      case 'unit-Scarab':
        drawBug(g, PALETTE.beetle, () => {
          // metallic shell stripe + a hieroglyphic dot
          g.fillStyle(PALETTE.queen.accent, 1);
          g.lineStyle(3, OUTLINE, 1);
          g.fillCircle(cx, cy + 2, 10);
          g.strokeCircle(cx, cy + 2, 10);
          g.fillStyle(OUTLINE, 1);
          g.fillRect(cx - 1, cy - 20, 2, 44);
        });
        break;
      case 'unit-MiniScarab':
        drawBug(g, PALETTE.beetle, () => {
          // smaller shell dot — draw on top of the default shell
          g.fillStyle(PALETTE.queen.body, 1);
          g.fillCircle(cx, cy + 2, 6);
        });
        break;
      case 'unit-NestSpider':
        drawBug(g, PALETTE.spider, () => {
          // extra spidery legs — two more pairs
          g.lineStyle(OUTLINE_W, OUTLINE, 1);
          for (let i = 0; i < 2; i++) {
            const y = cy - 20 + i * 10;
            g.beginPath();
            g.moveTo(cx - 38, y);
            g.lineTo(cx - 58, y - 10);
            g.strokePath();
            g.beginPath();
            g.moveTo(cx + 38, y);
            g.lineTo(cx + 58, y - 10);
            g.strokePath();
          }
        });
        break;
      default:
        drawBug(g, PALETTE.neutral, () => {});
    }
  });
}

// -- Building placeholders --------------------------------------------------

function drawBuilding(scene: Phaser.Scene, key: string): void {
  bake(scene, key, BUILDING_SIZE, (g) => {
    const s = BUILDING_SIZE;
    // soft ground shadow so buildings feel placed, not floating
    g.fillStyle(0x000000, 0.2);
    g.fillEllipse(s / 2, s - 20, s * 0.7, 18);
    const draw = PLACEHOLDER_BUILDINGS[key] ?? PLACEHOLDER_BUILDINGS.default!;
    draw(g, s);
  });
}

const PLACEHOLDER_BUILDINGS: Record<
  string,
  (g: Phaser.GameObjects.Graphics, s: number) => void
> = {
  'building-QueenChamber': (g, s) => {
    const cx = s / 2;
    // arch base
    g.fillStyle(PALETTE.queen.belly, 1);
    g.fillRoundedRect(cx - 66, s - 140, 132, 110, 14);
    g.fillStyle(PALETTE.queen.body, 1);
    g.fillRoundedRect(cx - 60, s - 136, 120, 100, 10);
    g.lineStyle(OUTLINE_W, OUTLINE, 1);
    g.strokeRoundedRect(cx - 60, s - 136, 120, 100, 10);
    // archway
    g.fillStyle(0x3a2a10, 1);
    g.slice(cx, s - 36, 34, Math.PI, 0, true);
    g.fillPath();
    g.lineStyle(OUTLINE_W, OUTLINE, 1);
    g.strokeCircle(cx, s - 36, 34);
    // crown dots
    g.fillStyle(PALETTE.queen.accent, 1);
    for (let i = -2; i <= 2; i++) {
      g.fillCircle(cx + i * 20, s - 146, 8);
      g.lineStyle(3, OUTLINE, 1);
      g.strokeCircle(cx + i * 20, s - 146, 8);
    }
  },
  'building-DewCollector': (g, s) => {
    const cx = s / 2;
    // twig frame
    g.lineStyle(6, PALETTE.wood.body, 1);
    g.lineBetween(cx - 60, s - 30, cx - 10, s - 100);
    g.lineBetween(cx + 60, s - 30, cx + 10, s - 100);
    // droplet
    g.fillStyle(PALETTE.dew.body, 1);
    g.lineStyle(OUTLINE_W, OUTLINE, 1);
    g.fillCircle(cx, s - 80, 40);
    g.strokeCircle(cx, s - 80, 40);
    // highlight
    g.fillStyle(PALETTE.dew.belly, 0.9);
    g.fillEllipse(cx - 12, s - 92, 18, 10);
  },
  'building-MushroomTurret': (g, s) => {
    const cx = s / 2;
    // stem
    g.fillStyle(PALETTE.turret.belly, 1);
    g.fillRoundedRect(cx - 24, s - 100, 48, 72, 10);
    g.lineStyle(OUTLINE_W, OUTLINE, 1);
    g.strokeRoundedRect(cx - 24, s - 100, 48, 72, 10);
    // cap
    g.fillStyle(PALETTE.turret.body, 1);
    g.slice(cx, s - 110, 64, Math.PI, 0, true);
    g.fillPath();
    g.strokeCircle(cx, s - 110, 64);
    // white dots
    g.fillStyle(0xfff3d6, 1);
    g.fillCircle(cx - 28, s - 118, 7);
    g.fillCircle(cx + 20, s - 132, 9);
    g.fillCircle(cx + 34, s - 110, 6);
    // muzzle
    g.fillStyle(OUTLINE, 1);
    g.fillRoundedRect(cx - 6, s - 72, 12, 20, 2);
  },
  'building-LeafWall': (g, s) => {
    const cx = s / 2;
    g.lineStyle(OUTLINE_W, OUTLINE, 1);
    g.fillStyle(PALETTE.leaf.body, 1);
    // stacked leaves
    for (let i = 0; i < 3; i++) {
      const y = s - 30 - i * 38;
      g.fillTriangle(cx - 66, y, cx + 66, y, cx, y - 46);
      g.strokeTriangle(cx - 66, y, cx + 66, y, cx, y - 46);
    }
    g.fillStyle(PALETTE.leaf.accent, 1);
    g.lineBetween(cx, s - 30, cx, s - 150);
  },
  'building-PebbleBunker': (g, s) => {
    const cx = s / 2;
    g.lineStyle(OUTLINE_W, OUTLINE, 1);
    // 5 stacked pebbles
    const palette = [PALETTE.stone.belly, PALETTE.stone.body, PALETTE.stone.accent];
    const rows = [
      { y: s - 44, count: 3 },
      { y: s - 82, count: 2 },
      { y: s - 120, count: 1 },
    ];
    rows.forEach((row, ri) => {
      for (let i = 0; i < row.count; i++) {
        const x = cx - ((row.count - 1) * 38) / 2 + i * 38;
        g.fillStyle(palette[(i + ri) % palette.length]!, 1);
        g.fillEllipse(x, row.y, 46, 34);
        g.strokeEllipse(x, row.y, 46, 34);
      }
    });
  },
  'building-LarvaNursery': (g, s) => {
    const cx = s / 2;
    g.fillStyle(PALETTE.sugar.body, 1);
    g.lineStyle(OUTLINE_W, OUTLINE, 1);
    g.slice(cx, s - 36, 70, Math.PI, 0, true);
    g.fillPath();
    g.strokeCircle(cx, s - 36, 70);
    // oval windows
    for (let i = -1; i <= 1; i++) {
      g.fillStyle(PALETTE.sugar.belly, 1);
      g.fillEllipse(cx + i * 30, s - 70, 16, 22);
      g.strokeEllipse(cx + i * 30, s - 70, 16, 22);
    }
  },
  'building-SugarVault': (g, s) => {
    const cx = s / 2;
    // wooden vault body
    g.fillStyle(PALETTE.wood.body, 1);
    g.lineStyle(OUTLINE_W, OUTLINE, 1);
    g.fillRoundedRect(cx - 58, s - 120, 116, 90, 10);
    g.strokeRoundedRect(cx - 58, s - 120, 116, 90, 10);
    // giant sugar cube on top
    g.fillStyle(PALETTE.sugar.belly, 1);
    g.fillRoundedRect(cx - 28, s - 154, 56, 36, 4);
    g.strokeRoundedRect(cx - 28, s - 154, 56, 36, 4);
    // door & keyhole
    g.fillStyle(OUTLINE, 1);
    g.fillRoundedRect(cx - 20, s - 80, 40, 50, 6);
    g.fillStyle(PALETTE.wood.accent, 1);
    g.fillCircle(cx, s - 52, 4);
  },
  'building-TunnelJunction': (g, s) => {
    const cx = s / 2;
    g.fillStyle(PALETTE.earth.accent, 1);
    g.fillEllipse(cx, s - 60, 140, 90);
    g.fillStyle(PALETTE.earth.body, 1);
    g.fillEllipse(cx, s - 60, 120, 76);
    g.fillStyle(0x1a0c05, 1);
    g.fillEllipse(cx, s - 60, 80, 46);
    g.lineStyle(OUTLINE_W, OUTLINE, 1);
    g.strokeEllipse(cx, s - 60, 120, 76);
  },
  'building-DungeonTrap': (g, s) => {
    const cx = s / 2;
    // pit shadow
    g.fillStyle(0x1a0c05, 1);
    g.fillEllipse(cx, s - 50, 110, 40);
    // disguise twigs
    g.lineStyle(5, PALETTE.wood.body, 1);
    for (let i = -2; i <= 2; i++) {
      g.lineBetween(cx + i * 16, s - 60, cx + i * 16 + 8, s - 90);
    }
    // one leaf
    g.fillStyle(PALETTE.leaf.body, 1);
    g.fillEllipse(cx - 30, s - 56, 42, 22);
    g.lineStyle(3, OUTLINE, 1);
    g.strokeEllipse(cx - 30, s - 56, 42, 22);
  },
  'building-AcidSpitter': (g, s) => {
    const cx = s / 2;
    // pitcher-plant mortar
    g.fillStyle(PALETTE.leaf.accent, 1);
    g.lineStyle(OUTLINE_W, OUTLINE, 1);
    g.fillRoundedRect(cx - 60, s - 130, 120, 90, 18);
    g.strokeRoundedRect(cx - 60, s - 130, 120, 90, 18);
    // acid pool inside
    g.fillStyle(0x9bd957, 1);
    g.fillEllipse(cx, s - 110, 80, 28);
    g.strokeEllipse(cx, s - 110, 80, 28);
    // highlight drip
    g.fillStyle(0xffffff, 0.55);
    g.fillCircle(cx - 22, s - 112, 5);
  },
  'building-SporeTower': (g, s) => {
    const cx = s / 2;
    // tall stem
    g.fillStyle(PALETTE.wood.body, 1);
    g.lineStyle(OUTLINE_W, OUTLINE, 1);
    g.fillRoundedRect(cx - 14, s - 120, 28, 90, 8);
    g.strokeRoundedRect(cx - 14, s - 120, 28, 90, 8);
    // puffball top
    g.fillStyle(PALETTE.turret.belly, 1);
    g.fillCircle(cx, s - 128, 36);
    g.strokeCircle(cx, s - 128, 36);
    // puff dots
    g.fillStyle(0xffffff, 0.9);
    g.fillCircle(cx - 18, s - 134, 5);
    g.fillCircle(cx + 10, s - 120, 4);
    g.fillCircle(cx - 4, s - 146, 3);
  },
  'building-RootSnare': (g, s) => {
    const cx = s / 2;
    // tangled roots/vine loop
    g.lineStyle(6, PALETTE.earth.body, 1);
    g.strokeCircle(cx, s - 60, 38);
    g.lineStyle(4, PALETTE.leaf.accent, 1);
    g.strokeCircle(cx, s - 60, 30);
    // cross twigs
    g.lineStyle(5, PALETTE.wood.accent, 1);
    g.lineBetween(cx - 28, s - 88, cx + 28, s - 30);
    g.lineBetween(cx + 28, s - 88, cx - 28, s - 30);
  },
  'building-HiddenStinger': (g, s) => {
    const cx = s / 2;
    // mostly-buried mound with a faint stinger peeking out
    g.fillStyle(PALETTE.earth.body, 1);
    g.lineStyle(OUTLINE_W, OUTLINE, 1);
    g.fillEllipse(cx, s - 50, 140, 60);
    g.strokeEllipse(cx, s - 50, 140, 60);
    // stinger tip
    g.fillStyle(PALETTE.bee.body, 1);
    g.fillTriangle(cx - 8, s - 80, cx + 8, s - 80, cx, s - 110);
    g.strokeTriangle(cx - 8, s - 80, cx + 8, s - 80, cx, s - 110);
    // question-mark ??? no; drop a few leaves for disguise
    g.fillStyle(PALETTE.leaf.body, 1);
    g.fillEllipse(cx - 40, s - 50, 34, 14);
    g.fillEllipse(cx + 40, s - 50, 34, 14);
  },
  'building-SpiderNest': (g, s) => {
    const cx = s / 2;
    // wrapped silk cocoon
    g.fillStyle(0xe2e8ec, 1);
    g.lineStyle(OUTLINE_W, OUTLINE, 1);
    g.fillEllipse(cx, s - 80, 120, 100);
    g.strokeEllipse(cx, s - 80, 120, 100);
    // web strands
    g.lineStyle(2, 0xf5f5f5, 0.9);
    for (let a = 0; a < 6; a++) {
      const r = Phaser.Math.DegToRad(30 + a * 30);
      g.lineBetween(cx, s - 80, cx + Math.cos(r) * 66, s - 80 + Math.sin(r) * 54);
    }
    // little spider peeking out
    g.fillStyle(PALETTE.spider.body, 1);
    g.fillCircle(cx, s - 80, 16);
    g.lineStyle(2, OUTLINE, 1);
    g.strokeCircle(cx, s - 80, 16);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(cx - 5, s - 82, 2);
    g.fillCircle(cx + 5, s - 82, 2);
  },
  'building-ThornHedge': (g, s) => {
    const cx = s / 2;
    g.lineStyle(OUTLINE_W, OUTLINE, 1);
    g.fillStyle(PALETTE.leaf.accent, 1);
    // denser, darker than LeafWall; thorns jut out
    for (let i = 0; i < 3; i++) {
      const y = s - 30 - i * 38;
      g.fillTriangle(cx - 66, y, cx + 66, y, cx, y - 46);
      g.strokeTriangle(cx - 66, y, cx + 66, y, cx, y - 46);
    }
    // thorns
    g.lineStyle(4, OUTLINE, 1);
    g.lineBetween(cx - 58, s - 40, cx - 74, s - 54);
    g.lineBetween(cx + 58, s - 40, cx + 74, s - 54);
    g.lineBetween(cx - 40, s - 78, cx - 60, s - 92);
    g.lineBetween(cx + 40, s - 78, cx + 60, s - 92);
  },
  default: (g, s) => {
    const cx = s / 2;
    g.fillStyle(PALETTE.neutral.body, 1);
    g.lineStyle(OUTLINE_W, OUTLINE, 1);
    g.fillRoundedRect(cx - 50, s - 120, 100, 90, 10);
    g.strokeRoundedRect(cx - 50, s - 120, 100, 90, 10);
  },
};

// -- UI placeholders --------------------------------------------------------

function drawUi(scene: Phaser.Scene, key: string): void {
  bake(scene, key, UI_SIZE, (g) => {
    switch (key) {
      case 'ui-resource-sugar':
        g.fillStyle(PALETTE.sugar.belly, 1);
        g.lineStyle(OUTLINE_W, OUTLINE, 1);
        g.fillRoundedRect(UI_SIZE / 2 - 30, UI_SIZE / 2 - 20, 60, 40, 6);
        g.strokeRoundedRect(UI_SIZE / 2 - 30, UI_SIZE / 2 - 20, 60, 40, 6);
        g.fillStyle(PALETTE.sugar.body, 1);
        for (let i = 0; i < 6; i++) {
          g.fillCircle(
            UI_SIZE / 2 - 20 + (i % 3) * 20,
            UI_SIZE / 2 - 8 + Math.floor(i / 3) * 16,
            4,
          );
        }
        break;
      case 'ui-resource-leaf':
        g.fillStyle(PALETTE.leaf.body, 1);
        g.lineStyle(OUTLINE_W, OUTLINE, 1);
        g.fillEllipse(UI_SIZE / 2, UI_SIZE / 2, 60, 40);
        g.strokeEllipse(UI_SIZE / 2, UI_SIZE / 2, 60, 40);
        g.lineStyle(3, PALETTE.leaf.accent, 1);
        g.lineBetween(UI_SIZE / 2 - 28, UI_SIZE / 2, UI_SIZE / 2 + 28, UI_SIZE / 2);
        break;
      case 'ui-resource-milk':
        g.fillStyle(PALETTE.dew.belly, 1);
        g.lineStyle(OUTLINE_W, OUTLINE, 1);
        g.fillCircle(UI_SIZE / 2, UI_SIZE / 2, 28);
        g.strokeCircle(UI_SIZE / 2, UI_SIZE / 2, 28);
        g.fillStyle(0xffffff, 0.6);
        g.fillEllipse(UI_SIZE / 2 - 10, UI_SIZE / 2 - 10, 14, 8);
        break;
      case 'ui-button-primary':
        g.fillStyle(0x3a7f3a, 1);
        g.lineStyle(OUTLINE_W, OUTLINE, 1);
        g.fillRoundedRect(4, 4, UI_SIZE - 8, UI_SIZE - 8, 12);
        g.strokeRoundedRect(4, 4, UI_SIZE - 8, UI_SIZE - 8, 12);
        g.fillStyle(0x5ba445, 0.5);
        g.fillRoundedRect(8, 8, UI_SIZE - 16, 20, 8);
        break;
      case 'ui-button-secondary':
        g.fillStyle(0x333a36, 1);
        g.lineStyle(OUTLINE_W, OUTLINE, 1);
        g.fillRoundedRect(4, 4, UI_SIZE - 8, UI_SIZE - 8, 12);
        g.strokeRoundedRect(4, 4, UI_SIZE - 8, UI_SIZE - 8, 12);
        break;
    }
  });
}

// -- Public API -------------------------------------------------------------

export function generateMissingPlaceholders(
  scene: Phaser.Scene,
  keys: readonly string[],
): void {
  for (const key of keys) {
    if (key.startsWith('unit-')) drawUnit(scene, key);
    else if (key.startsWith('building-')) drawBuilding(scene, key);
    else if (key.startsWith('ui-')) drawUi(scene, key);
  }
}

// Small helper used by RaidScene to draw a soft pheromone-trail dot even
// without a dedicated sprite key.
export function bakeTrailDot(scene: Phaser.Scene): string {
  const key = 'trail-dot';
  if (scene.textures.exists(key)) return key;
  const g = makeGraphics(scene);
  g.fillStyle(0xfff3a8, 0.85);
  g.fillCircle(12, 12, 10);
  g.fillStyle(0xffffff, 0.6);
  g.fillCircle(12, 12, 5);
  g.generateTexture(key, 24, 24);
  g.destroy();
  return key;
}
