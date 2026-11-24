// The game simulation: penguins, snowballs, big rolling snowballs, snowflakes, stockpiles and the match.
// No Three.js and no DOM, so the game server can run this exact code later.
import { SnowField, ISO } from '../world/SnowField';
import { MapDef, V3, mulberry32 } from '../world/MapDef';
import { CFG } from './config';
import { boxGround, boxPush, pointInBoxes, slideY } from '../world/Playground';

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
  aim: V3 | null; // point under the crosshair
}

export const emptyInput = (): PenguinInput => ({
  moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, slide: false, fire: false,
  plow: false, pack: false, dig: false, build: false, use: false, aim: null,
});

export type Action = 'idle' | 'plow' | 'pack' | 'dig' | 'build' | 'charge' | 'throw' | 'slide' | 'down';
export type Phase = 'build' | 'fight' | 'end';

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
  | { type: 'splat'; pid: number; by: number; x: number; y: number; z: number; cause: 'snowball' | 'bigball' }
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

  constructor(public id: number, public name: string, public team: number, public hat: string, public bot: boolean) {}
}

export interface Snowball {
  id: number; owner: number; team: number;
  x: number; y: number; z: number; px: number; py: number; pz: number;
  vx: number; vy: number; vz: number; age: number; alive: boolean;
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

export interface MatchOptions { teamSize: number; playerName: string; playerHat: string; }

const BOT_NAMES = ['Waddles', 'Sir Flaps', 'Pebble', 'Captain Ice', 'Nugget', 'Biscuit', 'Frosty', 'Wobbles', 'Sleet', 'Mittens',
  'Slushie', 'Tux', 'Puddles', 'Blizzard Bob', 'Chilly Willy Jr', 'Flipper', 'Snowcone', 'Sprinkles', 'Popsicle', 'Gizmo',
  'Noot', 'Pickle', 'Muffin', 'Dumpling', 'Squawk', 'Iceberg', 'Kevin', 'Frostbite', 'Bubbles', 'Toast'];
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
  time = 0;
  events: GameEvent[] = [];
  winner = -1;
  private nextId = 1;
  private bigBallTimer = 0;
  private rand = mulberry32(Date.now() & 0xffff);
  readonly playerId: number;

