// Bot penguins: they build forts in the build phase, pack and stash snowballs, then fight, grab snowflakes and roll big balls.
import { ISO } from '../world/SnowField';
import { V3 } from '../world/MapDef';
import { World, Penguin, solveThrow } from './World';
import { CFG } from './config';

type Goal = 'build' | 'pack' | 'stash' | 'grab' | 'fight' | 'flake' | 'roll' | 'retreat' | 'advance' | 'board';

const wrap = (a: number) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

export class BotBrain {
  goal: Goal = 'pack';
  role: 'builder' | 'packer' | 'roller';
  skill: number;
  private t = 0;
  private losT = 0;
  private targetId = -1;
  private targetVisible = false;
  private strafeT = 0;
  private strafeDir = 1;
  private chargeGoal = 0;
  private stuckT = 0;
  private buildSpot: V3 | null = null;
  private buildT = 0;
  private wallSide = 1;
  private ballId = -1;
  private rollT = 0;
  private advanceSpot: V3 | null = null;
  private reactT = 0;

  constructor(private index: number, rnd: () => number) {
    const r = rnd();
    this.role = r < 0.45 ? 'builder' : r < 0.85 ? 'packer' : 'roller';
    this.skill = 0.55 + rnd() * 0.4;
    this.strafeDir = rnd() < 0.5 ? -1 : 1;
  }

  think(w: World, p: Penguin, dt: number) {
    const inp = p.input;
    inp.fire = inp.fire && p.charging; // keep holding only while charging
    inp.plow = inp.pack = inp.dig = inp.build = inp.use = false;
    inp.slide = false;
    inp.moveX = 0; inp.moveZ = 0;
    if (!p.alive || w.phase === 'end') { inp.fire = false; return; }
    this.t += dt;
    this.losT -= dt;
    this.reactT -= dt;

    const base = w.map.bases[p.team];
    const enemyBase = w.map.bases[1 - p.team];
    const toCenter = p.team === 0 ? 1 : -1;

    // ── choose a goal ──
    if (w.phase === 'build') {
      if (this.role === 'builder' && this.t < CFG.buildPhase - 3) this.goal = 'build';
      else this.goal = p.carried >= CFG.maxCarry ? 'stash' : 'pack';
    } else {
      this.pickTarget(w, p);
      const flake = this.nearestFlake(w, p);
      if (p.carried === 0) {
        const pileDist = Math.hypot(p.x - base.stockpile.x, p.z - base.stockpile.z);
        this.goal = w.piles[p.team] > 0 && pileDist < 30 ? 'grab' : 'pack';
      } else if (p.health === 1 && p.sinceHit < 4 && this.targetVisible) {
        this.goal = 'retreat';
      } else if (w.board.active && w.board.holder < 0 && Math.hypot(w.board.x - p.x, w.board.z - p.z) < 22) {
        this.goal = 'board';
      } else if (flake && flake.d < 14 && p.mitten < 3 && !(this.targetVisible && p.carried > 0 && this.targetDist(w, p) < 14)) {
        this.goal = 'flake';
      } else if (this.role === 'roller' && this.findBall(w, p)) {
        this.goal = 'roll';
      } else if (this.targetId >= 0) {
        this.goal = 'fight';
      } else {
        this.goal = 'advance';
      }
    }

    switch (this.goal) {
      case 'build': this.doBuild(w, p, dt, base, toCenter); break;
      case 'pack': {
        inp.pack = true;
        this.faceYaw(p, base.facing + Math.sin(this.t * 0.3 + this.index) * 1.2);
        if (p.noSnowT > 0) inp.moveZ = 1;
        // during the fight, don't pack in the open next to an enemy: back off toward home
        if (w.phase === 'fight' && this.targetVisible && this.targetDist(w, p) < 12) { inp.pack = false; this.moveTo(w, p, base.center, 2, dt); }
        break;
      }
      case 'stash': {
        if (this.moveTo(w, p, base.stockpile, 1.4, dt)) { inp.use = true; }
        break;
      }
      case 'grab': {
        if (this.moveTo(w, p, base.stockpile, 1.4, dt)) {
          // tap: alternate frames so the sim sees press + release
          inp.use = (Math.floor(this.t * 10) % 2) === 0;
        }
        break;
      }
      case 'flake': {
        const f = this.nearestFlake(w, p)!;
        this.moveTo(w, p, f.f, 0.5, dt);
        this.combatWhileMoving(w, p);
        break;
      }
      case 'board': {
        this.moveTo(w, p, { x: w.board.x, y: w.board.y, z: w.board.z }, 0.3, dt);
        this.combatWhileMoving(w, p);
        break;
      }
      case 'retreat': {
        this.moveTo(w, p, base.center, 2, dt);
        if (Math.hypot(p.vx, p.vz) > 3 && this.downhill(w, p)) inp.slide = true;
        break;
      }
      case 'roll': this.doRoll(w, p, dt, enemyBase.center); break;
      case 'fight': this.doFight(w, p, dt); break;
      case 'advance': {
        if (!this.advanceSpot || Math.hypot(p.x - this.advanceSpot.x, p.z - this.advanceSpot.z) < 2.5 || Math.random() < 0.002) {
          const x = toCenter * -(4 + Math.random() * 12);
          const z = (Math.random() * 2 - 1) * 20;
          this.advanceSpot = { x: base.center.x * 0 + x, y: 0, z };
        }
        this.moveTo(w, p, this.advanceSpot, 1, dt);
        if (Math.hypot(p.vx, p.vz) > 3.5 && this.downhill(w, p) && Math.hypot(p.x - this.advanceSpot.x, p.z - this.advanceSpot.z) > 10) inp.slide = true;
        break;
      }
    }
  }

