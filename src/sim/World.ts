// The game simulation: penguins, snowballs, big rolling snowballs, snowflakes, stockpiles, snowman turrets,
// Conquest flags, Breakthrough sections, splat-streak rewards and the match.
// No Three.js and no DOM, so the game server can run this exact code later.
import { SnowField, ISO } from '../world/SnowField';
import { MapDef, V3, Front, mulberry32 } from '../world/MapDef';
import type { Mode } from '../world/Maps';
import { CFG } from './config';
import { boxGround, boxPush, pointInBoxes, slideY } from '../world/Playground';

export type { Mode };

export interface PenguinInput {
  moveX: number; // strafe (-1 left .. 1 right)
  moveZ: number; // forward (1) / back (-1)
  yaw: number; pitch: number; // where the penguin is looking
  jump: boolean; // edge: consumed by the sim
  slide: boolean; // held
  fire: boolean; // held: charge, release: throw
  plow: boolean; // held
  pack: boolean; // held
  dig: boolean; // held
  build: boolean; // held
  use: boolean; // held: tap = grab, hold = stash
  roll: boolean; // held: scoop up a new giant snowball in front of you
  turret: boolean; // held: scoop snow into a snowman turret at the aim point
  reward: number; // edge, consumed by the sim: 1..3 = use that splat-streak reward
  aim: V3 | null; // point under the crosshair
}

export const emptyInput = (): PenguinInput => ({
  moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, slide: false, fire: false,
  plow: false, pack: false, dig: false, build: false, use: false, roll: false, turret: false, reward: 0, aim: null,
});

export type Action = 'idle' | 'plow' | 'pack' | 'dig' | 'build' | 'charge' | 'throw' | 'slide' | 'down';
export type Phase = 'build' | 'fight' | 'end';
export type SplatCause = 'snowball' | 'bigball' | 'turret' | 'avalanche';

export type GameEvent =
  | { type: 'plow'; pid: number; x: number; y: number; z: number; fx: number; fz: number; mass: number }
  | { type: 'dig'; pid: number; x: number; y: number; z: number; tx: number; ty: number; tz: number; mass: number }
  | { type: 'build'; pid: number; x: number; y: number; z: number; tx: number; ty: number; tz: number; mass: number }
  | { type: 'packTick'; pid: number; x: number; y: number; z: number }
  | { type: 'packDone'; pid: number; count: number }
  | { type: 'noSnow'; pid: number }
  | { type: 'throw'; pid: number; x: number; y: number; z: number; power: number }
  | { type: 'snowHit'; x: number; y: number; z: number; nx: number; ny: number; nz: number }
  | { type: 'hit'; pid: number; by: number; x: number; y: number; z: number; health: number }
  | { type: 'splat'; pid: number; by: number; x: number; y: number; z: number; cause: SplatCause }
  | { type: 'respawn'; pid: number }
  | { type: 'grab'; pid: number; n: number; team: number; stolen: boolean }
  | { type: 'stash'; pid: number; n: number }
  | { type: 'flake'; pid: number; level: number; x: number; y: number; z: number }
  | { type: 'crush'; x: number; y: number; z: number; mass: number; r: number }
  | { type: 'bigBurst'; x: number; y: number; z: number; r: number }
  | { type: 'jump'; pid: number }
  | { type: 'slideStart'; pid: number }
  | { type: 'phase'; phase: Phase }
  | { type: 'board'; pid: number; what: 'grab' | 'drop' | 'spawn'; x: number; y: number; z: number; where?: string }
  | { type: 'launch'; pid: number }
  | { type: 'collapse'; x: number; y: number; z: number; drop: number; mass: number }
  | { type: 'ballMade'; pid: number; x: number; y: number; z: number }
  | { type: 'turretBuilt'; pid: number; tid: number; x: number; y: number; z: number; free: boolean }
  | { type: 'turretFire'; tid: number; x: number; y: number; z: number }
  | { type: 'turretHit'; tid: number; by: number; x: number; y: number; z: number; health: number }
  | { type: 'turretDown'; tid: number; team: number; owner: number; by: number; x: number; y: number; z: number }
  | { type: 'turretLoad'; pid: number; tid: number; n: number }
  | { type: 'streak'; pid: number; streak: number; reward: number } // reward: -1, or the index it just earned
  | { type: 'reward'; pid: number; reward: number; x: number; y: number; z: number }
  | { type: 'rewardFail'; pid: number }
  | { type: 'capture'; point: number; team: number; from: number } // `team` took the flag
  | { type: 'neutral'; point: number; team: number } // `team` lost the flag
  | { type: 'sector'; sector: number; tickets: number } // Breakthrough: the attackers took this section (tickets = what they got for it)
  | { type: 'sectorOpen'; sector: number } // Breakthrough: the regroup is over, this section is on
  | { type: 'lastStand' } // Breakthrough: the attackers are out of tickets
  | { type: 'gameOver'; winner: number };

export class Penguin {
  // previous position for render interpolation
  px = 0; py = 0; pz = 0;
  x = 0; y = 0; z = 0;
  vx = 0; vy = 0; vz = 0;
  yaw = 0; lookYaw = 0; lookPitch = 0;
  grounded = false;
  sliding = false;
  slideSlowT = 0;
  onIce = false;
  alive = true;
  downT = 0;
  invuln = 0;
  health = CFG.maxHealth;
  sinceHit = 99;
  carried = 0;
  packProgress = 0;
  charge = 0;
  charging = false;
  throwCd = 0;
  throwAnim = 0;
  action: Action = 'idle';
  mitten = 0;
  useT = -1;
  useDone = false;
  splats = 0;
  downs = 0;
  plowLoad = 0;
  digSide = 0;
  noSnowT = 0;
  lastHitBy = -1;
  input: PenguinInput = emptyInput();
  aimOk = false; // whether the aim point is within dig/build reach
  surfing = false;
  onSlide = false;
  onProp = false;
  rollCd = 0;
  /** why building isn't working right now: 0 = fine, 1 = too tall to reach, 2 = nothing to build on */
  buildBlock = 0;
  /** the new snow is sliding down the sides because the pile is too thin to go higher */
  slumping = false;
  /** splats since this penguin last went down (Team Deathmatch streak rewards) */
  streak = 0;
  /** rewards earned and not used yet: [Snowball Frenzy, Insta-Turret, Avalanche] */
  rewards = [0, 0, 0];
  /** Snowball Frenzy time left: unlimited snowballs and rapid throws */
  frenzyT = 0;
  /** snow scooped so far toward the turret this penguin is building, and where it will stand */
  turretSnow = 0;
  turretAt: V3 | null = null;
  /** why the turret isn't going up: 0 fine, 1 aim closer, 2 can't stand there, 3 too close to another, 4 the team has enough */
  turretBlock = 0;
  /** where this penguin last went down (Conquest brings you back at the nearest flag you hold) */
  downX = 0; downZ = 0;
  /** looks only: which penguin model this player picked (bots wear the default) */
  skin: Skin = DEFAULT_SKIN;

  constructor(public id: number, public name: string, public team: number, public hat: string, public bot: boolean) {}
}

export interface Snowball {
  id: number; owner: number; team: number;
  x: number; y: number; z: number; px: number; py: number; pz: number;
  vx: number; vy: number; vz: number; age: number; alive: boolean;
  /** 0 = thrown by a penguin, 1 = thrown by a turret, 2 = fell out of an Avalanche */
  kind: number;
}

export interface BigBall {
  id: number;
  x: number; y: number; z: number; px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  r: number; alive: boolean;
  grounded: boolean;
  lastPusher: number; pushT: number;
  restT: number;
  // render spin (axis-angle accumulated by renderer from velocity)
}

export interface Flake { id: number; spot: number; x: number; y: number; z: number; active: boolean; t: number; }

export interface Surfboard { x: number; y: number; z: number; vy: number; holder: number; active: boolean; yaw: number; }

/** A snowman turret: throws snowballs at enemies it can see until it runs out or gets knocked down. */
export interface Turret {
  id: number; owner: number; team: number;
  x: number; y: number; z: number;
  yaw: number; // where it's looking
  health: number; ammo: number;
  cd: number; // seconds until it can throw again
  target: number; // penguin id, or -1
  scanT: number;
  fireT: number; // counts down after each throw (for the arm swing)
  age: number;
  alive: boolean;
}

/** A Conquest flag. cap runs from -1 (all Team Blizzard) to +1 (all Team Sunrise). */
export interface CapturePoint {
  id: number; name: string; x: number; y: number; z: number; r: number;
  owner: number; cap: number;
  n0: number; n1: number; // penguins of each team standing on it right now
}

/** An Avalanche on its way: after `wait`, `left` snowballs rain down around the spot. */
export interface Barrage { owner: number; team: number; x: number; y: number; z: number; wait: number; left: number; acc: number; }

/** Who is in the match, as the server tells an online client. */
export interface RosterEntry { id: number; name: string; team: number; hat: string; bot: boolean; skin?: Skin; }

export interface MatchOptions {
  teamSize: number; playerName: string; playerHat: string; mode?: Mode;
  /** which penguin model the player wears (looks only) */
  playerSkin?: Skin;
  /** server: every slot starts as a bot, and humans take bots' places as they join */
  allBots?: boolean;
  /** online client: build the penguins from the server's roster (the server runs the match, this world only mirrors it) */
  roster?: RosterEntry[];
  /** online client: which roster entry is you */
  meId?: number;
  /** playing alone: the team you're on (Breakthrough: 0 attacks, 1 defends) */
  playerTeam?: number;
}

/** Breakthrough: Team Blizzard attacks, Team Sunrise defends. */
export const ATTACK = 0, DEFEND = 1;

const BOT_NAMES = ['Waddles', 'Sir Flaps', 'Pebble', 'Captain Ice', 'Nugget', 'Biscuit', 'Frosty', 'Wobbles', 'Sleet', 'Mittens',
  'Slushie', 'Tux', 'Puddles', 'Blizzard Bob', 'Chilly Willy Jr', 'Flipper', 'Snowcone', 'Sprinkles', 'Popsicle', 'Gizmo',
  'Noot', 'Pickle', 'Muffin', 'Dumpling', 'Squawk', 'Iceberg', 'Kevin', 'Frostbite', 'Bubbles', 'Toast'];
/**
 * Penguin skins, looks only. 'new' is the Blender-built penguin and hats (PenguinModel.ts); 'classic' is the original
 * hand-built penguin and hats from before the remake (ClassicPenguinModel.ts).
 */
export const SKINS = ['new', 'classic'] as const;
export type Skin = typeof SKINS[number];
export const DEFAULT_SKIN: Skin = 'new';
export const asSkin = (v: unknown): Skin => (SKINS as readonly unknown[]).includes(v) ? v as Skin : DEFAULT_SKIN;
export const HATS = ['none', 'beanie', 'tophat', 'propeller', 'viking', 'crown', 'fish', 'party', 'chef', 'cone'];

const tmpN = { x: 0, y: 0, z: 0 };
const pushTmp = { x: 0, z: 0 };
const plowOut = { mass: 0, cx: 0, cy: 0, cz: 0 };

export class World {
  readonly field: SnowField;
  penguins: Penguin[] = [];
  snowballs: Snowball[] = [];
  bigBalls: BigBall[] = [];
  flakes: Flake[] = [];
  board: Surfboard = { x: 0, y: -50, z: 0, vy: 0, holder: -1, active: false, yaw: 0 };
  piles = [CFG.startPile, CFG.startPile];
  scores = [0, 0];
  phase: Phase = 'build';
  phaseT = CFG.buildPhase;
  readonly mode: Mode;
  turrets: Turret[] = [];
  points: CapturePoint[] = [];
  barrages: Barrage[] = [];
  readonly scoreToWin: number;
  readonly buildLen: number;
  readonly fightLen: number;
  private capAcc = [0, 0];
  /** Breakthrough: the section being fought over */
  sector = 0;
  /** Breakthrough: seconds of regroup left after a section falls (the attackers wait behind the next line) */
  holdT = 0;
  /** Breakthrough: seconds the attackers have left once their tickets are gone (-1 = they still have tickets) */
  lastStandT = -1;
  time = 0;
  events: GameEvent[] = [];
  winner = -1;
  private nextId = 1;
  private bigBallTimer = 0;
  private rand = mulberry32(Date.now() & 0xffff);
  private botNames: string[] = [];
  readonly playerId: number;
  /** online client: only step your own penguin's movement; the server does the snow, throws, pickups and respawns */
  private predicting = false;

