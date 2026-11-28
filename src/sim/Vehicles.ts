// Vehicles: the snowmobile (a fast two-seater parked at every camp) and the snowplow (Breakthrough: a heavy tracked
// machine the attackers get every so often, which tears through snow walls and shoves the snow aside) and the snow tank
// (two per team, CFG.tanksPerTeam: the driver works a snowball machine gun, a second rider works the snowball catapult on the back; Tank.ts).
// Part of the simulation: no Three.js and no DOM, so the game server runs the same code.
import { ISO } from '../world/SnowField';
import { boxPush, pointInBoxes } from '../world/Playground';
import type { V3 } from '../world/MapDef';
import { CFG } from './config';
import type { World, Penguin } from './World';
import { TankGear, makeTankGear, stepTankGear, stepTankDriver, stepTankGunner, gunnerPos } from './Tank';

export type VehicleKind = 'snowmobile' | 'snowplow' | 'snowtank';
export const VEHICLE_KINDS: VehicleKind[] = ['snowmobile', 'snowplow', 'snowtank'];
export const VEHICLE_NAMES: Record<VehicleKind, string> = { snowmobile: 'snowmobile', snowplow: 'snowplow', snowtank: 'snow tank' };

/** How each kind drives and what it's made of as far as bumping into things goes. Lengths in metres, front = +forward. */
export interface VehicleSpec {
  /** where each rider sits: [forward, up, right] from the vehicle's origin (on the snow, under its middle) */
  seats: [number, number, number][];
  /** which seats can throw snowballs (the driver has both mittens on the bars) */
  canThrow: boolean[];
  /** riders are behind glass: snowballs hit the vehicle, not them */
  covered: boolean;
  /** what it bumps things with: circles along its centreline, [forward offset, radius] */
  circles: [number, number][];
  /** where it feels the ground: this far ahead of and behind its origin, and this far to each side */
  front: number; rear: number; halfW: number;
  height: number;
  maxSpeed: number; reverseSpeed: number; accel: number; brake: number;
  /** m/s² it slows by with nobody on the throttle */
  drag: number;
  /** how fast it turns (rad/s) at full lock */
  turn: number;
  /** a tracked vehicle can spin on the spot; anything else needs this much speed (m/s) to steer fully */
  pivot: boolean; turnAt: number;
  /** sideways grip (1/s): how quickly a slide scrubs off, on snow and on ice */
  grip: number; iceGrip: number;
  /** how much hills speed it up and slow it down (0..1) */
  slope: number;
  /** snow walls stop it (the snowplow goes through them instead) */
  blockedBySnow: boolean;
  /** how close you have to be to hop on */
  reach: number;
}

export const VEHICLE_SPECS: Record<VehicleKind, VehicleSpec> = {
  snowmobile: {
    seats: [[-0.12, 0.62, 0], [-0.86, 0.68, 0]],
    canThrow: [false, true],
    covered: false,
    circles: [[0.72, 0.6], [-0.62, 0.6]],
    front: 1.05, rear: 0.95, halfW: 0.55, height: 1.0,
    maxSpeed: 17, reverseSpeed: 5, accel: 11, brake: 22, drag: 3.2,
    turn: 2.1, pivot: false, turnAt: 4.5,
    grip: 7.5, iceGrip: 0.9, slope: 0.55,
    blockedBySnow: true, reach: 2.3,
  },
  snowplow: {
    seats: [[0.5, 1.12, 0]],
    canThrow: [false],
    covered: true,
    circles: [[2.05, 1.45], [0.75, 1.2], [-1.0, 1.2]],
    front: 1.5, rear: 1.5, halfW: 0.95, height: 2.6,
    maxSpeed: 6.6, reverseSpeed: 3.2, accel: 5.5, brake: 14, drag: 6,
    turn: 1.15, pivot: true, turnAt: 1,
    grip: 14, iceGrip: 3.5, slope: 0.25,
    blockedBySnow: false, reach: 3.4,
  },
  // the snow tank: the driver sits in an open tub behind the gun; the gunner stands on the catapult's turntable
  // (seat 1 is where they stand with the turntable facing forward: it turns with it, see Tank.gunnerPos)
  snowtank: {
    seats: [[0.2, 0.7, 0], [-0.85, 1.15, 0.85]],
    canThrow: [false, false],
    covered: false,
    circles: [[1.15, 1.2], [0, 1.25], [-1.15, 1.2]],
    front: 1.7, rear: 1.7, halfW: 1.0, height: 2.2,
    maxSpeed: 8, reverseSpeed: 4, accel: 6, brake: 15, drag: 5,
    turn: 1.35, pivot: true, turnAt: 1,
    grip: 12, iceGrip: 3, slope: 0.35,
    blockedBySnow: true, reach: 3.0,
  },
};

/** The snowplow's blade, in the vehicle's own frame. */
export const BLADE = { near: 1.9, far: 3.0, halfW: 1.55, top: 3.4 };
const PUSH_LOAD = 150000; // snow moved per second that slows the snowplow right down when it is pushing a heap
/** Blade down (Space): how deep it bites into the ground, and how high the heap in front of it can get. */
export const PUSH = { skim: 0.35, heap: 3.4, top: 5.0 };

