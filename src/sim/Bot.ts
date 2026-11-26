// Bot penguins: they build forts and turrets in the build phase, pack and stash snowballs, then fight, grab snowflakes,
// roll big balls, knock down turrets, spend their streak rewards, in Conquest take and hold the flags, and in
// Breakthrough attack or defend the section's objectives. They pick up guns that are close by and use them: hot
// chocolate on turrets, on walls someone is hiding behind and on anyone close; water on whoever they can see.
import { ISO } from '../world/SnowField';
import { V3 } from '../world/MapDef';
import { houseLocal, turned } from '../world/Landmarks';
import { World, Penguin, solveThrow } from './World';
import { CFG } from './config';
import { GUN_WATER, GUN_COCOA, GUN_BLADE } from './Guns';

type Goal = 'build' | 'pack' | 'stash' | 'grab' | 'fight' | 'flake' | 'roll' | 'retreat' | 'advance' | 'board' | 'turret' | 'capture' | 'gun';

/** What a bot is throwing at: a penguin or an enemy turret. */
interface Mark { x: number; y: number; z: number; vx: number; vz: number; h: number; alive: boolean; }

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
  private turretId = -1; // an enemy turret to knock down when no penguin is in sight
  private turretJob: boolean; // this bot puts up a snowman turret
  private raider: boolean; // Conquest: this bot likes to sneak round to the enemy's home flag
  private turretSpot: V3 | null = null;
  private turretT = 0;
  private turretWait = 0;
  private objective = -1; // Conquest: the flag this bot is going for
  private objectiveT = 0;
  private holdSpot: V3 | null = null;
  private rewardT = 0;
  private detourT = 0;
  private homeZ: number | null = null; // where along the team's line this bot builds
  private sector = 0; // Breakthrough: the section this bot's plans were made for
  private slot: number;
  private rnd: () => number;

  /** slot = this bot's number within its own team, so both teams get the same mix of jobs */
  constructor(private index: number, rnd: () => number, slot = index) {
    this.role = (['packer', 'builder', 'roller', 'packer', 'builder', 'builder', 'packer', 'roller', 'packer', 'builder'] as const)[slot % 10];
    this.skill = 0.55 + rnd() * 0.4;
    this.turretJob = slot % 5 === 1;
    this.raider = slot % 5 === 3;
    this.slot = slot;
    this.rnd = rnd;
    this.strafeDir = rnd() < 0.5 ? -1 : 1;
  }

  think(w: World, p: Penguin, dt: number) {
    const inp = p.input;
    inp.fire = inp.fire && p.charging; // keep holding only while charging
    inp.plow = inp.pack = inp.dig = inp.build = inp.use = inp.roll = inp.turret = false;
    inp.slide = false;
    inp.gun = false;
    inp.moveX = 0; inp.moveZ = 0;
    if (!p.alive || w.phase === 'end') { inp.fire = false; return; }
    this.t += dt;
    this.losT -= dt;
    this.reactT -= dt;
    this.detourT -= dt;
    this.turretWait -= dt;

    const conquest = w.mode === 'conquest', bt = w.mode === 'breakthrough', flags = conquest || bt;
    if (bt && w.sector !== this.sector) {
      // the fight moved on to the next section: forget every plan made for the old one
      this.sector = w.sector;
      this.objective = -1; this.objectiveT = 0; this.holdSpot = null; this.buildSpot = null;
      this.turretSpot = null; this.turretT = 0; this.turretWait = 0; this.homeZ = null; this.ballId = -1;
    }
    const front = w.front(p.team);
    // the nearest of the team's stockpiles is "home" for grabbing, stashing and falling back
    const pile = w.nearestPile(p.team, p.x, p.z);
    const base = { center: front.center, facing: front.facing, stockpile: pile };
    const enemyBase = w.front(1 - p.team);
    const toCenter = p.team === 0 ? 1 : -1;
    if (this.homeZ === null) this.homeZ = p.z;

    // ── choose a goal ──
    if (w.phase === 'build') {
      // builders build; packers switch to building once the stockpile is healthy
      // (Breakthrough attackers have nothing to fortify: they all stock up for the push)
      if (bt && p.team === 0) this.goal = p.carried >= CFG.maxCarry ? 'stash' : 'pack';
      else if (this.turretJob && this.turretWait <= 0 && this.wantsTurret(w, p) && this.t < w.buildLen - 4) this.goal = 'turret';
      else if ((this.role === 'builder' || (w.piles[p.team] >= 18 && p.carried === 0)) && this.t < w.buildLen - 3) this.goal = 'build';
      else this.goal = p.carried >= CFG.maxCarry ? 'stash' : 'pack';
    } else {
      this.pickTarget(w, p);
      this.spendRewards(w, p, dt);
      if (flags) this.pickObjective(w, p, dt);
      const flake = this.nearestFlake(w, p);
      const marked = this.targetId >= 0 || this.turretId >= 0;
      const pt = flags ? w.points[this.objective] : undefined;
      const onFlag = !!pt && Math.hypot(p.x - pt.x, p.z - pt.z) < pt.r;
      const pileDist = Math.hypot(p.x - base.stockpile.x, p.z - base.stockpile.z);
      const crate = p.gun ? null : this.nearestGun(w, p);
      if (p.gun && marked && this.targetDist(w, p) < (p.gun === GUN_WATER ? 22 : p.gun === GUN_BLADE ? 10 : 15) && (this.targetVisible || p.gun === GUN_COCOA)) {
        // a gun with something in the tank and someone to use it on: that comes before stocking up on snowballs
        this.goal = 'fight';
      } else if (p.carried === 0) {
        this.goal = w.piles[p.team] > 0 && pileDist < (flags ? 20 : 34) ? 'grab' : 'pack';
      } else if (bt && p.team === 0 && w.holdT > 0 && p.carried < CFG.maxCarry) {
        // waiting for the next section to open: fill your flippers
        this.goal = w.piles[p.team] > 0 && pileDist < 30 ? 'grab' : 'pack';
      } else if (p.health === 1 && p.sinceHit < 4 && this.targetVisible && !onFlag) {
        this.goal = 'retreat';
      } else if (w.board.active && w.board.holder < 0 && Math.hypot(w.board.x - p.x, w.board.z - p.z) < (flags ? 14 : 26)) {
        this.goal = 'board';
      } else if (crate && crate.d < (flags ? 12 : 20) && !(this.targetVisible && this.targetDist(w, p) < 12)) {
        this.goal = 'gun';
      } else if (flake && flake.d < (flags ? 9 : 16) && p.mitten < 3 && !(this.targetVisible && p.carried > 0 && this.targetDist(w, p) < 14)) {
        this.goal = 'flake';
      } else if (this.role === 'roller' && (!flags || (bt && p.team === 1 && w.holdT <= 0)) && this.findBall(w, p)) {
        this.goal = 'roll'; // Breakthrough: the defenders' rollers send giant snowballs at the attack
      } else if (flags && pt) {
        // the flag comes first: fight from inside the ring, and only chase enemies that are close to the way there
        if (marked && this.targetVisible && (onFlag || this.targetDist(w, p) < 22)) this.goal = 'fight';
        else if (onFlag && this.turretJob && pt.owner === p.team && pt.n0 * pt.n1 === 0 && this.turretWait <= 0 && this.wantsTurret(w, p)) this.goal = 'turret';
        else this.goal = 'capture';
      } else if (marked) {
        this.goal = 'fight';
      } else {
        this.goal = 'advance';
      }
    }

    switch (this.goal) {
      case 'build': this.doBuild(w, p, dt, base, toCenter); break;
      case 'turret': this.doTurret(w, p, dt, base, toCenter); break;
      case 'capture': this.doCapture(w, p, dt, base); break;
      case 'pack': {
        inp.pack = true;
        this.faceYaw(p, base.facing + Math.sin(this.t * 0.3 + this.index) * 1.2);
        if (p.noSnowT > 0) inp.moveZ = 1;
        // during the fight, don't pack in the open next to an enemy: back off toward home (in Conquest, hold the flag instead)
        if (w.phase === 'fight' && this.targetVisible && this.targetDist(w, p) < 12 && this.targetId >= 0) {
          const pt = flags ? w.points[this.objective] : undefined;
          if (!pt || Math.hypot(p.x - pt.x, p.z - pt.z) > pt.r) { inp.pack = false; this.moveTo(w, p, base.stockpile, 2, dt); }
        }
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
      case 'gun': {
        const c = this.nearestGun(w, p);
        if (c) this.moveTo(w, p, c.c, 0.3, dt);
        this.combatWhileMoving(w, p);
        break;
      }
      case 'retreat': {
        this.moveTo(w, p, base.stockpile, 2, dt);
        if (Math.hypot(p.vx, p.vz) > 3 && this.downhill(w, p)) inp.slide = true;
        break;
      }
      case 'roll': this.doRoll(w, p, dt, enemyBase.center); break;
      case 'fight': this.doFight(w, p, dt); break;
      case 'advance': {
        if (!this.advanceSpot || Math.hypot(p.x - this.advanceSpot.x, p.z - this.advanceSpot.z) < 2.5 || Math.random() < 0.002) {
          // spread out across the whole width of the map: every bot has its own lane, and now and then moves over one
          const bd = w.map.bounds, lanes = 6;
          const lane = (this.index * 5 + Math.floor(this.t / 40)) % lanes;
          const x = w.map.midLineX + toCenter * -(3 + Math.random() * 17);
          const z = bd.minZ + 10 + (lane + Math.random()) * (bd.maxZ - bd.minZ - 20) / lanes;
          this.advanceSpot = { x, y: 0, z };
        }
        this.moveTo(w, p, this.advanceSpot, 1, dt);
        if (Math.hypot(p.vx, p.vz) > 3.5 && this.downhill(w, p) && Math.hypot(p.x - this.advanceSpot.x, p.z - this.advanceSpot.z) > 10) inp.slide = true;
        break;
      }
    }
  }

  /** Whoever (or whatever) this bot is throwing at right now. */
  private mark(w: World): Mark | null {
    if (this.targetId >= 0) {
      const t = w.penguin(this.targetId);
      return t ? { x: t.x, y: t.y, z: t.z, vx: t.vx, vz: t.vz, h: t.sliding ? 0.3 : 0.7, alive: t.alive } : null;
    }
    if (this.turretId >= 0) {
      const t = w.turrets.find(q => q.id === this.turretId);
      return t ? { x: t.x, y: t.y, z: t.z, vx: 0, vz: 0, h: 1.0, alive: t.alive } : null;
    }
    return null;
  }

  private targetDist(w: World, p: Penguin) {
    const t = this.mark(w);
    return t ? Math.hypot(t.x - p.x, t.z - p.z) : 999;
  }

  /** Streak rewards don't wait around: frenzy when there's someone to throw at, a turret at their feet, an Avalanche on their target. */
  private spendRewards(w: World, p: Penguin, dt: number) {
    if (w.mode !== 'tdm' || !(p.rewards[0] + p.rewards[1] + p.rewards[2])) { this.rewardT = 0.6 + this.rnd() * 1.2; return; }
    this.rewardT -= dt;
    if (this.rewardT > 0) return;
    const t = this.targetId >= 0 ? w.penguin(this.targetId) : undefined;
    if (p.rewards[2] > 0 && t && this.targetVisible && this.targetDist(w, p) > 9) {
      p.input.aim = { x: t.x + t.vx * 1.2, y: t.y, z: t.z + t.vz * 1.2 };
      p.input.reward = 3;
    } else if (p.rewards[0] > 0 && t && this.targetVisible && p.frenzyT <= 0) p.input.reward = 1;
    else if (p.rewards[1] > 0) { p.input.aim = null; p.input.reward = 2; }
    this.rewardT = 1 + this.rnd() * 2;
  }

  /** No turret of our own standing, and the team has room for one. */
  private wantsTurret(w: World, p: Penguin) {
    let team = 0;
    for (const t of w.turrets) { if (!t.alive) continue; if (t.owner === p.id) return false; if (t.team === p.team) team++; }
    return team < CFG.maxTeamTurrets && this.turretT < 14;
  }

  /** Stand a few steps back from a good spot, face it, and scoop until the snowman is up. */
  private doTurret(w: World, p: Penguin, dt: number, base: { center: V3; facing: number }, toCenter: number) {
    if (!this.turretSpot) {
      const side = this.index % 2 ? 1 : -1;
      const home = w.mode !== 'tdm' ? w.points[this.objective >= 0 ? this.objective : this.homePoint(w, p)] : undefined;
      // Conquest and Breakthrough: just inside the ring, on the enemy's side of the flag. Deathmatch: out on the lip of the base.
      this.turretSpot = home ? { x: home.x + toCenter * 2.6, y: 0, z: home.z + side * 2.4 } : { x: base.center.x + toCenter * 25, y: 0, z: (this.homeZ ?? 0) + side * 6 };
    }
    const spot = this.turretSpot;
    const stand = { x: spot.x - toCenter * 2.4, y: 0, z: spot.z };
    if (!this.moveTo(w, p, stand, 0.7, dt)) return;
    this.turretT += dt;
    this.faceYaw(p, this.yawTo(p, spot.x, spot.z));
    const g = w.field.surfaceBelow(spot.x, p.y + 1.5, spot.z, 0.5, 4);
    if (g === null) { this.turretT = 99; return; }
    p.input.aim = { x: spot.x, y: g, z: spot.z };
    p.input.turret = true;
    // can't stand there, or no loose snow: shuffle sideways and try again, then give up for a while
    if (p.turretBlock >= 2 || (p.noSnowT > 0 && p.turretSnow <= 0)) { spot.z += (this.rnd() - 0.5) * 3; spot.x -= toCenter * 0.6; this.turretT += 1.5; }
    if (this.turretT >= 14) { this.turretT = 0; this.turretSpot = null; this.turretWait = 40; }
  }

  /** The flag this bot looks after when nothing else is going on: the team's home flag, or its share of the section's objectives. */
  private homePoint(w: World, p: Penguin) {
    if (w.mode === 'conquest') return p.team === 0 ? 0 : w.points.length - 1;
    const ids = w.activePoints();
    return ids[this.slot % ids.length];
  }

  /**
   * Conquest: pick the flag that most needs this bot. Builders with the turret job lean toward guarding the home flag.
   * Breakthrough: only this section's objectives count, and every bot has one it leans toward so both get people.
   */
  private pickObjective(w: World, p: Penguin, dt: number) {
    this.objectiveT -= dt;
    const bt = w.mode === 'breakthrough';
    const ids = w.activePoints();
    const cur = ids.includes(this.objective) ? w.points[this.objective] : undefined;
    const settled = cur && cur.owner === p.team && (p.team === 0 ? cur.n1 : cur.n0) === 0;
    if (cur && this.objectiveT > 0 && !(settled && this.objectiveT < 6)) return;
    const home = this.homePoint(w, p);
    let best = -1, bs = -1;
    for (const id of ids) {
      const pt = w.points[id];
      const enemies = p.team === 0 ? pt.n1 : pt.n0;
      const need = pt.owner !== p.team ? 1 : enemies > 0 ? 1.5 : 0.12;
      const d = Math.hypot(pt.x - p.x, pt.z - p.z);
      let score = need / (22 + d) * (0.6 + this.rnd() * 0.8);
      if (bt && p.team === 0) {
        // attackers move as a pack: most go for the objective that is closest to falling, the rest hold what's been taken
        const holder = this.slot % 5 >= 3;
        const taken = (1 - pt.cap) / 2; // 0 = all the defenders', 1 = ours
        const want = pt.owner !== 0 ? 1.2 + taken + (pt.id === ids[w.sector % ids.length] ? 0.15 : 0) : holder ? (enemies > 0 ? 2.4 : 1.5) : enemies > 0 ? 0.9 : 0.1;
        score = want / (45 + d) * (0.9 + this.rnd() * 0.2);
      } else if (bt) { if (pt.id === home) score *= 1.6; }
      else {
        if (pt.id === home && this.turretJob) score *= need > 1 ? 3 : 2.2;
        if (pt.id === w.points.length - 1 - home && this.raider) score *= 2.4; // raiders go for the enemy's home flag
      }
      if (score > bs) { bs = score; best = pt.id; }
    }
    if (best !== this.objective) { this.holdSpot = null; this.turretSpot = null; this.turretT = 0; }
    this.objective = best;
    this.objectiveT = 9 + this.rnd() * 8;
  }

  /** Get into the flag's ring and stay there. With nothing to throw at: stock up on snowballs, then thicken the walls. */
  private doCapture(w: World, p: Penguin, dt: number, base: { center: V3; facing: number }) {
    const pt = w.points[this.objective];
    if (!pt) return;
    if (!this.holdSpot || this.rnd() < 0.002) {
      const a = this.rnd() * Math.PI * 2, r = 1.2 + this.rnd() * (pt.r - 3.2);
      this.holdSpot = { x: pt.x + Math.cos(a) * r, y: pt.y, z: pt.z + Math.sin(a) * r };
    }
    const far = Math.hypot(p.x - pt.x, p.z - pt.z);
    if (!this.moveTo(w, p, this.holdSpot, 1.1, dt)) {
      if (far > 14 && Math.hypot(p.vx, p.vz) > 3.5 && this.downhill(w, p)) p.input.slide = true;
      this.combatWhileMoving(w, p);
      return;
    }
    // in the ring
    const toEnemy = base.facing; // look the way the enemy comes from
    if (p.carried < CFG.maxCarry) {
      p.input.pack = true;
      this.faceYaw(p, toEnemy + Math.sin(this.t * 0.4 + this.index) * 1.3);
      if (p.noSnowT > 0) this.holdSpot = null;
    } else if (this.role === 'builder' && pt.owner === p.team) {
      // pat more snow onto whatever wall is in front of us
      this.faceYaw(p, toEnemy + Math.sin(this.index * 2.1) * 0.9);
      const yaw = p.input.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const hit = w.field.raycast(p.x, p.y + 1.2, p.z, fx * 0.95, -0.31, fz * 0.95, 4.5, 0.15);
      if (hit) { p.input.aim = { x: hit.x, y: hit.y, z: hit.z }; p.input.build = true; }
      this.buildT += dt;
      if (this.buildT > 5) { this.buildT = 0; this.holdSpot = null; }
    } else {
      this.faceYaw(p, toEnemy + Math.sin(this.t * 0.5 + this.index) * 1.4);
    }
    this.combatWhileMoving(w, p);
  }

  private pickTarget(w: World, p: Penguin) {
    if (this.losT > 0) return;
    this.losT = 0.25 + Math.random() * 0.15;
    let best = -1, bestD = 46;
    let vis = false;
    for (const e of w.penguins) {
      if (e.team === p.team || !e.alive) continue;
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      if (d > bestD) continue;
      const seen = this.canSee(w, p, e);
      const score = d * (seen ? 1 : 1.8);
      if (score < bestD) { bestD = score; best = e.id; vis = seen; }
    }
    // nobody in sight? then an enemy turret is worth knocking down
    this.turretId = -1;
    if (best < 0 || !vis) {
      let td = 30;
      for (const t of w.turrets) {
        if (!t.alive || t.team === p.team) continue;
        const d = Math.hypot(t.x - p.x, t.z - p.z);
        if (d < td && this.canSee(w, p, { x: t.x, y: t.y + 0.4, z: t.z })) { td = d; this.turretId = t.id; }
      }
      if (this.turretId >= 0) { best = -1; vis = true; }
    }
    if (best !== this.targetId) this.reactT = 0.35 + (1 - this.skill) * 0.5;
    this.targetId = best;
    this.targetVisible = vis;
  }

  private canSee(w: World, p: Penguin, e: { x: number; y: number; z: number }) {
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

  private nearestGun(w: World, p: Penguin) {
    let best: { c: V3; d: number } | null = null;
    for (const c of w.guns.crates) {
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (!best || d < best.d) best = { c: { x: c.x, y: c.y, z: c.z }, d };
    }
    return best;
  }

  /**
   * Use the gun on this bot's mark, if it's the right tool right now. Returns true when it has the trigger this tick.
   * Water: soak a penguin in sight until it's frozen stiff, then go back to snowballs to finish it.
   * Hot chocolate: up close, melt turrets, scald penguins, and melt the wall a hidden one is behind.
   * Candy cane blade: run at a penguin or turret that is close and swing.
   */
  private gunCombat(w: World, p: Penguin) {
    if (!p.gun || w.phase !== 'fight' || p.charging || p.sliding) return false;
    const t = this.mark(w);
    if (!t || !t.alive || this.reactT > 0) return false;
    const d = Math.hypot(t.x - p.x, t.z - p.z);
    const foe = this.targetId >= 0 ? w.penguin(this.targetId) : undefined;
    let aim: V3;
    if (p.gun === GUN_BLADE) {
      // the blade is for someone right there; anyone further off gets snowballs (unless this bot is already charging them)
      if (!this.targetVisible || (foe && foe.invuln > 0) || d > (this.goal === 'fight' ? 9 : 4.5)) return false;
      p.input.gun = true;
      p.input.yaw = this.yawTo(p, t.x, t.z);
      p.input.aim = { x: t.x, y: t.y + t.h, z: t.z };
      p.input.fire = d < CFG.bladeReach + 0.25;
      return true;
    }
    if (p.gun === GUN_WATER) {
      if (!foe || !this.targetVisible || d > 22 || foe.invuln > 0 || (foe.chill > 0.9 && p.carried > 0)) return false;
      const flight = d / CFG.waterSpeed, lead = this.skill * 0.9;
      const err = (0.2 + d * 0.035) * (1.3 - this.skill);
      aim = { x: t.x + t.vx * flight * lead + (Math.random() * 2 - 1) * err, y: t.y + t.h + (Math.random() * 2 - 1) * err * 0.4, z: t.z + t.vz * flight * lead + (Math.random() * 2 - 1) * err };
    } else {
      if (d > 13) return false;
      aim = { x: t.x, y: t.y + t.h, z: t.z };
      if (!this.targetVisible) {
        // they're behind snow: melt it
        const ox = p.x, oy = p.y + 1.0, oz = p.z;
        const dx = aim.x - ox, dy = aim.y - oy, dz = aim.z - oz, dl = Math.hypot(dx, dy, dz) || 1;
        const hit = w.field.raycast(ox, oy, oz, dx / dl, dy / dl, dz / dl, dl, 0.3);
        if (!hit) return false;
        aim = { x: hit.x, y: hit.y, z: hit.z };
      } else if (foe && foe.invuln > 0) return false;
      const err = 0.25 * (1.3 - this.skill);
      aim.x += (Math.random() * 2 - 1) * err; aim.z += (Math.random() * 2 - 1) * err;
    }
    p.input.gun = true;
    p.input.yaw = this.yawTo(p, aim.x, aim.z);
    p.input.aim = aim;
    p.input.fire = true;
    return true;
  }

  private faceYaw(p: Penguin, yaw: number) {
    const cur = p.input.yaw;
    p.input.yaw = cur + wrap(yaw - cur) * 0.25;
  }

  private yawTo(p: Penguin, x: number, z: number) { return Math.atan2(-(x - p.x), -(z - p.z)); }

  /** Walk toward a point (facing it). Returns true once within `near`. */
  private moveTo(w: World, p: Penguin, to: V3, near: number, dt: number, faceAlso = true) {
    {
      const dx = to.x - p.x, dz = to.z - p.z;
      if (Math.hypot(dx, dz) < near) return true;
    }
    // heading into a house from outside? go to the door on our side first, then in through it
    for (const h of w.map.houses) {
      // in the house's own frame: its length runs along x, with a door in each end
      const lt = houseLocal(h, to.x, to.z), lp = houseLocal(h, p.x, p.z);
      const inside = (l: { x: number; z: number }, pad: number) => Math.abs(l.x) < h.hx + pad && Math.abs(l.z) < h.hz + pad;
      if (!inside(lt, 0) || inside(lp, -0.3)) continue;
      const side = lp.x < 0 ? -1 : 1;
      const lined = Math.abs(lp.z) < h.doorW / 2 - 0.35;
      const door = lined ? { x: h.x, z: h.z } : turned(h.x, h.z, h.rot, side * (h.hx + 1.6), 0);
      to = { x: door.x, y: h.y, z: door.z };
    }
    const dx = to.x - p.x, dz = to.z - p.z;
    const d = Math.hypot(dx, dz);
    let yaw = this.yawTo(p, to.x, to.z);
    // walked into something solid (a wall, a pillar): go round it for a moment
    if (this.detourT > 0) yaw += this.strafeDir * 1.25;
    // look a little ahead for walls
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const ax = p.x + fx * 1.1, az = p.z + fz * 1.1;
    const ahead = w.field.sample(ax, p.y + 0.8, az) > ISO;
    if (ahead) {
      const low = w.field.sample(ax, p.y + 1.3, az) <= ISO;
      if (low && p.grounded) p.input.jump = true;
      else yaw += this.strafeDir * 0.9;
    } else if (w.propAt(ax, p.y + 0.5, az)) {
      // a sled, a fallen candy cane, a broken wall: hop it if it's low, else go round
      if (!w.propAt(ax, p.y + 1.15, az) && p.grounded) p.input.jump = true;
      else yaw += this.strafeDir * 1.0;
    }
    if (faceAlso) this.faceYaw(p, yaw);
    const rel = wrap(yaw - p.input.yaw);
    p.input.moveZ = Math.cos(rel);
    p.input.moveX = -Math.sin(rel);
    // stuck?
    if (Math.hypot(p.vx, p.vz) < 0.6) { this.stuckT += dt; if (this.stuckT > 0.8) { p.input.jump = true; this.strafeDir *= -1; this.stuckT = 0; this.detourT = 1.1; } }
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
      // out in front of the stretch of the line this bot started on
      this.buildSpot = { x: base.center.x + toCenter * (13 + row * 6), y: 0, z: (this.homeZ ?? 0) + lane * 2.2 + (row % 2) * 3 };
      // Conquest and Breakthrough: thicken the old fort round our flag instead, on the side the enemy comes from
      if (w.mode !== 'tdm') {
        const home = w.points[this.homePoint(w, p)];
        this.buildSpot = { x: home.x + toCenter * (2.2 + row * 0.5), y: 0, z: home.z + lane * 1.9 };
      }
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
        const mid = w.mode !== 'tdm' ? w.points[this.homePoint(w, p)].z : this.homeZ ?? 0;
        if (Math.abs(this.buildSpot.z - mid) > (w.mode !== 'tdm' ? 4.5 : 11)) this.wallSide *= -1;
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
    const t = this.mark(w);
    if (!t) return;
    const dx = t.x - p.x, dz = t.z - p.z, d = Math.hypot(dx, dz) || 1;
    const want = p.gun === GUN_COCOA ? 7 : 11 + this.skill * 5; // hot chocolate doesn't reach far
    const charge = p.gun === GUN_BLADE && this.targetVisible && d < 12; // blade in hand and someone close: run straight at them
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafeT = 0.8 + Math.random() * 1.6; this.strafeDir = Math.random() < 0.5 ? -1 : 1; }
    // face the target
    this.faceYaw(p, this.yawTo(p, t.x, t.z));
    let mx = 0, mz = 0;
    if (!this.targetVisible) { mx = dx / d; mz = dz / d; }
    else if (d > want + 4) { mx = dx / d * 0.8; mz = dz / d * 0.8; }
    else if (d < want - 4) { mx = -dx / d * 0.7; mz = -dz / d * 0.7; }
    mx += (-dz / d) * this.strafeDir * 0.7; mz += (dx / d) * this.strafeDir * 0.7;
    if (charge) { mx = dx / d; mz = dz / d; }
    // Conquest: don't get drawn off the flag you're holding or taking
    const pt = w.mode !== 'tdm' ? w.points[this.objective] : undefined;
    if (pt) {
      const ox = pt.x - p.x, oz = pt.z - p.z, od = Math.hypot(ox, oz);
      if (od > pt.r - 2.2 && od < pt.r + 12) { const k = od < pt.r ? 1.2 : 2.2; mx = mx * 0.5 + ox / od * k; mz = mz * 0.5 + oz / od * k; }
    }
    // bump into a wall? hop or reverse the strafe
    const ml = Math.hypot(mx, mz) || 1;
    if (w.field.sample(p.x + mx / ml * 1.0, p.y + 0.8, p.z + mz / ml * 1.0) > ISO) { this.strafeDir *= -1; }
    this.moveDir(p, mx / ml, mz / ml);
    // move on the ball in front of us? stand still and pack if empty-handed
    this.combatWhileMoving(w, p);
  }

  private combatWhileMoving(w: World, p: Penguin) {
    if (this.gunCombat(w, p)) return;
    if (w.phase !== 'fight' || p.carried === 0) { p.input.fire = false; return; }
    const t = this.mark(w);
    if (!t || !this.targetVisible || !t.alive || this.reactT > 0) { if (!p.charging) p.input.fire = false; return; }
    const d = Math.hypot(t.x - p.x, t.z - p.z);
    if (d > 40) { p.input.fire = false; return; }
    if (!p.charging && p.throwCd <= 0) {
      p.input.fire = true;
      this.chargeGoal = d > 28 ? 0.8 : d > 17 ? 0.35 : Math.random() * 0.2;
      return;
    }
    if (p.charging) {
      // aim with lead + human-ish error
      p.input.yaw = this.yawTo(p, t.x, t.z);
      const speed = (CFG.throwSpeedMin + (CFG.throwSpeedMax - CFG.throwSpeedMin) * p.charge) * (1 + p.mitten * CFG.throwPerLevel);
      const h = w.handPos(p);
      let aim = { x: t.x, y: t.y + t.h, z: t.z };
      for (let it = 0; it < 2; it++) {
        const v = solveThrow(h, aim, speed, CFG.snowballGravity);
        const flight = v ? Math.hypot(aim.x - h.x, aim.z - h.z) / Math.max(1, Math.hypot(v.x, v.z)) : d / speed;
        const lead = this.skill * 0.9;
        aim = { x: t.x + t.vx * flight * lead, y: t.y + t.h, z: t.z + t.vz * flight * lead };
      }
      const err = (0.25 + d * 0.05) * (1.3 - this.skill);
      aim.x += (Math.random() * 2 - 1) * err; aim.z += (Math.random() * 2 - 1) * err; aim.y += (Math.random() * 2 - 1) * err * 0.4;
      p.input.aim = aim;
      if (p.charge >= this.chargeGoal) p.input.fire = false; // release → throw
      else p.input.fire = true;
    }
  }
}
