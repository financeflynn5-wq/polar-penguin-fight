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
  aimAssist: 0.55, // how much a throw leads a moving penguin under the crosshair (0 = none)
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
};

export const MITTEN_NAMES = ['Wool Mittens', 'Frost Mittens', 'Glacier Mittens', 'Aurora Mittens'];
