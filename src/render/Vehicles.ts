// What you see of the vehicles: the Blender-built snowmobile and snowplow (tools/blender/vehicles.py, loaded by
// VehicleModel.ts), their moving parts, the snow they throw up and the tracks they leave.
import * as THREE from 'three';
import type { World } from '../sim/World';
import { Vehicle, VehicleKind, VEHICLE_KINDS, VEHICLE_SPECS, BLADE, maxHealth } from '../sim/Vehicles';
import { Particles, PKind } from './Particles';
import { Decals } from './Decals';
import { makeVehicleModel, disposeVehicleModel } from './VehicleModel';

/** Team paint: Blizzard blue, Sunrise orange. */
export const VEHICLE_TINT = [0x2f7ee8, 0xff8a2e];

const lerpA = (a: number, b: number, t: number) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; };
const _v = new THREE.Vector3();

interface View {
  kind: VehicleKind; team: number;
  /** at the vehicle's origin, turned to its heading */
  root: THREE.Group;
  /** leans with the slope */
  tilt: THREE.Group;
  model: THREE.Group | null;
  steer: THREE.Object3D[]; wheels: { o: THREE.Object3D; r: number }[];
  tracks: { o: THREE.Object3D; tex: THREE.Texture[]; side: number }[];
  blade: THREE.Object3D | null; beacon: THREE.MeshStandardMaterial[]; exhaust: THREE.Object3D | null;
  seats: (THREE.Object3D | null)[];
  bladeNow: number; trail: number; puff: number; seen: number; lastYaw: number; bounce: number; bounceV: number; smoke: number;
}

export class VehiclesView {
  readonly group = new THREE.Group();
  private views = new Map<number, View>();
  private frame = 0;

  constructor() {
    // fetch both models up front, so the first snowplow doesn't pop in a moment after it turns up
    for (const kind of VEHICLE_KINDS) makeVehicleModel(kind, 0xffffff).then(disposeVehicleModel).catch(() => { /* reported when one is needed */ });
  }

  private make(v: Vehicle): View {
    const root = new THREE.Group(), tilt = new THREE.Group();
    root.add(tilt);
    this.group.add(root);
    const view: View = {
      kind: v.kind, team: v.team, root, tilt, model: null, steer: [], wheels: [], tracks: [], blade: null, beacon: [], exhaust: null,
      seats: [], bladeNow: 0.25, trail: 0, puff: 0, seen: 0, lastYaw: v.yaw, bounce: 0, bounceV: 0, smoke: 0,
    };
    makeVehicleModel(v.kind, VEHICLE_TINT[v.team] ?? 0xffffff).then(model => {
      if (!root.parent) return; // gone before it loaded
      view.model = model;
      tilt.add(model);
      model.traverse(o => {
        const n = o.name;
        if (n === 'steer' || n === 'skiL' || n === 'skiR') view.steer.push(o);
        else if (n.startsWith('wheel')) view.wheels.push({ o, r: +(o.userData.radius ?? 0.2) || 0.2 });
        else if (n === 'track' || n === 'trackL' || n === 'trackR') view.tracks.push({ o, tex: (o.userData.scroll as THREE.Texture[] | undefined) ?? [], side: n === 'trackL' ? -1 : n === 'trackR' ? 1 : 0 });
        else if (n === 'blade') view.blade = o;
        else if (n === 'exhaust') view.exhaust = o;
        else if (n === 'beacon') {
          // each snowplow flashes its own beacon (the loader gives every vehicle its own copy of the material)
          const mat = o.userData.material as THREE.MeshStandardMaterial | undefined;
          if (mat) view.beacon.push(mat);
        }
        const seat = /^seat(\d)$/.exec(n);
        if (seat) view.seats[+seat[1]] = o;
      });
    }).catch(err => {
      console.error(`vehicle model ${v.kind} did not load`, err);
      // stand-in so the game is still playable
      const spec = VEHICLE_SPECS[v.kind];
      const box = new THREE.Mesh(new THREE.BoxGeometry(spec.front + spec.rear, spec.height * 0.6, spec.halfW * 2), new THREE.MeshStandardMaterial({ color: VEHICLE_TINT[v.team] }));
      box.position.y = spec.height * 0.35; box.castShadow = true;
      tilt.add(box);
    });
    return view;
  }

  /** Where a rider's seat is right now (world space), or null until the model has loaded. */
  seat(vid: number, seat: number): THREE.Object3D | null {
    return this.views.get(vid)?.seats[seat] ?? null;
  }

  /** The quaternion of the vehicle's body (heading and lean), for sitting riders on it. */
  body(vid: number): THREE.Object3D | null { return this.views.get(vid)?.tilt ?? null; }

