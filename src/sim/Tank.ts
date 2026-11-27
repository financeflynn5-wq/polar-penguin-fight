// The snow tank's weapons: a snowball machine gun on a little turret up front, fired by the driver, and a snowball
// catapult on a turntable on the back deck, which only a second rider can work.
// Part of the simulation: no Three.js and no DOM, so the game server runs the same code.
import { CFG } from './config';
import { solveThrow, lookVelocity } from './World';
import type { World, Penguin } from './World';
import type { Vehicle } from './Vehicles';

/** Where things are on the tank (metres, the vehicle's own frame: forward, up, right). Matches tools/blender/snowtank.py. */
export const TANK = {
  /** the turret's pivot on the front deck, and how high the gun's hinge sits */
  turretF: 1.05, gunY: 1.5,
  /** from the gun's hinge to the end of the barrels */
  barrel: 0.85,
  /** the turret can't swing round onto the driver: this far either side of the nose (rad) */
  gunArc: 1.95,
  gunPitchMin: -0.3, gunPitchMax: 0.7,
  /** the gun only tips down while it points roughly ahead (off to the sides it would hit the deck's lamps and crate) */
  gunDownArc: 0.9,
  /** the turntable can't swing the gunner into the driver: its range, relative to the hull (rad, + = left) */
  catMin: -2.6, catMax: 0.65,
  /** the catapult's turntable on the back deck */
  catF: -0.95, catY: 1.15,
  /** where the ball leaves the bucket, from the turntable's pivot, at the top of the swing */
  releaseF: 0.82, releaseY: 1.99,
  /** the gunner's feet, from the turntable's pivot (they turn with it) */
  gunnerF: 0.1, gunnerR: 0.85,
};

/** The moving parts the snapshot carries. */
export interface TankGear {
  /** the gun turret's heading and the gun's tilt, relative to the hull (rad) */
  aimYaw: number; aimPitch: number;
  /** the catapult turntable's heading, relative to the hull (rad) */
  catYaw: number;
  /** 0..1: the gun gets hot as it fires; at 1 it jams until it has cooled down (`hot`) */
  heat: number; hot: boolean;
  /** seconds until the gun can fire again */
  fireT: number;
  /** seconds since the gun last fired (the barrels spin down) */
  gunT: number;
  /** seconds until the catapult is wound back and loaded (0 = ready) */
  catT: number;
}

export const makeTankGear = (): TankGear => ({ aimYaw: 0, aimPitch: 0, catYaw: 0, heat: 0, hot: false, fireT: 0, gunT: 9, catT: 0 });

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const wrap = (a: number) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
const toward = (a: number, b: number, max: number) => a + clamp(wrap(b - a), -max, max);

/** The end of the gun's barrels, in the world. */
export function muzzlePos(v: Vehicle, g: TankGear) {
  const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
  const d = lookVelocity(v.yaw + g.aimYaw, g.aimPitch, TANK.barrel);
  return { x: v.x + fx * TANK.turretF + d.x, y: v.y + TANK.gunY + Math.sin(v.pitch) * TANK.turretF + d.y, z: v.z + fz * TANK.turretF + d.z };
}

/** Where the catapult lets go of its ball, in the world. */
export function releasePos(v: Vehicle, g: TankGear) {
  const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
  const cy = v.yaw + g.catYaw;
  return {
    x: v.x + fx * TANK.catF - Math.sin(cy) * TANK.releaseF,
    y: v.y + TANK.catY + TANK.releaseY + Math.sin(v.pitch) * TANK.catF,
    z: v.z + fz * TANK.catF - Math.cos(cy) * TANK.releaseF,
  };
}

/** Where the gunner stands: on the turntable, so they swing round with it. */
export function gunnerPos(v: Vehicle, g: TankGear) {
  const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
  const cy = v.yaw + g.catYaw;
  const cfx = -Math.sin(cy), cfz = -Math.cos(cy), crx = Math.cos(cy), crz = -Math.sin(cy);
  return {
    x: v.x + fx * TANK.catF + cfx * TANK.gunnerF + crx * TANK.gunnerR,
    y: v.y + TANK.catY + Math.sin(v.pitch) * TANK.catF,
    z: v.z + fz * TANK.catF + cfz * TANK.gunnerF + crz * TANK.gunnerR,
  };
}

/**
 * The catapult's lob: a high arc (about 50°) that comes down on `to`, from `from`. Returns the speed along the
 * ground and up. The range is limited both ways (too close and it sails over; too far and it falls short).
 */
export function catapultLaunch(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number } | null, yaw: number, lookPitch: number) {
  const th = CFG.catAngle;
  let D: number, dy: number;
  if (to) { D = Math.hypot(to.x - from.x, to.z - from.z); dy = to.y - from.y; }
  else { D = 18 + (lookPitch + 0.15) * 70; dy = -2.5; }
  D = clamp(D, CFG.catMinRange, CFG.catMaxRange);
  const c = Math.cos(th), den = 2 * c * c * (D * Math.tan(th) - dy);
  const s = den > 0.5 ? clamp(Math.sqrt(CFG.snowballGravity * D * D / den), CFG.catMinSpeed, CFG.catMaxSpeed) : CFG.catMaxSpeed;
  const h = Math.cos(th) * s;
  return { x: -Math.sin(yaw) * h, y: Math.sin(th) * s, z: -Math.cos(yaw) * h };
}

