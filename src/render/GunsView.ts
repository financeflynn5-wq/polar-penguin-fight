// Everything you see of the guns and the Candy Cane Blade: the gun in a penguin's mittens (or slung on its back), guns floating over their
// pads, the streams of hot chocolate and freezing water, steam and splashes, the ice patches, and the ice that
// creeps up a soaked penguin. The gun models are Blender assets (tools/blender/guns.py → src/assets/models/guns).
import * as THREE from 'three';
import { SnowField, ISO } from '../world/SnowField';
import { World, Penguin, GameEvent } from '../sim/World';
import { GUN_COCOA, GUN_WATER, GUN_BLADE, IcePatch } from '../sim/Guns';
import { CFG } from '../sim/config';
import { Assets } from './Assets';
import { Particles, PKind } from './Particles';
import { bladePose, BladeAt } from './BladePose';

export const GUN_COLORS = [0xffffff, 0xff9d4d, 0x62d6ff, 0xff5c7a];
const GUN_FILES = ['', 'cocoa', 'water', 'blade'];

/** Where the gun sits when a penguin holds it, in the penguin's own frame (x right, y up, -z ahead), and on its back. */
export const GUN_HOLD = new THREE.Vector3(0.48, 0.58, -0.12);
export const GUN_BACK = new THREE.Vector3(-0.04, 0.66, 0.36);
export const GUN_BACK_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2 - 0.25, 0, 0.55, 'ZXY'));

/** A stand-in built from plain shapes, used only if the Blender model is missing. Same layout: grip at the origin, barrel along -z. */
function standIn(gun: number) {
  const g = new THREE.Group();
  if (gun === GUN_BLADE) {
    const red = new THREE.MeshStandardMaterial({ color: 0xe0263c, roughness: 0.25 }), white = new THREE.MeshStandardMaterial({ color: 0xfff4f0, roughness: 0.25 });
    for (let k = 0; k < 8; k++) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.035 - k * 0.002, 0.037 - k * 0.002, 0.1, 10), k % 2 ? white : red);
      m.rotation.x = Math.PI / 2; m.position.set(0, 0, -0.1 - k * 0.1); m.castShadow = true; g.add(m);
    }
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.033, 0.16, 8), new THREE.MeshStandardMaterial({ color: 0x5b2f17, roughness: 0.7 }));
    grip.rotation.x = Math.PI / 2; g.add(grip);
    const tip = new THREE.Object3D(); tip.name = 'tip'; tip.position.set(0, 0, -0.87); g.add(tip);
    return g;
  }
  const cocoa = gun === GUN_COCOA;
  const body = new THREE.MeshStandardMaterial({ color: cocoa ? 0xb5482f : 0x2aa7e8, roughness: 0.45 });
  const trim = new THREE.MeshStandardMaterial({ color: cocoa ? 0xf4ead8 : 0xffd23e, roughness: 0.5 });
  const tank = new THREE.MeshStandardMaterial({ color: cocoa ? 0x5b2f17 : 0x9fe6ff, roughness: 0.2 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.x = rx; m.castShadow = true; g.add(m); return m;
  };
  add(new THREE.CapsuleGeometry(0.06, 0.26, 4, 10), body, 0, 0.07, -0.14, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.03, 0.036, 0.26, 10), trim, 0, 0.08, -0.42, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.03, 0.035, 0.13, 8), body, 0, -0.03, 0.01, 0.25);
  add(cocoa ? new THREE.CylinderGeometry(0.085, 0.075, 0.15, 14) : new THREE.SphereGeometry(0.095, 14, 10), tank, 0, 0.2, -0.1);
  const muzzle = new THREE.Object3D(); muzzle.name = 'muzzle'; muzzle.position.set(0, 0.08, -0.56); g.add(muzzle);
  return g;
}

export function makeGun(gun: number): THREE.Object3D {
  const src = Assets.guns.get(GUN_FILES[gun]);
  return src ? src.clone(true) : standIn(gun);
}