  constructor(readonly map: MapDef, readonly opts: MatchOptions) {
    this.field = map.field;
    this.mode = opts.mode ?? 'tdm';
    const conquest = this.mode === 'conquest', bt = this.mode === 'breakthrough';
    this.scoreToWin = conquest ? CFG.conquestScore : CFG.scoreToWin;
    this.buildLen = bt ? CFG.btBuildPhase : conquest ? CFG.conquestBuildPhase : CFG.buildPhase;
    this.fightLen = bt ? CFG.btFightPhase : conquest ? CFG.conquestFightPhase : CFG.fightPhase;
    this.phaseT = this.buildLen;
    // Breakthrough keeps score its own way: the attackers' tickets, and the sections the defenders still hold
    if (bt) this.scores = [Math.round(CFG.btTickets * opts.teamSize), map.sectors.length];
    if (conquest || bt) this.points = map.points.map((d, id) => ({ id, name: d.name, x: d.x, y: d.y, z: d.z, r: d.r, owner: d.owner, cap: d.owner < 0 ? 0 : d.owner === 0 ? -1 : 1, n0: 0, n1: 0 }));
    if (opts.roster) {
      // an online client's mirror of the server's match: you first, then everyone else
      const me = opts.roster.find(r => r.id === opts.meId) ?? opts.roster[0];
      for (const r of [me, ...opts.roster.filter(r => r !== me)]) {
        const p = new Penguin(r.id, r.name, r.team, r.hat, r.bot);
        p.skin = asSkin(r.skin);
        this.penguins.push(p);
      }
      this.playerId = me.id;
      this.nextId = Math.max(0, ...opts.roster.map(r => r.id)) + 1;
      return;
    }
    // teams: the player on their team (Team Blizzard unless they asked for the other one), bots fill the rest
    const names = [...BOT_NAMES].sort(() => this.rand() - 0.5);
    this.botNames = names;
    const mine = opts.playerTeam === 1 ? 1 : 0;
    const player = opts.allBots
      ? new Penguin(this.nextId++, names[names.length - 1], mine, HATS[1 + Math.floor(this.rand() * (HATS.length - 1))], true)
      : new Penguin(this.nextId++, opts.playerName || 'You', mine, opts.playerHat, false);
    if (!opts.allBots) player.skin = asSkin(opts.playerSkin);
    this.penguins.push(player);
    this.playerId = player.id;
    let n = 0;
    for (let team = 0; team < 2; team++) {
      const count = team === mine ? opts.teamSize - 1 : opts.teamSize;
      for (let c = 0; c < count; c++) {
        const hat = HATS[1 + Math.floor(this.rand() * (HATS.length - 1))];
        this.penguins.push(new Penguin(this.nextId++, names[n++ % names.length], team, hat, true));
      }
    }
    this.penguins.forEach((p, i) => this.spawn(p, i));
    for (let s = 0; s < 4; s++) this.spawnBigBall(s);
    for (let f = 0; f < CFG.flakeActive; f++) this.spawnFlake();
  }

  get player() { return this.penguins[0]; }
  penguin(id: number) { return this.penguins.find(p => p.id === id); }
  emit(e: GameEvent) { this.events.push(e); }

  roster(): RosterEntry[] { return this.penguins.map(p => ({ id: p.id, name: p.name, team: p.team, hat: p.hat, bot: p.bot, skin: p.skin })); }

  /**
   * Server: a person joins and takes a bot's place on the team with fewer people (or the team they ask for, if it has room).
   * Returns null when every slot already has a person in it.
   */
  addHuman(name: string, hat: string, wantTeam = -1, skin: Skin = DEFAULT_SKIN): Penguin | null {
    const humans = [0, 0];
    for (const p of this.penguins) if (!p.bot) humans[p.team]++;
    const open = (t: number) => this.penguins.some(p => p.bot && p.team === t);
    let team = wantTeam === 0 || wantTeam === 1 ? wantTeam : -1;
    if (team < 0 || !open(team)) team = !open(0) ? 1 : !open(1) ? 0 : humans[0] < humans[1] ? 0 : humans[1] < humans[0] ? 1 : this.scores[0] <= this.scores[1] ? 0 : 1;
    if (!open(team)) return null;
    // take the bot that's least busy: dead, or the one furthest from the action
    const bots = this.penguins.filter(p => p.bot && p.team === team);
    const home = this.front(team).center;
    bots.sort((a, b) => (a.alive ? 1 : 0) - (b.alive ? 1 : 0) || Math.hypot(a.x - home.x, a.z - home.z) - Math.hypot(b.x - home.x, b.z - home.z));
    const p = bots[0];
    if (this.board.holder === p.id) { this.board.holder = -1; this.board.x = p.x; this.board.y = p.y + 0.6; this.board.z = p.z; this.board.vy = 4; p.surfing = false; }
    p.bot = false; p.name = name; p.hat = hat; p.skin = asSkin(skin);
    p.splats = 0; p.downs = 0; p.mitten = 0;
    p.streak = 0; p.rewards = [0, 0, 0]; p.frenzyT = 0; p.turretSnow = 0; p.turretAt = null; p.turretBlock = 0;
    p.input = emptyInput();
    this.spawn(p);
    return p;
  }

  /** Server: a person left; a bot takes over their penguin. */
  removeHuman(id: number) {
    const p = this.penguin(id);
    if (!p || p.bot) return;
    const used = new Set(this.penguins.map(q => q.name));
    p.bot = true;
    p.skin = DEFAULT_SKIN;
    p.name = this.botNames.find(n => !used.has(n)) ?? BOT_NAMES[Math.floor(this.rand() * BOT_NAMES.length)];
    p.input = emptyInput();
  }

  /** Online client: step just your own penguin's movement ahead of the server, with no side effects on the match. */
  predictPenguin(p: Penguin, dt: number) {
    p.px = p.x; p.py = p.y; p.pz = p.z;
    this.predicting = true;
    try { this.stepPenguin(p, dt); } finally { this.predicting = false; }
  }

  /** Where a team lives right now: its spawn line and its stockpiles. In Breakthrough that moves up the map with the fight. */
  front(team: number): Front {
    return this.mode === 'breakthrough' ? this.map.sectors[this.sector].fronts[team] : this.map.bases[team];
  }

  /** Breakthrough: the objectives that can be taken right now (ids into `points`). */
  activePoints(): number[] { return this.mode === 'breakthrough' ? this.map.sectors[this.sector].points : this.points.map(p => p.id); }

  /**
   * The line nobody may cross yet, or null. In the build phase it keeps the teams apart; in Breakthrough it also holds
   * the attackers back for a moment after a section falls, while the defenders dig in at the next one.
   */
  holdLine(): number | null {
    if (this.mode === 'breakthrough') return this.phase === 'build' || (this.phase === 'fight' && this.holdT > 0) ? this.map.sectors[this.sector].lineX : null;
    return this.phase === 'build' ? this.map.midLineX : null;
  }

  /** The nearest place this team can grab and stash snowballs. */
  nearestPile(team: number, x: number, z: number): V3 {
    const list = this.front(team).stockpiles;
    let best = list[0], bd = Infinity;
    for (const s of list) { const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { bd = d; best = s; } }
    return best;
  }

  /**
   * Somewhere along the team's spawn line. At the start everyone is spread evenly along it; after that you come back
   * at a random spot on it, away from any enemy who has pushed up that far.
   */
  private lineSpawn(p: Penguin, first: boolean): V3 {
    const list = this.front(p.team).spawns;
    if (first) {
      const mates = this.penguins.filter(q => q.team === p.team);
      return list[Math.floor((mates.indexOf(p) + 0.5) * list.length / Math.max(1, mates.length)) % list.length];
    }
    let pick = list[Math.floor(this.rand() * list.length)];
    for (let tries = 0; tries < 6; tries++) {
      const s = pick;
      if (!this.penguins.some(e => e.alive && e.team !== p.team && Math.hypot(e.x - s.x, e.z - s.z) < 13)) break;
      pick = list[Math.floor(this.rand() * list.length)];
    }
    return pick;
  }

  spawn(p: Penguin, index?: number) {
    const base = this.front(p.team);
    const s = (index === undefined ? this.flagSpawn(p) : null) ?? this.lineSpawn(p, index !== undefined);
    p.x = s.x + (this.rand() - 0.5) * 0.6; p.z = s.z + (this.rand() - 0.5) * 0.6;
    const g = this.field.surfaceBelow(p.x, 25, p.z, 0, 30);
    p.y = (g ?? s.y) + 0.05;
    p.px = p.x; p.py = p.y; p.pz = p.z;
    p.vx = p.vy = p.vz = 0;
    p.yaw = p.lookYaw = base.facing;
    p.input.yaw = base.facing;
    p.alive = true; p.health = CFG.maxHealth; p.invuln = CFG.spawnProtect; p.sinceHit = 99;
    p.carried = 0; p.packProgress = 0; p.charge = 0; p.charging = false; p.sliding = false;
    p.action = 'idle';
  }

  /**
   * Conquest: come back at the flag your team holds that is nearest to where you went down (on your own base's side
   * of it), unless your base is nearer or the other team is standing on that flag.
   */
  private flagSpawn(p: Penguin): V3 | null {
    if (this.mode !== 'conquest' || this.phase !== 'fight') return null;
    const base = this.map.bases[p.team].center;
    let best: CapturePoint | null = null, bd = Math.hypot(p.downX - base.x, p.downZ - base.z);
    for (const pt of this.points) {
      if (pt.owner !== p.team || (p.team === 0 ? pt.n1 : pt.n0) > 0) continue;
      const d = Math.hypot(p.downX - pt.x, p.downZ - pt.z);
      if (d < bd) { bd = d; best = pt; }
    }
    if (!best) return null;
    const a = Math.atan2(base.z - best.z, base.x - best.x) + (this.rand() - 0.5) * 1.5;
    const r = best.r + 1.5 + this.rand() * 2;
    return { x: best.x + Math.cos(a) * r, y: best.y, z: best.z + Math.sin(a) * r };
  }

  // ───────────────────────── main step ─────────────────────────
  step(dt: number) {
    this.time += dt;
    this.updatePhase(dt);
    for (const p of this.penguins) { p.px = p.x; p.py = p.y; p.pz = p.z; }
    for (const p of this.penguins) this.stepPenguin(p, dt);
    this.separatePenguins();
    this.stepSnowballs(dt);
    this.stepBigBalls(dt);
    this.stepFlakes(dt);
    this.stepBoard(dt);
    this.stepTurrets(dt);
    this.stepBarrages(dt);
    this.stepPoints(dt);
    this.stepBreakthrough(dt);
    // snow that lost its support falls
    this.field.settle(3, (x, y, z, drop, mass) => { if (mass > 300) this.emit({ type: 'collapse', x, y, z, drop, mass }); });
  }

  private updatePhase(dt: number) {
    if (this.phase === 'end') return;
    this.phaseT -= dt;
    if (this.phase === 'build' && this.phaseT <= 0) {
      this.phase = 'fight'; this.phaseT = this.fightLen;
      this.emit({ type: 'phase', phase: 'fight' });
    } else if (this.phase === 'fight') {
      if (this.mode === 'breakthrough') {
        // out of time: the defenders held (running out of tickets and taking the last section are in stepBreakthrough)
        if (this.phaseT <= 0) this.endMatch(DEFEND);
      } else if (this.phaseT <= 0 || this.scores[0] >= this.scoreToWin || this.scores[1] >= this.scoreToWin) {
        this.endMatch(this.scores[0] === this.scores[1] ? -1 : this.scores[0] > this.scores[1] ? 0 : 1);
      }
    }
  }

  private endMatch(winner: number) {
    this.phase = 'end'; this.phaseT = 0;
    this.winner = winner;
    this.emit({ type: 'phase', phase: 'end' });
    this.emit({ type: 'gameOver', winner });
  }

  /** Breakthrough: once the attackers' tickets are gone, the ones who go down stay down (until they take a section). */
  private canRespawn(p: Penguin) {
    return !(this.mode === 'breakthrough' && p.team === ATTACK && this.phase === 'fight' && this.scores[ATTACK] <= 0);
  }

