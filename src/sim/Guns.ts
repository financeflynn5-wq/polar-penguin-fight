// The guns: the Hot Chocolate Blaster (melts snow walls), the Freeze Soaker (slows penguins, freezes slippery
// patches) and the Candy Cane Blade (a sword for up close: counted as a gun, so it shares the pads, the X key and
// the one-at-a-time rule). They turn up on gun pads on each team's side of the map, and a splatted penguin drops theirs.
// Part of the simulation: no Three.js and no DOM, so the game server runs this too.
import { V3, mulberry32 } from '../world/MapDef';
import { ISO } from '../world/SnowField';
import { pointInBoxes } from '../world/Playground';
import { CFG } from './config';
import { solveThrow, lookVelocity } from './World';
import type { World, Penguin } from './World';

export const GUN_NONE = 0, GUN_COCOA = 1, GUN_WATER = 2, GUN_BLADE = 3;

/** A gun waiting to be picked up: floating over its pad, or lying where a splatted penguin dropped it. */
export interface GunCrate {
  id: number; gun: number; x: number; y: number; z: number; ammo: number;
  /** which pad it belongs to, or -1 for a dropped gun */
  pad: number;
  /** seconds left before a dropped gun melts away (pad guns wait for ever) */
  life: number;
}

/** A slippery patch of ice a Freeze Soaker left on the snow. */
export interface IcePatch { id: number; x: number; y: number; z: number; r: number; t: number; }

/** One squirt in flight. Only the server has these: clients draw their own from the 'gunShot' events. */
interface Squirt { gun: number; owner: number; team: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; alive: boolean; }

interface Pad { x: number; z: number; gun: number; team: number; t: number; crate: number; }

export const gunAmmoMax = (gun: number) => (gun === GUN_COCOA ? CFG.cocoaAmmo : gun === GUN_WATER ? CFG.waterAmmo : gun === GUN_BLADE ? CFG.bladeSwings : 0);

const tmpN = { x: 0, y: 0, z: 0 };

export class Guns {
  crates: GunCrate[] = [];
  patches: IcePatch[] = [];
  private squirts: Squirt[] = [];
  private pads: Pad[] = [];
  private padKey = -99;
  private nextId = 1;
  private rand = mulberry32(0x51ed);
  private turretHeat = new Map<number, number>();
  private patchCheck = 0;
  /** blade swings still in the air: for a moment after a swing starts it smashes snowballs coming at its owner */
  private swings: { pid: number; t: number }[] = [];

  constructor(private w: World) {}

  // ───────────────────────── per penguin ─────────────────────────
  /** Runs for every penguin every tick, and for your own penguin when an online client steps it ahead of the server. */
  tick(p: Penguin, dt: number) {
    p.gunCd = Math.max(0, p.gunCd - dt);
    p.slipT = Math.max(0, p.slipT - dt);
    p.slipCd = Math.max(0, p.slipCd - dt);
    if (p.chill > 0) {
      if (p.chillT > 0) p.chillT -= dt;
      else p.chill = Math.max(0, p.chill - CFG.chillFade * dt);
    }
    if (p.heat > 0) p.heat = Math.max(0, p.heat - CFG.heatFade * dt);
    p.gunOut = p.alive && p.gun !== GUN_NONE && p.input.gun && !p.sliding && this.w.phase !== 'end';
  }

  /** How much of its speed a soaked penguin keeps. */
  speedMult(p: Penguin) { return 1 - CFG.chillSlow * p.chill; }

  /** Holding the trigger with the gun (or the blade) out. */
  firing(p: Penguin) {
    return p.gunOut && p.input.fire && !p.input.plow && p.gunAmmo > 0 && this.w.phase === 'fight';
  }

  /** Spraying a gun slows your walk, like winding up a throw. Swinging the blade doesn't. */
  spraying(p: Penguin) { return p.gun !== GUN_BLADE && this.firing(p); }

  /** Is this spot on one of the Freeze Soaker's ice patches? */
  onPatch(x: number, y: number, z: number) {
    for (const s of this.patches) {
      const dx = x - s.x, dz = z - s.z;
      if (dx * dx + dz * dz < s.r * s.r && Math.abs(y - s.y) < 0.7) return true;
    }
    return false;
  }

