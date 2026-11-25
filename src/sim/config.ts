// Every gameplay number in one place, so we can tune live on stream.
export const CFG = {
  gravity: 20,
  walkSpeed: 5.0,
  plowSpeed: 2.7,
  busySpeed: 1.4, // while packing / digging / building
  chargeSpeed: 3.6, // while winding up a throw
  jumpVel: 6.6,
  slideBoost: 4.0,
  slideMaxSpeed: 19,
  slideFriction: 0.85, // m/s² on snow
  iceFriction: 0.25,
  sledAssist: 3.2, // how strongly the sled run's ice turns a slider to follow the track (per second)
  slideSteer: 1.8, // rad/s
  radius: 0.38,
  stepUp: 0.45,

  maxHealth: 3,
  regenDelay: 9,
  respawnTime: 3.5,
  spawnProtect: 2.0,

  maxCarry: 5,
  packTime: [0.62, 0.5, 0.4, 0.3], // per mitten level
  packMass: 420, // snow used per snowball
  throwSpeedMin: 25,
  throwSpeedMax: 41,
  throwChargeTime: 0.7,
  throwCooldown: 0.28,
  throwPerLevel: 0.07,
  snowballGravity: 9.5, // lower = flatter throws
  hitRadius: 0.5, // how close a snowball has to pass to count as a hit
  aimAssist: 0.2, // how much a throw leads a moving penguin under the crosshair (0 = none)
  snowballRadius: 0.13,

  reach: 4.2, // dig / build reach
  digRate: 2700, // snow units per second
  buildRate: 3600,
  buildRadius: 0.9, // size of the lump of snow each build tick adds
  buildBaseRun: 0.8, // a pile needs snow this far out to every side ...
  buildBaseRise: 1.35, // ... this far below its top, or new snow slumps down the sides
  buildHard: 150,
  rateBonusPerLevel: 0.25,

  surfSpeedMult: 1.55,
  surfAccel: 9,
  surfMaxSpeed: 13,
  boardSpawnDelay: 20, // seconds into the fight before the surfboard pops up

  stockRadius: 2.6,
  startPile: 6,
  useHoldTime: 0.35,

  bigBallStartRadius: 1.05,
  bigBallMaxRadius: 2.6,
  ballStartMass: 1150, // snow scooped to start your own giant snowball (2040 = one cubic metre)
  ballGrowth: 420, // snow picked up per metre rolled, per metre of radius
  ballMakeCooldown: 2.5,
  maxMadeBalls: 8, // how many player-made balls can exist on top of the map's own
  maxBigBalls: 6,
  bigBallRespawn: 22,

  flakeActive: 3,
  flakeRespawn: 12,
  maxMitten: 3,

  buildPhase: 60,
  fightPhase: 300,
  scoreToWin: 25,

  // snowman turrets
  turretCost: 8200, // snow to build one (2040 = one cubic metre, so about 4 cubic metres)
  turretRate: 2500, // snow scooped per second while holding T
  turretHealth: 4, // snowball hits to knock one down
  turretAmmo: 24, // snowballs it starts with
  turretAmmoMax: 36,
  turretAmmoPerBall: 3, // shots you load per snowball you hand it
  turretRange: 25,
  turretFireEvery: 1.3,
  turretThrowSpeed: 30,
  turretTurn: 2.6, // rad/s
  turretSpread: 0.035, // aim error per metre to the target
  turretRadius: 0.6,
  turretHeight: 1.9,
  maxTeamTurrets: 4,

  // splat streak rewards (Team Deathmatch only)
  streakAt: [3, 5, 7], // splats in one life for Snowball Frenzy, Insta-Turret, Avalanche
  frenzyTime: 10,
  frenzyCooldown: 0.13,
  avalancheBalls: 34,
  avalancheTime: 3.6,
  avalancheRadius: 5.5,
  avalancheDelay: 1.3,
  avalancheRange: 75,

  // polar bear charge (Shift)
  rushSpeed: 12.5,
  rushTime: 1.15, // seconds a charge lasts
  rushCooldown: 7, // seconds after a charge before the next
  rushSteer: 1.5, // how fast a charge can be turned, rad/s
  rushDamage: 2, // hits an enemy takes from being bowled over
  rushSmash: 7500, // snow one charge can burst through before it stalls (2040 = one cubic metre)

  // Conquest
  conquestBuildPhase: 45,
  conquestFightPhase: 480,
  conquestScore: 250, // first team to this many flag points wins
  conquestRate: 0.5, // points per second for every flag you hold
  captureTime: 7, // seconds for one penguin to take a neutral flag
  captureCrowd: 3, // more penguins than this on a flag don't speed it up further

  // Breakthrough (Team Blizzard attacks, Team Sunrise defends)
  btBuildPhase: 45, // the defenders dig in at the first section
  btFightPhase: 1200, // the attackers have this long in all
  btTickets: 8, // attackers' tickets at the start, per penguin on the team (each attacker who goes down costs one)
  btSectorTickets: 5, // tickets the attackers get back for taking a section, per penguin on the team
  btCaptureTime: 5, // an objective goes from all theirs to all yours in twice this long with one penguin on it, faster with more
  btRetake: 0.4, // how fast the defenders win an objective back, next to how fast the attackers take it
  btRegroup: 20, // seconds the attackers wait after a section falls
  btLastStand: 60, // seconds the attackers have once their tickets are gone
  btRespawn: [3.5, 5], // seconds down: attackers, defenders
};

export const REWARD_NAMES = ['Snowball Frenzy', 'Insta-Turret', 'Avalanche'];

export const MITTEN_NAMES = ['Wool Mittens', 'Frost Mittens', 'Glacier Mittens', 'Aurora Mittens'];