export interface Vehicle {
  id: number; kind: VehicleKind;
  /** whose camp it belongs to (anyone can ride a snowmobile; only this team can drive the snowplow) */
  team: number;
  /** which of the team's parking spots it came from */
  slot: number;
  x: number; y: number; z: number; px: number; py: number; pz: number;
  yaw: number; pyaw: number; pitch: number; roll: number;
  vx: number; vy: number; vz: number;
  /** speed along its own nose (negative in reverse), for the tracks, skis and engine note */
  speed: number;
  /** -1 (hard left) .. 1 (hard right), eased */
  steer: number;
  grounded: boolean;
  health: number;
  /** penguin id in each seat, or -1 */
  seats: number[];
  alive: boolean;
  /** seconds since anyone was on it */
  idleT: number;
  /** who last drove it, and for which team (so an empty one still counts as theirs for a moment) */
  lastDriver: number;
  /** seconds since a snowball last landed on it (the model flinches) */
  hitT: number;
  /** how hard the blade is working, 0..1 (the snowplow slows down as it pushes) */
  load: number;
  /** how fast the ground under it was rising or falling: this is what throws it into the air off a ramp */
  climb: number;
  snowAcc: number; snowT: number;
  /** snowplow: the blade is down, heaping snow up in front of it into a wall (up, it cuts through and throws it aside) */
  plowDown: boolean; plowCd: number;
  stuckT: number;
  /** the snow tank's gun and catapult (only on a snow tank) */
  tank?: TankGear;
}

interface Pending { kind: VehicleKind; team: number; slot: number; t: number; }

/** Everything the match keeps about vehicles besides the vehicles themselves. */
export interface Garage {
  /** vehicles on their way back to camp: wrecked ones, and the ones that haven't turned up yet */
  pending: Pending[];
  /** Breakthrough: seconds until the attackers' next snowplow (counts down only while they don't have one) */
  plowT: number;
}

export const makeGarage = (): Garage => ({ pending: [], plowT: -1 });

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const wrap = (a: number) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
const pushTmp = { x: 0, z: 0 };
const cut = { mass: 0, cx: 0, cy: 0, cz: 0 };

export function vehicleOf(w: World, p: Penguin): Vehicle | null {
  if (p.riding < 0) return null;
  for (const v of w.vehicles) if (v.id === p.riding) return v;
  return null;
}

/** Whose side a vehicle is on right now: its riders', or (empty) the team it belongs to. */
export function vehicleSide(w: World, v: Vehicle): number {
  for (const id of v.seats) { const p = id >= 0 ? w.penguin(id) : undefined; if (p) return p.team; }
  return v.team;
}

// ───────────────────────── where they park ─────────────────────────

/** Is there room for a vehicle here: open snow, nothing solid within r, not on a stockpile? */
function clearAt(w: World, x: number, z: number, r: number, self: Vehicle | null): V3 | null {
  const bd = w.map.bounds;
  if (x < bd.minX + r + 0.5 || x > bd.maxX - r - 0.5 || z < bd.minZ + r + 0.5 || z > bd.maxZ - r - 0.5) return null;
  const y = w.field.surfaceBelow(x, 30, z, 0, 34);
  if (y === null || w.isIce(x, z)) return null;
  // not on a steep bank
  for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
    const g = w.field.surfaceBelow(x + dx, y + 3, z + dz, 0, 6);
    if (g === null || Math.abs(g - y) > r * 0.55) return null;
  }
  const pg = w.map.playground;
  for (let a = 0; a < 8; a++) {
    const ax = x + Math.cos(a * Math.PI / 4) * r, az = z + Math.sin(a * Math.PI / 4) * r;
    if (pointInBoxes(pg.boxes, ax, y + 0.7, az, 0.2)) return null;
  }
  if (pointInBoxes(pg.boxes, x, y + 0.7, z, 0.2)) return null;
  for (const c of pg.cyls) if (y + 0.7 > c.y0 && y < c.y1 && Math.hypot(x - c.x, z - c.z) < c.r + r) return null;
  for (const t of w.map.trees) if (Math.hypot(x - t.x, z - t.z) < t.r + r + 0.3) return null;
  for (const b of w.map.bases) if (Math.hypot(x - b.igloo.x, z - b.igloo.z) < 2.6 + r) return null;
  for (let t = 0; t < 2; t++) {
    const f = w.front(t);
    for (const s of f.stockpiles) if (Math.hypot(x - s.x, z - s.z) < CFG.stockRadius + r + 0.6) return null;
  }
  for (const pt of w.points) if (Math.hypot(x - pt.x, z - pt.z) < pt.r) return null;
  for (const v of w.vehicles) if (v !== self && v.alive && Math.hypot(x - v.x, z - v.z) < r + 2.2) return null;
  return { x, y, z };
}

/**
 * Where a team's vehicle parks: beside its camp, just behind the spawn line, facing the fight. Worked out from the
 * team's front, so it follows the camps up the map in Breakthrough and no map has to list parking spots.
 */
export function parkingSpot(w: World, kind: VehicleKind, team: number, slot: number, self: Vehicle | null = null): (V3 & { yaw: number }) | null {
  const f = w.front(team);
  const fx = -Math.sin(f.facing), fz = -Math.cos(f.facing); // toward the enemy
  const sx = -fz, sz = fx; // along the spawn line
  const r = kind === 'snowplow' ? 2.6 : kind === 'snowtank' ? 2.2 : 1.3;
  let tries: [number, number][];
  let ox: number, oz: number;
  if (kind === 'snowplow') {
    ox = f.center.x; oz = f.center.z;
    tries = [[-8, 0], [-8, 6], [-8, -6], [-11, 0], [-5, 8], [-5, -8], [-3, 0], [-11, 9], [-11, -9], [1, 0], [3, 7], [3, -7], [6, 0]];
  } else if (kind === 'snowtank') {
    // off to one side of the camp's middle (the snowplow has the middle)
    ox = f.center.x; oz = f.center.z;
    const s = slot % 2 ? -1 : 1;
    tries = [[-6, 13 * s], [-6, -13 * s], [-9, 10 * s], [-9, -10 * s], [-3, 17 * s], [-3, -17 * s], [-11, 15 * s], [-11, -15 * s], [-12, 0], [0, 11 * s], [0, -11 * s], [4, 15 * s], [4, -15 * s]];
  } else {
    const pile = f.stockpiles[slot % f.stockpiles.length];
    ox = pile.x; oz = pile.z;
    // alternate sides of the pile so two of them don't park nose to tail
    const s = (slot >> 1) % 2 ? -1 : 1, lap = Math.floor(slot / f.stockpiles.length);
    tries = [[-2, 5.5 * s], [-2, -5.5 * s], [-5.5, 3 * s], [-5.5, -3 * s], [1.5, 6.5 * s], [1.5, -6.5 * s], [-8, 0], [-4, 8 * s], [-4, -8 * s], [4, 5 * s], [4, -5 * s], [6, 0]];
    if (lap % 2) tries.reverse();
  }
  for (const [ahead, side] of tries) {
    const at = clearAt(w, ox + fx * ahead + sx * side, oz + fz * ahead + sz * side, r, self);
    if (at) return { ...at, yaw: f.facing };
  }
  return null;
}

