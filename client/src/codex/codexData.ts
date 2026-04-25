import type { Types } from '@hive/shared';

// Codex lore. Short in-universe blurb + mechanical blurb for every
// unit and building the sim knows about. The Magic-card-style
// CodexScene renders these; no in-game effect, so keep the tone
// punchy and keep the stats line short enough to read at a glance.
//
// Treat this as the canonical place to update when a new unit or
// building ships — units.ts and base.ts type-check the set
// completeness, so the scene can never render an empty card for a
// kind that actually exists.

export interface CodexEntry {
  kind: string;
  name: string;
  role: string;
  faction: Types.Faction;
  spriteKey: string;
  story: string;
  power: string;
}

// Units. role = the one-line "what it does" that sits under the name.
// power = the long blurb that sits under the image.
export const UNIT_CODEX: Record<Types.UnitKind, CodexEntry> = {
  WorkerAnt: {
    kind: 'WorkerAnt',
    name: 'Worker Ant',
    role: 'Cheap swarm',
    faction: 'Ants',
    spriteKey: 'unit-WorkerAnt',
    story:
      'Every colony runs on its workers. Ferrying sugar, patching ' +
      'walls, and — when the queen calls — rushing the enemy gate. ' +
      'Not a soldier by training, but she runs through flame if the ' +
      'pheromone trail says so.',
    power:
      'Low HP, low damage, but cheap and fast. Overwhelm an enemy ' +
      'by sending three or four at once along a single trail.',
  },
  SoldierAnt: {
    kind: 'SoldierAnt',
    name: 'Soldier Ant',
    role: 'Frontline melee',
    faction: 'Ants',
    spriteKey: 'unit-SoldierAnt',
    story:
      'Heavy-jawed and bred for the breach. A soldier ant takes a ' +
      'turret hit so three workers behind her can reach the vault. ' +
      'She will charge the queen chamber alone if the path dries up.',
    power:
      'Solid HP and damage against buildings. Slower than a worker ' +
      'but breaks walls reliably. Best deployed behind a shield ' +
      'beetle or in a wide wedge.',
  },
  DirtDigger: {
    kind: 'DirtDigger',
    name: 'Dirt Digger',
    role: 'Underground breacher',
    faction: 'Ants',
    spriteKey: 'unit-DirtDigger',
    story:
      'A worker who lost her way one winter and came back wearing ' +
      'the tunnels like armor. She can burrow through any pebble ' +
      'bunker given thirty seconds and a grudge.',
    power:
      'Spawns on the underground layer. Ignores surface walls by ' +
      'tunnelling past them. Pair with a tunnel junction to flank ' +
      'the queen from below.',
  },
  Forager: {
    kind: 'Forager',
    name: 'Forager',
    role: 'Loot specialist',
    faction: 'Ants',
    spriteKey: 'unit-Forager',
    story:
      'Better at reading a garden than a map. A forager goes for ' +
      'dew, leaf-bits, and anything that smells sweet — trophies ' +
      'come second.',
    power:
      'Small HP boost but +40% loot from collectors and vaults. ' +
      'Deploy her last, after the turrets are down.',
  },
  Wasp: {
    kind: 'Wasp',
    name: 'Wasp',
    role: 'Flying sniper',
    faction: 'Bees',
    spriteKey: 'unit-Wasp',
    story:
      'Uninvited. The wasp court cut its deal with the hive three ' +
      'springs ago and has been selling air support ever since. No ' +
      'one trusts a wasp, but everyone wants one on their side.',
    power:
      'Flies over walls and bunkers. Low HP — glass cannon. Best ' +
      'used to cut a path to the queen chamber over a defensive ' +
      'maze.',
  },
  HoneyTank: {
    kind: 'HoneyTank',
    name: 'Honey Tank',
    role: 'Heavy bruiser',
    faction: 'Bees',
    spriteKey: 'unit-HoneyTank',
    story:
      'Three drones fused into a single honey-soaked husk. Slow to ' +
      'start but gets heavier as it absorbs fire. A honey tank that ' +
      'reaches the vault is usually game over.',
    power:
      'Highest HP in the deck. Slow, low DPS, but absurd siege ' +
      'value. Drop one in front of a cluster of mushroom turrets to ' +
      'soak the salvo for your glass units.',
  },
  ShieldBeetle: {
    kind: 'ShieldBeetle',
    name: 'Shield Beetle',
    role: 'Anti-turret vanguard',
    faction: 'Beetles',
    spriteKey: 'unit-ShieldBeetle',
    story:
      'A carapace forged in the stone orchards. Shield beetles ' +
      'walk into the line of fire so the colony behind them can ' +
      'work. When one falls, another steps in.',
    power:
      'Reduces incoming turret damage by 60% for units within two ' +
      'tiles. Has to be the first unit on a trail to earn its keep.',
  },
  BombBeetle: {
    kind: 'BombBeetle',
    name: 'Bomb Beetle',
    role: 'One-shot sapper',
    faction: 'Beetles',
    spriteKey: 'unit-BombBeetle',
    story:
      'She knows she only walks one trail. The explosive sacs on ' +
      'her back are a calling, not a cargo. Grandma said, "Aim for ' +
      "the biggest wall you see, and don't flinch.\"",
    power:
      'Detonates on contact. Devastating against leaf walls and ' +
      'pebble bunkers. Low HP — protect her with shield beetles so ' +
      'she reaches the breach.',
  },
  Roller: {
    kind: 'Roller',
    name: 'Roller',
    role: 'Momentum crusher',
    faction: 'Beetles',
    spriteKey: 'unit-Roller',
    story:
      'Tucks into a glossy sphere and picks up speed on downhill ' +
      'trails. Rollers love long pheromone paths; the longer the ' +
      'run-up, the harder they hit.',
    power:
      'Damage scales with trail length up to a cap. Draw a curved ' +
      'path across the entire board for a front-line crush, not a ' +
      'short straight one.',
  },
  Jumper: {
    kind: 'Jumper',
    name: 'Jumper',
    role: 'Wall-hopping harasser',
    faction: 'Spiders',
    spriteKey: 'unit-Jumper',
    story:
      "Eight eyes. Eight legs. Eight times you'll check your " +
      'defensive perimeter after a jumper gets through it. They ' +
      'cross walls like the walls are suggestions.',
    power:
      'Leaps over leaf walls (but not pebble bunkers). Medium HP, ' +
      'medium damage — value is positioning, not numbers.',
  },
  WebSetter: {
    kind: 'WebSetter',
    name: 'Web Setter',
    role: 'Crowd controller',
    faction: 'Spiders',
    spriteKey: 'unit-WebSetter',
    story:
      'Deploys silk as she walks. Anything that steps into her ' +
      'thread slows to a crawl — useful when you want mushroom ' +
      'turret salvos to hit your own heavies.',
    power:
      'Leaves a 3-tile web trail that slows enemy movement by ' +
      '50%. Pair with a honey tank to maximize soak time.',
  },
  Ambusher: {
    kind: 'Ambusher',
    name: 'Ambusher',
    role: 'Burst assassin',
    faction: 'Spiders',
    spriteKey: 'unit-Ambusher',
    story:
      'Arrives in silence. Leaves in silence. The queen chamber ' +
      'never saw her come and only learned she was there when the ' +
      'throne tipped over.',
    power:
      'First strike deals triple damage. Best aimed at the queen ' +
      'chamber directly — wasted on fodder.',
  },
  FireAnt: {
    kind: 'FireAnt',
    name: 'Fire Ant',
    role: 'Sticky burn',
    faction: 'Ants',
    spriteKey: 'unit-FireAnt',
    story:
      'Venom runs hot in her mandibles. Every bite leaves a smolder ' +
      'that eats through chitin long after the column has moved on.',
    power:
      'Lays a burn DoT on whatever she bites. The burn keeps ticking ' +
      'after she dies — great against heavy buildings like vaults.',
  },
  Termite: {
    kind: 'Termite',
    name: 'Termite',
    role: 'Building-eater',
    faction: 'Ants',
    spriteKey: 'unit-Termite',
    story:
      'Pale, soft, harmless-looking — until her jaws meet wood. The ' +
      'hedge line heard the gnawing two seconds before it fell.',
    power:
      'Deals double damage to buildings. Thin HP — send her in with ' +
      'a shield beetle escort, not alone.',
  },
  Dragonfly: {
    kind: 'Dragonfly',
    name: 'Dragonfly',
    role: 'Fast flyer',
    faction: 'Bees',
    spriteKey: 'unit-Dragonfly',
    story:
      'Four wings, a hunting record the hive still talks about. She ' +
      'skims the mortars and strafes the turrets before they turn.',
    power:
      'Flies over walls. Fast, low HP. Spore Towers eat her alive — ' +
      'scout for them and path around.',
  },
  Mantis: {
    kind: 'Mantis',
    name: 'Mantis',
    role: 'Single-target burst',
    faction: 'Beetles',
    spriteKey: 'unit-Mantis',
    story:
      'Folded arms open once, close once. The turret she chose had ' +
      'time to swivel, not time to fire.',
    power:
      'Huge damage per swing but a slow cooldown. Aim her at a ' +
      'single high-value target — a turret, a vault, the queen.',
  },
  Scarab: {
    kind: 'Scarab',
    name: 'Scarab',
    role: 'Spawns on death',
    faction: 'Beetles',
    spriteKey: 'unit-Scarab',
    story:
      'When the shell cracks open, two smaller shells crawl out. ' +
      'Ancient priests said the same thing about the sun god.',
    power:
      'Spawns two mini-scarabs when killed. Trade one big unit for ' +
      'three attacks on the way down.',
  },
  MiniScarab: {
    kind: 'MiniScarab',
    name: 'Mini Scarab',
    role: 'Scarab offspring',
    faction: 'Beetles',
    spriteKey: 'unit-MiniScarab',
    story:
      'Half the size, all the same bite. Nobody deploys one on ' +
      'purpose — they show up when a big sister falls.',
    power:
      'Spawned from a dying Scarab. Not directly recruitable; plan ' +
      'around the parent, not the child.',
  },
  NestSpider: {
    kind: 'NestSpider',
    name: 'Nest Spider',
    role: 'Defender AI',
    faction: 'Spiders',
    spriteKey: 'unit-NestSpider',
    story:
      'Lives in the silk cocoons underground and boils up any time a ' +
      'raider gets too close to the queen.',
    power:
      'Only spawns from a Spider Nest during a raid. Not in any ' +
      'attacker\'s hand — this is the defender\'s answer.',
  },
};