  // ───────────────────────── penguins ─────────────────────────
  private stepPenguin(p: Penguin, dt: number) {
    const inp = p.input;
    p.lookYaw = inp.yaw; p.lookPitch = inp.pitch;
    p.throwCd = Math.max(0, p.throwCd - dt);
    p.throwAnim = Math.max(0, p.throwAnim - dt);
    p.invuln = Math.max(0, p.invuln - dt);
    p.noSnowT = Math.max(0, p.noSnowT - dt);
    p.sinceHit += dt;
    p.frenzyT = Math.max(0, p.frenzyT - dt);
    const reward = inp.reward; inp.reward = 0;

    if (!p.alive) {
      p.action = 'down';
      p.downT -= dt;
      p.vx *= 0.9; p.vz *= 0.9;
      if (p.downT <= 0 && !this.predicting && this.canRespawn(p)) { this.spawn(p); this.emit({ type: 'respawn', pid: p.id }); }
      return;
    }
    if (this.phase === 'end') { p.vx = p.vz = 0; p.action = 'idle'; return; }

    if (p.health < CFG.maxHealth && p.sinceHit > CFG.regenDelay && !this.predicting) { p.health++; p.sinceHit = CFG.regenDelay * 0.5; }

    const fwdX = -Math.sin(p.lookYaw), fwdZ = -Math.cos(p.lookYaw);
    const rightX = Math.cos(p.lookYaw), rightZ = -Math.sin(p.lookYaw);
    let mx = inp.moveX, mz = inp.moveZ;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    const wishX = fwdX * mz + rightX * mx, wishZ = fwdZ * mz + rightZ * mx;

    // ── belly slide ──
    if (inp.slide && p.grounded && !p.sliding && !p.surfing && (Math.hypot(p.vx, p.vz) > 1.5 || ml > 0.2)) {
      p.sliding = true; p.slideSlowT = 0;
      const sp = Math.hypot(p.vx, p.vz);
      let dx = sp > 0.5 ? p.vx / sp : wishX, dz = sp > 0.5 ? p.vz / sp : wishZ;
      const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      const ns = Math.min(CFG.slideMaxSpeed, Math.max(sp, 3) + CFG.slideBoost);
      p.vx = dx * ns; p.vz = dz * ns;
      p.vy = Math.max(p.vy, 1.6);
      this.emit({ type: 'slideStart', pid: p.id });
    }
    if (p.sliding && !p.onSlide && (inp.jump || (!inp.slide && p.grounded))) p.sliding = false;

    // what are the mittens doing?
    const busy = !p.sliding && p.grounded;
    let action: Action = p.sliding ? 'slide' : 'idle';
    const canThrow = this.phase === 'fight' && p.carried > 0 && p.throwCd <= 0;
    if (inp.fire && canThrow && !inp.plow) { p.charging = true; }
    if (p.charging) {
      if (inp.fire && p.carried > 0) {
        p.charge = Math.min(1, p.charge + dt / CFG.throwChargeTime);
        action = p.sliding ? 'slide' : 'charge';
      } else {
        if (p.carried > 0 && this.phase === 'fight') {
          // a predicting client only plays the arm swing; the server throws the real snowball
          if (this.predicting) { p.throwCd = p.frenzyT > 0 ? CFG.frenzyCooldown : CFG.throwCooldown; p.throwAnim = 0.25; } else this.throwSnowball(p);
        }
        p.charging = false; p.charge = 0;
      }
    }
    if (!p.charging && busy) {
      if (inp.plow) action = 'plow';
      else if (inp.pack) action = 'pack';
      else if (inp.dig) action = 'dig';
      else if (inp.build || inp.turret) action = 'build';
    }
    if (p.throwAnim > 0 && action === 'idle') action = 'throw';
    p.action = action;

    // ── movement ──
    const ice = this.isIce(p.x, p.z);
    p.onIce = ice;
    if (p.sliding) {
      // steer by turning the velocity a little
      const sp = Math.hypot(p.vx, p.vz);
      const steer = inp.moveX * CFG.slideSteer * dt;
      if (sp > 0.1 && steer !== 0) {
        const c = Math.cos(-steer), s = Math.sin(-steer);
        const nvx = p.vx * c - p.vz * s, nvz = p.vx * s + p.vz * c;
        p.vx = nvx; p.vz = nvz;
      }
      if (p.grounded && !p.onSlide && !p.onProp) {
        // gravity along the slope
        const n = this.groundNormal(p.x, p.y, p.z);
        p.vx += CFG.gravity * n.y * n.x * dt * 0.95;
        p.vz += CFG.gravity * n.y * n.z * dt * 0.95;
        const fr = (ice ? CFG.iceFriction : CFG.slideFriction) * dt;
        const s2 = Math.hypot(p.vx, p.vz);
        if (s2 > 0) { const k = Math.max(0, s2 - fr) / s2; p.vx *= k; p.vz *= k; }
      }
      if (ice && p.grounded && this.map.creekAt) {
        // on the sled run the ice carries you round the bends, like a luge track (you can still steer out of it)
        const c = this.map.creekAt(p.x, p.z);
        const sp = Math.hypot(p.vx, p.vz);
        if (c.d < 2.2 && sp > 1 && (p.vx * c.tx + p.vz * c.tz) > 0) {
          const k = Math.min(1, CFG.sledAssist * dt);
          p.vx += (c.tx * sp - p.vx) * k; p.vz += (c.tz * sp - p.vz) * k;
        }
      }
      const s3 = Math.hypot(p.vx, p.vz);
      if (s3 > CFG.slideMaxSpeed) { p.vx *= CFG.slideMaxSpeed / s3; p.vz *= CFG.slideMaxSpeed / s3; }
      if (s3 < 1.2 && !p.onSlide) { p.slideSlowT += dt; if (p.slideSlowT > 0.5) p.sliding = false; } else p.slideSlowT = 0;
      p.yaw = Math.atan2(-p.vx, -p.vz);
    } else {
      let speed = CFG.walkSpeed;
      if (action === 'plow') speed = CFG.plowSpeed / (1 + p.plowLoad * 0.0004);
      else if (action === 'pack' || action === 'dig' || action === 'build') speed = CFG.busySpeed;
      else if (action === 'charge') speed = CFG.chargeSpeed;
      if (p.surfing) speed *= CFG.surfSpeedMult;
      const tx = wishX * speed, tz = wishZ * speed;
      let accel = p.grounded ? (ice ? 2.2 : 12) : 3;
      if (p.surfing) accel = p.grounded ? (ice ? 4 : CFG.surfAccel) : 2.5;
      const k = Math.min(1, accel * dt);
      if (p.surfing && ml < 0.1) {
        // no input: keep gliding
        const fr = (ice ? 0.3 : 2.2) * dt, sp = Math.hypot(p.vx, p.vz);
        if (sp > 0) { const kk = Math.max(0, sp - fr) / sp; p.vx *= kk; p.vz *= kk; }
      } else {
        p.vx += (tx - p.vx) * k; p.vz += (tz - p.vz) * k;
      }
      if (p.surfing && p.grounded && !p.onProp) {
        // surf down hills
        const n = this.groundNormal(p.x, p.y, p.z);
        p.vx += CFG.gravity * n.y * n.x * dt * 0.7;
        p.vz += CFG.gravity * n.y * n.z * dt * 0.7;
        const sp = Math.hypot(p.vx, p.vz);
        if (sp > CFG.surfMaxSpeed) { p.vx *= CFG.surfMaxSpeed / sp; p.vz *= CFG.surfMaxSpeed / sp; }
      }
      // body turns toward where we look
      let dyaw = p.lookYaw - p.yaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      p.yaw += dyaw * Math.min(1, dt * 12);
    }

    if (inp.jump) {
      if (p.grounded) { p.vy = CFG.jumpVel * (p.surfing ? 1.15 : 1); p.grounded = false; p.sliding = false; p.onSlide = false; this.emit({ type: 'jump', pid: p.id }); }
      inp.jump = false;
    }

    p.vy -= CFG.gravity * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;

    this.collideBody(p);
    this.groundPenguin(p, dt);

    // build phase: stay on your side of the ice line. Breakthrough: the attackers also wait behind the next line
    // while the defenders regroup (anyone already past it gets walked back)
    const line = this.holdLine();
    if (line !== null) {
      const lim = 1.0;
      if (p.team === 0 && p.x > line - lim) { p.x = Math.max(line - lim, p.x - 14 * dt); if (p.vx > 0) p.vx = 0; }
      if (p.team === 1 && this.phase === 'build' && p.x < line + lim) { p.x = line + lim; if (p.vx < 0) p.vx = 0; }
    }

    // ── snow work ──
    if (this.predicting) return; // the server digs, builds, packs and runs the stockpiles
    p.aimOk = false;
    if (action === 'plow') this.doPlow(p, dt, fwdX, fwdZ);
    else p.plowLoad *= 0.9;
    if (action === 'pack') this.doPack(p, dt, fwdX, fwdZ);
    if (action === 'dig') this.doDig(p, dt, fwdX, fwdZ);
    const turreting = action === 'build' && inp.turret && !inp.build;
    if (action === 'build' && !turreting) this.doBuild(p, dt, fwdX, fwdZ); else { p.buildBlock = 0; p.slumping = false; }
    if (turreting) this.doTurret(p, dt, fwdX, fwdZ); else { p.turretBlock = 0; this.dropTurretSnow(p); }
    if (reward) this.useReward(p, reward - 1);
    p.rollCd = Math.max(0, p.rollCd - dt);
    if (inp.roll && busy && !p.charging && p.rollCd <= 0) this.startBigBall(p, fwdX, fwdZ);

    // stockpile: tap = grab, hold = stash
    if (inp.use) {
      if (p.useT < 0) { p.useT = 0; p.useDone = false; }
      p.useT += dt;
      if (!p.useDone && p.useT >= CFG.useHoldTime) {
        p.useDone = true;
        if (p.carried > 0 && this.nearPile(p) === p.team) {
          this.piles[p.team] += p.carried;
          this.emit({ type: 'stash', pid: p.id, n: p.carried });
          p.carried = 0;
        } else if (p.carried > 0) this.loadTurret(p);
      }
    } else if (p.useT >= 0) {
      if (!p.useDone) this.tryGrab(p);
      p.useT = -1;
    }
  }

  tryGrab(p: Penguin) {
    for (let t = 0; t < 2; t++) {
      if (this.atPile(p, t) && this.piles[t] > 0 && p.carried < CFG.maxCarry) {
        const n = Math.min(CFG.maxCarry - p.carried, this.piles[t]);
        this.piles[t] -= n; p.carried += n;
        this.emit({ type: 'grab', pid: p.id, n, team: t, stolen: t !== p.team });
        return true;
      }
    }
    return false;
  }

  private atPile(p: Penguin, team: number) {
    for (const b of this.front(team).stockpiles) if (Math.hypot(p.x - b.x, p.z - b.z) < CFG.stockRadius) return true;
    return false;
  }

  /** Which team's stockpile this penguin is standing at (their own first), or -1. */
  nearPile(p: Penguin): number {
    if (this.atPile(p, p.team)) return p.team;
    return this.atPile(p, 1 - p.team) ? 1 - p.team : -1;
  }

  /** Is there something solid here that isn't snow: a wall, a sled, a pillar? (Bots look ahead with this.) */
  propAt(x: number, y: number, z: number) {
    const pg = this.map.playground;
    if (pointInBoxes(pg.boxes, x, y, z, 0.1)) return true;
    for (const c of pg.cyls) if (y > c.y0 && y < c.y1 && Math.hypot(x - c.x, z - c.z) < c.r + 0.1) return true;
    return false;
  }

  isIce(x: number, z: number) {
    const f = this.field, col = f.colIndex(x, z);
    if (!f.ice[col]) return false;
    const base = f.baseHeight[col];
    const g = f.surfaceBelow(x, base + 0.3, z, 0.1, 0.6);
    return g !== null && Math.abs(g - base) < 0.22;
  }

  groundNormal(x: number, y: number, z: number) {
    const e = 0.45;
    const hx1 = this.field.surfaceBelow(x + e, y, z, 0.8, 1.6) ?? y;
    const hx0 = this.field.surfaceBelow(x - e, y, z, 0.8, 1.6) ?? y;
    const hz1 = this.field.surfaceBelow(x, y, z + e, 0.8, 1.6) ?? y;
    const hz0 = this.field.surfaceBelow(x, y, z - e, 0.8, 1.6) ?? y;
    const gx = (hx1 - hx0) / (2 * e), gz = (hz1 - hz0) / (2 * e);
    const l = Math.hypot(gx, 1, gz);
    tmpN.x = -gx / l; tmpN.y = 1 / l; tmpN.z = -gz / l;
    return tmpN;
  }