  update(w: World | null, alpha: number, dt: number, time: number, P: Particles, decals: Decals) {
    this.frame++;
    if (w) for (const v of w.vehicles) {
      let view = this.views.get(v.id);
      if (!view) { view = this.make(v); this.views.set(v.id, view); }
      view.seen = this.frame;
      this.pose(w, v, view, alpha, dt, time, P, decals);
    }
    for (const [id, view] of this.views) {
      if (view.seen === this.frame) continue;
      this.group.remove(view.root);
      if (view.model) disposeVehicleModel(view.model);
      this.views.delete(id);
    }
  }

  private pose(w: World, v: Vehicle, view: View, alpha: number, dt: number, time: number, P: Particles, decals: Decals) {
    const spec = VEHICLE_SPECS[v.kind];
    const x = v.px + (v.x - v.px) * alpha, y = v.py + (v.y - v.py) * alpha, z = v.pz + (v.z - v.pz) * alpha;
    const yaw = lerpA(v.pyaw, v.yaw, alpha);
    const plow = v.kind === 'snowplow';
    const ridden = v.seats.some(s => s >= 0), driven = v.seats[0] >= 0;
    const speed = v.speed, abs = Math.abs(speed);

    // a little suspension: it bobs when it lands, when it's hit, and with the engine when someone's on it
    if (v.hitT < 0.05) view.bounceV = Math.min(view.bounceV, -0.9);
    view.bounceV += (-view.bounce * 160 - view.bounceV * 14) * dt;
    view.bounce += view.bounceV * dt;
    const idle = ridden ? Math.sin(time * (plow ? 31 : 47)) * (plow ? 0.006 : 0.004) : 0;
    view.root.position.set(x, y + view.bounce * 0.12 + idle, z);
    view.root.rotation.y = yaw + Math.PI / 2; // the models face +x
    const k = Math.min(1, dt * 12);
    view.tilt.rotation.z += (v.pitch - view.tilt.rotation.z) * k;
    // lean into the turn a touch (snowmobile), on top of the slope
    const lean = plow ? 0 : -v.steer * Math.min(1, abs / 9) * 0.16;
    view.tilt.rotation.x += (-v.roll + lean - view.tilt.rotation.x) * k;

    const dist = speed * dt;
    const turn = lerpA(view.lastYaw, yaw, 1) - view.lastYaw; // positive = turning left
    view.lastYaw = yaw;
    for (const s of view.steer) s.rotation.y += (-v.steer * (s.name === 'steer' ? 0.55 : 0.4) - s.rotation.y) * Math.min(1, dt * 14);
    for (const wh of view.wheels) wh.o.rotation.z -= dist / wh.r;
    for (const t of view.tracks) {
      // the tracks run at their own speeds when it turns on the spot
      const run = dist + t.side * turn * spec.halfW;
      for (const tex of t.tex) tex.offset.y = (tex.offset.y + run) % 1;
    }
    if (view.blade) {
      // down and working when it's pushing forward, lifted clear otherwise
      const want = driven && speed > 0.3 ? 0 : driven ? 0.14 : 0.24;
      view.bladeNow += (want - view.bladeNow) * Math.min(1, dt * 4);
      view.blade.rotation.z = view.bladeNow + (v.load > 0.05 ? Math.sin(time * 38) * 0.008 * v.load : 0);
    }
    for (const m of view.beacon) m.emissiveIntensity = driven ? 1.2 + 2.6 * Math.max(0, Math.sin(time * 9)) : 0.25;

    // ── snow and smoke ──
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    if (v.grounded && abs > 1.2) {
      // rooster tails off the track, powder off the skis
      const n = Math.min(plow ? 5 : 4, abs * dt * (plow ? 9 : 7) + Math.random());
      for (let i = 0; i < Math.floor(n); i++) {
        const side = (Math.random() - 0.5) * 2 * (plow ? spec.halfW + 0.15 : 0.22);
        const back = plow ? -spec.rear * (0.2 + Math.random()) : -spec.rear * (0.75 + Math.random() * 0.3);
        const sp = Math.sign(speed);
        P.spawn(PKind.Grain, x + fx * back * sp + rx * side, y + 0.08, z + fz * back * sp + rz * side,
          -fx * sp * abs * (0.15 + Math.random() * 0.3) + rx * (Math.random() - 0.5) * 2, 1.2 + Math.random() * (plow ? 2 : 1.5 + abs * 0.28), -fz * sp * abs * (0.15 + Math.random() * 0.3) + rz * (Math.random() - 0.5) * 2,
          0.035 + Math.random() * 0.06, 0.9 + Math.random() * 0.8);
      }
      if (!plow && abs > 6 && Math.random() < dt * 22) {
        for (const s of [-1, 1]) P.spawn(PKind.Puff, x + fx * spec.front * 0.8 + rx * s * 0.5, y + 0.1, z + fz * spec.front * 0.8 + rz * s * 0.5, rx * s * 1.5, 0.5, rz * s * 1.5, 0.3 + Math.random() * 0.25, 0.5);
      }
      if (Math.random() < dt * (plow ? 7 : 3 + abs * 0.35)) P.spawn(PKind.Puff, x - fx * spec.rear + rx * (Math.random() - 0.5) * (plow ? 1.6 : 0.3), y + 0.2, z - fz * spec.rear + rz * (Math.random() - 0.5) * (plow ? 1.6 : 0.3), -fx * 1.5, 0.6, -fz * 1.5, plow ? 0.4 + Math.random() * 0.4 : 0.22 + Math.random() * 0.22, 0.6);
      // tracks in the snow
      view.trail += abs * dt;
      if (view.trail > (plow ? 0.5 : 0.3)) {
        view.trail = 0;
        if (plow) for (const s of [-1, 1]) decals.groove(time, x - fx * 0.6 + rx * s * 0.82, y, z - fz * 0.6 + rz * s * 0.82, yaw, 0.62, 0.7);
        else { decals.groove(time, x - fx * 0.55, y, z - fz * 0.55, yaw, 0.44, 0.5); decals.boardTrack(time, x + fx * 0.8, y, z + fz * 0.8, yaw); }
      }
    }
    // exhaust: a chug of grey from the stack (snowplow), a wisp from under the cowl (snowmobile)
    view.puff -= dt * (driven ? 6 + abs * 1.5 : 0);
    if (view.puff < 0) {
      view.puff = 1;
      if (view.exhaust) view.exhaust.getWorldPosition(_v); else _v.set(x - fx * spec.rear * 0.9, y + 0.45, z - fz * spec.rear * 0.9);
      const g = 0.55 + Math.random() * 0.15;
      P.spawn(PKind.Puff, _v.x, _v.y, _v.z, -fx * 0.6 + (Math.random() - 0.5) * 0.4, 1.4 + Math.random(), -fz * 0.6 + (Math.random() - 0.5) * 0.4, plow ? 0.35 : 0.2, 0.9, g, g, g + 0.03);
    }
    // nearly wrecked: it smokes
    const frac = v.health / maxHealth(w, v.kind);
    if (frac < 0.4) {
      view.smoke -= dt * (frac < 0.2 ? 14 : 7);
      if (view.smoke < 0) {
        view.smoke = 1;
        P.spawn(PKind.Puff, x + fx * spec.front * 0.4 + (Math.random() - 0.5) * 0.5, y + spec.height * 0.55, z + fz * spec.front * 0.4 + (Math.random() - 0.5) * 0.5, 0, 1.8 + Math.random(), 0, 0.5 + Math.random() * 0.4, 1.3, 0.3, 0.3, 0.32);
      }
    }
  }