export const BUILDING_CODEX: Record<Types.BuildingKind, CodexEntry> = {
  QueenChamber: {
    kind: 'QueenChamber',
    name: 'Queen Chamber',
    role: 'Colony core',
    faction: 'Ants',
    spriteKey: 'building-QueenChamber',
    story:
      'The throne and the life of the hive. Spans both layers — ' +
      'a surface turret wired to an underground throne room. If ' +
      'she falls, the colony scatters.',
    power:
      'Lose it and the raid ends. Upgrading the queen unlocks new ' +
      'building slots and higher-tier defenses.',
  },
  DewCollector: {
    kind: 'DewCollector',
    name: 'Dew Collector',
    role: 'Surface income',
    faction: 'Ants',
    spriteKey: 'building-DewCollector',
    story:
      'Wide petals catch the morning dew; a drip system routes it ' +
      'down to the vault. A well-placed collector earns sugar ' +
      'while you sleep.',
    power:
      '+8 sugar/second while the base is online. Cluster them ' +
      'behind walls so raiders have to work for every drop.',
  },
  MushroomTurret: {
    kind: 'MushroomTurret',
    name: 'Mushroom Turret',
    role: 'Ranged defense',
    faction: 'Ants',
    spriteKey: 'building-MushroomTurret',
    story:
      'A bioengineered puff-cap, pressurized to spit spore darts ' +
      'at anything on a pheromone trail. Thank the alchemist ' +
      'worker who bred the original strain.',
    power:
      'Medium range, medium damage. Every attacker walks past at ' +
      'least one — layout them to overlap fire arcs.',
  },
  LeafWall: {
    kind: 'LeafWall',
    name: 'Leaf Wall',
    role: 'Cheap blocker',
    faction: 'Ants',
    spriteKey: 'building-LeafWall',
    story:
      'Tightly folded chlorophyll armor. Easy to weave, easy to ' +
      'replace. A wall is rarely the last line — just the first ' +
      'hurdle.',
    power:
      'Low HP. Use to funnel attackers into turret kill-zones, ' +
      'not as an endgame barrier.',
  },
  PebbleBunker: {
    kind: 'PebbleBunker',
    name: 'Pebble Bunker',
    role: 'Heavy blocker',
    faction: 'Ants',
    spriteKey: 'building-PebbleBunker',
    story:
      'Hauled from the creek bed by generations of workers. A ' +
      'pebble bunker is meant to outlast the colony that built it.',
    power:
      'High HP. Slows down bomb beetles and diggers long enough ' +
      'that a turret can finish them.',
  },
  LarvaNursery: {
    kind: 'LarvaNursery',
    name: 'Larva Nursery',
    role: 'Underground income',
    faction: 'Ants',
    spriteKey: 'building-LarvaNursery',
    story:
      'Warm, humid, softly glowing. New ants hatch here by the ' +
      'hundred; the colony loses raid loot, not future workers.',
    power:
      '+3 leaf-bits/second while the base is online. Must sit on ' +
      'the underground layer.',
  },
  SugarVault: {
    kind: 'SugarVault',
    name: 'Sugar Vault',
    role: 'Storage cap',
    faction: 'Ants',
    spriteKey: 'building-SugarVault',
    story:
      "Sweet, heavy, the colony's stored wealth. A raid's worth " +
      'of sugar sits locked inside — the deeper the vault, the ' +
      'thicker the armor.',
    power:
      'Caps how much sugar the base can hold. Upgrade to survive ' +
      'long offline stretches without overflow.',
  },
  TunnelJunction: {
    kind: 'TunnelJunction',
    name: 'Tunnel Junction',
    role: 'Layer connector',
    faction: 'Ants',
    spriteKey: 'building-TunnelJunction',
    story:
      'Where surface and underground meet. Workers pass freely in ' +
      'peacetime; in a raid, dirt diggers use it to flank upward ' +
      'or reinforce a collapsing front.',
    power:
      'Lets units switch layers instantly. Place at least one per ' +
      'base or your underground troops are stranded.',
  },
  DungeonTrap: {
    kind: 'DungeonTrap',
    name: 'Dungeon Trap',
    role: 'One-shot surprise',
    faction: 'Ants',
    spriteKey: 'building-DungeonTrap',
    story:
      'A sprung plate covering a hollow shaft, laced with dart ' +
      'vines. Every raider thinks they know the base layout. Every ' +
      'raider is wrong once.',
    power:
      'Fires one spike volley the first time a unit crosses it, ' +
      'then consumes itself. High burst damage; position near ' +
      'the queen chamber for a last-ditch surprise.',
  },
  AcidSpitter: {
    kind: 'AcidSpitter',
    name: 'Acid Spitter',
    role: 'Splash mortar',
    faction: 'Ants',
    spriteKey: 'building-AcidSpitter',
    story:
      'A pitcher plant trained to aim. Spits a long arc of caustic ' +
      'nectar that turns a tight line of raiders into a wet smoke.',
    power:
      'Long range, slow reload, splash damage. Devastating against ' +
      'clumped swarms; wasted on a single fast unit.',
  },
  SporeTower: {
    kind: 'SporeTower',
    name: 'Spore Tower',
    role: 'Anti-air',
    faction: 'Ants',
    spriteKey: 'building-SporeTower',
    story:
      'A mushroom grown to cough. The cloud it throws clots in a ' +
      'flyer\'s wings faster than they can clear it.',
    power:
      'Only targets flying units. Hard-counters Wasp and Dragonfly ' +
      'swarms. Ignored by ground attackers.',
  },
  RootSnare: {
    kind: 'RootSnare',
    name: 'Root Snare',
    role: 'One-shot trap',
    faction: 'Ants',
    spriteKey: 'building-RootSnare',
    story:
      'A noose of living root coiled under a leaf. Springs the ' +
      'first foot that steps on it, then wilts.',
    power:
      'Fires once: damage + roots the target in place for two ' +
      'seconds. Great for freezing a champion mid-push.',
  },
  HiddenStinger: {
    kind: 'HiddenStinger',
    name: 'Hidden Stinger',
    role: 'Cloaked ambush',
    faction: 'Ants',
    spriteKey: 'building-HiddenStinger',
    story:
      'A buried wasp nest with a rigged lid. The raid force never ' +
      'sees it — until the lid pops and the stingers come up.',
    power:
      'Invisible until a raider walks into range. Fast cadence once ' +
      'revealed; keeps firing until destroyed.',
  },
  SpiderNest: {
    kind: 'SpiderNest',
    name: 'Spider Nest',
    role: 'Defender spawner',
    faction: 'Spiders',
    spriteKey: 'building-SpiderNest',
    story:
      'The spiders don\'t take orders. They take rent. And when the ' +
      'queen\'s walls shake, they crawl up from their cocoon to pay it.',
    power:
      'Spawns Nest Spiders every few seconds during a raid. Up to ' +
      'three defenders alive at once — pull them in with fodder.',
  },
  ThornHedge: {
    kind: 'ThornHedge',
    name: 'Thorn Hedge',
    role: 'Reinforced wall',
    faction: 'Ants',
    spriteKey: 'building-ThornHedge',
    story:
      'Leaf walls that grew back barbed. What the first raid taught, ' +
      'the colony stitched into every next one.',
    power:
      'Higher HP than a Leaf Wall and lays a burn on any melee ' +
      'attacker. Gates the path; punishes the push.',
  },
  AphidFarm: {
    kind: 'AphidFarm',
    name: 'Aphid Farm',
    role: 'Premium producer',
    faction: 'Ants',
    spriteKey: 'building-AphidFarm',
    story:
      'A herd of aphids tended in the dark. Tickle their backs and ' +
      'they weep a pearl-thick milk that no rival colony can fake.',
    power:
      'Slowly mints Aphid Milk — the rare currency. Burrowed in the ' +
      'underground next to the vault; raiders who breach the tunnels ' +
      'will set this on the priority list.',
  },
};

// Stable ordering for Codex navigation. Matches the deck order in
// RaidScene so players learn the same layout twice.
export const ALL_CODEX_ENTRIES: CodexEntry[] = [
  ...(Object.values(UNIT_CODEX) as CodexEntry[]),
  ...(Object.values(BUILDING_CODEX) as CodexEntry[]),
];
