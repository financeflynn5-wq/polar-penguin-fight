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
  slideBrake: 7, // m/s² while you push back against a slide
  rampKick: 1.15, // how much of your speed up a jump ramp turns into height at the lip (1 = what the ramp's shape gives)
  rampBoost: 2.5, // m/s a belly slide (or the surfboard) gains off the lip of a jump ramp
  rampMinSpeed: 2.5, // slower than this and you just drop off the end
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

  // vehicles: tap E beside one to hop on, E again to hop off. W/S drive, A/D steer.
  // (the driving numbers for each kind are in VEHICLE_SPECS in src/sim/Vehicles.ts)
  snowmobilesPer5: 1, // snowmobiles parked at each team's camp for every 5 penguins on the team
  snowmobileHealth: 5, // snowball hits to wreck one (the riders are out in the open and get hit like anyone else)
  snowmobileRespawn: 20, // seconds until a wrecked one is back at camp
  snowmobileRam: 9, // m/s: run into an enemy faster than this and it knocks them flying
  snowmobileRamDamage: 2,
  plowHealth: 3.5, // snowball hits to wreck the snowplow, for each penguin on a team (its driver is safe inside until then)
  plowBallDamage: 7, // what a rolling giant snowball does to it
  plowFirst: 30, // Breakthrough: seconds into the fight before the attackers' first snowplow turns up
  plowEvery: 90, // ... and seconds after one is wrecked before the next
  plowRam: 2.2, // m/s: the blade flattens any enemy it reaches faster than this
  plowBotWait: 6, // seconds a fresh snowplow waits for a person before a bot may take it
  vehicleIdleHome: 30, // an empty vehicle left out in the field goes back to camp after this long
  // the snow tank: one at each camp in every mode. The driver works a snowball machine gun, and a second rider
  // standing on the back works the snowball catapult (see src/sim/Tank.ts)
  tanksPerTeam: 1,
  tankFirst: 0, // seconds into the match before the tanks are at camp
  tankHealth: 16, // snowball hits to wreck one (both riders are out in the open)
  tankRespawn: 45, // seconds until a wrecked one is back at camp
  tankGunRate: 8, // machine-gun snowballs a second
  tankGunSpeed: 36, // m/s
  tankGunSpread: 0.03, // rad of scatter either way
  tankGunDamage: 0.5, // hearts a machine-gun snowball takes (so two hits = one heart)
  tankGunShots: 20, // shots in a row before the gun overheats and jams
  tankGunCool: 3, // seconds for a red-hot gun to cool right down
  tankGunUnjam: 0.35, // a jammed gun fires again once it has cooled to this
  tankTurretTurn: 4.5, // rad/s
  catTurn: 2.4, // rad/s the catapult's turntable turns
  catReload: 4.5, // seconds to wind the arm back and load the next ball
  catAngle: 0.87, // rad: how steeply it lobs (about 50°)
  catMinRange: 8, catMaxRange: 60, // metres
  catMinSpeed: 9, catMaxSpeed: 27,
  catBallRadius: 0.42,
  catDamage: 3, // hearts for a direct hit (a fresh penguin is splatted)
  catSplash: 3.6, // metres: everyone on the other side this close to where it lands...
  catSplashDamage: 2, // ...takes this many hearts (unless there's snow between them and the blast)
  catCrater: 1.9, // metres: the hole it knocks in a wall
  catCraterMass: 7000, // snow it can knock out (2040 = one cubic metre)
  catVehicleDamage: 4, // hits a direct hit takes off a vehicle (and half that for one in the splash)

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
  btRespawn: [3.5, 6.5], // seconds down: attackers, defenders (who also come back further from the fight: Front.respawns)

  // guns: picked up from the gun pads on each team's side (cocoa to the north, the blade in the middle, water to the south), one at a time
  gunRespawn: 40, // seconds before a pad makes another gun (5v5; bigger teams get them faster)
  gunFirst: 6, // seconds into the fight before the first guns show up
  gunDropLife: 20, // a gun dropped by a splatted penguin lies there this long
  gunMoveSpeed: 3.6, // walking speed while spraying
  // the Hot Chocolate Blaster: a short hot stream that melts snow (walls!), snowman turrets and, slowly, penguins
  cocoaAmmo: 80, // squirts in a full tank
  cocoaRate: 13, // squirts per second
  cocoaSpeed: 21,
  cocoaGravity: 14,
  cocoaLife: 0.75, // seconds a squirt flies: with the speed, that's about 15 m of reach
  cocoaSpread: 0.035,
  cocoaMelt: 330, // snow melted per squirt (2040 = one cubic metre): a full tank is about 13 cubic metres of wall
  cocoaMeltRadius: 0.6,
  cocoaHitsPerHeart: 9, // squirts on a penguin for one heart
  cocoaHitsPerTurret: 6, // squirts on a snowman for one of its hit points
  heatFade: 0.3, // how fast a scalded penguin cools off, per second
  // the Freeze Soaker: soaked penguins stiffen up and slow down; a miss freezes a slippery patch on the snow
  waterAmmo: 24,
  waterRate: 4,
  waterSpeed: 34,
  waterGravity: 9.5,
  waterLife: 0.8, // about 26 m of reach
  waterSpread: 0.01,
  chillPerHit: 0.25, // four hits and you're frozen stiff
  chillSlow: 0.5, // how much of your speed you lose when frozen stiff
  chillHold: 2, // seconds before the chill starts to wear off
  chillFade: 0.35, // ... and how fast it does, per second
  patchRadius: 1.5,
  patchMaxRadius: 2.6,
  patchLife: 16,
  maxPatches: 24,
  slipTime: 0.9, // seconds on your belly after stepping on an ice patch
  slipAgain: 2.2, // seconds before you can slip again
  slipSpeed: 2.2, // slower than this and you keep your feet
  // the Candy Cane Blade: a sword you swing up close. It turns up on the middle gun pad of each team's side
  bladeSwings: 14, // swings before the candy cane snaps
  bladeCooldown: 0.5, // seconds between swings
  bladeReach: 2.3, // metres from you to the far end of a swing
  bladeArc: 1.0, // how wide a swing is: radians to either side of where you look
  bladeDamage: 2, // hearts a hit takes (penguins have 3), so two whacks splat a fresh penguin
  bladeKnock: 7, // m/s a hit shoves a penguin back (about a metre and a half)
  bladeBlockTime: 0.3, // seconds after a swing starts in which it smashes enemy snowballs flying at you
  bladeCut: 600, // snow a swing chops out of a wall in front of you (2040 = one cubic metre)
};

export const GUN_NAMES = ['', 'Hot Chocolate Blaster', 'Freeze Soaker', 'Candy Cane Blade'];

export const REWARD_NAMES = ['Snowball Frenzy', 'Insta-Turret', 'Avalanche'];

export const MITTEN_NAMES = ['Wool Mittens', 'Frost Mittens', 'Glacier Mittens', 'Aurora Mittens'];