  private targetDist(w: World, p: Penguin) {
    const t = w.penguin(this.targetId);
    return t ? Math.hypot(t.x - p.x, t.z - p.z) : 999;
  }

  private pickTarget(w: World, p: Penguin) {
    if (this.losT > 0) return;
    this.losT = 0.25 + Math.random() * 0.15;
    let best = -1, bestD = 40;
    let vis = false;
    for (const e of w.penguins) {
      if (e.team === p.team || !e.alive) continue;
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      if (d > bestD) continue;
      const seen = this.canSee(w, p, e);
      const score = d * (seen ? 1 : 1.8);
      if (score < bestD) { bestD = score; best = e.id; vis = seen; }
    }
    if (best !== this.targetId) this.reactT = 0.35 + (1 - this.skill) * 0.5;
    this.targetId = best;
    this.targetVisible = vis;
  }

  private canSee(w: World, p: Penguin, e: Penguin) {
    const ox = p.x, oy = p.y + 1.1, oz = p.z;
    const dx = e.x - ox, dy = e.y + 0.7 - oy, dz = e.z - oz;
    const d = Math.hypot(dx, dy, dz);
    const hit = w.field.raycast(ox, oy, oz, dx / d, dy / d, dz / d, d, 0.35);
    return !hit || hit.t > d - 0.6;
  }

  private nearestFlake(w: World, p: Penguin) {
    let best: { f: V3; d: number } | null = null;
    for (const f of w.flakes) {
      if (!f.active) continue;
      const d = Math.hypot(f.x - p.x, f.z - p.z);
      if (!best || d < best.d) best = { f: { x: f.x, y: f.y, z: f.z }, d };
    }
    return best;
  }

  private faceYaw(p: Penguin, yaw: number) {
    const cur = p.input.yaw;
    p.input.yaw = cur + wrap(yaw - cur) * 0.25;
  }

  private yawTo(p: Penguin, x: number, z: number) { return Math.atan2(-(x - p.x), -(z - p.z)); }

