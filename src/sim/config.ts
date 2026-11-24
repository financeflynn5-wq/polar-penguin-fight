// Every gameplay number in one place, so we can tune live on stream.
export const CFG = {
  gravity: 20,
  walkSpeed: 5.0,
  plowSpeed: 2.7,
  busySpeed: 1.4, // while packing / digging / building
  chargeSpeed: 3.6, // while winding up a throw
  jumpVel: 6.6,
  slideBoost: 4.0,
  slideMaxSpeed: 15,
  slideFriction: 1.1, // m/s² on snow
  iceFriction: 0.25,
  slideSteer: 1.8, // rad/s
  radius: 0.38,
  stepUp: 0.45,

  maxHealth: 3,
  regenDelay: 9,
  respawnTime: 3.5,
  spawnProtect: 2.0,

  maxCarry: 5,
  packTime: [0.8, 0.62, 0.48, 0.36], // per mitten level
  packMass: 420, // snow used per snowball
  throwSpeedMin: 20,
  throwSpeedMax: 32,
  throwChargeTime: 0.7,
  throwCooldown: 0.28,
  throwPerLevel: 0.07,
  snowballGravity: 13,
  snowballRadius: 0.13,

  reach: 4.2, // dig / build reach
  digRate: 2700, // snow units per second
  buildRate: 2300,
  buildHard: 150,
  rateBonusPerLevel: 0.25,

  stockRadius: 2.6,
  startPile: 6,
  useHoldTime: 0.35,

  bigBallStartRadius: 1.05,
  bigBallMaxRadius: 2.1,
  maxBigBalls: 6,
  bigBallRespawn: 22,

  flakeActive: 3,
  flakeRespawn: 12,
  maxMitten: 3,

  buildPhase: 30,
  fightPhase: 300,
  scoreToWin: 25,
};

export const MITTEN_NAMES = ['Wool Mittens', 'Frost Mittens', 'Glacier Mittens', 'Aurora Mittens'];
