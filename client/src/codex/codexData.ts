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

// One-line faction-wide rule, surfaced in unitInfoModal so players
// can see why a Beetle hits walls harder or a Bee waltzes past a
// trap. Mirrors the per-faction sim rules in shared/src/sim/stats.ts
// (UnitBehavior.vsWallPercent / firstHitBonusPercent and
// BuildingBehavior.groundOnly). Keep these in sync when the sim
// rules change.
export const FACTION_SIGNATURES: Record<Types.Faction, string> = {
  Ants:    'All-rounder. No special faction rule — versatile by design.',
  Beetles: '+25% damage when attacking walls (LeafWall, ThornHedge).',
  Bees:    'All Bees fly — ground traps (DungeonTrap, RootSnare) cannot catch them.',
  Spiders: '+50% damage on this unit\'s FIRST attack only. Choose the opening hit carefully.',
};

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
  HoneyBee: {
    kind: 'HoneyBee',
    name: 'Honey Bee',
    role: 'Cheap flyer',
    faction: 'Bees',
    spriteKey: 'unit-HoneyBee',
    story:
      'Spilled out of an overturned hive and now answers the colony\'s ' +
      'pheromone like any worker. Doesn\'t care about walls — flight is ' +
      'her birthright, not a tactic.',
    power:
      'Fast and cheap with flight. Bypasses walls and ground traps. ' +
      'Fragile alone — deploy in burst waves of 3-5 and let the swarm ' +
      'tide handle the queen chamber.',
  },
  HiveDrone: {
    kind: 'HiveDrone',
    name: 'Hive Drone',
    role: 'Flying tank',
    faction: 'Bees',
    spriteKey: 'unit-HiveDrone',
    story:
      'A bulkier drone bred for breaching. Slow on the wing, but a ' +
      'wall is just an obstacle she flies over with the queen\'s ' +
      'blessing humming in her thorax.',
    power:
      'Heavy HP and flight, but slow attacks and no splash. Front a ' +
      'swarm of HoneyBees behind her so the soak holds while the ' +
      'damage stacks.',
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
  LeafSilo: {
    kind: 'LeafSilo',
    name: 'Leaf Silo',
    role: 'Leaf storage',
    faction: 'Ants',
    spriteKey: 'building-LeafSilo',
    story:
      'A clay-walled underground bin packed with stripped leaf-bits. ' +
      'Workers crawl in over the lip and tamp the pile down with their ' +
      'mandibles. The colony lives or dies on what fits in here.',
    power:
      'Adds +1600 leaf cap per level. Pure storage — no production ' +
      'side-effect, just a bigger bucket so raid loot has somewhere ' +
      'to land. Fat HP makes raiders prioritise it.',
  },
  MilkPot: {
    kind: 'MilkPot',
    name: 'Milk Pot',
    role: 'Aphid Milk storage',
    faction: 'Ants',
    spriteKey: 'building-MilkPot',
    story:
      'A glazed clay vessel sealed with wax, kept at the deepest ' +
      'chamber where the warmth is steady. The first pot a colony ' +
      'fires marks the moment milk becomes wealth instead of trickle.',
    power:
      'Adds +800 milk cap per level (base 500). Until you build the ' +
      'first pot, milk has no cap — production never stops. Once the ' +
      'pot exists, the cap activates and you\'ll need more pots to ' +
      'hold a deeper milk reserve.',
  },
};

// Resource cards. Not units or buildings — these document the
// economy itself so a player who taps Codex can read "where does
// milk come from?" without digging through the tutorial. spriteKey
// reuses the HUD pill icons so the card portrait is consistent
// with what the player already sees in the corner stack.
export const RESOURCE_CODEX: Record<'sugar' | 'leaf' | 'milk', CodexEntry> = {
  sugar: {
    kind: 'sugar',
    name: 'Sugar',
    role: 'Build & upgrade currency',
    faction: 'Ants',
    spriteKey: 'ui-resource-sugar',
    story:
      'The colony runs on sugar. Workers ferry crystallised dewdrops ' +
      'from the surface chambers, where the morning collectors filter ' +
      'water sweet enough to fuel a tier-up.',
    power:
      'Earn from Dew Collectors (8/sec at L1, scales with level), ' +
      'Sugar Vaults (slow trickle), and raid loot. Spend on every ' +
      'building placement, every upgrade, and every colony tier-up. ' +
      'Capped by Sugar Vaults — production stops at the cap.',
  },
  leaf: {
    kind: 'leaf',
    name: 'Leaf Bits',
    role: 'Unit & nursery currency',
    faction: 'Ants',
    spriteKey: 'ui-resource-leaf',
    story:
      'Strip-cut from the soft inner leaves of the surrounding ' +
      'forest, leaf bits are the staple of the larval feed. Without ' +
      'them the nursery stays empty and the swarm thins.',
    power:
      'Earn from Larva Nurseries (3/sec at L1) and raid loot. Spend ' +
      'on unit upgrades and most non-Queen buildings. Capped by ' +
      'Larva Nurseries.',
  },
  milk: {
    kind: 'milk',
    name: 'Aphid Milk',
    role: 'Premium currency',
    faction: 'Ants',
    spriteKey: 'ui-resource-milk',
    story:
      'The fat-bodied aphids on the rear range secrete a thick milk ' +
      'the elder workers ferment into something that buys favours: ' +
      'time itself, or a queen who looks the part.',
    power:
      'Earn three ways. (1) Aphid Farms produce 0.2/sec/level once ' +
      'unlocked at colony 4. (2) Login-streak rewards: 1 milk on ' +
      'day 5, 2 on day 6, 5 on day 7. (3) Campaign chapter clears: ' +
      '1 milk for chapter 1, 3 for chapter 2, 5 for chapter 3. ' +
      'Spend on builder skips (1 milk per minute remaining, max 60) ' +
      'or unlock cosmetic Queen skins from the shop. Uncapped.',
  },
};