  /** Push the penguin's body out of snow walls, trees, igloos and big balls. */
  private collideBody(p: Penguin) {
    const r = CFG.radius;
    const heights = p.sliding ? [0.3] : [0.6, 0.95];
    const f = this.field;
    for (let iter = 0; iter < 2; iter++) {
      let pushX = 0, pushZ = 0;
      for (const h of heights) {
        const cy = p.y + h;
        for (let a = 0; a < 12; a++) {
          const ang = (a / 12) * Math.PI * 2;
          const dx = Math.cos(ang), dz = Math.sin(ang);
          if (f.sample(p.x + dx * r, cy, p.z + dz * r) > ISO) {
            // find how deep we are along this direction
            let lo = 0, hi = r;
            for (let n = 0; n < 4; n++) {
              const m = (lo + hi) * 0.5;
              if (f.sample(p.x + dx * m, cy, p.z + dz * m) > ISO) hi = m; else lo = m;
            }
            const pen = r - lo;
            pushX -= dx * pen; pushZ -= dz * pen;
          }
        }
      }
      if (pushX === 0 && pushZ === 0) break;
      const pl = Math.hypot(pushX, pushZ);
      const lim = Math.min(pl, 0.25);
      p.x += pushX / pl * lim * 0.5; p.z += pushZ / pl * lim * 0.5;
      // kill velocity into the wall
      const nx = pushX / pl, nz = pushZ / pl;
      const vn = p.vx * nx + p.vz * nz;
      if (vn < 0) {
        if (p.sliding) { p.vx -= vn * nx * 1.5; p.vz -= vn * nz * 1.5; } // bounce off walls a bit
        else { p.vx -= vn * nx; p.vz -= vn * nz; }
      }
    }
    // head bump
    if (p.vy > 0 && f.sample(p.x, p.y + (p.sliding ? 0.55 : 1.1), p.z) > ISO) p.vy = 0;
    // trees
    for (const t of this.map.trees) {
      const dx = p.x - t.x, dz = p.z - t.z;
      const d = Math.hypot(dx, dz), min = t.r + r;
      if (d < min && d > 1e-4 && p.y < t.y + t.h) { p.x = t.x + dx / d * min; p.z = t.z + dz / d * min; const vn = (p.vx * dx + p.vz * dz) / d; if (vn < 0) { p.vx -= vn * dx / d; p.vz -= vn * dz / d; } }
    }
    // igloos
    for (const b of this.map.bases) {
      const dx = p.x - b.igloo.x, dz = p.z - b.igloo.z;
      const d = Math.hypot(dx, dz), min = 2.4 + r * 0.6;
      if (d < min && d > 1e-4 && p.y < b.igloo.y + 2.2) { p.x = b.igloo.x + dx / d * min; p.z = b.igloo.z + dz / d * min; }
    }
    // playground: boxes and poles
    const pg = this.map.playground;
    const head = p.y + (p.sliding ? 0.6 : 1.05);
    if (boxPush(pg.boxes, p.x, p.z, p.y + 0.02, head, r, pushTmp)) {
      p.x += pushTmp.x; p.z += pushTmp.z;
      const pl = Math.hypot(pushTmp.x, pushTmp.z) || 1;
      const nx = pushTmp.x / pl, nz = pushTmp.z / pl;
      const vn = p.vx * nx + p.vz * nz;
      if (vn < 0) { p.vx -= vn * nx; p.vz -= vn * nz; }
    }
    for (const c of pg.cyls) {
      if (p.y > c.y1 || head < c.y0) continue;
      const dx = p.x - c.x, dz = p.z - c.z;
      const d = Math.hypot(dx, dz), min = c.r + r;
      if (d < min && d > 1e-4) { p.x = c.x + dx / d * min; p.z = c.z + dz / d * min; const vn = (p.vx * dx + p.vz * dz) / d; if (vn < 0) { p.vx -= vn * dx / d; p.vz -= vn * dz / d; } }
    }
    // slide side rails: if we're on the slide, stay between them
    if (p.onSlide) {
      const sl = pg.slide;
      const lim = sl.width / 2 - 0.1;
      if (p.x < sl.x - lim) { p.x = sl.x - lim; p.vx = Math.max(0, p.vx); }
      if (p.x > sl.x + lim) { p.x = sl.x + lim; p.vx = Math.min(0, p.vx); }
    }
    // snowman turrets
    for (const t of this.turrets) {
      if (!t.alive || p.y > t.y + CFG.turretHeight || head < t.y) continue;
      const dx = p.x - t.x, dz = p.z - t.z;
      const d = Math.hypot(dx, dz), min = CFG.turretRadius * 0.85 + r;
      if (d < min && d > 1e-4) { p.x = t.x + dx / d * min; p.z = t.z + dz / d * min; const vn = (p.vx * dx + p.vz * dz) / d; if (vn < 0) { p.vx -= vn * dx / d; p.vz -= vn * dz / d; } }
    }
    // big balls (pushing them happens in stepBigBalls)
    for (const b of this.bigBalls) {
      const dx = p.x - b.x, dz = p.z - b.z;
      const dy = (p.y + 0.5) - b.y;
      const d3 = Math.hypot(dx, dy, dz), min = b.r + r;
      if (d3 < min && d3 > 1e-4) {
        const dh = Math.hypot(dx, dz) || 1e-4;
        const pen = min - d3;
        p.x += dx / dh * pen; p.z += dz / dh * pen;
        if (dy > b.r * 0.6 && p.vy < 0) { p.vy = 0; p.y += pen * 0.5; p.grounded = true; }
      }
    }
    // arena bounds
    const bd = this.map.bounds;
    if (p.x < bd.minX) { p.x = bd.minX; p.vx = Math.max(0, p.vx); }
    if (p.x > bd.maxX) { p.x = bd.maxX; p.vx = Math.min(0, p.vx); }
    if (p.z < bd.minZ) { p.z = bd.minZ; p.vz = Math.max(0, p.vz); }
    if (p.z > bd.maxZ) { p.z = bd.maxZ; p.vz = Math.min(0, p.vz); }
  }

  private groundPenguin(p: Penguin, dt: number) {
    const f = this.field;
    const stepUp = p.sliding ? 0.35 : CFG.stepUp;
    const down = p.grounded ? 0.6 : 0.2 + Math.max(0, -p.vy * dt);
    // the playground slide
    if (this.onPlaygroundSlide(p, dt)) return;
    let g = f.surfaceBelow(p.x, p.y, p.z, stepUp, down);
    const pb = boxGround(this.map.playground.boxes, p.x, p.z, p.y, stepUp, down, CFG.radius * 0.5);
    p.onProp = false;
    if (pb !== null && (g === null || pb > g)) { g = pb; p.onProp = true; }
    const wasGrounded = p.grounded;
    if (g !== null && p.y <= g + 0.02 && p.vy <= 0.5) {
      p.y = g; p.vy = 0; p.grounded = true;
    } else if (g !== null && wasGrounded && p.vy <= 0 && p.y - g < 0.6) {
      p.y = g; p.vy = 0; p.grounded = true; // stick to slopes going down
    } else if (g !== null && p.y < g && p.vy > 0) {
      p.y = g; p.grounded = false;
    } else {
      p.grounded = false;
    }
    // buried? (someone dumped snow on us) → pop up to the surface
    if (f.sample(p.x, p.y + 0.5, p.z) > ISO + 40 && f.sample(p.x, p.y + 0.9, p.z) > ISO + 40) {
      const top = f.surfaceBelow(p.x, p.y + 3, p.z, 0, 3.2);
      if (top !== null && top > p.y) { p.y = top; p.vy = 0; }
    }
    if (p.y < -4 && !this.predicting) { p.y = 30; this.spawn(p); }
  }

  /** Riding the playground slide: follow the ramp, speed up downhill, and launch off the lip at the end. */
  private onPlaygroundSlide(p: Penguin, dt: number) {
    const sl = this.map.playground.slide;
    const s = (p.z - sl.z0) * sl.dirZ;
    const half = sl.width / 2;
    if (s < 0 || s > sl.length || Math.abs(p.x - sl.x) > half) { if (p.onSlide) { p.onSlide = false; this.emit({ type: 'launch', pid: p.id }); } return false; }
    const y = slideY(sl, s);
    if (p.y < y - 0.45 || p.y > y + 0.3 || (p.vy > 1 && !p.onSlide)) { p.onSlide = false; return false; }
    // on the ramp
    const e = 0.15;
    const dyds = (slideY(sl, Math.min(sl.length, s + e)) - slideY(sl, Math.max(0, s - e))) / (2 * e);
    const tl = Math.hypot(1, dyds);
    const ts = 1 / tl, ty = dyds / tl;
    const vs = p.vz * sl.dirZ;
    let along = vs * ts + p.vy * ty;
    if (!p.onSlide) along = Math.max(along, 1.5);
    along += -CFG.gravity * ty * dt; // downhill speeds you up, the lip slows you a bit
    along -= Math.sign(along) * 0.3 * dt;
    p.vz = sl.dirZ * along * ts;
    p.vy = along * ty;
    p.vx *= 0.9;
    p.y = y;
    p.grounded = true;
    p.onSlide = true;
    p.onProp = true;
    p.sliding = true;
    p.yaw = sl.dirZ > 0 ? Math.PI : 0;
    // leaving the end of the lip: launch!
    if (s + along * ts * dt > sl.length - 0.05 && ty > 0) {
      p.grounded = false; p.onSlide = false;
      p.vy = Math.max(p.vy, 3) + 1.5;
      this.emit({ type: 'launch', pid: p.id });
    }
    return true;
  }

  private separatePenguins() {
    const ps = this.penguins;
    for (let a = 0; a < ps.length; a++) {
      const A = ps[a]; if (!A.alive) continue;
      for (let b = a + 1; b < ps.length; b++) {
        const B = ps[b]; if (!B.alive) continue;
        const dx = B.x - A.x, dz = B.z - A.z;
        if (Math.abs(A.y - B.y) > 1) continue;
        const d = Math.hypot(dx, dz), min = CFG.radius * 2;
        if (d < min && d > 1e-4) {
          const push = (min - d) * 0.5;
          A.x -= dx / d * push; A.z -= dz / d * push;
          B.x += dx / d * push; B.z += dz / d * push;
          // a fast belly slide bowls enemies over
          if (A.team !== B.team) {
            const sa = Math.hypot(A.vx, A.vz), sb = Math.hypot(B.vx, B.vz);
            if (A.sliding && sa > 7 && !B.sliding) { B.vx += A.vx * 0.6; B.vz += A.vz * 0.6; B.vy = 4; B.grounded = false; }
            if (B.sliding && sb > 7 && !A.sliding) { A.vx += B.vx * 0.6; A.vz += B.vz * 0.6; A.vy = 4; A.grounded = false; }
          }
        }
      }
    }
  }

  // ───────────────────────── snow work ─────────────────────────
  private rateMult(p: Penguin) { return 1 + p.mitten * CFG.rateBonusPerLevel; }

  private doPlow(p: Penguin, dt: number, fx: number, fz: number) {
    const fwdSpeed = p.vx * fx + p.vz * fz;
    const intent = Math.max(0, p.input.moveZ);
    const sp = Math.max(fwdSpeed, intent * 0.6);
    if (sp < 0.2) return;
    const rate = Math.min(0.6, (sp * dt / 0.5) * 2.4) * (0.9 + p.mitten * 0.1);
    const moved = this.field.plow(p.x, p.y, p.z, fx, fz, 1.3, 0.5, 1.15, rate, plowOut);
    p.plowLoad = p.plowLoad * 0.95 + moved * 0.6;
    if (moved > 0) this.emit({ type: 'plow', pid: p.id, x: plowOut.cx, y: plowOut.cy, z: plowOut.cz, fx, fz, mass: moved });
  }

  private doPack(p: Penguin, dt: number, fx: number, fz: number) {
    if (p.carried >= CFG.maxCarry) { p.noSnowT = 0.4; return; }
    const want = CFG.packMass * dt / CFG.packTime[p.mitten];
    const got = this.field.removeMass(p.x + fx * 0.6, p.y - 0.05, p.z + fz * 0.6, 0.5, want, 0.3, 0.7);
    if (got < want * 0.3) {
      // try right under our feet
      const got2 = this.field.removeMass(p.x, p.y - 0.1, p.z, 0.55, want - got, 0.3, 0.7);
      if (got + got2 < want * 0.3) { p.noSnowT = 0.6; if (Math.random() < 0.05) this.emit({ type: 'noSnow', pid: p.id }); return; }
    }
    p.packProgress += dt / CFG.packTime[p.mitten];
    if (Math.random() < 0.35) this.emit({ type: 'packTick', pid: p.id, x: p.x + fx * 0.5, y: p.y + 0.15, z: p.z + fz * 0.5 });
    if (p.packProgress >= 1) {
      p.packProgress = 0;
      p.carried++;
      this.emit({ type: 'packDone', pid: p.id, count: p.carried });
    }
  }

  private aimInReach(p: Penguin, extra = 0) {
    const a = p.input.aim;
    if (!a) return null;
    const d = Math.hypot(a.x - p.x, a.y - (p.y + 0.8), a.z - p.z);
    if (d > CFG.reach + extra) return null;
    return a;
  }

  private doDig(p: Penguin, dt: number, fx: number, fz: number) {
    const a = this.aimInReach(p);
    if (!a) return;
    p.aimOk = true;
    const want = CFG.digRate * dt * this.rateMult(p);
    // dig a little past the surface point so tunnels go in straight
    const dx = a.x - p.x, dz = a.z - p.z, dl = Math.hypot(dx, dz) || 1;
    const got = this.field.removeMass(a.x + dx / dl * 0.15, a.y, a.z + dz / dl * 0.15, 0.62, want, 0.35);
    if (got <= 0) { p.noSnowT = 0.4; return; }
    // fling it over the shoulder
    p.digSide = (p.digSide + 1) % 3;
    const side = (p.digSide - 1) * 0.9;
    const rx = -fz, rz = fx;
    const tx = p.x - fx * 1.6 + rx * side, tz = p.z - fz * 1.6 + rz * side;
    const placed = this.field.pourColumns(tx, tz, 0.75, got * 0.85, p.y, p.y + 1.6);
    this.emit({ type: 'dig', pid: p.id, x: a.x, y: a.y, z: a.z, tx, ty: p.y + 0.3, tz, mass: got });
    void placed;
  }