  constructor(readonly map: MapDef, readonly opts: MatchOptions) {
    this.field = map.field;
    // teams: player on team 0, bots fill the rest
    const names = [...BOT_NAMES].sort(() => this.rand() - 0.5);
    const player = new Penguin(this.nextId++, opts.playerName || 'You', 0, opts.playerHat, false);
    this.penguins.push(player);
    this.playerId = player.id;
    let n = 0;
    for (let team = 0; team < 2; team++) {
      const count = team === 0 ? opts.teamSize - 1 : opts.teamSize;
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

  spawn(p: Penguin, index?: number) {
    const base = this.map.bases[p.team];
    const list = base.spawns;
    const s = list[(index ?? Math.floor(this.rand() * list.length)) % list.length];
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
  }

  private updatePhase(dt: number) {
    if (this.phase === 'end') return;
    this.phaseT -= dt;
    if (this.phase === 'build' && this.phaseT <= 0) {
      this.phase = 'fight'; this.phaseT = CFG.fightPhase;
      this.emit({ type: 'phase', phase: 'fight' });
    } else if (this.phase === 'fight') {
      if (this.phaseT <= 0 || this.scores[0] >= CFG.scoreToWin || this.scores[1] >= CFG.scoreToWin) {
        this.phase = 'end'; this.phaseT = 0;
        this.winner = this.scores[0] === this.scores[1] ? -1 : this.scores[0] > this.scores[1] ? 0 : 1;
        this.emit({ type: 'phase', phase: 'end' });
        this.emit({ type: 'gameOver', winner: this.winner });
      }
    }
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

    if (!p.alive) {
      p.action = 'down';
      p.downT -= dt;
      p.vx *= 0.9; p.vz *= 0.9;
      if (p.downT <= 0) { this.spawn(p); this.emit({ type: 'respawn', pid: p.id }); }
      return;
    }
    if (this.phase === 'end') { p.vx = p.vz = 0; p.action = 'idle'; return; }

    if (p.health < CFG.maxHealth && p.sinceHit > CFG.regenDelay) { p.health++; p.sinceHit = CFG.regenDelay * 0.5; }

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
        if (p.carried > 0 && this.phase === 'fight') this.throwSnowball(p);
        p.charging = false; p.charge = 0;
      }
    }
    if (!p.charging && busy) {
      if (inp.plow) action = 'plow';
      else if (inp.pack) action = 'pack';
      else if (inp.dig) action = 'dig';
      else if (inp.build) action = 'build';
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

    // build phase: stay on your side of the ice line
    if (this.phase === 'build') {
      const lim = 1.0;
      if (p.team === 0 && p.x > -lim) { p.x = -lim; if (p.vx > 0) p.vx = 0; }
      if (p.team === 1 && p.x < lim) { p.x = lim; if (p.vx < 0) p.vx = 0; }
    }

    // ── snow work ──
    p.aimOk = false;
    if (action === 'plow') this.doPlow(p, dt, fwdX, fwdZ);
    else p.plowLoad *= 0.9;
    if (action === 'pack') this.doPack(p, dt, fwdX, fwdZ);
    if (action === 'dig') this.doDig(p, dt, fwdX, fwdZ);
    if (action === 'build') this.doBuild(p, dt, fwdX, fwdZ);

    // stockpile: tap = grab, hold = stash
    if (inp.use) {
      if (p.useT < 0) { p.useT = 0; p.useDone = false; }
      p.useT += dt;
      if (!p.useDone && p.useT >= CFG.useHoldTime) {
        p.useDone = true;
        const b = this.map.bases[p.team].stockpile;
        if (p.carried > 0 && Math.hypot(p.x - b.x, p.z - b.z) < CFG.stockRadius) {
          this.piles[p.team] += p.carried;
          this.emit({ type: 'stash', pid: p.id, n: p.carried });
          p.carried = 0;
        }
      }
    } else if (p.useT >= 0) {
      if (!p.useDone) this.tryGrab(p);
      p.useT = -1;
    }
  }

  tryGrab(p: Penguin) {
    for (let t = 0; t < 2; t++) {
      const b = this.map.bases[t].stockpile;
      if (Math.hypot(p.x - b.x, p.z - b.z) < CFG.stockRadius && this.piles[t] > 0 && p.carried < CFG.maxCarry) {
        const n = Math.min(CFG.maxCarry - p.carried, this.piles[t]);
        this.piles[t] -= n; p.carried += n;
        this.emit({ type: 'grab', pid: p.id, n, team: t, stolen: t !== p.team });
        return true;
      }
    }
    return false;
  }

  nearPile(p: Penguin): number {
    for (let t = 0; t < 2; t++) {
      const b = this.map.bases[t].stockpile;
      if (Math.hypot(p.x - b.x, p.z - b.z) < CFG.stockRadius) return t;
    }
    return -1;
  }

  isIce(x: number, z: number) {
    const pd = this.map.pond;
    if (Math.hypot(x - pd.x, z - pd.z) > pd.r - 0.3) return false;
    const g = this.field.surfaceBelow(x, pd.y + 0.3, z, 0.1, 0.6);
    return g !== null && Math.abs(g - pd.y) < 0.2;
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
    if (p.y < -4) { p.y = 30; this.spawn(p); }
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

  private doBuild(p: Penguin, dt: number, fx: number, fz: number) {
    const a = this.aimInReach(p, 0.6);
    if (!a) return;
    p.aimOk = true;
    const want = CFG.buildRate * dt * this.rateMult(p);
    // scoop from the ground around our feet (behind and to the sides), so building leaves a shallow trench around you
    let got = 0, sx = p.x, sy = p.y, sz = p.z;
    for (let tries = 0; tries < 4 && got < want * 0.5; tries++) {
      const ang = Math.PI * (0.45 + Math.random() * 1.1); // the back 200°
      const rad = 0.9 + Math.random() * 1.2;
      const c = Math.cos(ang), s = Math.sin(ang);
      const rx = -fz, rz = fx;
      const dirX = fx * c + rx * s, dirZ = fz * c + rz * s;
      sx = p.x + dirX * rad; sz = p.z + dirZ * rad;
      sy = this.field.surfaceBelow(sx, p.y + 0.5, sz, 0.4, 1.2) ?? p.y;
      got += this.field.removeMass(sx, sy - 0.1, sz, 0.55, want - got, 0.5, 0.55);
    }
    if (got <= 0) { p.noSnowT = 0.5; return; }
    // build toward the builder so walls grow out of surfaces
    const dx = p.x - a.x, dz = p.z - a.z, dl = Math.hypot(dx, dz) || 1;
    const bx = a.x + dx / dl * 0.18, bz = a.z + dz / dl * 0.18, by = a.y + 0.12;
    const added = this.field.addMass(bx, by, bz, 0.6, got, CFG.buildHard);
    if (added < got - 2) this.field.pourColumns(sx, sz, 0.6, got - added, sy, sy + 0.8);
    this.emit({ type: 'build', pid: p.id, x: sx, y: sy, z: sz, tx: bx, ty: by, tz: bz, mass: added });
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
      vx: v.x + p.vx * 0.3, vy: v.y, vz: v.z + p.vz * 0.3, age: 0, alive: true });
    p.carried--;
    p.throwCd = CFG.throwCooldown;
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
          const hitR = 0.42 + CFG.snowballRadius;
          let d: number;
          if (p.sliding) d = Math.hypot(b.x - p.x, b.y - (p.y + 0.3), b.z - p.z);
          else {
            const cy = Math.max(p.y + 0.3, Math.min(p.y + 1.05, b.y));
            d = Math.hypot(b.x - p.x, b.y - cy, b.z - p.z);
          }
          if (d < hitR) { this.hitPenguin(p, b); b.alive = false; break; }
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
          if (b.y < t.y + t.h && Math.hypot(b.x - t.x, b.z - t.z) < 0.25 + (1 - (b.y - t.y) / t.h) * 1.2 * (t.h / 5)) {
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
    if (p.health <= 0) this.splat(p, b.owner, 'snowball');
  }

  splat(p: Penguin, by: number, cause: 'snowball' | 'bigball') {
    if (!p.alive) return;
    p.alive = false;
    p.downT = CFG.respawnTime;
    p.downs++;
    p.sliding = false; p.charging = false; p.charge = 0;
    p.mitten = Math.max(0, p.mitten - 1);
    const killer = this.penguin(by);
    if (killer && killer.team !== p.team) {
      killer.splats++;
      if (this.phase === 'fight') this.scores[killer.team]++;
    }
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
    const order = spots.map((_, i) => i);
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
          const got = f.removeMass(b.x, b.y - b.r - 0.05, b.z, Math.min(0.9, b.r * 0.6), sp * dt * 260, 0.6);
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
    if (this.bigBalls.length > CFG.maxBigBalls + 2) {
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

  // ───────────────────────── the surfboard ─────────────────────────
  private stepBoard(dt: number) {
    const bd = this.board;
    if (!bd.active) {
      if (this.phase === 'fight' && CFG.fightPhase - this.phaseT > CFG.boardSpawnDelay) {
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
    const free = spots.map((_, i) => i).filter(i => !used.has(i));
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