// ───────────────────────── the streams ─────────────────────────
const CAP = 420;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _d = new THREE.Vector3();
const FWD = new THREE.Vector3(0, 0, 1);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** Blobs of liquid in flight, drawn as stretched little spheres. One of these per gun kind. */
class Stream {
  readonly mesh: THREE.InstancedMesh;
  private pos = new Float32Array(CAP * 3);
  private vel = new Float32Array(CAP * 3);
  private life = new Float32Array(CAP);
  private wait = new Float32Array(CAP);
  private size = new Float32Array(CAP);
  private owner = new Int32Array(CAP);
  private team = new Int8Array(CAP);
  private next = 0;
  live = 0;

  constructor(readonly gun: number, mat: THREE.Material, private g: number) {
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), mat, CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.visible = false; // nothing to draw until someone squirts (saves drawing CAP empty drops every frame)
    for (let i = 0; i < CAP; i++) this.mesh.setMatrixAt(i, ZERO);
  }

  add(owner: number, team: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, wait = 0) {
    const i = this.next; this.next = (this.next + 1) % CAP;
    if (this.life[i] <= 0) this.live++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.wait[i] = wait; this.size[i] = size; this.owner[i] = owner; this.team[i] = team;
  }

  update(dt: number, w: World, field: SnowField, splash: (gun: number, x: number, y: number, z: number, onPenguin: boolean) => void) {
    this.mesh.visible = this.live > 0;
    if (this.live <= 0) return;
    for (let i = 0; i < CAP; i++) {
      if (this.life[i] <= 0) continue;
      if (this.wait[i] > 0) { this.wait[i] -= dt; continue; }
      const i3 = i * 3;
      this.life[i] -= dt;
      this.vel[i3 + 1] -= this.g * dt;
      let x = this.pos[i3], y = this.pos[i3 + 1], z = this.pos[i3 + 2];
      const vx = this.vel[i3], vy = this.vel[i3 + 1], vz = this.vel[i3 + 2];
      let hit = 0;
      // two half steps so a fast squirt doesn't skip through a thin wall
      for (let h = 0; h < 2 && !hit; h++) {
        x += vx * dt * 0.5; y += vy * dt * 0.5; z += vz * dt * 0.5;
        if (y < 0 || field.sample(x, y, z) > ISO) hit = 1;
        else for (const p of w.penguins) {
          if (!p.alive || p.team === this.team[i]) continue; // (the real squirts fly past teammates too)
          const cy = p.sliding ? p.y + 0.3 : Math.max(p.y + 0.3, Math.min(p.y + 1.05, y));
          if (Math.abs(x - p.x) < 0.5 && Math.abs(z - p.z) < 0.5 && Math.hypot(x - p.x, y - cy, z - p.z) < 0.5) { hit = 2; break; }
        }
      }
      if (hit || this.life[i] <= 0) {
        if (hit) splash(this.gun, x, y, z, hit === 2);
        this.life[i] = 0; this.live--;
        this.mesh.setMatrixAt(i, ZERO);
        continue;
      }
      this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
      const sp = Math.hypot(vx, vy, vz) || 1;
      _q.setFromUnitVectors(FWD, _d.set(vx / sp, vy / sp, vz / sp));
      const s = this.size[i];
      _m.compose(_p.set(x, y, z), _q, _s.set(s, s, s * (1 + sp * 0.2)));
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ───────────────────────── ice patches ─────────────────────────
const RINGS = 4, SEGS = 22;
const ICE = new THREE.MeshPhysicalMaterial({
  color: 0xbfeaff, roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.8,
  emissive: 0x3d9fd8, emissiveIntensity: 0.22, transparent: true, opacity: 0.82, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
});

class PatchMesh {
  readonly mesh: THREE.Mesh;
  private mat: THREE.MeshPhysicalMaterial;
  private r = -1;
  private age = 0;
  private checkT = 0;

  constructor(readonly patch: IcePatch) {
    const geo = new THREE.BufferGeometry();
    const n = 1 + RINGS * SEGS;
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const idx: number[] = [];
    for (let s = 0; s < SEGS; s++) {
      const s1 = (s + 1) % SEGS;
      idx.push(0, 1 + s1, 1 + s);
      for (let r = 0; r < RINGS - 1; r++) {
        const a = 1 + r * SEGS + s, b = 1 + r * SEGS + s1, c = a + SEGS, d = b + SEGS;
        idx.push(a, b, d, a, d, c);
      }
    }
    geo.setIndex(idx);
    this.mat = ICE.clone();
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  update(q: IcePatch, field: SnowField, dt: number) {
    this.age += dt;
    this.checkT -= dt;
    if (q.r !== this.r || this.checkT <= 0 || this.age < 0.35) {
      // lay the sheet over the snow as it is now (a wobbly edge so it reads as a frozen puddle, not a disc)
      this.r = q.r; this.checkT = 0.5;
      const grow = Math.min(1, 0.3 + this.age / 0.3 * 0.7);
      const pos = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
      const at = (i: number, x: number, z: number) => {
        const g = field.surfaceBelow(x, q.y + 0.5, z, 0.3, 1.2);
        pos.setXYZ(i, x, (g !== null && Math.abs(g - q.y) < 0.6 ? g : q.y) + 0.035, z);
      };
      at(0, q.x, q.z);
      for (let r = 0; r < RINGS; r++) for (let s = 0; s < SEGS; s++) {
        const a = s / SEGS * Math.PI * 2;
        const wob = 1 + 0.13 * Math.sin(a * 3 + q.id * 1.7) + 0.07 * Math.sin(a * 7 + q.id);
        const rad = q.r * grow * wob * (r + 1) / RINGS;
        at(1 + r * SEGS + s, q.x + Math.cos(a) * rad, q.z + Math.sin(a) * rad);
      }
      pos.needsUpdate = true;
      this.mesh.geometry.computeVertexNormals();
    }
    // melts away over its last couple of seconds
    this.mat.opacity = 0.82 * Math.min(1, q.t / 2);
  }

  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}

// ───────────────────────── the view ─────────────────────────
interface Held { gun: number; obj: THREE.Object3D; root: THREE.Object3D; muzzle: THREE.Object3D | null; tip: THREE.Object3D | null; hand: THREE.Object3D | null; kick: number; out: boolean; at: BladeAt | null; }
interface Floating { gun: number; group: THREE.Group; model: THREE.Object3D; ring: THREE.Mesh; beam: THREE.Mesh | null; phase: number; }
interface Frost { group: THREE.Group; root: THREE.Object3D; now: number; }

const CRYSTAL = new THREE.OctahedronGeometry(1, 0);
const CRYSTAL_MAT = new THREE.MeshPhysicalMaterial({
  color: 0xc8f0ff, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05, transparent: true, opacity: 0.8,
  emissive: 0x4db4ea, emissiveIntensity: 0.35, envMapIntensity: 1.8,
});
const RING_GEO = new THREE.RingGeometry(0.7, 0.92, 40).rotateX(-Math.PI / 2);
const BEAM_GEO = new THREE.CylinderGeometry(0.4, 0.62, 7, 20, 1, true).translate(0, 3.5, 0);

function beamMaterial(color: number) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: 'varying float vH; void main(){ vH = position.y / 7.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: // clamp: vH reaches a hair over 1.0 at the beam's top edge, and pow() of a negative number is NaN, which the
    // bloom pass used to smear into big black squares across the screen
    'uniform vec3 uColor; varying float vH; void main(){ float a = pow(clamp(1.0 - vH, 0.0, 1.0), 1.8) * 0.7; gl_FragColor = vec4(uColor * a, a); }',
  });
}