  /**
   * Building stacks snow on top of whatever snow is under the aim point, so holding still grows a pile straight up
   * and sweeping the aim draws a wall. Snow physics: a pile can only stand as tall as its base is wide, so on a pile
   * that's too thin the new snow slumps down the sides (widening the base) until it can carry more height.
   */
  private doBuild(p: Penguin, dt: number, fx: number, fz: number) {
    p.buildBlock = 0; p.slumping = false;
    const a = this.aimInReach(p, 1.2);
    if (!a) return;
    const f = this.field;
    let top: number;
    if (f.sample(a.x, a.y - 0.2, a.z) > ISO) top = f.topAbove(a.x, a.y - 0.2, a.z, 7);
    else {
      const g = f.surfaceBelow(a.x, a.y + 0.3, a.z, 0, 2.5);
      if (g === null) { p.buildBlock = 2; return; } // nothing under there to build on
      top = g;
    }
    if (top > (f.ny - 3) * f.cell) { p.buildBlock = 1; return; }
    if (Math.hypot(a.x - p.x, top - (p.y + 0.9), a.z - p.z) > CFG.reach + 1.5) { p.buildBlock = 1; return; } // too tall to reach from here
    p.aimOk = true;
    const want = CFG.buildRate * dt * this.rateMult(p);
    // scoop from the ground around our feet (behind and to the sides), so building leaves a shallow trench around you
    let got = 0, sx = p.x, sy = p.y, sz = p.z;
    for (let tries = 0; tries < 6 && got < want * 0.6; tries++) {
      const ang = Math.PI * (0.4 + Math.random() * 1.2); // the back 215°
      const rad = 0.9 + Math.random() * 1.6;
      const c = Math.cos(ang), s = Math.sin(ang);
      const rx = -fz, rz = fx;
      const dirX = fx * c + rx * s, dirZ = fz * c + rz * s;
      const qx = p.x + dirX * rad, qz = p.z + dirZ * rad;
      if (Math.hypot(qx - a.x, qz - a.z) < CFG.buildRadius + 0.7) continue; // never eat the thing we're building
      const qy = f.surfaceBelow(qx, p.y + 0.5, qz, 0.4, 1.2);
      if (qy === null) continue;
      const g = f.removeMass(qx, qy - 0.1, qz, 0.65, want - got, 0.5, 0.8);
      if (g > 0) { got += g; sx = qx; sy = qy; sz = qz; }
    }
    if (got <= 0) { p.noSnowT = 0.5; return; }
    // is the pile wide enough under its top to carry more height?
    const low: number[] = [];
    const run = CFG.buildBaseRun, rise = CFG.buildBaseRise;
    for (let n = 0; n < 8; n++) {
      const ang = n * Math.PI / 4;
      const lx = a.x + Math.cos(ang) * run, lz = a.z + Math.sin(ang) * run;
      if (f.sample(lx, top - rise, lz) <= ISO) low.push(lx, lz);
    }
    let added = 0;
    const ty = top + 0.25;
    if (low.length >= 6) {
      // too thin: the snow slides down the open sides and thickens the base
      p.slumping = true;
      const share = got / (low.length / 2);
      for (let n = 0; n < low.length; n += 2) {
        const gy = f.surfaceBelow(low[n], top, low[n + 1], 0, 6) ?? top - rise;
        const put = f.pourColumns(low[n], low[n + 1], 0.6, share, gy, top);
        if (put > 0) f.pack(low[n], gy + 0.3, low[n + 1], 0.75, CFG.buildHard * 0.5);
        added += put;
      }
    } else {
      added = f.addMass(a.x, ty, a.z, CFG.buildRadius, got, CFG.buildHard);
    }
    if (added < got - 2) f.pourColumns(sx, sz, 0.7, got - added, sy, sy + 0.8);
    this.emit({ type: 'build', pid: p.id, x: sx, y: sy, z: sz, tx: a.x, ty, tz: a.z, mass: added });
  }

  /** Scoop the snow in front of you into a new giant snowball. Roll it through fresh snow to grow it. */
  private startBigBall(p: Penguin, fx: number, fz: number) {
    p.rollCd = 0.6;
    if (this.bigBalls.length >= CFG.maxBigBalls + CFG.maxMadeBalls) { p.noSnowT = 0.6; return; }
    const f = this.field;
    const cx = p.x + fx * 1.05, cz = p.z + fz * 1.05;
    const g = f.surfaceBelow(cx, p.y + 0.8, cz, 0.5, 2);
    if (g === null || this.isIce(cx, cz)) { p.noSnowT = 0.6; return; }
    const got = f.removeMass(cx, g, cz, 1.0, CFG.ballStartMass, 0.3, 0.6);
    if (got < CFG.ballStartMass * 0.35) { f.pourColumns(cx, cz, 0.8, got, g - 0.5, g + 0.6); p.noSnowT = 0.6; this.emit({ type: 'noSnow', pid: p.id }); return; }
    const r = Math.cbrt((got / 2040) * 3 / (4 * Math.PI));
    const top = f.surfaceBelow(cx, g + 1, cz, 0, 3) ?? g;
    this.bigBalls.push({ id: this.nextId++, x: cx, y: top + r, z: cz, px: cx, py: top + r, pz: cz, vx: fx * 1.2, vy: 0, vz: fz * 1.2, r, alive: true, grounded: true, lastPusher: p.id, pushT: 4, restT: 0 });
    p.rollCd = CFG.ballMakeCooldown;
    this.emit({ type: 'ballMade', pid: p.id, x: cx, y: top + r, z: cz });
  }

  // ───────────────────────── throwing ─────────────────────────
  handPos(p: Penguin) {
    const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    return { x: p.x + rx * 0.35, y: p.y + (p.sliding ? 0.5 : 1.05), z: p.z + rz * 0.35 };
  }

  throwSnowball(p: Penguin) {
    const speed = (CFG.throwSpeedMin + (CFG.throwSpeedMax - CFG.throwSpeedMin) * p.charge) * (1 + p.mitten * CFG.throwPerLevel);
    const h = this.handPos(p);
    const v = solveThrow(h, p.input.aim, speed, CFG.snowballGravity) ?? lookVelocity(p.lookYaw, p.lookPitch + 0.07, speed);
    this.snowballs.push({ id: this.nextId++, owner: p.id, team: p.team, x: h.x, y: h.y, z: h.z, px: h.x, py: h.y, pz: h.z,
      vx: v.x + p.vx * 0.3, vy: v.y, vz: v.z + p.vz * 0.3, age: 0, alive: true, kind: 0 });
    // Snowball Frenzy: the snowballs don't run out and the arm doesn't rest
    if (p.frenzyT <= 0) p.carried--;
    p.throwCd = p.frenzyT > 0 ? CFG.frenzyCooldown : CFG.throwCooldown;
    p.throwAnim = 0.25;
    this.emit({ type: 'throw', pid: p.id, x: h.x, y: h.y, z: h.z, power: p.charge });
  }