  /** The blade is cutting snow: a wave of it breaks over the top and pours off both ends. */
  plowSpray(v: Vehicle, mass: number, P: Particles) {
    const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw), rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);
    const n = Math.min(60, 4 + Math.ceil(mass / 60));
    const sp = Math.max(2, Math.abs(v.speed));
    for (let i = 0; i < n; i++) {
      const u = (Math.random() * 2 - 1) * BLADE.halfW;
      const edge = Math.abs(u) / BLADE.halfW;
      const bx = v.x + fx * (BLADE.near + 0.5 + Math.random() * 0.6) + rx * u, bz = v.z + fz * (BLADE.near + 0.5 + Math.random() * 0.6) + rz * u;
      const out = Math.sign(u) * (1 + edge * 4) * (0.5 + Math.random());
      P.spawn(PKind.Grain, bx, v.y + 0.2 + Math.random() * 1.2, bz, fx * sp * (0.4 + Math.random() * 0.6) + rx * out, 1.5 + Math.random() * 3.5, fz * sp * (0.4 + Math.random() * 0.6) + rz * out,
        0.04 + Math.random() * 0.08, 1 + Math.random());
    }
    if (mass > 400) for (let i = 0; i < 2; i++) P.spawn(PKind.Puff, v.x + fx * (BLADE.far - 0.2) + rx * (Math.random() - 0.5) * 3, v.y + 0.6 + Math.random(), v.z + fz * (BLADE.far - 0.2) + rz * (Math.random() - 0.5) * 3, fx * 2, 1.2, fz * 2, 0.45 + Math.random() * 0.45, 0.7);
  }

  dispose() {
    for (const view of this.views.values()) { this.group.remove(view.root); if (view.model) disposeVehicleModel(view.model); }
    this.views.clear();
  }
}