/** What a vehicle starts with: the snowplow is tougher the more penguins there are to throw at it. */
export function maxHealth(w: World, kind: VehicleKind) {
  return kind === 'snowplow' ? Math.round(CFG.plowHealth * w.opts.teamSize) : kind === 'snowtank' ? CFG.tankHealth : CFG.snowmobileHealth;
}

function makeVehicle(w: World, kind: VehicleKind, team: number, slot: number, at: V3 & { yaw: number }): Vehicle {
  const spec = VEHICLE_SPECS[kind];
  return {
    id: w.newId(), kind, team, slot,
    x: at.x, y: at.y, z: at.z, px: at.x, py: at.y, pz: at.z, yaw: at.yaw, pyaw: at.yaw, pitch: 0, roll: 0,
    vx: 0, vy: 0, vz: 0, speed: 0, steer: 0, grounded: true,
    health: maxHealth(w, kind),
    seats: spec.seats.map(() => -1), alive: true, idleT: 0, lastDriver: -1, hitT: 9, load: 0, climb: 0, snowAcc: 0, snowT: 0, stuckT: 0, plowDown: false, plowCd: 0,
    ...(kind === 'snowtank' ? { tank: makeTankGear() } : {}),
  };
}

/** Put a vehicle at its team's camp. False if there's no room right now (it tries again in a moment). */
function spawnVehicle(w: World, kind: VehicleKind, team: number, slot: number): boolean {
  const at = parkingSpot(w, kind, team, slot);
  if (!at) return false;
  const v = makeVehicle(w, kind, team, slot, at);
  w.vehicles.push(v);
  w.emit({ type: 'vehicle', what: 'spawn', vid: v.id, kind, team, pid: -1, x: v.x, y: v.y, z: v.z });
  return true;
}

/** The start of a match: snowmobiles at both camps. (The snowplow turns up later, on its timer.) */
export function initVehicles(w: World) {
  const n = Math.max(1, Math.round(w.opts.teamSize / 5 * CFG.snowmobilesPer5));
  for (let team = 0; team < 2; team++) for (let slot = 0; slot < n; slot++) w.garage.pending.push({ kind: 'snowmobile', team, slot, t: 0 });
  // CFG.tanksPerTeam snow tanks at each camp, in every mode (slots alternate sides of the camp)
  for (let team = 0; team < 2; team++) for (let slot = 0; slot < CFG.tanksPerTeam; slot++) w.garage.pending.push({ kind: 'snowtank', team, slot, t: CFG.tankFirst });
  w.garage.plowT = w.mode === 'breakthrough' ? CFG.plowFirst : -1;
}

// ───────────────────────── hopping on and off ─────────────────────────

/** The nearest vehicle this penguin could hop onto right now (a free seat, close enough), or null. */
export function nearVehicle(w: World, p: Penguin): Vehicle | null {
  if (!p.alive || p.riding >= 0) return null;
  let best: Vehicle | null = null, bd = Infinity;
  for (const v of w.vehicles) {
    if (!v.alive || Math.abs(v.y - p.y) > 2.2) continue;
    const spec = VEHICLE_SPECS[v.kind];
    const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
    // distance to its centreline, so you can hop on from anywhere alongside
    const along = clamp((p.x - v.x) * fx + (p.z - v.z) * fz, -spec.rear, spec.front);
    const d = Math.hypot(p.x - (v.x + fx * along), p.z - (v.z + fz * along));
    if (d > spec.reach || d >= bd) continue;
    if (!v.seats.some(s => s < 0)) continue;
    bd = d; best = v;
  }
  return best;
}

/** Why this penguin can't take that vehicle: 0 = they can, 2 = other team's riders are on it. (An empty one is anybody's, the snowplow too.) */
export function boardingBlock(w: World, v: Vehicle, p: Penguin): number {
  for (const id of v.seats) { const r = id >= 0 ? w.penguin(id) : undefined; if (r && r.team !== p.team) return 2; }
  return 0;
}

/** Tap E beside a vehicle: take the driver's seat if it's free, else the back seat. */
export function tryEnter(w: World, p: Penguin): boolean {
  const v = nearVehicle(w, p);
  if (!v) return false;
  const block = boardingBlock(w, v, p);
  if (block) { w.emit({ type: 'vehicle', what: 'denied', vid: v.id, kind: v.kind, team: v.team, pid: p.id, x: v.x, y: v.y, z: v.z }); return true; }
  const seat = v.seats.indexOf(-1);
  v.seats[seat] = p.id;
  p.riding = v.id; p.seat = seat;
  p.sliding = false; p.onSlide = false; p.charging = false; p.charge = 0;
  if (w.board.holder === p.id) w.dropBoard(p);
  if (seat === 0) { v.lastDriver = p.id; v.stuckT = 0; }
  v.idleT = 0;
  seatRider(w, v, p);
  p.px = p.x; p.py = p.y; p.pz = p.z;
  w.emit({ type: 'vehicle', what: 'enter', vid: v.id, kind: v.kind, team: v.team, pid: p.id, x: v.x, y: v.y, z: v.z });
  return true;
}