  private stepSnowballs(dt: number) {
    const g = CFG.snowballGravity;
    for (const b of this.snowballs) {
      if (!b.alive) continue;
      b.px = b.x; b.py = b.y; b.pz = b.z;
      b.age += dt;
      b.vy -= g * dt;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.vx, b.vy, b.vz) * dt / 0.2));
      const sdt = dt / steps;
      for (let s = 0; s < steps && b.alive; s++) {
        b.x += b.vx * sdt; b.y += b.vy * sdt; b.z += b.vz * sdt;
        // penguins
        for (const p of this.penguins) {
          if (!p.alive || p.team === b.team || p.id === b.owner) continue;
          const hitR = CFG.hitRadius + CFG.snowballRadius;
          let d: number;
          if (p.sliding) d = Math.hypot(b.x - p.x, b.y - (p.y + 0.3), b.z - p.z);
          else {
            const cy = Math.max(p.y + 0.3, Math.min(p.y + 1.05, b.y));
            d = Math.hypot(b.x - p.x, b.y - cy, b.z - p.z);
          }
          if (d < hitR) { this.hitPenguin(p, b); b.alive = false; break; }
        }
        if (!b.alive) break;
        // enemy turrets take the hit (your own team's snowballs fly straight past theirs)
        for (const t of this.turrets) {
          if (!t.alive || t.team === b.team) continue;
          if (b.y > t.y - 0.1 && b.y < t.y + CFG.turretHeight && Math.hypot(b.x - t.x, b.z - t.z) < CFG.turretRadius + CFG.snowballRadius) {
            this.hitTurret(t, b.owner, b.x, b.y, b.z);
            b.alive = false; break;
          }
        }
        if (!b.alive) break;
        // big balls soak it up
        for (const bb of this.bigBalls) {
          if (Math.hypot(b.x - bb.x, b.y - bb.y, b.z - bb.z) < bb.r + CFG.snowballRadius) {
            this.emit({ type: 'snowHit', x: b.x, y: b.y, z: b.z, nx: (b.x - bb.x) / bb.r, ny: (b.y - bb.y) / bb.r, nz: (b.z - bb.z) / bb.r });
            b.alive = false; break;
          }
        }
        if (!b.alive) break;
        const pg = this.map.playground;
        let propHit = pointInBoxes(pg.boxes, b.x, b.y, b.z, CFG.snowballRadius);
        if (!propHit) for (const c of pg.cyls) if (b.y > c.y0 && b.y < c.y1 && Math.hypot(b.x - c.x, b.z - c.z) < c.r + CFG.snowballRadius) { propHit = true; break; }
        if (!propHit) {
          const sl = pg.slide, ss = (b.z - sl.z0) * sl.dirZ;
          if (ss >= 0 && ss <= sl.length && Math.abs(b.x - sl.x) < sl.width / 2 + 0.05) {
            const yy = slideY(sl, ss);
            if (b.y < yy + 0.05 && b.y > yy - 0.25) propHit = true;
          }
        }
        if (propHit) { this.emit({ type: 'snowHit', x: b.x, y: b.y, z: b.z, nx: -b.vx * 0.05, ny: 0.5, nz: -b.vz * 0.05 }); b.alive = false; break; }
        for (const t of this.map.trees) {
          const ty = b.y - t.y;
          if (ty < t.h && Math.hypot(b.x - t.x, b.z - t.z) < (ty < t.cb ? t.r + 0.1 : 0.2 + (1 - (ty - t.cb) / (t.h - t.cb)) * t.cw * 0.8)) {
            this.emit({ type: 'snowHit', x: b.x, y: b.y, z: b.z, nx: 0, ny: 1, nz: 0 });
            b.alive = false; break;
          }
        }
        if (!b.alive) break;
        if (this.field.sample(b.x, b.y, b.z) > ISO || b.y < 0) {
          this.field.normalAt(b.x, b.y, b.z, tmpN);
          this.emit({ type: 'snowHit', x: b.x, y: b.y, z: b.z, nx: tmpN.x, ny: tmpN.y, nz: tmpN.z });
          b.alive = false;
        }
      }
      if (b.age > 6) b.alive = false;
    }
    this.snowballs = this.snowballs.filter(b => b.alive);
  }

  private hitPenguin(p: Penguin, b: Snowball) {
    if (p.invuln > 0) {
      this.emit({ type: 'snowHit', x: b.x, y: b.y, z: b.z, nx: 0, ny: 1, nz: 0 });
      return;
    }
    p.health--;
    p.sinceHit = 0;
    p.lastHitBy = b.owner;
    const sp = Math.hypot(b.vx, b.vz) || 1;
    p.vx += b.vx / sp * 1.6; p.vz += b.vz / sp * 1.6;
    this.emit({ type: 'hit', pid: p.id, by: b.owner, x: b.x, y: b.y, z: b.z, health: p.health });
    if (p.health <= 0) this.splat(p, b.owner, b.kind === 1 ? 'turret' : b.kind === 2 ? 'avalanche' : 'snowball');
  }

  splat(p: Penguin, by: number, cause: SplatCause) {
    if (!p.alive) return;
    p.alive = false;
    p.downX = p.x; p.downZ = p.z;
    p.frenzyT = 0;
    this.dropTurretSnow(p);
    p.downT = this.mode === 'breakthrough' ? CFG.btRespawn[p.team] : CFG.respawnTime;
    p.downs++;
    // Breakthrough: every attacker who goes down costs the attackers a ticket
    if (this.mode === 'breakthrough' && this.phase === 'fight' && p.team === ATTACK && this.scores[ATTACK] > 0) this.scores[ATTACK]--;
    p.sliding = false; p.charging = false; p.charge = 0;
    p.mitten = Math.max(0, p.mitten - 1);
    const killer = this.penguin(by);
    if (killer && killer.team !== p.team) {
      killer.splats++;
      // Team Deathmatch scores splats and counts streaks; Conquest scores flags instead
      if (this.phase === 'fight' && this.mode === 'tdm') {
        this.scores[killer.team]++;
        // only splats you land yourself build a streak: turrets and Avalanches don't feed it
        if (cause === 'snowball' || cause === 'bigball') this.addStreak(killer);
      }
    }
    p.streak = 0;
    this.emit({ type: 'splat', pid: p.id, by, x: p.x, y: p.y, z: p.z, cause });
    p.carried = 0;
    if (this.board.holder === p.id) {
      // the surfboard drops right where you got splatted
      const bd = this.board;
      bd.holder = -1; bd.x = p.x; bd.y = p.y + 0.6; bd.z = p.z; bd.vy = 4; bd.yaw = p.yaw;
      p.surfing = false;
      this.emit({ type: 'board', pid: p.id, what: 'drop', x: bd.x, y: bd.y, z: bd.z });
    }
  }

  // ───────────────────────── big rolling snowballs ─────────────────────────
  private spawnBigBall(hint?: number) {
    const spots = this.map.bigBallSpawns;
    if (!spots.length) return false;
    let order = spots.map((_, i) => i);
    if (this.mode === 'breakthrough' && hint === undefined) {
      const near = order.filter(i => this.inPlay(spots[i].x));
      if (near.length) order = near;
    }
    if (hint !== undefined) order.unshift(order.splice(hint % spots.length, 1)[0]);
    else order.sort(() => this.rand() - 0.5);
    for (const i of order) {
      const s = spots[i];
      if (this.bigBalls.some(b => Math.hypot(b.x - s.x, b.z - s.z) < 4)) continue;
      const r = CFG.bigBallStartRadius;
      const g = this.field.surfaceBelow(s.x, 25, s.z, 0, 30) ?? s.y;
      this.bigBalls.push({ id: this.nextId++, x: s.x, y: g + r, z: s.z, px: s.x, py: g + r, pz: s.z, vx: 0, vy: 0, vz: 0, r, alive: true, grounded: true, lastPusher: -1, pushT: 0, restT: 0 });
      return true;
    }
    return false;
  }

  private stepBigBalls(dt: number) {
    const f = this.field;
    this.bigBallTimer += dt;
    if (this.bigBallTimer > CFG.bigBallRespawn) {
      this.bigBallTimer = 0;
      if (this.bigBalls.length < CFG.maxBigBalls) this.spawnBigBall();
    }
    for (const b of this.bigBalls) {
      b.px = b.x; b.py = b.y; b.pz = b.z;
      b.pushT = Math.max(0, b.pushT - dt);
      // penguins push the ball (pushing with mittens out is stronger)
      for (const p of this.penguins) {
        if (!p.alive) continue;
        const dx = b.x - p.x, dz = b.z - p.z;
        const dh = Math.hypot(dx, dz);
        if (dh > b.r + CFG.radius + 0.12 || Math.abs((p.y + 0.5) - b.y) > b.r + 0.6) continue;
        const nx = dx / (dh || 1), nz = dz / (dh || 1);
        const pv = p.vx * nx + p.vz * nz;
        const intoBall = (p.input.moveZ !== 0 || p.input.moveX !== 0) ? 1 : 0;
        if (pv > 0.4 && intoBall) {
          const mass = b.r * b.r * b.r;
          const strength = (p.action === 'plow' ? 13 : 7) / Math.max(0.6, mass);
          const bv = b.vx * nx + b.vz * nz;
          const target = (p.action === 'plow' ? CFG.plowSpeed : CFG.walkSpeed) * 0.9;
          if (bv < target) { b.vx += nx * strength * dt; b.vz += nz * strength * dt; }
          b.lastPusher = p.id; b.pushT = 4;
        }
        // fast ball runs penguins over
        const rel = Math.hypot(b.vx - p.vx, b.vz - p.vz);
        if (rel > 3.2 && dh < b.r + CFG.radius && (b.vx * -nx + b.vz * -nz) > 2.5) {
          const pusher = this.penguin(b.lastPusher);
          const sameTeam = pusher && pusher.team === p.team;
          if (!sameTeam && p.invuln <= 0) {
            p.vx += b.vx * 1.2; p.vz += b.vz * 1.2; p.vy = 6;
            p.health = 0; p.sinceHit = 0;
            this.emit({ type: 'hit', pid: p.id, by: b.lastPusher, x: p.x, y: p.y + 0.6, z: p.z, health: 0 });
            this.splat(p, pusher ? pusher.id : -1, 'bigball');
          } else {
            p.vx += b.vx * 0.8; p.vz += b.vz * 0.8; p.vy = 3;
          }
        }
      }

      // gravity / rolling
      const bottom = b.y - b.r;
      const g = f.surfaceBelow(b.x, bottom + 0.2, b.z, 0.6, 1.0 + Math.max(0, -b.vy * dt));
      if (g !== null && bottom <= g + 0.05 && b.vy <= 0.1) {
        b.grounded = true;
        b.y = g + b.r; b.vy = 0;
        const n = this.groundNormalAt(b.x, g, b.z, b.r * 0.6);
        b.vx += CFG.gravity * n.y * n.x * dt * (5 / 7);
        b.vz += CFG.gravity * n.y * n.z * dt * (5 / 7);
        const sp = Math.hypot(b.vx, b.vz);
        const ice = this.isIce(b.x, b.z);
        const fr = (ice ? 0.15 : 0.55) * dt + sp * (ice ? 0.02 : 0.12) * dt;
        if (sp > 0) { const k = Math.max(0, sp - fr) / sp; b.vx *= k; b.vz *= k; }
      } else if (g !== null && bottom < g && b.vy <= 0) {
        b.y = g + b.r; b.vy = 0; b.grounded = true;
      } else {
        b.grounded = false;
        b.vy -= CFG.gravity * dt;
      }
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;

      const sp = Math.hypot(b.vx, b.vz);
      // carve through whatever is in front
      if (sp > 0.6) {
        const nx = b.vx / sp, nz = b.vz / sp;
        const cx = b.x + nx * b.r * 0.35, cz = b.z + nz * b.r * 0.35;
        const cy = b.y + 0.12;
        const present = f.sample(b.x + nx * b.r * 0.8, cy, b.z + nz * b.r * 0.8);
        if (present > 40) {
          const budget = sp * dt * Math.PI * b.r * b.r * 2040 * 1.3;
          const removed = f.removeMass(cx, cy, cz, b.r * 0.97, budget, 0.65);
          if (removed > 0) {
            const mass = (4 / 3) * Math.PI * b.r ** 3 * 2040;
            const k = Math.max(0, 1 - (removed / mass) * 0.55);
            b.vx *= k; b.vz *= k;
            if (removed > 120) this.emit({ type: 'crush', x: b.x + nx * b.r, y: b.y, z: b.z + nz * b.r, mass: removed, r: b.r });
            // packs a bit onto the ball
            const vol = (4 / 3) * Math.PI * b.r ** 3 + removed / 2040 * 0.15;
            b.r = Math.min(CFG.bigBallMaxRadius, Math.cbrt(vol * 3 / (4 * Math.PI)));
          }
          // still blocked by packed snow? stop dead and maybe burst
          if (f.sample(b.x + nx * b.r * 0.92, cy, b.z + nz * b.r * 0.92) > ISO + 60) {
            const before = sp;
            b.vx *= 0.4; b.vz *= 0.4;
            b.x -= nx * 0.05; b.z -= nz * 0.05;
            if (before > 6.5) { this.burstBall(b); continue; }
          }
        }
        // grow by rolling over fresh snow
        if (b.grounded && b.r < CFG.bigBallMaxRadius) {
          // picks up a layer of snow as wide as the ball, so bigger balls grow faster and leave a wider rut
          const got = this.isIce(b.x, b.z) ? 0 : f.removeMass(b.x, b.y - b.r - 0.05, b.z, Math.min(1.5, Math.max(0.5, b.r * 0.75)), sp * dt * b.r * CFG.ballGrowth, 0.6, 0.5);
          if (got > 0) {
            const vol = (4 / 3) * Math.PI * b.r ** 3 + got / 2040;
            b.r = Math.min(CFG.bigBallMaxRadius, Math.cbrt(vol * 3 / (4 * Math.PI)));
          }
        }
      }
      // trees
      for (const t of this.map.trees) {
        const dx = b.x - t.x, dz = b.z - t.z, d = Math.hypot(dx, dz), min = b.r + t.r;
        if (d < min && d > 1e-4 && b.y - b.r < t.y + t.h) {
          b.x = t.x + dx / d * min; b.z = t.z + dz / d * min;
          const vn = (b.vx * dx + b.vz * dz) / d; if (vn < 0) { b.vx -= 1.5 * vn * dx / d; b.vz -= 1.5 * vn * dz / d; }
        }
      }
      // playground
      {
        const pg = this.map.playground;
        if (boxPush(pg.boxes, b.x, b.z, b.y - b.r * 0.7, b.y + b.r * 0.7, b.r, pushTmp)) {
          b.x += pushTmp.x; b.z += pushTmp.z;
          const pl = Math.hypot(pushTmp.x, pushTmp.z) || 1;
          const nx = pushTmp.x / pl, nz = pushTmp.z / pl;
          const vn = b.vx * nx + b.vz * nz;
          if (vn < 0) { b.vx -= 1.5 * vn * nx; b.vz -= 1.5 * vn * nz; if (vn < -3) this.emit({ type: 'crush', x: b.x, y: b.y, z: b.z, mass: 600, r: b.r }); }
        }
        for (const c of pg.cyls) {
          if (b.y - b.r > c.y1) continue;
          const dx = b.x - c.x, dz = b.z - c.z, d = Math.hypot(dx, dz), min = b.r + c.r;
          if (d < min && d > 1e-4) { b.x = c.x + dx / d * min; b.z = c.z + dz / d * min; const vn = (b.vx * dx + b.vz * dz) / d; if (vn < 0) { b.vx -= 1.5 * vn * dx / d; b.vz -= 1.5 * vn * dz / d; } }
        }
      }
      // igloos
      for (const base of this.map.bases) {
        const dx = b.x - base.igloo.x, dz = b.z - base.igloo.z, d = Math.hypot(dx, dz), min = b.r + 2.4;
        if (d < min && d > 1e-4) {
          b.x = base.igloo.x + dx / d * min; b.z = base.igloo.z + dz / d * min;
          const vn = (b.vx * dx + b.vz * dz) / d; if (vn < 0) { b.vx -= 1.6 * vn * dx / d; b.vz -= 1.6 * vn * dz / d; }
        }
      }
      // snowman turrets: a rolling ball flattens them (not your own team's), a slow one just bumps
      for (const t of this.turrets) {
        if (!t.alive) continue;
        const dx = b.x - t.x, dz = b.z - t.z, d = Math.hypot(dx, dz), min = b.r + CFG.turretRadius;
        if (d >= min || d < 1e-4 || b.y - b.r > t.y + CFG.turretHeight) continue;
        const pusher = this.penguin(b.lastPusher);
        if (Math.hypot(b.vx, b.vz) > 2.5 && !(pusher && pusher.team === t.team)) {
          this.destroyTurret(t, pusher ? pusher.id : -1);
          b.vx *= 0.75; b.vz *= 0.75;
        } else {
          b.x = t.x + dx / d * min; b.z = t.z + dz / d * min;
          const vn = (b.vx * dx + b.vz * dz) / d; if (vn < 0) { b.vx -= 1.5 * vn * dx / d; b.vz -= 1.5 * vn * dz / d; }
        }
      }
      // arena edge
      const bd = this.map.bounds;
      if (b.x < bd.minX + b.r || b.x > bd.maxX - b.r || b.z < bd.minZ + b.r || b.z > bd.maxZ - b.r) {
        b.x = Math.max(bd.minX + b.r, Math.min(bd.maxX - b.r, b.x));
        b.z = Math.max(bd.minZ + b.r, Math.min(bd.maxZ - b.r, b.z));
        b.vx *= -0.3; b.vz *= -0.3;
      }
      // resting
      if (Math.hypot(b.vx, b.vz) < 0.15) b.restT += dt; else b.restT = 0;
      if (b.y < -5) b.alive = false;
    }
    // ball vs ball
    for (let a = 0; a < this.bigBalls.length; a++) for (let c = a + 1; c < this.bigBalls.length; c++) {
      const A = this.bigBalls[a], B = this.bigBalls[c];
      const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
      const d = Math.hypot(dx, dy, dz), min = A.r + B.r;
      if (d < min && d > 1e-4) {
        const nx = dx / d, nz = dz / d;
        const push = (min - d) * 0.5;
        A.x -= nx * push; A.z -= nz * push; B.x += nx * push; B.z += nz * push;
        const rel = (B.vx - A.vx) * nx + (B.vz - A.vz) * nz;
        if (rel < 0) {
          const ma = A.r ** 3, mb = B.r ** 3;
          const j = -1.6 * rel / (1 / ma + 1 / mb);
          A.vx -= j / ma * nx; A.vz -= j / ma * nz; B.vx += j / mb * nx; B.vz += j / mb * nz;
        }
      }
    }
    // too many sitting around? the oldest resting one crumbles into a snow pile
    if (this.bigBalls.length > CFG.maxBigBalls + CFG.maxMadeBalls - 2) {
      const resting = this.bigBalls.filter(b => b.restT > 10).sort((a, b) => b.restT - a.restT)[0];
      if (resting) this.burstBall(resting);
    }
    this.bigBalls = this.bigBalls.filter(b => b.alive);
  }

  private burstBall(b: BigBall) {
    b.alive = false;
    const vol = (4 / 3) * Math.PI * b.r ** 3 * 2040 * 0.7;
    this.field.pourColumns(b.x, b.z, b.r * 1.6, vol, b.y - b.r, b.y + b.r * 0.6);
    this.emit({ type: 'bigBurst', x: b.x, y: b.y, z: b.z, r: b.r });
  }

  private groundNormalAt(x: number, y: number, z: number, e: number) {
    const f = this.field;
    const hx1 = f.surfaceBelow(x + e, y, z, 1.2, 2) ?? y;
    const hx0 = f.surfaceBelow(x - e, y, z, 1.2, 2) ?? y;
    const hz1 = f.surfaceBelow(x, y, z + e, 1.2, 2) ?? y;
    const hz0 = f.surfaceBelow(x, y, z - e, 1.2, 2) ?? y;
    const gx = (hx1 - hx0) / (2 * e), gz = (hz1 - hz0) / (2 * e);
    const l = Math.hypot(gx, 1, gz);
    tmpN.x = -gx / l; tmpN.y = 1 / l; tmpN.z = -gz / l;
    return tmpN;
  }

  // ───────────────────────── snowman turrets ─────────────────────────
  /** Where a turret would stand if you aimed here: on the snow, clear of trees, props and other solid things. */
  private turretSpot(x: number, y: number, z: number): V3 | null {
    const g = this.field.surfaceBelow(x, y + 0.6, z, 0.3, 2.5);
    if (g === null) return null;
    const bd = this.map.bounds;
    if (x < bd.minX + 1 || x > bd.maxX - 1 || z < bd.minZ + 1 || z > bd.maxZ - 1) return null;
    const pg = this.map.playground;
    if (pointInBoxes(pg.boxes, x, g + 0.6, z, 0.45)) return null;
    for (const c of pg.cyls) if (g < c.y1 && Math.hypot(x - c.x, z - c.z) < c.r + 0.5) return null;
    for (const t of this.map.trees) if (Math.hypot(x - t.x, z - t.z) < t.r + 0.6) return null;
    for (const b of this.map.bases) {
      if (Math.hypot(x - b.igloo.x, z - b.igloo.z) < 3.1) return null;
      for (const sp of b.stockpiles) if (Math.hypot(x - sp.x, z - sp.z) < 1.6) return null;
    }
    return { x, y: g, z };
  }

  /**
   * Hold T: scoop the snow around you into a snowman at the aim point. It takes a lot (CFG.turretCost), so you leave a
   * proper crater. Let go early and what you've gathered stays there as a mound.
   */
  private doTurret(p: Penguin, dt: number, fx: number, fz: number) {
    p.turretBlock = 0;
    const f = this.field;
    if (!p.turretAt) {
      // aiming at snow within reach puts it there; aiming anywhere else puts it a couple of steps in front of you
      const a = this.aimInReach(p, 0.8) ?? { x: p.x + fx * 2.3, y: p.y + 0.6, z: p.z + fz * 2.3 };
      const spot = this.turretSpot(a.x, a.y, a.z);
      if (!spot) { p.turretBlock = 2; return; }
      if (this.turrets.some(t => t.alive && Math.hypot(t.x - spot.x, t.z - spot.z) < 2.4)) { p.turretBlock = 3; return; }
      if (this.turrets.filter(t => t.alive && t.team === p.team && t.owner !== p.id).length >= CFG.maxTeamTurrets) { p.turretBlock = 4; return; }
      p.turretAt = spot; p.turretSnow = 0;
    }
    const at = p.turretAt;
    if (Math.hypot(at.x - p.x, at.z - p.z) > CFG.reach + 2.5) { this.dropTurretSnow(p); return; } // walked off and left it
    p.aimOk = true;
    const want = CFG.turretRate * dt * this.rateMult(p);
    let got = 0, sx = p.x, sy = p.y, sz = p.z;
    for (let tries = 0; tries < 7 && got < want * 0.7; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = 0.9 + Math.random() * 2.1;
      const qx = p.x + Math.cos(ang) * rad, qz = p.z + Math.sin(ang) * rad;
      if (Math.hypot(qx - at.x, qz - at.z) < 1.5) continue; // not from under the snowman
      const qy = f.surfaceBelow(qx, p.y + 0.5, qz, 0.4, 1.4);
      if (qy === null) continue;
      const g = f.removeMass(qx, qy - 0.1, qz, 0.7, want - got, 0.45, 1.0);
      if (g > 0) { got += g; sx = qx; sy = qy; sz = qz; }
    }
    if (got <= 0) { p.noSnowT = 0.5; return; }
    p.turretSnow += got;
    const done = Math.min(1, p.turretSnow / CFG.turretCost);
    this.emit({ type: 'build', pid: p.id, x: sx, y: sy, z: sz, tx: at.x, ty: at.y + 0.3 + done * 1.3, tz: at.z, mass: got });
    if (p.turretSnow >= CFG.turretCost) {
      p.turretSnow = 0; p.turretAt = null;
      this.spawnTurret(p, at, false);
    }
  }

  /** Stopped building a turret part-way: the snow gathered so far stays where the snowman was going, as a mound. */
  private dropTurretSnow(p: Penguin) {
    const at = p.turretAt;
    if (at && p.turretSnow > 0) this.field.pourColumns(at.x, at.z, 1.0, p.turretSnow * 0.9, at.y, at.y + 1.5);
    p.turretSnow = 0; p.turretAt = null;
  }

  /** Each penguin keeps one turret: a new one melts their old one. */
  private spawnTurret(p: Penguin, at: V3, free: boolean) {
    const old = this.turrets.find(t => t.alive && t.owner === p.id);
    if (old) this.destroyTurret(old, -1);
    const t: Turret = {
      id: this.nextId++, owner: p.id, team: p.team, x: at.x, y: at.y, z: at.z, yaw: p.lookYaw,
      health: CFG.turretHealth, ammo: CFG.turretAmmo, cd: 1.2, target: -1, scanT: 0, fireT: 0, age: 0, alive: true,
    };
    this.turrets.push(t);
    this.emit({ type: 'turretBuilt', pid: p.id, tid: t.id, x: t.x, y: t.y, z: t.z, free });
    return t;
  }

  private hitTurret(t: Turret, by: number, x: number, y: number, z: number) {
    t.health--;
    this.emit({ type: 'turretHit', tid: t.id, by, x, y, z, health: t.health });
    if (t.health <= 0) this.destroyTurret(t, by);
  }

  private destroyTurret(t: Turret, by: number) {
    if (!t.alive) return;
    t.alive = false;
    this.field.pourColumns(t.x, t.z, 1.1, CFG.turretCost * 0.4, t.y, t.y + 1.4);
    this.emit({ type: 'turretDown', tid: t.id, team: t.team, owner: t.owner, by, x: t.x, y: t.y, z: t.z });
  }

  /** The nearest of your team's turrets you could hand snowballs to (it has room and you're beside it). */
  nearTurret(p: Penguin): Turret | null {
    let best: Turret | null = null, bd = CFG.turretRadius + 1.7;
    for (const t of this.turrets) {
      if (!t.alive || t.team !== p.team || t.ammo > CFG.turretAmmoMax - CFG.turretAmmoPerBall) continue;
      const d = Math.hypot(t.x - p.x, t.z - p.z);
      if (d < bd && Math.abs(t.y - p.y) < 2) { bd = d; best = t; }
    }
    return best;
  }

  private loadTurret(p: Penguin) {
    const t = this.nearTurret(p);
    if (!t) return;
    const n = Math.min(p.carried, Math.floor((CFG.turretAmmoMax - t.ammo) / CFG.turretAmmoPerBall));
    if (n <= 0) return;
    t.ammo += n * CFG.turretAmmoPerBall;
    p.carried -= n;
    this.emit({ type: 'turretLoad', pid: p.id, tid: t.id, n });
  }

  private turretTarget(t: Turret) {
    let best = -1, bd = CFG.turretRange;
    const ox = t.x, oy = t.y + 1.3, oz = t.z;
    for (const e of this.penguins) {
      if (e.team === t.team || !e.alive || e.invuln > 0) continue;
      const dx = e.x - ox, dy = e.y + 0.7 - oy, dz = e.z - oz;
      const d = Math.hypot(dx, dy, dz);
      if (d >= bd || d < 0.5) continue;
      const hit = this.field.raycast(ox, oy, oz, dx / d, dy / d, dz / d, d, 0.35);
      if (hit && hit.t < d - 0.6) continue; // snow in the way
      bd = d; best = e.id;
    }
    return best;
  }

  private stepTurrets(dt: number) {
    const f = this.field;
    for (const t of this.turrets) {
      if (!t.alive) continue;
      t.age += dt;
      t.cd = Math.max(0, t.cd - dt);
      t.fireT = Math.max(0, t.fireT - dt);
      // it sits on the snow: dig under it and it drops, bury it and it rides up
      const g = f.surfaceBelow(t.x, t.y + 0.8, t.z, 0.8, 6);
      if (g !== null) t.y = g > t.y ? Math.min(g, t.y + 3 * dt) : Math.max(g, t.y - 9 * dt);
      if (this.phase !== 'fight') continue;
      t.scanT -= dt;
      if (t.scanT <= 0) { t.scanT = 0.25; t.target = this.turretTarget(t); }
      const e = t.target >= 0 ? this.penguin(t.target) : undefined;
      if (!e || !e.alive) { t.target = -1; continue; }
      const my = t.y + 1.3;
      const d = Math.hypot(e.x - t.x, e.z - t.z);
      const flight = d / CFG.turretThrowSpeed;
      const ax = e.x + e.vx * flight * 0.6, az = e.z + e.vz * flight * 0.6, ay = e.y + (e.sliding ? 0.3 : 0.7);
      let turn = Math.atan2(-(ax - t.x), -(az - t.z)) - t.yaw;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      const max = CFG.turretTurn * dt;
      t.yaw += Math.max(-max, Math.min(max, turn));
      if (t.ammo > 0 && t.cd <= 0 && Math.abs(turn) < 0.15) {
        const err = d * CFG.turretSpread;
        const aim = { x: ax + (this.rand() * 2 - 1) * err, y: ay + (this.rand() * 2 - 1) * err * 0.4, z: az + (this.rand() * 2 - 1) * err };
        const from = { x: t.x - Math.sin(t.yaw) * 0.75, y: my, z: t.z - Math.cos(t.yaw) * 0.75 };
        const v = solveThrow(from, aim, CFG.turretThrowSpeed, CFG.snowballGravity);
        if (v) {
          this.snowballs.push({ id: this.nextId++, owner: t.owner, team: t.team, x: from.x, y: from.y, z: from.z, px: from.x, py: from.y, pz: from.z,
            vx: v.x, vy: v.y, vz: v.z, age: 0, alive: true, kind: 1 });
          t.ammo--; t.cd = CFG.turretFireEvery; t.fireT = 0.3;
          this.emit({ type: 'turretFire', tid: t.id, x: from.x, y: from.y, z: from.z });
        }
      }
    }
    if (this.turrets.some(t => !t.alive)) this.turrets = this.turrets.filter(t => t.alive);
  }

  // ───────────────────────── splat-streak rewards (Team Deathmatch) ─────────────────────────
  private addStreak(k: Penguin) {
    k.streak++;
    const cycle = CFG.streakAt[CFG.streakAt.length - 1];
    const reward = CFG.streakAt.indexOf(((k.streak - 1) % cycle) + 1);
    if (reward >= 0) k.rewards[reward]++;
    this.emit({ type: 'streak', pid: k.id, streak: k.streak, reward });
  }

  /** 0 = Snowball Frenzy, 1 = Insta-Turret (at the aim point if it's close, else right in front), 2 = Avalanche at the aim point. */
  private useReward(p: Penguin, r: number) {
    if (this.mode !== 'tdm' || this.phase !== 'fight' || r < 0 || r > 2 || !(p.rewards[r] > 0)) return;
    const a = p.input.aim;
    const fx = -Math.sin(p.lookYaw), fz = -Math.cos(p.lookYaw);
    let x = p.x, y = p.y, z = p.z;
    if (r === 0) {
      p.frenzyT = CFG.frenzyTime; p.carried = CFG.maxCarry; p.throwCd = 0;
    } else if (r === 1) {
      x = p.x + fx * 1.8; z = p.z + fz * 1.8;
      if (a) { const d = Math.hypot(a.x - p.x, a.z - p.z); if (d > 1 && d < CFG.reach + 2) { x = a.x; y = a.y; z = a.z; } }
      const spot = this.turretSpot(x, y, z);
      if (!spot || this.turrets.some(t => t.alive && Math.hypot(t.x - spot.x, t.z - spot.z) < 2.4)) { this.emit({ type: 'rewardFail', pid: p.id }); return; }
      this.dropTurretSnow(p);
      this.spawnTurret(p, spot, true);
      x = spot.x; y = spot.y; z = spot.z;
    } else {
      x = p.x + fx * 16; z = p.z + fz * 16;
      if (a) {
        const d = Math.hypot(a.x - p.x, a.z - p.z) || 1, k = Math.min(1, CFG.avalancheRange / d);
        x = p.x + (a.x - p.x) * k; z = p.z + (a.z - p.z) * k;
      }
      y = this.field.surfaceBelow(x, 26, z, 0, 30) ?? p.y;
      this.barrages.push({ owner: p.id, team: p.team, x, y, z, wait: CFG.avalancheDelay, left: CFG.avalancheBalls, acc: 0 });
    }
    p.rewards[r]--;
    this.emit({ type: 'reward', pid: p.id, reward: r, x, y, z });
  }

  private stepBarrages(dt: number) {
    if (!this.barrages.length) return;
    for (const b of this.barrages) {
      if (b.wait > 0) { b.wait -= dt; continue; }
      b.acc += dt * CFG.avalancheBalls / CFG.avalancheTime;
      while (b.acc >= 1 && b.left > 0) {
        b.acc--; b.left--;
        const a = this.rand() * Math.PI * 2, r = Math.sqrt(this.rand()) * CFG.avalancheRadius;
        const x = b.x + Math.cos(a) * r, z = b.z + Math.sin(a) * r, y = b.y + 24;
        this.snowballs.push({ id: this.nextId++, owner: b.owner, team: b.team, x, y, z, px: x, py: y, pz: z,
          vx: (this.rand() - 0.5) * 2.4, vy: -15, vz: (this.rand() - 0.5) * 2.4, age: 0, alive: true, kind: 2 });
      }
    }
    this.barrages = this.barrages.filter(b => b.left > 0);
  }

  // ───────────────────────── Conquest flags ─────────────────────────
  /** Stand on a flag with more penguins than the other team to pull it your way; every flag you hold scores over time. */
  private stepPoints(dt: number) {
    if (!this.points.length) return;
    const bt = this.mode === 'breakthrough';
    const active = bt ? this.map.sectors[this.sector].points : null;
    const capTime = bt ? CFG.btCaptureTime : CFG.captureTime;
    for (const pt of this.points) { pt.n0 = 0; pt.n1 = 0; }
    for (const p of this.penguins) {
      if (!p.alive) continue;
      for (const pt of this.points) {
        if (Math.hypot(p.x - pt.x, p.z - pt.z) < pt.r && Math.abs(p.y - pt.y) < 8) { if (p.team === 0) pt.n0++; else pt.n1++; }
      }
    }
    if (this.phase !== 'fight' || (bt && this.holdT > 0)) return;
    for (const pt of this.points) {
      if (active && !active.includes(pt.id)) continue; // Breakthrough: only this section's objectives are in play
      const diff = pt.n1 - pt.n0;
      if (diff !== 0) {
        // Breakthrough: the defenders win ground back more slowly than the attackers take it
        const rate = bt && diff > 0 ? CFG.btRetake : 1;
        pt.cap += Math.sign(diff) * rate * Math.pow(Math.min(CFG.captureCrowd, Math.abs(diff)), 0.75) / capTime * dt;
      } else if (pt.n0 === 0) {
        // nobody home: it settles back to whoever holds it
        const rest = pt.owner < 0 ? 0 : pt.owner === 0 ? -1 : 1;
        const step = dt / (capTime * 2.5);
        pt.cap += Math.max(-step, Math.min(step, rest - pt.cap));
      }
      pt.cap = Math.max(-1, Math.min(1, pt.cap));
      const side = pt.cap <= -1 ? 0 : pt.cap >= 1 ? 1 : -1;
      if (side >= 0 && pt.owner !== side) {
        const from = pt.owner;
        pt.owner = side;
        this.emit({ type: 'capture', point: pt.id, team: side, from });
      } else if (!bt && ((pt.owner === 0 && pt.cap >= 0) || (pt.owner === 1 && pt.cap <= 0))) {
        // (in Breakthrough an objective stays with whoever holds it until the other side has taken it all the way)
        this.emit({ type: 'neutral', point: pt.id, team: pt.owner });
        pt.owner = -1;
      }
    }
    if (bt) return; // no flag points in Breakthrough: it's sections and tickets
    for (let t = 0; t < 2; t++) {
      let held = 0;
      for (const pt of this.points) if (pt.owner === t) held++;
      this.capAcc[t] += held * CFG.conquestRate * dt;
      while (this.capAcc[t] >= 1) { this.capAcc[t]--; this.scores[t]++; }
    }
  }

  // ───────────────────────── Breakthrough ─────────────────────────
  /** Is this x somewhere the fight is right now? (From the attackers' camp to the end of the section in play.) */
  inPlay(x: number) {
    const secs = this.map.sectors;
    if (this.mode !== 'breakthrough' || !secs.length) return true;
    const end = this.sector + 1 < secs.length ? secs[this.sector + 1].lineX + 6 : this.map.bounds.maxX;
    return x > secs[this.sector].lineX - 4 && x < end;
  }

  /**
   * The attackers take every objective in a section to move the fight on to the next one, and win by taking the last.
   * Each attacker who goes down costs a ticket. With no tickets left nobody on the attack comes back: the defenders win
   * when the last attacker is down, or when the last stand runs out of time.
   */
  private stepBreakthrough(dt: number) {
    if (this.mode !== 'breakthrough' || this.phase !== 'fight') return;
    const secs = this.map.sectors;
    if (this.holdT > 0) {
      this.holdT -= dt;
      if (this.holdT <= 0) { this.holdT = 0; this.emit({ type: 'sectorOpen', sector: this.sector }); }
      return;
    }
    if (secs[this.sector].points.every(i => this.points[i].owner === ATTACK)) {
      const fallen = this.sector;
      if (fallen === secs.length - 1) {
        this.scores[DEFEND] = 0;
        this.emit({ type: 'sector', sector: fallen, tickets: 0 });
        this.endMatch(ATTACK);
        return;
      }
      const bonus = Math.round(CFG.btSectorTickets * this.opts.teamSize);
      this.sector++;
      this.holdT = CFG.btRegroup;
      this.lastStandT = -1;
      this.scores[ATTACK] += bonus;
      this.scores[DEFEND] = secs.length - this.sector;
      // the defenders' snowmen in the lost section crumble (they'd be throwing into the attackers' new camp)
      const line = secs[this.sector].lineX;
      for (const t of this.turrets) if (t.alive && t.team === DEFEND && t.x < line) this.destroyTurret(t, -1);
      // both camps start the next section with something in the pile
      for (let t = 0; t < 2; t++) this.piles[t] = Math.max(this.piles[t], CFG.startPile);
      this.emit({ type: 'sector', sector: fallen, tickets: bonus });
      return;
    }
    if (this.scores[ATTACK] <= 0) {
      if (this.lastStandT < 0) { this.lastStandT = CFG.btLastStand; this.emit({ type: 'lastStand' }); }
      this.lastStandT -= dt;
      const up = this.penguins.some(p => p.team === ATTACK && p.alive);
      if (!up || this.lastStandT <= 0) { this.lastStandT = 0; this.endMatch(DEFEND); }
    }
  }

  // ───────────────────────── the surfboard ─────────────────────────
  private stepBoard(dt: number) {
    const bd = this.board;
    if (!bd.active) {
      if (this.phase === 'fight' && this.map.boardSpots.length && this.fightLen - this.phaseT > CFG.boardSpawnDelay) {
        const spot = this.map.boardSpots[Math.floor(this.rand() * this.map.boardSpots.length)];
        bd.active = true; bd.holder = -1; bd.x = spot.x; bd.z = spot.z;
        bd.y = (this.field.surfaceBelow(spot.x, 25, spot.z, 0, 30) ?? 5) + 2; bd.vy = 0;
        this.emit({ type: 'board', pid: -1, what: 'spawn', x: bd.x, y: bd.y, z: bd.z, where: spot.name });
      }
      return;
    }
    for (const p of this.penguins) p.surfing = p.id === bd.holder && p.alive;
    if (bd.holder >= 0) {
      const h = this.penguin(bd.holder);
      if (!h || !h.alive) { bd.holder = -1; return; }
      bd.x = h.x; bd.y = h.y; bd.z = h.z;
      const sp = Math.hypot(h.vx, h.vz);
      if (sp > 0.5) bd.yaw = Math.atan2(-h.vx, -h.vz);
      return;
    }
    // lying around: fall onto the snow, wait for someone to grab it
    bd.vy -= CFG.gravity * dt;
    bd.y += bd.vy * dt;
    const g = this.field.surfaceBelow(bd.x, bd.y + 0.5, bd.z, 0.5, 4);
    if (g !== null && bd.y < g + 0.15) { bd.y = g + 0.15; bd.vy = 0; }
    if (bd.y < -5) { bd.active = false; return; }
    if (this.phase === 'end') return;
    for (const p of this.penguins) {
      if (!p.alive) continue;
      if (Math.hypot(p.x - bd.x, p.z - bd.z) < 1.2 && Math.abs(p.y - bd.y) < 1.6) {
        bd.holder = p.id; p.surfing = true; p.sliding = false;
        this.emit({ type: 'board', pid: p.id, what: 'grab', x: bd.x, y: bd.y, z: bd.z });
        break;
      }
    }
  }

  // ───────────────────────── shiny snowflakes ─────────────────────────
  private spawnFlake() {
    const spots = this.map.flakeSpots;
    const used = new Set(this.flakes.filter(f => f.active).map(f => f.spot));
    let free = spots.map((_, i) => i).filter(i => !used.has(i));
    // Breakthrough: snowflakes turn up where the fight is, not three sections away
    const near = free.filter(i => this.inPlay(spots[i].x));
    if (near.length) free = near;
    if (!free.length) return;
    const spot = free[Math.floor(this.rand() * free.length)];
    const s = spots[spot];
    const g = this.field.surfaceBelow(s.x, 25, s.z, 0, 30) ?? s.y - 1.1;
    this.flakes.push({ id: this.nextId++, spot, x: s.x, y: g + 1.1, z: s.z, active: true, t: 0 });
  }

  private stepFlakes(dt: number) {
    for (const f of this.flakes) {
      if (!f.active) { f.t -= dt; continue; }
      // keep it floating above whatever snow is under it now
      const g = this.field.surfaceBelow(f.x, f.y + 1.5, f.z, 0, 6);
      if (g !== null) f.y += ((g + 1.1) - f.y) * Math.min(1, dt * 3);
      for (const p of this.penguins) {
        if (!p.alive) continue;
        if (Math.hypot(p.x - f.x, (p.y + 0.6) - f.y, p.z - f.z) < 1.3) {
          f.active = false; f.t = CFG.flakeRespawn;
          p.mitten = Math.min(3, p.mitten + 1);
          this.emit({ type: 'flake', pid: p.id, level: p.mitten, x: f.x, y: f.y, z: f.z });
          break;
        }
      }
    }
    const respawn = this.flakes.filter(f => !f.active && f.t <= 0);
    this.flakes = this.flakes.filter(f => f.active || f.t > 0);
    for (let n = 0; n < respawn.length; n++) this.spawnFlake();
  }
}

// ───────────────────────── helpers ─────────────────────────
export function lookVelocity(yaw: number, pitch: number, speed: number) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp * speed, y: Math.sin(pitch) * speed, z: -Math.cos(yaw) * cp * speed };
}

/** Velocity to throw from `from` and land on `to` with a low arc. Null if it's out of range. */
export function solveThrow(from: V3, to: V3 | null, speed: number, g: number): V3 | null {
  if (!to) return null;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const D = Math.hypot(dx, dz);
  if (D < 0.4) return null;
  const v2 = speed * speed;
  const disc = v2 * v2 - g * (g * D * D + 2 * dy * v2);
  if (disc < 0) return null;
  const tan = (v2 - Math.sqrt(disc)) / (g * D);
  const th = Math.atan(tan);
  const c = Math.cos(th) * speed;
  return { x: dx / D * c, y: Math.sin(th) * speed, z: dz / D * c };
}