export class GunsView {
  readonly group = new THREE.Group();
  private held = new Map<number, Held>();
  private floating = new Map<number, Floating>();
  private patches = new Map<number, PatchMesh>();
  private frost = new Map<number, Frost>();
  private streams: Stream[];
  private beamMats = [null, beamMaterial(GUN_COLORS[GUN_COCOA]), beamMaterial(GUN_COLORS[GUN_WATER]), beamMaterial(GUN_COLORS[GUN_BLADE])];
  private ringMats = [null, GUN_COLORS[GUN_COCOA], GUN_COLORS[GUN_WATER], GUN_COLORS[GUN_BLADE]].map(c => c === null ? null
    : new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));

  constructor(private field: SnowField, private particles: Particles) {
    const cocoa = new THREE.MeshStandardMaterial({ color: 0x6b3416, roughness: 0.22, emissive: 0x2a1206, emissiveIntensity: 0.5 });
    const water = new THREE.MeshStandardMaterial({ color: 0xa5e6ff, roughness: 0.1, emissive: 0x2f9ad8, emissiveIntensity: 0.7, transparent: true, opacity: 0.9 });
    this.streams = [new Stream(GUN_COCOA, cocoa, CFG.cocoaGravity), new Stream(GUN_WATER, water, CFG.waterGravity)];
    for (const s of this.streams) this.group.add(s.mesh);
  }

  /** A squirt left a gun (the 'gunShot' event): draw it. The server decides what it hits; this is only the picture. */
  shot(e: Extract<GameEvent, { type: 'gunShot' }>, team: number) {
    const P = this.particles;
    const h = this.held.get(e.pid);
    if (h) h.kick = 1;
    // start the picture at the nozzle you can see (the server's squirt starts within a hand's width of it)
    let x = e.x, y = e.y, z = e.z;
    if (h && h.muzzle && h.out) { h.muzzle.getWorldPosition(_p2); if (Math.hypot(_p2.x - x, _p2.y - y, _p2.z - z) < 0.7) { x = _p2.x; y = _p2.y; z = _p2.z; } }
    if (e.gun === GUN_COCOA) {
      // a thick wobbly stream: a few blobs per squirt, set off a moment apart so they join up
      const st = this.streams[0], every = 1 / CFG.cocoaRate;
      for (let k = 0; k < 4; k++) {
        const j = 0.5;
        st.add(e.pid, team, x, y, z, e.vx + (Math.random() - 0.5) * j, e.vy + (Math.random() - 0.5) * j, e.vz + (Math.random() - 0.5) * j,
          CFG.cocoaLife, 0.06 + Math.random() * 0.04, k * every / 4);
      }
      // a wisp of steam off the stream now and then
      if (Math.random() < 0.25) P.spawn(PKind.Puff, x + e.vx * 0.05, y + e.vy * 0.05 + 0.08, z + e.vz * 0.05, e.vx * 0.05, 0.8, e.vz * 0.05, 0.07 + Math.random() * 0.05, 0.45);
    } else {
      // one fat glob with a few beads trailing it
      const st = this.streams[1];
      st.add(e.pid, team, x, y, z, e.vx, e.vy, e.vz, CFG.waterLife, 0.085);
      for (let k = 1; k <= 3; k++) st.add(e.pid, team, x, y, z, e.vx * (1 - k * 0.035), e.vy * (1 - k * 0.035), e.vz * (1 - k * 0.035), CFG.waterLife, 0.05 - k * 0.008, k * 0.012);
      for (let k = 0; k < 3; k++) P.spawn(PKind.Spark, x, y, z, e.vx * 0.12 + (Math.random() - 0.5) * 2, e.vy * 0.12 + Math.random() * 1.5, e.vz * 0.12 + (Math.random() - 0.5) * 2, 0.05, 0.25, 0.7, 0.92, 1);
    }
  }

  /** Where a stream lands: steam off melting snow, or a splash of icy spray. */
  private splash = (gun: number, x: number, y: number, z: number, onPenguin: boolean) => {
    const P = this.particles;
    if (gun === GUN_COCOA) {
      if (Math.random() < 0.7) P.spawn(PKind.Puff, x + (Math.random() - 0.5) * 0.3, y + 0.1, z + (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.8, 1.6 + Math.random() * 1.4, (Math.random() - 0.5) * 0.8, 0.3 + Math.random() * 0.35, 0.7 + Math.random() * 0.5);
      for (let k = 0; k < (onPenguin ? 3 : 2); k++) {
        const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 2;
        P.spawn(PKind.Grain, x, y + 0.05, z, Math.cos(a) * sp, 1.5 + Math.random() * 2, Math.sin(a) * sp, 0.035 + Math.random() * 0.03, 0.9, 0.42, 0.22, 0.1);
      }
    } else {
      for (let k = 0; k < (onPenguin ? 12 : 7); k++) {
        const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 2.6;
        P.spawn(PKind.Grain, x, y + 0.05, z, Math.cos(a) * sp, 1.5 + Math.random() * 2.5, Math.sin(a) * sp, 0.03 + Math.random() * 0.035, 0.8, 0.72, 0.9, 1);
      }
      P.spawn(PKind.Puff, x, y + 0.1, z, 0, 0.5, 0, 0.3, 0.4, 0.8, 0.93, 1);
      if (onPenguin) P.sparkle(x, y, z, 8, 0.6, 0.9, 1);
    }
  };

  update(w: World, roots: (id: number) => THREE.Object3D | undefined, dt: number, time: number) {
    this.updateHeld(w, roots, dt, time);
    this.updateFloating(w, dt, time);
    this.updatePatches(w, dt);
    this.updateFrost(w, roots, dt, time);
    for (const s of this.streams) s.update(dt, w, this.field, this.splash);
  }

  private updateHeld(w: World, roots: (id: number) => THREE.Object3D | undefined, dt: number, time: number) {
    for (const p of w.penguins) {
      let h = this.held.get(p.id);
      const root = roots(p.id);
      if (h && (h.gun !== p.gun || h.root !== root)) { h.root.remove(h.obj); this.held.delete(p.id); h = undefined; }
      if (!p.gun || !root) continue;
      if (!h) {
        const obj = makeGun(p.gun);
        h = { gun: p.gun, obj, root, muzzle: obj.getObjectByName('muzzle') ?? null, tip: obj.getObjectByName('tip') ?? null, hand: root.getObjectByName('handR') ?? null, kick: 0, out: false, at: null };
        root.add(obj);
        this.held.set(p.id, h);
      }
      const o = h.obj;
      o.visible = p.alive && (p.invuln <= 0 || Math.floor(time * 12) % 2 === 0);
      h.kick = Math.max(0, h.kick - dt * 9);
      const out = p.gunOut && (p.action === 'idle' || p.action === 'throw');
      h.out = out;
      if (out && h.gun === GUN_BLADE) {
        // the blade: carried upright in the right mitten, and swung over the shoulder and down (the sim borrows the throw timer for it)
        const pitch = Math.max(-0.6, Math.min(0.6, p.lookPitch));
        const to = bladePose(p.throwAnim > 0 ? 1 - p.throwAnim / 0.25 : -1, pitch, _bt);
        if (!h.at) h.at = { ...to };
        // swings snap to the pose; afterwards the blade settles back to the carry
        const k = p.throwAnim > 0 ? 1 : Math.min(1, dt * 12);
        const at = h.at;
        at.x += (to.x - at.x) * k; at.y += (to.y - at.y) * k; at.z += (to.z - at.z) * k;
        at.rx += (to.rx - at.rx) * k; at.ry += (to.ry - at.ry) * k; at.rz += (to.rz - at.rz) * k;
        o.position.set(at.x, at.y + Math.sin(time * 2.1 + p.id) * 0.006, at.z);
        // the grip goes wherever the right mitten really is (the arm is posed to reach for the same spot, see PenguinModel)
        if (h.hand) { root.updateMatrixWorld(true); o.position.copy(root.worldToLocal(h.hand.localToWorld(_p2.copy(MITTEN)))); }
        o.rotation.set(at.rx, at.ry, at.rz, 'YXZ');
        o.scale.setScalar(1);
        if (p.throwAnim > 0.04 && h.tip && o.visible) {
          // a sugary streak off the tip
          h.tip.getWorldPosition(_p2);
          for (let n = 0; n < 2; n++) this.particles.spawn(PKind.Spark, _p2.x, _p2.y, _p2.z, (Math.random() - 0.5) * 0.6, 0.3, (Math.random() - 0.5) * 0.6, 0.07, 0.28, 1, n ? 0.45 : 0.95, n ? 0.55 : 0.95);
        }
      } else if (out) {
        // in the mittens, pointing where the penguin looks (the body turns to follow, a moment behind)
        let rel = p.lookYaw - p.yaw;
        while (rel > Math.PI) rel -= Math.PI * 2;
        while (rel < -Math.PI) rel += Math.PI * 2;
        const pitch = Math.max(-0.7, Math.min(0.75, p.lookPitch));
        o.position.copy(GUN_HOLD);
        o.position.y += pitch * 0.12 + Math.sin(time * 2.1 + p.id) * 0.006;
        o.position.z += h.kick * 0.03;
        o.rotation.set(pitch + h.kick * 0.05, Math.max(-0.9, Math.min(0.9, rel)), 0, 'YXZ');
        o.scale.setScalar(1);
      } else {
        // slung across the back
        o.position.copy(GUN_BACK);
        if (p.sliding) { o.position.set(-0.04, 0.5, 0.2); o.quaternion.setFromEuler(_e.set(0.1, 0, Math.PI / 2 + 0.3)); }
        else o.quaternion.copy(GUN_BACK_Q);
        o.scale.setScalar(0.92);
        h.at = null;
      }
    }
  }

  private updateFloating(w: World, dt: number, time: number) {
    const seen = new Set<number>();
    for (const c of w.guns.crates) {
      seen.add(c.id);
      let f = this.floating.get(c.id);
      if (!f) {
        const group = new THREE.Group();
        const model = makeGun(c.gun);
        model.scale.setScalar(c.gun === GUN_BLADE ? 1.5 : 1.9);
        model.rotation.z = 0.28;
        // the blade hangs point up, like a sword waiting for its hero
        if (c.gun === GUN_BLADE) { model.rotation.set(Math.PI / 2 - 0.2, 0, 0); model.position.y = -0.55; }
        const tilt = new THREE.Group(); tilt.add(model); group.add(tilt);
        const ring = new THREE.Mesh(RING_GEO, this.ringMats[c.gun]!);
        ring.renderOrder = 3;
        group.add(ring);
        // pad guns stand in a tall beam of light so you can find them from across the map; dropped ones just glow
        const beam = c.pad < 0 ? null : new THREE.Mesh(BEAM_GEO, this.beamMats[c.gun]!);
        if (beam) { beam.renderOrder = 6; group.add(beam); }
        f = { gun: c.gun, group, model: tilt, ring, beam, phase: c.id * 1.3 };
        this.group.add(group);
        this.floating.set(c.id, f);
      }
      f.group.position.set(c.x, c.y, c.z);
      f.model.rotation.y = time * 1.6 + f.phase;
      f.model.position.y = Math.sin(time * 2.4 + f.phase) * 0.09;
      f.model.position.z = 0;
      const pulse = 1 + Math.sin(time * 4 + f.phase) * 0.08;
      f.ring.position.y = -0.9; f.ring.scale.set(pulse, 1, pulse);
      if (f.beam) f.beam.position.y = -0.9;
      if (Math.random() < dt * 5) {
        const col = c.gun === GUN_COCOA ? [1, 0.75, 0.45] : c.gun === GUN_BLADE ? [1, 0.55, 0.65] : [0.6, 0.9, 1];
        this.particles.spawn(PKind.Spark, c.x + (Math.random() - 0.5) * 0.9, c.y - 0.6 + Math.random() * 1.2, c.z + (Math.random() - 0.5) * 0.9, 0, 1.2, 0, 0.05, 0.7, col[0], col[1], col[2]);
      }
    }
    for (const [id, f] of this.floating) if (!seen.has(id)) { this.group.remove(f.group); this.floating.delete(id); }
  }

  private updatePatches(w: World, dt: number) {
    const seen = new Set<number>();
    for (const q of w.guns.patches) {
      seen.add(q.id);
      let m = this.patches.get(q.id);
      if (!m) { m = new PatchMesh(q); this.group.add(m.mesh); this.patches.set(q.id, m); }
      m.update(q, this.field, dt);
    }
    for (const [id, m] of this.patches) if (!seen.has(id)) { this.group.remove(m.mesh); m.dispose(); this.patches.delete(id); }
  }

  /** Ice creeping up a soaked penguin: crystals round its feet and body that grow with the chill. */
  private updateFrost(w: World, roots: (id: number) => THREE.Object3D | undefined, dt: number, time: number) {
    for (const p of w.penguins) {
      let f = this.frost.get(p.id);
      const root = roots(p.id);
      if (f && f.root !== root) { f.root.remove(f.group); this.frost.delete(p.id); f = undefined; }
      const chill = p.alive ? p.chill : 0;
      if (!f) {
        if (chill <= 0.02 || !root) continue;
        const group = new THREE.Group();
        for (let k = 0; k < 9; k++) {
          const c = new THREE.Mesh(CRYSTAL, CRYSTAL_MAT);
          const a = k / 9 * Math.PI * 2 + (k % 2) * 0.3, low = k % 3 !== 0;
          const rad = low ? 0.4 : 0.36;
          c.position.set(Math.cos(a) * rad, low ? 0.1 + (k % 2) * 0.08 : 0.55 + (k % 2) * 0.2, Math.sin(a) * rad);
          c.rotation.set(Math.cos(a) * 0.5 + k, k * 1.3, Math.sin(a) * 0.5);
          c.scale.set(0.07 + (k % 3) * 0.02, 0.2 + (k % 4) * 0.05, 0.07 + (k % 2) * 0.03);
          c.userData.s = c.scale.clone();
          group.add(c);
        }
        f = { group, root, now: 0 };
        root.add(group);
        this.frost.set(p.id, f);
      }
      f.now += (chill - f.now) * Math.min(1, dt * 10);
      f.group.visible = f.now > 0.02;
      if (!f.group.visible) continue;
      const k = 0.35 + 0.65 * f.now;
      for (const c of f.group.children) c.scale.copy(c.userData.s as THREE.Vector3).multiplyScalar(k);
      if (Math.random() < dt * 14 * f.now) {
        this.particles.spawn(PKind.Spark, p.x + (Math.random() - 0.5) * 0.7, p.y + Math.random() * 1.1, p.z + (Math.random() - 0.5) * 0.7, 0, 0.5, 0, 0.045, 0.5, 0.7, 0.92, 1);
      }
      void time;
    }
  }

  /** The tip of the gun a penguin is holding, in the world (for effects that start at the nozzle). */
  muzzleOf(id: number, out: THREE.Vector3) {
    const h = this.held.get(id);
    if (!h || !h.muzzle) return null;
    return h.muzzle.getWorldPosition(out);
  }

  dispose() {
    for (const m of this.patches.values()) m.dispose();
    for (const s of this.streams) { s.mesh.geometry.dispose(); (s.mesh.material as THREE.Material).dispose(); }
  }
}

const _e = new THREE.Euler(), _p2 = new THREE.Vector3();
const _bt: BladeAt = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
/** the middle of the right mitten's palm, in the hand joint's own frame */
const MITTEN = new THREE.Vector3(0.0447, -0.0627, 0);