/** Hop off (or get thrown off, when the vehicle is wrecked): land beside it, on whichever side is clear. */
export function leaveVehicle(w: World, p: Penguin, thrown = false) {
  const v = vehicleOf(w, p);
  p.riding = -1; p.covered = false;
  if (!v) return;
  const seat = v.seats.indexOf(p.id);
  if (seat >= 0) v.seats[seat] = -1;
  const spec = VEHICLE_SPECS[v.kind];
  const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw), rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);
  const s = spec.seats[Math.max(0, seat)];
  const side = spec.halfW + CFG.radius + 0.75;
  let done = false;
  for (const [f, r] of [[s[0], -side], [s[0], side], [-spec.rear - 1.1, 0], [spec.front + 1.3, 0]]) {
    const x = v.x + fx * f + rx * r, z = v.z + fz * f + rz * r;
    const g = w.field.surfaceBelow(x, v.y + 1.2, z, 0.6, 4);
    if (g === null || w.field.sample(x, g + 0.7, z) > ISO || w.propAt(x, g + 0.6, z)) continue;
    p.x = x; p.y = g + 0.05; p.z = z;
    done = true;
    break;
  }
  if (!done) { p.x = v.x; p.z = v.z; p.y = v.y + spec.height + 0.1; } // boxed in: climb out of the top
  p.vx = v.vx * 0.5; p.vz = v.vz * 0.5; p.vy = thrown ? 6 : 2.5;
  if (thrown) { p.vx += (w.random() - 0.5) * 5; p.vz += (w.random() - 0.5) * 5; }
  p.grounded = false;
  p.yaw = p.lookYaw;
  p.px = p.x; p.py = p.y; p.pz = p.z;
  w.emit({ type: 'vehicle', what: 'exit', vid: v.id, kind: v.kind, team: v.team, pid: p.id, x: p.x, y: p.y, z: p.z });
}

/** Put a rider where their seat is. */
function seatRider(w: World, v: Vehicle, p: Penguin) {
  const spec = VEHICLE_SPECS[v.kind];
  const s = spec.seats[p.seat] ?? spec.seats[0];
  const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw), rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);
  p.x = v.x + fx * s[0] + rx * s[2]; p.z = v.z + fz * s[0] + rz * s[2];
  p.y = v.y + s[1] + Math.sin(v.pitch) * s[0];
  if (v.tank && p.seat === 1) { const g = gunnerPos(v, v.tank); p.x = g.x; p.y = g.y; p.z = g.z; }
  p.vx = v.vx; p.vy = v.vy; p.vz = v.vz;
  p.grounded = true; p.sliding = false; p.onIce = false; p.onProp = false; p.onSlide = false; p.surfing = false;
  p.covered = spec.covered;
  // the driver faces where the vehicle points; a passenger turns to look where they're aiming
  p.yaw = spec.canThrow[p.seat] ? p.lookYaw : v.tank && p.seat === 1 ? v.yaw + v.tank.catYaw : v.yaw;
}

/**
 * A penguin's turn while riding: the driver's keys are read by the vehicle itself (stepVehicles); here a passenger
 * winds up and throws, and E hops off.
 */
export function stepRider(w: World, p: Penguin, dt: number) {
  const v = vehicleOf(w, p);
  if (!v || !v.alive || v.seats[p.seat] !== p.id) { p.riding = -1; p.covered = false; return; }
  const inp = p.input;
  // Space in the snowplow's cab puts the blade down, or lifts it again
  if (inp.jump && p.seat === 0 && v.kind === 'snowplow' && v.plowCd <= 0 && w.phase !== 'end') {
    v.plowDown = !v.plowDown; v.plowCd = 0.3;
    w.emit({ type: 'vehicle', what: v.plowDown ? 'bladeDown' : 'bladeUp', vid: v.id, kind: v.kind, team: v.team, pid: p.id, x: v.x, y: v.y, z: v.z });
  }
  inp.jump = false;
  const spec = VEHICLE_SPECS[v.kind];
  if (v.kind === 'snowtank') {
    // the driver works the machine gun, the gunner the catapult (neither throws by hand)
    p.charging = false; p.charge = 0;
    if (p.seat === 0) stepTankDriver(w, v, p, dt); else stepTankGunner(w, v, p, dt);
  } else if (spec.canThrow[p.seat]) {
    if (inp.fire && w.phase === 'fight' && p.carried > 0 && p.throwCd <= 0) p.charging = true;
    if (p.charging) {
      if (inp.fire && p.carried > 0) p.charge = Math.min(1, p.charge + dt / CFG.throwChargeTime);
      else {
        if (p.carried > 0 && w.phase === 'fight') w.throwSnowball(p);
        p.charging = false; p.charge = 0;
      }
    }
  } else { p.charging = false; p.charge = 0; }
  if (v.kind !== 'snowtank') p.action = p.charging ? 'charge' : p.throwAnim > 0 ? 'throw' : 'idle';
  p.plowLoad = 0; p.aimOk = false; p.buildBlock = 0; p.slumping = false; p.turretBlock = 0;
  // E: hop off
  if (inp.use) { if (p.useT < 0) p.useT = 0; p.useT += dt; }
  else if (p.useT >= 0) { p.useT = -1; leaveVehicle(w, p); return; }
  seatRider(w, v, p);
}

// ───────────────────────── damage ─────────────────────────

export function damageVehicle(w: World, v: Vehicle, n: number, by: number, x: number, y: number, z: number) {
  if (!v.alive) return;
  v.health -= n; v.hitT = 0;
  w.emit({ type: 'vehicleHit', vid: v.id, by, x, y, z, health: Math.max(0, v.health) });
  if (v.health <= 0) wreckVehicle(w, v, by);
}