  /** Walk toward a point (facing it). Returns true once within `near`. */
  private moveTo(w: World, p: Penguin, to: V3, near: number, dt: number, faceAlso = true) {
    const dx = to.x - p.x, dz = to.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < near) return true;
    let yaw = this.yawTo(p, to.x, to.z);
    // look a little ahead for walls
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const ahead = w.field.sample(p.x + fx * 1.1, p.y + 0.8, p.z + fz * 1.1) > ISO;
    if (ahead) {
      const low = w.field.sample(p.x + fx * 1.1, p.y + 1.3, p.z + fz * 1.1) <= ISO;
      if (low && p.grounded) p.input.jump = true;
      else yaw += this.strafeDir * 0.9;
    }
    if (faceAlso) this.faceYaw(p, yaw);
    const rel = wrap(yaw - p.input.yaw);
    p.input.moveZ = Math.cos(rel);
    p.input.moveX = -Math.sin(rel);
    // stuck?
    if (Math.hypot(p.vx, p.vz) < 0.6) { this.stuckT += dt; if (this.stuckT > 0.8) { p.input.jump = true; this.strafeDir *= -1; this.stuckT = 0; } }
    else this.stuckT = 0;
    return false;
  }

  /** Move in a world direction while facing another direction. */
  private moveDir(p: Penguin, dirX: number, dirZ: number) {
    const yaw = p.input.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    p.input.moveZ = dirX * fx + dirZ * fz;
    p.input.moveX = dirX * rx + dirZ * rz;
  }

  private downhill(w: World, p: Penguin) {
    const sp = Math.hypot(p.vx, p.vz);
    if (sp < 0.1) return false;
    const ahead = w.field.surfaceBelow(p.x + p.vx / sp * 2, p.y + 1, p.z + p.vz / sp * 2, 1, 4);
    return ahead !== null && ahead < p.y - 0.25;
  }

  private doBuild(w: World, p: Penguin, dt: number, base: { center: V3; facing: number }, toCenter: number) {
    if (!this.buildSpot) {
      const row = this.index % 3;
      const lane = ((this.index * 7) % 5) - 2;
      this.buildSpot = { x: base.center.x + toCenter * (10 + row * 5), y: 0, z: lane * 4.5 + (row % 2) * 2 };
    }
    if (!this.moveTo(w, p, this.buildSpot, 0.8, dt)) { this.buildT = 0; return; }
    this.buildT += dt;
    // face the enemy and build a wall 2m ahead, shuffling sideways to make it wide
    const yaw = base.facing;
    this.faceYaw(p, yaw);
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const eyeY = p.y + 1.2;
    const pitch = -0.32;
    const dx = fx * Math.cos(pitch), dy = Math.sin(pitch), dz = fz * Math.cos(pitch);
    const hit = w.field.raycast(p.x, eyeY, p.z, dx, dy, dz, 4, 0.15);
    if (hit) {
      p.input.aim = { x: hit.x, y: hit.y, z: hit.z };
      p.input.build = true;
      // wall tall enough here? shuffle sideways
      const wallTop = w.field.surfaceBelow(p.x + fx * 2, p.y + 2.5, p.z + fz * 2, 0, 3) ?? p.y;
      if (wallTop - p.y > 1.15 || this.buildT > 4) {
        this.buildT = 0;
        const rx = Math.cos(yaw), rz = -Math.sin(yaw);
        this.buildSpot = { x: this.buildSpot.x + rx * this.wallSide * 1.4, y: 0, z: this.buildSpot.z + rz * this.wallSide * 1.4 };
        if (Math.abs(this.buildSpot.z) > 14) this.wallSide *= -1;
      }
    }
  }

  private findBall(w: World, p: Penguin) {
    if (this.ballId >= 0) {
      const b = w.bigBalls.find(b => b.id === this.ballId);
      if (b && this.rollT < 9) return b;
      this.ballId = -1; this.rollT = 0;
    }
    let best = null, bd = 18;
    for (const b of w.bigBalls) {
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      if (d < bd && Math.hypot(b.vx, b.vz) < 2) { bd = d; best = b; }
    }
    if (best) { this.ballId = best.id; this.rollT = 0; }
    return best;
  }

  private doRoll(w: World, p: Penguin, dt: number, enemy: V3) {
    const b = w.bigBalls.find(b => b.id === this.ballId);
    if (!b) return;
    this.rollT += dt;
    const dx = enemy.x - b.x, dz = enemy.z - b.z, d = Math.hypot(dx, dz) || 1;
    const behind = { x: b.x - dx / d * (b.r + 0.7), y: 0, z: b.z - dz / d * (b.r + 0.7) };
    if (Math.hypot(p.x - behind.x, p.z - behind.z) > 1.0 && Math.hypot(b.vx, b.vz) < 1) {
      // walk around the ball to get behind it
      const side = { x: behind.x + (-dz / d) * this.strafeDir * 0.5, y: 0, z: behind.z + (dx / d) * this.strafeDir * 0.5 };
      this.moveTo(w, p, side, 0.4, dt);
    } else {
      this.faceYaw(p, this.yawTo(p, b.x, b.z));
      p.input.moveZ = 1;
      p.input.plow = true;
      if (Math.hypot(b.vx, b.vz) > 4.5) { this.ballId = -1; this.rollT = 0; }
    }
    this.combatWhileMoving(w, p);
  }

  private doFight(w: World, p: Penguin, dt: number) {
    const t = w.penguin(this.targetId);
    if (!t) return;
    const dx = t.x - p.x, dz = t.z - p.z, d = Math.hypot(dx, dz) || 1;
    const want = 11 + this.skill * 5;
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafeT = 0.8 + Math.random() * 1.6; this.strafeDir = Math.random() < 0.5 ? -1 : 1; }
    // face the target
    this.faceYaw(p, this.yawTo(p, t.x, t.z));
    let mx = 0, mz = 0;
    if (!this.targetVisible) { mx = dx / d; mz = dz / d; }
    else if (d > want + 4) { mx = dx / d * 0.8; mz = dz / d * 0.8; }
    else if (d < want - 4) { mx = -dx / d * 0.7; mz = -dz / d * 0.7; }
    mx += (-dz / d) * this.strafeDir * 0.7; mz += (dx / d) * this.strafeDir * 0.7;
    // bump into a wall? hop or reverse the strafe
    const ml = Math.hypot(mx, mz) || 1;
    if (w.field.sample(p.x + mx / ml * 1.0, p.y + 0.8, p.z + mz / ml * 1.0) > ISO) { this.strafeDir *= -1; }
    this.moveDir(p, mx / ml, mz / ml);
    // move on the ball in front of us? stand still and pack if empty-handed
    this.combatWhileMoving(w, p);
  }

  private combatWhileMoving(w: World, p: Penguin) {
    if (w.phase !== 'fight' || p.carried === 0) { p.input.fire = false; return; }
    const t = w.penguin(this.targetId);
    if (!t || !this.targetVisible || !t.alive || this.reactT > 0) { if (!p.charging) p.input.fire = false; return; }
    const d = Math.hypot(t.x - p.x, t.z - p.z);
    if (d > 34) { p.input.fire = false; return; }
    if (!p.charging && p.throwCd <= 0) {
      p.input.fire = true;
      this.chargeGoal = d > 24 ? 0.8 : d > 15 ? 0.35 : Math.random() * 0.2;
      return;
    }
    if (p.charging) {
      // aim with lead + human-ish error
      p.input.yaw = this.yawTo(p, t.x, t.z);
      const speed = (CFG.throwSpeedMin + (CFG.throwSpeedMax - CFG.throwSpeedMin) * p.charge) * (1 + p.mitten * CFG.throwPerLevel);
      const h = w.handPos(p);
      let aim = { x: t.x, y: t.y + (t.sliding ? 0.3 : 0.7), z: t.z };
      for (let it = 0; it < 2; it++) {
        const v = solveThrow(h, aim, speed, CFG.snowballGravity);
        const flight = v ? Math.hypot(aim.x - h.x, aim.z - h.z) / Math.max(1, Math.hypot(v.x, v.z)) : d / speed;
        const lead = this.skill * 0.9;
        aim = { x: t.x + t.vx * flight * lead, y: t.y + (t.sliding ? 0.3 : 0.7), z: t.z + t.vz * flight * lead };
      }
      const err = (0.25 + d * 0.05) * (1.3 - this.skill);
      aim.x += (Math.random() * 2 - 1) * err; aim.z += (Math.random() * 2 - 1) * err; aim.y += (Math.random() * 2 - 1) * err * 0.4;
      p.input.aim = aim;
      if (p.charge >= this.chargeGoal) p.input.fire = false; // release → throw
      else p.input.fire = true;
    }
  }
}