  /** A fresh penguin (start of the match, or back from a splat): warm, dry and on its feet. */
  reset(p: Penguin) {
    p.chill = 0; p.chillT = 0; p.heat = 0; p.slipT = 0; p.slipCd = 0; p.gunCd = 0; p.gunOut = false;
  }

  /** Splatted: the gun falls where you went down, with whatever is left in the tank. */
  drop(p: Penguin) {
    if (p.gun !== GUN_NONE && p.gunAmmo > 0) {
      this.crates.push({ id: this.nextId++, gun: p.gun, x: p.x, y: p.y + 0.9, z: p.z, ammo: p.gunAmmo, pad: -1, life: CFG.gunDropLife });
      this.w.emit({ type: 'gunDrop', pid: p.id, gun: p.gun, x: p.x, y: p.y + 0.9, z: p.z });
    }
    p.gun = GUN_NONE; p.gunAmmo = 0; p.gunOut = false;
  }

  /** Where the squirts leave the gun. */
  muzzle(p: Penguin): V3 {
    const cp = Math.cos(p.lookPitch), sp = Math.sin(p.lookPitch);
    const fx = -Math.sin(p.lookYaw), fz = -Math.cos(p.lookYaw);
    const rx = Math.cos(p.lookYaw), rz = -Math.sin(p.lookYaw);
    // (matches where the model's nozzle is when the gun is in the mittens: see HOLD in render/GunsView)
    const f = 0.12 + cp * 0.55;
    const m = { x: p.x + rx * 0.46 + fx * f, y: p.y + 0.68 + sp * 0.62, z: p.z + rz * 0.46 + fz * f };
    // pressed up against a wall: squirt from the chest instead of from inside the snow
    if (this.w.field.sample(m.x, m.y, m.z) > ISO) { m.x = p.x + fx * 0.3; m.y = p.y + 0.8; m.z = p.z + fz * 0.3; }
    return m;
  }

  /** Server only: pull the trigger. */
  use(p: Penguin, dt: number) {
    if (!this.firing(p) || (p.action !== 'idle' && p.action !== 'throw')) return;
    if (p.gun === GUN_BLADE) { if (p.gunCd <= 0) this.swing(p); return; }
    const every = 1 / (p.gun === GUN_COCOA ? CFG.cocoaRate : CFG.waterRate);
    let n = 0;
    while (p.gunCd <= 0 && p.gunAmmo > 0 && n++ < 3) { this.shoot(p); p.gunCd += every; }
    if (p.gunCd < 0) p.gunCd = 0;
    void dt;
  }

  private shoot(p: Penguin) {
    const w = this.w;
    const cocoa = p.gun === GUN_COCOA;
    const speed = cocoa ? CFG.cocoaSpeed : CFG.waterSpeed, g = cocoa ? CFG.cocoaGravity : CFG.waterGravity;
    const m = this.muzzle(p);
    const v = solveThrow(m, p.input.aim, speed, g) ?? lookVelocity(p.lookYaw, p.lookPitch + 0.04, speed);
    const jit = (cocoa ? CFG.cocoaSpread : CFG.waterSpread) * speed;
    const vx = v.x + (this.rand() * 2 - 1) * jit + p.vx * 0.3, vy = v.y + (this.rand() * 2 - 1) * jit, vz = v.z + (this.rand() * 2 - 1) * jit + p.vz * 0.3;
    this.squirts.push({ gun: p.gun, owner: p.id, team: p.team, x: m.x, y: m.y, z: m.z, vx, vy, vz, life: cocoa ? CFG.cocoaLife : CFG.waterLife, alive: true });
    w.emit({ type: 'gunShot', pid: p.id, gun: p.gun, x: m.x, y: m.y, z: m.z, vx, vy, vz });
    p.gunAmmo--;
    if (p.gunAmmo <= 0) {
      w.emit({ type: 'gunEmpty', pid: p.id, gun: p.gun });
      p.gun = GUN_NONE; p.gunOut = false;
    }
  }

  // ───────────────────────── the Candy Cane Blade ─────────────────────────
  /** Is there snow between a penguin's chest and a point? (You can't whack someone through a wall.) */
  private walled(p: Penguin, x: number, y: number, z: number) {
    const oy = p.y + 0.9, dx = x - p.x, dy = y - oy, dz = z - p.z, d = Math.hypot(dx, dy, dz);
    if (d < 0.8) return false;
    const hit = this.w.field.raycast(p.x, oy, p.z, dx / d, dy / d, dz / d, d - 0.4, 0.2);
    return !!hit;
  }