/** It falls to bits: the riders are thrown clear, and a new one turns up at camp after a while. */
export function wreckVehicle(w: World, v: Vehicle, by: number) {
  if (!v.alive) return;
  v.alive = false;
  for (const id of [...v.seats]) { const p = id >= 0 ? w.penguin(id) : undefined; if (p) leaveVehicle(w, p, true); }
  w.emit({ type: 'vehicleDown', vid: v.id, kind: v.kind, team: v.team, by, x: v.x, y: v.y, z: v.z });
  if (v.kind === 'snowplow') w.garage.plowT = CFG.plowEvery;
  else w.garage.pending.push({ kind: v.kind, team: v.team, slot: v.slot, t: v.kind === 'snowtank' ? CFG.tankRespawn : CFG.snowmobileRespawn });
}

/** A snowball in flight: did it land on a vehicle? (Your own side's snowballs fly straight past.) */
export function snowballHitsVehicle(w: World, b: { x: number; y: number; z: number; team: number; owner: number; kind: number; cat?: boolean }): boolean {
  for (const v of w.vehicles) {
    if (!v.alive) continue;
    const spec = VEHICLE_SPECS[v.kind];
    if (b.y < v.y - 0.2 || b.y > v.y + spec.height || Math.abs(b.x - v.x) > 5 || Math.abs(b.z - v.z) > 5) continue;
    if (vehicleSide(w, v) === b.team) continue;
    const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
    for (const [f, r] of spec.circles) {
      if (Math.hypot(b.x - (v.x + fx * f), b.z - (v.z + fz * f)) > r * 0.92 + CFG.snowballRadius) continue;
      // a catapult ball hits hard; the tank gun's little snowballs take two to make one dent
      const n = b.cat ? CFG.catVehicleDamage : b.kind === 3 ? (w.chip(`v${v.id}`, CFG.tankGunDamage) ? 1 : 0) : 1;
      if (n > 0) damageVehicle(w, v, n, b.owner, b.x, b.y, b.z);
      else { v.hitT = 0; w.emit({ type: 'vehicleHit', vid: v.id, by: b.owner, x: b.x, y: b.y, z: b.z, health: Math.max(0, v.health) }); }
      return true;
    }
  }
  return false;
}

// ───────────────────────── driving ─────────────────────────

export function stepVehicles(w: World, dt: number) {
  const g = w.garage;
  // the garage: wrecked snowmobiles come back, and in Breakthrough the attackers' snowplow turns up on its timer
  for (const q of g.pending) {
    q.t -= dt;
    if (q.t <= 0 && w.phase !== 'end') { if (spawnVehicle(w, q.kind, q.team, q.slot)) q.t = NaN; else q.t = 2; }
  }
  if (g.pending.some(q => Number.isNaN(q.t))) g.pending = g.pending.filter(q => !Number.isNaN(q.t));
  if (w.mode === 'breakthrough' && w.phase === 'fight' && !w.vehicles.some(v => v.alive && v.kind === 'snowplow')) {
    g.plowT -= dt;
    if (g.plowT <= 0) g.plowT = spawnVehicle(w, 'snowplow', 0, 0) ? CFG.plowEvery : 2;
  }

  for (const p of w.penguins) p.ramCd = Math.max(0, p.ramCd - dt);
  for (const v of w.vehicles) if (v.alive) { stepVehicle(w, v, dt); stepTankGear(v, dt); }
  // vehicles shove each other apart (the snowplow doesn't budge for a snowmobile)
  for (let a = 0; a < w.vehicles.length; a++) for (let b = a + 1; b < w.vehicles.length; b++) bumpVehicles(w, w.vehicles[a], w.vehicles[b]);
  for (const v of w.vehicles) if (v.alive) for (const id of v.seats) { const p = id >= 0 ? w.penguin(id) : undefined; if (p && p.riding === v.id) seatRider(w, v, p); }
  if (w.vehicles.some(v => !v.alive)) w.vehicles = w.vehicles.filter(v => v.alive);
}

/** Breakthrough: the camps moved up the map. Vehicles nobody is on move up with them. */
export function reparkVehicles(w: World) {
  for (const v of w.vehicles) {
    if (!v.alive || v.seats.some(s => s >= 0)) continue;
    sendHome(w, v);
  }
}

function sendHome(w: World, v: Vehicle) {
  const at = parkingSpot(w, v.kind, v.team, v.slot, v);
  if (!at) return false;
  w.emit({ type: 'vehicle', what: 'home', vid: v.id, kind: v.kind, team: v.team, pid: -1, x: v.x, y: v.y, z: v.z });
  v.x = v.px = at.x; v.y = v.py = at.y; v.z = v.pz = at.z; v.yaw = v.pyaw = at.yaw;
  v.vx = v.vy = v.vz = 0; v.speed = 0; v.pitch = v.roll = 0; v.idleT = 0; v.grounded = true;
  w.emit({ type: 'vehicle', what: 'spawn', vid: v.id, kind: v.kind, team: v.team, pid: -1, x: v.x, y: v.y, z: v.z });
  return true;
}