/** The tank's clocks run whether or not anyone is on it: the gun cools, the catapult winds back. */
export function stepTankGear(v: Vehicle, dt: number) {
  const g = v.tank;
  if (!g) return;
  g.fireT = Math.max(0, g.fireT - dt);
  g.gunT += dt;
  g.catT = Math.max(0, g.catT - dt);
  if (g.gunT > 0.15) g.heat = Math.max(0, g.heat - dt / CFG.tankGunCool);
  if (g.hot && g.heat <= CFG.tankGunUnjam) g.hot = false;
}

/** The driver: the turret follows where they look, and holding the mouse button sprays snowballs. */
export function stepTankDriver(w: World, v: Vehicle, p: Penguin, dt: number) {
  const g = v.tank;
  if (!g) return;
  const inp = p.input;
  const m = muzzlePos(v, g);
  const want = solveThrow(m, inp.aim, CFG.tankGunSpeed, CFG.snowballGravity) ?? lookVelocity(p.lookYaw, p.lookPitch + 0.04, CFG.tankGunSpeed);
  const wantYaw = clamp(wrap(Math.atan2(-want.x, -want.z) - v.yaw), -TANK.gunArc, TANK.gunArc);
  g.aimYaw = clamp(toward(g.aimYaw, wantYaw, CFG.tankTurretTurn * dt), -TANK.gunArc, TANK.gunArc);
  const floor = Math.abs(g.aimYaw) < TANK.gunDownArc ? TANK.gunPitchMin : 0;
  const wantPitch = clamp(Math.atan2(want.y, Math.hypot(want.x, want.z)), floor, TANK.gunPitchMax);
  g.aimPitch += clamp(wantPitch - g.aimPitch, -3 * dt, 3 * dt);
  p.action = 'idle';
  if (!inp.fire || w.phase !== 'fight' || g.fireT > 0) return;
  if (g.hot) return;
  // the snowballs go where the gun points (it may still be swinging round), with a little scatter
  const d = lookVelocity(v.yaw + g.aimYaw + (w.random() - 0.5) * CFG.tankGunSpread * 2, g.aimPitch + (w.random() - 0.5) * CFG.tankGunSpread * 2, CFG.tankGunSpeed);
  w.snowballs.push({ id: w.newId(), owner: p.id, team: p.team, x: m.x, y: m.y, z: m.z, px: m.x, py: m.y, pz: m.z,
    vx: d.x + v.vx, vy: d.y + v.vy, vz: d.z + v.vz, age: 0, alive: true, kind: 3 });
  g.fireT = 1 / CFG.tankGunRate;
  g.gunT = 0;
  g.heat = Math.min(1, g.heat + 1 / CFG.tankGunShots);
  if (g.heat >= 1) g.hot = true;
  w.emit({ type: 'tankFire', vid: v.id, gun: 0, pid: p.id, x: m.x, y: m.y, z: m.z, hot: g.hot });
}

/** The gunner: the turntable follows where they look; click (when it's loaded) and the arm flings a huge snowball. */
export function stepTankGunner(w: World, v: Vehicle, p: Penguin, dt: number) {
  const g = v.tank;
  if (!g) return;
  const inp = p.input;
  const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
  const px = v.x + fx * TANK.catF, pz = v.z + fz * TANK.catF;
  const wantYaw = inp.aim && Math.hypot(inp.aim.x - px, inp.aim.z - pz) > 2 ? Math.atan2(-(inp.aim.x - px), -(inp.aim.z - pz)) : p.lookYaw;
  // (the range has a gap behind the driver: going round the long way is fine, it never crosses the gap)
  const rel = clamp(wrap(wantYaw - v.yaw), TANK.catMin, TANK.catMax);
  const err = wrap(wantYaw - v.yaw - g.catYaw);
  g.catYaw = clamp(g.catYaw + clamp(rel - g.catYaw, -CFG.catTurn * dt, CFG.catTurn * dt), TANK.catMin, TANK.catMax);
  p.action = 'idle';
  if (!inp.fire || w.phase !== 'fight' || g.catT > 0 || Math.abs(err) > 0.15) return;
  const r = releasePos(v, g);
  const vel = catapultLaunch(r, inp.aim, v.yaw + g.catYaw, p.lookPitch);
  w.snowballs.push({ id: w.newId(), owner: p.id, team: p.team, x: r.x, y: r.y, z: r.z, px: r.x, py: r.y, pz: r.z,
    vx: vel.x + v.vx * 0.5, vy: vel.y, vz: vel.z + v.vz * 0.5, age: 0, alive: true, kind: 0, cat: true });
  g.catT = CFG.catReload;
  w.emit({ type: 'tankFire', vid: v.id, gun: 1, pid: p.id, x: r.x, y: r.y, z: r.z, hot: false });
}