  /** One swing: everything in an arc in front of you gets it, right away. Server only. */
  private swing(p: Penguin) {
    const w = this.w;
    p.gunCd = CFG.bladeCooldown;
    p.throwAnim = 0.25; // (the swing borrows the throw's arm animation and timing)
    w.emit({ type: 'bladeSwing', pid: p.id });
    this.swings.push({ pid: p.id, t: CFG.bladeBlockTime });
    const fx = -Math.sin(p.lookYaw), fz = -Math.cos(p.lookYaw);
    const cosArc = Math.cos(CFG.bladeArc);
    const reach = (x: number, y: number, z: number, extra: number) => {
      const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
      if (d > CFG.bladeReach + extra || Math.abs(y - (p.y + 0.6)) > 1.5) return false;
      return d < 0.6 || (dx * fx + dz * fz) / d >= cosArc;
    };
    for (const q of w.penguins) {
      if (!q.alive || q.team === p.team || q.invuln > 0 || !reach(q.x, q.y + 0.6, q.z, CFG.radius) || this.walled(p, q.x, q.y + 0.6, q.z)) continue;
      const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz) || 1;
      q.health = Math.max(0, q.health - CFG.bladeDamage);
      q.sinceHit = 0;
      q.lastHitBy = p.id;
      // a good whack sends them flying back
      q.vx += dx / d * CFG.bladeKnock; q.vz += dz / d * CFG.bladeKnock;
      if (q.grounded && !q.sliding) { q.vy = 3.8; q.grounded = false; }
      w.emit({ type: 'hit', pid: q.id, by: p.id, x: q.x, y: q.y + 0.7, z: q.z, health: q.health });
      w.emit({ type: 'bladeHit', pid: q.id, by: p.id, x: q.x, y: q.y + 0.7, z: q.z });
      if (q.health <= 0) w.splat(q, p.id, 'blade');
    }
    for (const t of w.turrets) {
      if (!t.alive || t.team === p.team || !reach(t.x, t.y + 0.8, t.z, CFG.turretRadius) || this.walled(p, t.x, t.y + 1, t.z)) continue;
      w.emit({ type: 'bladeHit', pid: -1, by: p.id, x: t.x, y: t.y + 1.1, z: t.z });
      w.hitTurret(t, p.id, t.x, t.y + 1.1, t.z);
    }
    // it chops snow too: a few swings make a hole in a wall
    w.field.removeMass(p.x + fx * 1.25, p.y + 0.95, p.z + fz * 1.25, 0.7, CFG.bladeCut, 0);
    p.gunAmmo--;
    if (p.gunAmmo <= 0) {
      // candy canes only take so much
      w.emit({ type: 'gunEmpty', pid: p.id, gun: p.gun });
      p.gun = GUN_NONE; p.gunOut = false;
    }
  }

  /** While a swing is in the air, enemy snowballs that fly into it shatter. */
  private stepSwings(dt: number) {
    if (!this.swings.length) return;
    const w = this.w, cosArc = Math.cos(Math.min(Math.PI, CFG.bladeArc + 0.35));
    for (const s of this.swings) {
      s.t -= dt;
      const p = w.penguin(s.pid);
      if (!p || !p.alive) { s.t = 0; continue; }
      const fx = -Math.sin(p.lookYaw), fz = -Math.cos(p.lookYaw);
      for (const b of w.snowballs) {
        if (!b.alive || b.team === p.team) continue;
        const dx = b.x - p.x, dy = b.y - (p.y + 0.7), dz = b.z - p.z;
        if (dx * dx + dy * dy + dz * dz > 1.7 * 1.7) continue;
        const d = Math.hypot(dx, dz);
        if (d > 0.5 && (dx * fx + dz * fz) / d < cosArc) continue;
        b.alive = false;
        w.emit({ type: 'bladeBlock', pid: p.id, x: b.x, y: b.y, z: b.z });
      }
    }
    this.swings = this.swings.filter(s => s.t > 0);
  }

  // ───────────────────────── the world's share ─────────────────────────
  step(dt: number) {
    this.stepPads(dt);
    this.stepCrates(dt);
    this.stepSquirts(dt);
    this.stepSwings(dt);
    this.stepPatches(dt);
  }

  /** Three pads on each team's side: cocoa to the north, the blade in the middle, water to the south. In Breakthrough they move up with the camps. */
  private buildPads() {
    const w = this.w, m = w.map, bd = m.bounds, bt = w.mode === 'breakthrough';
    const midZ = (bd.minZ + bd.maxZ) / 2, halfZ = (bd.maxZ - bd.minZ) / 2;
    this.pads = [];
    for (let team = 0; team < 2; team++) {
      const f = w.front(team);
      const x = bt ? f.center.x + (team === 0 ? 10 : -10) : m.midLineX + (f.center.x - m.midLineX) * 0.4;
      for (const [gun, side] of [[GUN_COCOA, -1], [GUN_BLADE, 0], [GUN_WATER, 1]]) {
        const s = this.clearSpot(x, midZ + side * halfZ * (bt ? 0.5 : 0.42));
        this.pads.push({ x: s.x, z: s.z, gun, team, t: CFG.gunFirst, crate: -1 });
      }
    }
  }

  /** The nearest open snow to a spot: not in a tree, a house, a prop, a stockpile or out on the ice. */
  private clearSpot(x: number, z: number) {
    const w = this.w, m = w.map;
    const ok = (qx: number, qz: number) => {
      const bd = m.bounds;
      if (qx < bd.minX + 3 || qx > bd.maxX - 3 || qz < bd.minZ + 3 || qz > bd.maxZ - 3) return false;
      const g = w.field.surfaceBelow(qx, 26, qz, 0, 30);
      if (g === null || w.isIce(qx, qz)) return false;
      for (const t of m.trees) if (Math.hypot(qx - t.x, qz - t.z) < t.r + 3) return false;
      for (let a = 0; a < 8; a++) {
        const ax = qx + Math.cos(a * Math.PI / 4) * 1.1, az = qz + Math.sin(a * Math.PI / 4) * 1.1;
        if (w.propAt(ax, g + 0.4, az) || w.propAt(ax, g + 1.2, az)) return false;
      }
      for (const h of m.houses) if (Math.hypot(qx - h.x, qz - h.z) < Math.hypot(h.hx, h.hz) + 1.5) return false;
      for (let t = 0; t < 2; t++) for (const s of w.front(t).stockpiles) if (Math.hypot(qx - s.x, qz - s.z) < 4.5) return false;
      return true;
    };
    for (let r = 0; r <= 14; r += 1.5) {
      const n = r === 0 ? 1 : Math.ceil(r * 4);
      for (let k = 0; k < n; k++) {
        const a = k / n * Math.PI * 2;
        const qx = x + Math.cos(a) * r, qz = z + Math.sin(a) * r;
        if (ok(qx, qz)) return { x: qx, z: qz };
      }
    }
    return { x, z };
  }

  private stepPads(dt: number) {
    const w = this.w;
    const key = w.mode === 'breakthrough' ? w.sector : 0;
    if (key !== this.padKey) {
      // (Breakthrough: the fight moved on, so the old pads' guns go with them)
      this.padKey = key;
      this.crates = this.crates.filter(c => c.pad < 0);
      this.buildPads();
    }
    if (w.phase !== 'fight' || w.holdT > 0) return;
    const respawn = CFG.gunRespawn * (w.opts.teamSize >= 10 ? 0.7 : 1);
    this.pads.forEach((pad, i) => {
      if (pad.crate >= 0) { if (!this.crates.some(c => c.id === pad.crate)) { pad.crate = -1; pad.t = respawn; } return; }
      pad.t -= dt;
      if (pad.t > 0) return;
      const g = w.field.surfaceBelow(pad.x, 26, pad.z, 0, 30) ?? 0;
      const c: GunCrate = { id: this.nextId++, gun: pad.gun, x: pad.x, y: g + 0.95, z: pad.z, ammo: gunAmmoMax(pad.gun), pad: i, life: 0 };
      this.crates.push(c);
      pad.crate = c.id;
      w.emit({ type: 'gunSpawn', gun: c.gun, team: pad.team, x: c.x, y: c.y, z: c.z });
    });
  }

  private stepCrates(dt: number) {
    const w = this.w;
    for (const c of this.crates) {
      // it floats above whatever snow is under it now
      const g = w.field.surfaceBelow(c.x, c.y + 1.2, c.z, 0, 8);
      if (g !== null) c.y += ((g + 0.95) - c.y) * Math.min(1, dt * 4);
      if (c.pad < 0) { c.life -= dt; if (c.life <= 0) { c.ammo = 0; continue; } }
      if (w.phase === 'end') continue;
      for (const p of w.penguins) {
        if (!p.alive || Math.hypot(p.x - c.x, p.z - c.z) > 1.25 || Math.abs(p.y + 0.6 - c.y) > 1.8) continue;
        const max = gunAmmoMax(c.gun);
        // one gun at a time: an empty-handed penguin takes it, and one with the same gun tops up its tank
        if (p.gun === GUN_NONE) { p.gun = c.gun; p.gunAmmo = c.ammo; }
        else if (p.gun === c.gun && p.gunAmmo <= max - 4) p.gunAmmo = Math.min(max, p.gunAmmo + c.ammo);
        else continue;
        c.ammo = 0;
        w.emit({ type: 'gunGrab', pid: p.id, gun: c.gun, x: c.x, y: c.y, z: c.z });
        break;
      }
    }
    if (this.crates.some(c => c.ammo <= 0)) this.crates = this.crates.filter(c => c.ammo > 0);
  }

  private stepSquirts(dt: number) {
    if (!this.squirts.length) return;
    const w = this.w, f = w.field, pg = w.map.playground;
    for (const s of this.squirts) {
      const cocoa = s.gun === GUN_COCOA;
      s.life -= dt;
      if (s.life <= 0) { s.alive = false; continue; }
      s.vy -= (cocoa ? CFG.cocoaGravity : CFG.waterGravity) * dt;
      const steps = Math.max(1, Math.ceil(Math.hypot(s.vx, s.vy, s.vz) * dt / 0.22));
      const sdt = dt / steps;
      for (let n = 0; n < steps && s.alive; n++) {
        s.x += s.vx * sdt; s.y += s.vy * sdt; s.z += s.vz * sdt;
        for (const p of w.penguins) {
          if (!p.alive || p.id === s.owner) continue;
          // enemies get it; hot chocolate also thaws a soaked teammate
          if (p.team === s.team && !(cocoa && p.chill > 0)) continue;
          const cy = p.sliding ? p.y + 0.3 : Math.max(p.y + 0.3, Math.min(p.y + 1.05, s.y));
          if (Math.hypot(s.x - p.x, s.y - cy, s.z - p.z) > 0.56) continue;
          s.alive = false;
          if (cocoa) this.scald(p, s); else this.soak(p, s);
          break;
        }
        if (!s.alive) break;
        for (const t of w.turrets) {
          if (!t.alive || t.team === s.team) continue;
          if (s.y > t.y - 0.1 && s.y < t.y + CFG.turretHeight && Math.hypot(s.x - t.x, s.z - t.z) < CFG.turretRadius + 0.1) {
            s.alive = false;
            if (cocoa) {
              // snowmen melt
              const h = (this.turretHeat.get(t.id) ?? 0) + 1 / CFG.cocoaHitsPerTurret;
              if (h >= 1) { this.turretHeat.delete(t.id); w.hitTurret(t, s.owner, s.x, s.y, s.z); } else this.turretHeat.set(t.id, h);
            }
            break;
          }
        }
        if (!s.alive) break;
        for (const b of w.bigBalls) if (Math.hypot(s.x - b.x, s.y - b.y, s.z - b.z) < b.r) { s.alive = false; break; }
        if (!s.alive) break;
        if (pointInBoxes(pg.boxes, s.x, s.y, s.z, 0.06)) { s.alive = false; break; }
        for (const c of pg.cyls) if (s.y > c.y0 && s.y < c.y1 && Math.hypot(s.x - c.x, s.z - c.z) < c.r + 0.06) { s.alive = false; break; }
        if (!s.alive) break;
        for (const t of w.map.trees) {
          const ty = s.y - t.y;
          if (ty < t.h && Math.hypot(s.x - t.x, s.z - t.z) < (ty < t.cb ? t.r + 0.1 : 0.2 + (1 - (ty - t.cb) / (t.h - t.cb)) * t.cw * 0.8)) { s.alive = false; break; }
        }
        if (!s.alive) break;
        if (s.y < 0 || f.sample(s.x, s.y, s.z) > ISO) {
          s.alive = false;
          if (cocoa) this.melt(s); else this.freeze(s);
        }
      }
    }
    this.squirts = this.squirts.filter(s => s.alive);
  }

  /** Hot chocolate on a penguin: it warms them right out of a chill, and enough of it costs an enemy a heart. */
  private scald(p: Penguin, s: Squirt) {
    const w = this.w;
    if (p.chill > 0) { p.chill = 0; p.chillT = 0; w.emit({ type: 'thaw', pid: p.id, by: s.owner }); }
    if (p.team === s.team || p.invuln > 0) return;
    p.heat += 1 / CFG.cocoaHitsPerHeart;
    if (p.heat < 1) return;
    p.heat = 0;
    p.health--;
    p.sinceHit = 0;
    p.lastHitBy = s.owner;
    w.emit({ type: 'hit', pid: p.id, by: s.owner, x: s.x, y: s.y, z: s.z, health: p.health });
    if (p.health <= 0) w.splat(p, s.owner, 'cocoa');
  }

  /** Freezing water on a penguin: each hit stiffens them up a bit more, and the chill lasts a few seconds. */
  private soak(p: Penguin, s: Squirt) {
    if (p.invuln > 0) return;
    p.chill = Math.min(1, p.chill + CFG.chillPerHit);
    p.chillT = CFG.chillHold;
    p.heat = 0;
    this.w.emit({ type: 'soak', pid: p.id, by: s.owner, x: s.x, y: s.y, z: s.z, chill: p.chill });
  }

  /** Hot chocolate on snow: the snow is gone (packed walls melt as easily as powder), and so is any ice patch there. */
  private melt(s: Squirt) {
    const w = this.w;
    const sp = Math.hypot(s.vx, s.vy, s.vz) || 1;
    w.field.removeMass(s.x + s.vx / sp * 0.2, s.y + s.vy / sp * 0.2, s.z + s.vz / sp * 0.2, CFG.cocoaMeltRadius, CFG.cocoaMelt, 0);
    if (this.patches.length) this.patches = this.patches.filter(q => Math.hypot(q.x - s.x, q.z - s.z) > q.r * 0.7 + 0.3 || Math.abs(q.y - s.y) > 1);
  }

  /** A miss with the Freeze Soaker: a slippery patch where it landed (on ground you can stand on, not on a wall's face). */
  private freeze(s: Squirt) {
    const w = this.w, f = w.field;
    f.normalAt(s.x, s.y, s.z, tmpN);
    if (tmpN.y < 0.6) return;
    const g = f.surfaceBelow(s.x, s.y + 0.4, s.z, 0.2, 1);
    if (g === null) return;
    for (const q of this.patches) {
      if (Math.hypot(q.x - s.x, q.z - s.z) < q.r * 0.8 && Math.abs(q.y - g) < 0.6) {
        // more water on the same patch: it lasts longer and spreads a little
        q.t = CFG.patchLife;
        q.r = Math.min(CFG.patchMaxRadius, q.r + 0.3);
        return;
      }
    }
    this.patches.push({ id: this.nextId++, x: s.x, y: g, z: s.z, r: CFG.patchRadius, t: CFG.patchLife });
    if (this.patches.length > CFG.maxPatches) this.patches.shift();
    w.emit({ type: 'icePatch', x: s.x, y: g, z: s.z });
  }

  private stepPatches(dt: number) {
    if (!this.patches.length) return;
    for (const q of this.patches) q.t -= dt;
    // a patch goes when its time is up, or when the snow it was on has been dug away or built over
    this.patchCheck -= dt;
    if (this.patchCheck <= 0) {
      this.patchCheck = 0.4;
      for (const q of this.patches) {
        const g = this.w.field.surfaceBelow(q.x, q.y + 0.5, q.z, 0.4, 1.2);
        if (g === null || Math.abs(g - q.y) > 0.4) q.t = 0;
      }
    }
    if (this.patches.some(q => q.t <= 0)) this.patches = this.patches.filter(q => q.t > 0);
  }
}