function stepVehicle(w: World, v: Vehicle, dt: number) {
  const spec = VEHICLE_SPECS[v.kind];
  const f = w.field;
  v.px = v.x; v.py = v.y; v.pz = v.z; v.pyaw = v.yaw;
  v.hitT += dt;

  const driver = v.seats[0] >= 0 ? w.penguin(v.seats[0]) : undefined;
  const ridden = v.seats.some(s => s >= 0);
  if (ridden) v.idleT = 0;
  else {
    v.idleT += dt;
    // left out in the field: it finds its own way back to camp
    if (v.idleT > CFG.vehicleIdleHome && Math.hypot(v.vx, v.vz) < 0.5) {
      const home = parkingSpot(w, v.kind, v.team, v.slot, v);
      if (home && Math.hypot(home.x - v.x, home.z - v.z) > 7) { sendHome(w, v); return; }
      v.idleT = 0;
    }
  }

  let throttle = 0, steerIn = 0;
  if (driver && w.phase !== 'end') { throttle = clamp(driver.input.moveZ, -1, 1); steerIn = clamp(driver.input.moveX, -1, 1); }
  v.steer += (steerIn - v.steer) * Math.min(1, dt * 7);

  let fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw), rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);
  let vf = v.vx * fx + v.vz * fz, vr = v.vx * rx + v.vz * rz;

  if (v.grounded) {
    const ice = w.isIce(v.x, v.z);
    const top = spec.maxSpeed * (1 - 0.7 * v.load);
    if (throttle > 0) {
      // (rolling back slowly counts as standing: braking to a stop every frame would leave it stuck nose-up on a slope)
      if (vf < -0.4) vf = Math.min(0, vf + spec.brake * dt);
      else vf += spec.accel * throttle * Math.max(0, 1 - vf / top) * dt;
    } else if (throttle < 0) {
      if (vf > 0.4) vf = Math.max(0, vf - spec.brake * dt);
      else vf = Math.max(-spec.reverseSpeed, vf + spec.accel * 0.7 * throttle * dt);
    } else {
      const d = (ridden ? spec.drag : spec.drag * 2.5) * (ice ? 0.3 : 1) * dt;
      vf = Math.abs(vf) <= d ? 0 : vf - Math.sign(vf) * d;
    }
    if (vf > top) vf += (top - vf) * Math.min(1, dt * 5);
    // hills: nose up slows it, nose down speeds it up; a side slope drags it sideways (a lot, on ice)
    // (left alone and standing still it holds on its brake, so a parked one doesn't creep off down the hill)
    const held = throttle === 0 && !ice && Math.abs(vf) < 0.5 && Math.abs(vr) < 0.5 && (!driver || Math.abs(v.pitch) < 0.3);
    if (held) { vf = 0; vr = 0; }
    else {
      vf -= CFG.gravity * Math.sin(v.pitch) * spec.slope * dt;
      vr -= CFG.gravity * Math.sin(v.roll) * (ice ? 0.5 : 0.12) * dt;
    }
    vr *= Math.exp(-(ice ? spec.iceGrip : spec.grip) * dt);
    // steering
    const k = spec.pivot ? 1 : clamp(Math.abs(vf) / spec.turnAt, 0, 1);
    const fade = 1 / (1 + Math.max(0, Math.abs(vf) - spec.turnAt) * 0.045);
    v.yaw -= v.steer * spec.turn * k * fade * (vf < -0.3 ? -1 : 1) * dt;
    fx = -Math.sin(v.yaw); fz = -Math.cos(v.yaw); rx = Math.cos(v.yaw); rz = -Math.sin(v.yaw);

    // the snowplow's blade: whatever stands in front of it is cut down to the ground and shoved off to the sides
    if (v.kind === 'snowplow') {
      let inst = 0;
      v.plowCd = Math.max(0, v.plowCd - dt);
      if (!driver) v.plowDown = false;
      if (vf > 0.35) {
        // blade down: it heaps the snow up in front and carries it along (a wall, when you stop). Up: straight through.
        const m = v.plowDown
          ? f.shove(v.x, v.z, fx, fz, BLADE.halfW, BLADE.near, BLADE.far, v.y + PUSH.top, PUSH.skim, PUSH.heap, 0.55, cut)
          : f.bulldoze(v.x, v.z, fx, fz, BLADE.halfW, BLADE.near, BLADE.far, v.y + BLADE.top, 0.55, cut);
        inst = m / dt / (v.plowDown ? PUSH_LOAD : 26000);
        v.snowAcc += m;
        v.snowT -= dt;
        if (v.snowT <= 0 && v.snowAcc > 60) {
          w.emit({ type: 'plowSnow', vid: v.id, x: cut.cx, y: Math.max(v.y + 0.3, cut.cy), z: cut.cz, fx, fz, mass: v.snowAcc });
          v.snowAcc = 0; v.snowT = 0.1;
        }
      }
      v.load += (clamp(inst, 0, 1) - v.load) * Math.min(1, dt * 5);
    }
    v.vx = fx * vf + rx * vr; v.vz = fz * vf + rz * vr;
  } else {
    // in the air: it keeps going the way it was thrown, and you can only nudge the nose round
    v.yaw -= v.steer * spec.turn * 0.25 * dt;
    v.vy -= CFG.gravity * dt;
    v.load *= 0.9;
  }
  v.speed = vf;

  v.x += v.vx * dt; v.z += v.vz * dt;

  collideVehicle(w, v, spec, driver);

  // ── the ground under it ──
  fx = -Math.sin(v.yaw); fz = -Math.cos(v.yaw); rx = Math.cos(v.yaw); rz = -Math.sin(v.yaw);
  const up = 1.15, down = v.grounded ? 2.5 : 0.4 + Math.max(0, -v.vy * dt);
  const gF = f.surfaceBelow(v.x + fx * spec.front, v.y, v.z + fz * spec.front, up, down + 2);
  const gR = f.surfaceBelow(v.x - fx * spec.rear, v.y, v.z - fz * spec.rear, up, down + 2);
  const gL = f.surfaceBelow(v.x - rx * spec.halfW, v.y, v.z - rz * spec.halfW, up, down + 2);
  const gRt = f.surfaceBelow(v.x + rx * spec.halfW, v.y, v.z + rz * spec.halfW, up, down + 2);
  const gC = f.surfaceBelow(v.x, v.y, v.z, up, down + 2);
  let gy: number | null = null;
  if (gF !== null && gR !== null) gy = (gF + gR) / 2;
  else gy = gC ?? gF ?? gR;
  if (gy !== null && gC !== null) gy = Math.max(gy, gC - 0.12); // don't sink into a hump under the middle
  const wasGrounded = v.grounded;
  if (v.grounded) {
    // stay on the snow unless it falls away faster than we can follow: then we're flying
    const stick = 0.22 + Math.max(0, -v.climb) * dt * 1.6 + Math.hypot(v.vx, v.vz) * dt * 0.5;
    if (gy !== null && gy > v.y - stick) {
      const ny = v.y + (gy - v.y) * Math.min(1, dt * 22);
      v.climb += ((ny - v.y) / dt - v.climb) * 0.35;
      v.y = ny; v.vy = 0;
    } else {
      v.grounded = false;
      v.vy = clamp(v.climb, -4, 11);
      if (v.vy > 2.5 && ridden) w.emit({ type: 'vehicleAir', vid: v.id, x: v.x, y: v.y, z: v.z });
    }
  }
  if (!v.grounded) {
    v.y += v.vy * dt;
    if (gy !== null && v.y <= gy && v.vy <= 0) {
      if (!wasGrounded && v.vy < -7) w.emit({ type: 'vehicleLand', vid: v.id, x: v.x, y: gy, z: v.z, hard: Math.min(1, -v.vy / 16) });
      v.y = gy; v.vy = 0; v.grounded = true; v.climb = 0;
    }
    if (v.y < -6) { wreckVehicle(w, v, -1); return; }
  }
  // it sits on the slope
  let pitch = v.pitch, roll = v.roll;
  if (v.grounded) {
    if (gF !== null && gR !== null) pitch = Math.atan2(gF - gR, spec.front + spec.rear);
    if (gL !== null && gRt !== null) roll = Math.atan2(gRt - gL, spec.halfW * 2);
  } else {
    pitch = clamp(v.vy * 0.03, -0.45, 0.4); roll = 0;
  }
  const ease = Math.min(1, dt * (v.grounded ? 9 : 3));
  v.pitch += (clamp(pitch, -0.8, 0.8) - v.pitch) * ease;
  v.roll += (clamp(roll, -0.6, 0.6) - v.roll) * ease;
}