// Hero cards (PR C). Heroes are special, persistent units the
// player owns and equips into raids — distinct from regular units.
// Each card mirrors the in-game catalog (HERO_CATALOG in
// shared/types/heroes.ts) so the codex stays the canonical
// reference even when the player hasn't unlocked them yet.
export const HERO_CODEX: Record<
  'Mantis' | 'HerculesBeetle' | 'WaspQueen' | 'StagBeetle',
  CodexEntry
> = {
  Mantis: {
    kind: 'Mantis',
    name: 'Praying Mantis',
    role: 'Hero · assassin',
    faction: 'Ants',
    spriteKey: 'hero-Mantis',
    story:
      'A blade with eyes. Found a colony in distress on the eastern ' +
      'fringe and never left — folds her wings into a scarf, leans ' +
      'against the chamber wall, listens. When she moves, three ' +
      'turrets are already down.',
    power:
      'High damage, low HP. Aura grants +25% attack speed to allied ' +
      'units within 3 tiles. Best deployed alongside a tank so the ' +
      'aura sticks long enough to sweep a wing.',
  },
  HerculesBeetle: {
    kind: 'HerculesBeetle',
    name: 'Hercules Beetle',
    role: 'Hero · tank',
    faction: 'Ants',
    spriteKey: 'hero-HerculesBeetle',
    story:
      'A walking siege engine. Carapace older than most colonies; ' +
      'turret splash buffs its breastplate, doesn\'t scratch it. ' +
      'Plants himself in the breach and the swarm files past him.',
    power:
      'Massive HP, modest damage. Aura grants +30% max HP to ' +
      'allied units within 3 tiles, applied as a flat overshield ' +
      'when they enter range.',
  },
  WaspQueen: {
    kind: 'WaspQueen',
    name: 'Wasp Queen',
    role: 'Hero · support flyer',
    faction: 'Ants',
    spriteKey: 'hero-WaspQueen',
    story:
      'Defected from a rival hive after the elders refused to back ' +
      'her run on a mortar nest. Now she trades sting for nectar — ' +
      'follows the swarm, drips honey on every wound.',
    power:
      'Flying. Heals allied units in a 3-tile radius for 10 HP/sec. ' +
      'Frail (600 HP) — keep her on the back line and let melee ' +
      'heroes draw fire.',
  },
  StagBeetle: {
    kind: 'StagBeetle',
    name: 'Stag Beetle',
    role: 'Hero · siege',
    faction: 'Ants',
    spriteKey: 'hero-StagBeetle',
    story:
      'Big horns, bigger problem if you\'re a wall. Old enough to ' +
      'remember the queens who first drew the boundary line, and ' +
      'spends his retirement re-drawing it.',
    power:
      'Hits buildings hard. Aura grants +20% building damage to ' +
      'allied units within 3 tiles. Stack with cheap workers for a ' +
      'controlled wave that chews through walls.',
  },
};

// Stable ordering for Codex navigation. Matches the deck order in
// RaidScene so players learn the same layout twice. Resource cards
// sit at the front so a confused player who opens the codex sees
// the economy explainer first; heroes follow as the next layer up
// from regular units.
export const ALL_CODEX_ENTRIES: CodexEntry[] = [
  ...(Object.values(RESOURCE_CODEX) as CodexEntry[]),
  ...(Object.values(HERO_CODEX) as CodexEntry[]),
  ...(Object.values(UNIT_CODEX) as CodexEntry[]),
  ...(Object.values(BUILDING_CODEX) as CodexEntry[]),
];