function collideVehicle(w: World, v: Vehicle, spec: VehicleSpec, driver: Penguin | undefined) {
  const f = w.field;
  const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
  const side = vehicleSide(w, v);
  let px = 0, pz = 0;
  const y0 = v.y + 0.4, y1 = v.y + spec.height;
  const pg = w.map.playground;
  for (const [fo, r] of spec.circles) {
    const cx = v.x + fx * fo, cz = v.z + fz * fo;
    // snow walls (the snowplow's blade deals with those)
    if (spec.blockedBySnow && v.grounded) {
      const g = f.surfaceBelow(cx, v.y, cz, 1.3, 2.5);
      if (g !== null) {
        const cy = g + 0.85;
        for (let a = 0; a < 8; a++) {
          const dx = Math.cos(a * Math.PI / 4), dz = Math.sin(a * Math.PI / 4);
          if (f.sample(cx + dx * r, cy, cz + dz * r) <= ISO) continue;
          let lo = 0, hi = r;
          for (let n = 0; n < 4; n++) { const m = (lo + hi) * 0.5; if (f.sample(cx + dx * m, cy, cz + dz * m) > ISO) hi = m; else lo = m; }
          px -= dx * (r - lo) * 0.5; pz -= dz * (r - lo) * 0.5;
        }
      }
    }
    if (boxPush(pg.boxes, cx, cz, y0, y1, r, pushTmp)) { px += pushTmp.x; pz += pushTmp.z; }
    for (const c of pg.cyls) {
      if (y0 > c.y1 || y1 < c.y0) continue;
      const dx = cx - c.x, dz = cz - c.z, d = Math.hypot(dx, dz), min = c.r + r;
      if (d < min && d > 1e-4) { px += dx / d * (min - d); pz += dz / d * (min - d); }
    }
    for (const t of w.map.trees) {
      const dx = cx - t.x, dz = cz - t.z, d = Math.hypot(dx, dz), min = t.r + r;
      if (d < min && d > 1e-4 && v.y < t.y + t.h) { px += dx / d * (min - d); pz += dz / d * (min - d); }
    }
    for (const b of w.map.bases) {
      const dx = cx - b.igloo.x, dz = cz - b.igloo.z, d = Math.hypot(dx, dz), min = 2.4 + r;
      if (d < min && d > 1e-4 && v.y < b.igloo.y + 2.4) { px += dx / d * (min - d); pz += dz / d * (min - d); }
    }
    // snowman turrets: the snowplow flattens the other side's, anything else bumps off them
    for (const t of w.turrets) {
      if (!t.alive || v.y > t.y + CFG.turretHeight || y1 < t.y) continue;
      const dx = cx - t.x, dz = cz - t.z, d = Math.hypot(dx, dz), min = CFG.turretRadius + r;
      if (d >= min || d < 1e-4) continue;
      if (v.kind === 'snowplow' && driver && t.team !== side) w.destroyTurret(t, driver.id);
      else { px += dx / d * (min - d); pz += dz / d * (min - d); }
    }
    // giant snowballs: a rolling one hits hard (and bursts); the snowplow bursts any it drives into
    for (const b of w.bigBalls) {
      if (!b.alive || b.y - b.r > y1) continue;
      const dx = cx - b.x, dz = cz - b.z, d = Math.hypot(dx, dz), min = b.r + r;
      if (d >= min || d < 1e-4) continue;
      const nx = dx / d, nz = dz / d;
      const ballIn = b.vx * nx + b.vz * nz, mine = -(v.vx * nx + v.vz * nz);
      const pusher = w.penguin(b.lastPusher);
      if (ballIn > 2.5 && !(pusher && pusher.team === side)) {
        w.burstBall(b);
        damageVehicle(w, v, v.kind === 'snowplow' ? CFG.plowBallDamage : 99, pusher ? pusher.id : -1, b.x, b.y, b.z);
        if (!v.alive) return;
      } else if (v.kind === 'snowplow' && mine > 1) {
        w.burstBall(b);
      } else {
        // shove it along
        b.x -= nx * (min - d) * 0.7; b.z -= nz * (min - d) * 0.7;
        if (mine > 0) { b.vx += -nx * mine * 0.5; b.vz += -nz * mine * 0.5; b.lastPusher = driver ? driver.id : b.lastPusher; b.pushT = 4; }
        px += nx * (min - d) * 0.3; pz += nz * (min - d) * 0.3;
      }
    }
    // penguins on foot: run them over, or nudge them out of the way
    for (const p of w.penguins) {
      if (!p.alive || p.riding >= 0) continue;
      if (p.y > y1 || p.y + 1.05 < v.y) continue;
      const dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz), min = r + CFG.radius;
      if (d >= min) continue;
      const nx = d > 1e-4 ? dx / d : fx, nz = d > 1e-4 ? dz / d : fz;
      const closing = (v.vx - p.vx) * nx + (v.vz - p.vz) * nz;
      const ram = v.kind === 'snowplow' ? CFG.plowRam : CFG.snowmobileRam;
      if (driver && p.team !== driver.team && closing > ram && p.invuln <= 0 && p.ramCd <= 0 && w.phase === 'fight') {
        p.ramCd = 0.9;
        p.health = v.kind === 'snowplow' ? 0 : p.health - CFG.snowmobileRamDamage;
        p.sinceHit = 0; p.lastHitBy = driver.id;
        p.vx = v.vx * 0.9 + nx * 3; p.vz = v.vz * 0.9 + nz * 3; p.vy = 6; p.grounded = false; p.sliding = false;
        w.emit({ type: 'hit', pid: p.id, by: driver.id, x: p.x, y: p.y + 0.6, z: p.z, health: Math.max(0, p.health) });
        if (p.health <= 0) w.splat(p, driver.id, 'vehicle');
        if (v.kind === 'snowmobile') { v.vx *= 0.82; v.vz *= 0.82; }
      }
      p.x = cx + nx * min; p.z = cz + nz * min;
      const vn = p.vx * nx + p.vz * nz, want = v.vx * nx + v.vz * nz;
      if (vn < want) { p.vx += (want - vn) * nx; p.vz += (want - vn) * nz; }
    }
  }
  if (px !== 0 || pz !== 0) {
    const pl = Math.hypot(px, pz);
    const lim = Math.min(pl, 0.6);
    v.x += px / pl * lim; v.z += pz / pl * lim;
    const nx = px / pl, nz = pz / pl;
    const vn = v.vx * nx + v.vz * nz;
    if (vn < 0) {
      if (vn < -5) w.emit({ type: 'vehicleBump', vid: v.id, x: v.x - nx * 0.8, y: v.y + 0.5, z: v.z - nz * 0.8, hard: Math.min(1, -vn / 14) });
      const bounce = v.kind === 'snowmobile' ? 1.25 : 1;
      v.vx -= vn * nx * bounce; v.vz -= vn * nz * bounce;
    }
  }
  // the edge of the map
  const bd = w.map.bounds, m = 1.2;
  if (v.x < bd.minX + m) { v.x = bd.minX + m; v.vx = Math.max(0, v.vx); }
  if (v.x > bd.maxX - m) { v.x = bd.maxX - m; v.vx = Math.min(0, v.vx); }
  if (v.z < bd.minZ + m) { v.z = bd.minZ + m; v.vz = Math.max(0, v.vz); }
  if (v.z > bd.maxZ - m) { v.z = bd.maxZ - m; v.vz = Math.min(0, v.vz); }
  // the line nobody may cross yet (build phase; Breakthrough's regroup), same as on foot
  const line = w.holdLine();
  if (line !== null) {
    const lim = spec.front + 1.2;
    if (side === 0 && v.x > line - lim) { v.x = Math.max(line - lim, v.x - 14 / 60); if (v.vx > 0) v.vx = 0; }
    if (side === 1 && w.phase === 'build' && v.x < line + lim) { v.x = line + lim; if (v.vx < 0) v.vx = 0; }
  }
}

function bumpVehicles(w: World, a: Vehicle, b: Vehicle) {
  if (!a.alive || !b.alive || Math.abs(a.y - b.y) > 2.5 || Math.hypot(a.x - b.x, a.z - b.z) > 7) return;
  const sa = VEHICLE_SPECS[a.kind], sb = VEHICLE_SPECS[b.kind];
  const mass = (k: VehicleKind) => k === 'snowplow' ? 8 : k === 'snowtank' ? 5 : 1;
  const ma = mass(a.kind), mb = mass(b.kind);
  for (const [fa, ra] of sa.circles) for (const [fb, rb] of sb.circles) {
    const ax = a.x - Math.sin(a.yaw) * fa, az = a.z - Math.cos(a.yaw) * fa;
    const bx = b.x - Math.sin(b.yaw) * fb, bz = b.z - Math.cos(b.yaw) * fb;
    const dx = bx - ax, dz = bz - az, d = Math.hypot(dx, dz), min = ra + rb;
    if (d >= min || d < 1e-4) continue;
    const nx = dx / d, nz = dz / d, pen = min - d;
    a.x -= nx * pen * mb / (ma + mb); a.z -= nz * pen * mb / (ma + mb);
    b.x += nx * pen * ma / (ma + mb); b.z += nz * pen * ma / (ma + mb);
    const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
    if (rel < 0) {
      const j = -1.2 * rel / (1 / ma + 1 / mb);
      a.vx -= j / ma * nx; a.vz -= j / ma * nz; b.vx += j / mb * nx; b.vz += j / mb * nz;
      // the snowplow wrecks an enemy snowmobile it drives into
      if (rel < -3 && vehicleSide(w, a) !== vehicleSide(w, b)) {
        if (a.kind === 'snowplow' && b.kind === 'snowmobile') damageVehicle(w, b, 3, a.seats[0], bx, b.y + 0.5, bz);
        if (b.kind === 'snowplow' && a.kind === 'snowmobile') damageVehicle(w, a, 3, b.seats[0], ax, a.y + 0.5, az);
      }
    }
  }
}
