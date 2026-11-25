import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Penguin } from '../sim/World';
import { TEAM_COLORS } from './Environment';
import { makeSurfboard } from './Props';
import { Assets, RigFacts } from './Assets';
import { CLASSES, ClassId } from '../sim/Classes';

// The penguin, the polar bear, the yeti and the hats are Blender assets (tools/blender → src/assets/models). This file
// dresses a copy in team colours and animates its skeleton. All three share one skeleton layout, and every joint is
// axis-aligned at rest: x = the character's right, y = up, -z = ahead. What differs between them (how the arms hang,
// how tall they are, where snow sticks) comes from Assets.rigs.

// Team looks: jacket in the team colour, scarf and mittens in a lighter accent so the silhouette has some contrast.
const SCARF_COLORS = [0xa9e4ff, 0xffd43d];
const MITTEN_COLORS = [0x4f9df8, 0xff8a3a];
const UPGRADED_MITTENS: { color: number; emissive: number; glow: number; metal: number; rough: number }[] = [
  { color: 0x7fe3ff, emissive: 0x1a6a8a, glow: 0.5, metal: 0, rough: 0.5 },
  { color: 0xe8f4ff, emissive: 0x8ab8ff, glow: 0.6, metal: 0.45, rough: 0.3 },
  { color: 0xffd34d, emissive: 0xff9d00, glow: 0.8, metal: 0.65, rough: 0.28 },
];

interface Looks {
  base: THREE.Material; eye: THREE.Material; other: Record<string, THREE.Material>;
  jacket: THREE.Material[]; scarf: THREE.Material[]; mitten: THREE.Material[][];
  all: THREE.MeshPhysicalMaterial[];
}
type Side = 'L' | 'R';
type Sides = Record<Side, THREE.Vector3>;
/** One class's model, its materials, and the numbers its poses are built from. */
interface Rig {
  src: THREE.Group; facts: RigFacts; looks: Looks;
  /** how much bigger than the penguin it is (pose offsets are written for the penguin and scaled by this) */
  size: number;
  /** the model itself is scaled by this (only when a class has no model of its own yet and borrows the penguin) */
  scale: number;
  armBind: Sides; elbowAxis: Sides; lidAxis: Sides;
}
const rigs = new Map<ClassId, Rig>();
let lowQuality = false;

function tinted(src: THREE.MeshPhysicalMaterial, color: number, glow: number) {
  const m = src.clone();
  m.color.set(color);
  m.sheenColor.multiply(m.color); // the fuzz on wool picks up the dye, so sunlit scarves stay colourful instead of going pale
  // a little self-light in the team colour keeps jackets readable in shade
  m.emissive.set(color); m.emissiveMap = m.map; m.emissiveIntensity = glow;
  return m;
}

const DRESSED = ['Eye', 'TeamJacket', 'TeamScarf', 'Mitten'];

function buildLooks(src: THREE.Group): Looks {
  const found: Record<string, THREE.MeshPhysicalMaterial> = {};
  src.traverse(o => { const m = (o as THREE.Mesh).material as THREE.MeshPhysicalMaterial | undefined; if (m && !Array.isArray(m)) found[m.name] = m; });
  // everything that isn't an eye or team clothing: feathers or fur, beak or muzzle, feet
  const other: Record<string, THREE.Material> = {};
  for (const n of Object.keys(found)) if (!DRESSED.includes(n)) other[n] = found[n];
  const base = Object.values(other)[0] as THREE.MeshPhysicalMaterial, eye = found.Eye;
  eye.envMapIntensity = 1.6;
  // the whites and the painted catch-lights glow a little, so eyes still sparkle when a face is in shade
  eye.emissive.set(0xffffff); eye.emissiveMap = eye.map; eye.emissiveIntensity = 0.3;
  const jacket = TEAM_COLORS.map(c => tinted(found.TeamJacket, c, 0.16));
  const scarf = SCARF_COLORS.map(c => tinted(found.TeamScarf, c, 0.1));
  const mitten = MITTEN_COLORS.map(c => {
    const row = [tinted(found.Mitten, c, 0.1)];
    for (const u of UPGRADED_MITTENS) {
      const m = found.Mitten.clone();
      m.color.set(u.color); m.emissive.set(u.emissive); m.emissiveIntensity = u.glow; m.emissiveMap = m.map;
      m.metalness = u.metal; m.metalnessMap = null; m.roughness = u.rough;
      row.push(m);
    }
    return row;
  });
  const all = [...Object.values(other) as THREE.MeshPhysicalMaterial[], eye, ...jacket, ...scarf, ...mitten.flat()];
  for (const m of all) { m.userData.normalMap = m.normalMap; m.userData.sheen = m.sheen; m.userData.clearcoat = m.clearcoat; }
  const l = { base, eye, other, jacket, scarf, mitten, all };
  applyQuality(l);
  return l;
}

function rigFor(cls: ClassId): Rig {
  let r = rigs.get(cls);
  if (r) return r;
  // a class whose model isn't built yet borrows the penguin, scaled up to its size
  const own = Assets.models[cls];
  const src = own ?? Assets.models.penguin!;
  const facts = own ? Assets.rigs[cls] : Assets.rigs.penguin;
  const scale = own ? 1 : CLASSES[cls].top / CLASSES.penguin.top;
  const a = facts.armRest, e = facts.eyeYaw;
  r = {
    src, facts, scale, looks: (own ? null : rigs.get('penguin')?.looks) ?? buildLooks(src),
    size: facts.height * scale / Assets.rigs.penguin.height,
    armBind: { L: new THREE.Vector3(-Math.sin(a), -Math.cos(a), 0), R: new THREE.Vector3(Math.sin(a), -Math.cos(a), 0) },
    elbowAxis: { L: new THREE.Vector3(Math.cos(a), -Math.sin(a), 0), R: new THREE.Vector3(Math.cos(a), Math.sin(a), 0) },
    lidAxis: { L: new THREE.Vector3(Math.cos(e), 0, -Math.sin(e)), R: new THREE.Vector3(Math.cos(e), 0, Math.sin(e)) },
  };
  rigs.set(cls, r);
  return r;
}

function applyQuality(l: Looks) {
  for (const m of l.all) {
    m.normalMap = lowQuality ? null : m.userData.normalMap;
    m.sheen = lowQuality ? 0 : m.userData.sheen;
    m.clearcoat = lowQuality ? 0 : m.userData.clearcoat;
    m.needsUpdate = true;
  }
}

/** Fast graphics: drop the normal maps and the fuzzy sheen layer. */
export function setPenguinQuality(low: boolean) {
  if (low === lowQuality) return;
  lowQuality = low;
  for (const r of new Set([...rigs.values()].map(r => r.looks))) applyQuality(r);
}

const SNOW = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
function lumpy(r: number, detail: number, seed: number, amount = 0.12) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = Math.sin(x * 31.7 / r + seed) * Math.sin(y * 27.3 / r + seed * 1.7) * Math.sin(z * 29.1 / r + seed * 2.3);
    const k = 1 + n * amount;
    p.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeVertexNormals();
  return g;
}
const G = { ball: lumpy(0.07, 2, 1.3), giant: lumpy(1, 3, 3.3, 0.05), splat: lumpy(1, 2, 4.1, 0.2), lump: lumpy(1, 3, 2.2, 0.1) };

/** A copy of a Blender-built hat, ready to sit on the head's hat joint. Null for 'none' (or a hat that isn't built). */
export function makeHat(name: string): THREE.Object3D | null {
  const src = Assets.hats.get(name);
  return src ? src.clone(true) : null;
}

function nameTag(text: string, team: number) {
  const c = document.createElement('canvas');
  c.width = 384; c.height = 96;
  const ctx = c.getContext('2d')!;
  ctx.font = '700 40px Fredoka, Nunito, sans-serif';
  const w = Math.min(360, ctx.measureText(text).width + 78);
  const x0 = (384 - w) / 2;
  // solid team-coloured pill with a white rim: readable from across the map
  ctx.fillStyle = team === 0 ? '#1f6fe0' : '#f0561d';
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.roundRect(x0, 16, w, 64, 32); ctx.fill(); ctx.stroke();
  // team badge: snowflake dot for Blizzard, sun for Sunrise
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  if (team === 0) { for (let a = 0; a < 6; a++) { const an = a * Math.PI / 3; ctx.moveTo(x0 + 34, 48); ctx.lineTo(x0 + 34 + Math.cos(an) * 15, 48 + Math.sin(an) * 15); } ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.stroke(); }
  else { ctx.arc(x0 + 34, 48, 12, 0, Math.PI * 2); ctx.fill(); }
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x0 + 58, 50, w - 76);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true, fog: false }));
  s.scale.set(1.7, 0.425, 1);
  return s;
}

const BONES = ['body', 'chest', 'head', 'jaw', 'tail', 'footL', 'footR', 'armL', 'armR', 'forearmL', 'forearmR', 'handL', 'handR'] as const;
type BoneName = typeof BONES[number];
interface Target { q: THREE.Quaternion; p: THREE.Vector3; s: THREE.Vector3; bone: THREE.Bone; rest: THREE.Vector3 }

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => { x = clamp01(x); return x * x * (3 - 2 * x); };

/** A strand that trails behind: a scarf tail of three joints that hangs by gravity and streams out with speed. */
class Strand {
  dir: THREE.Vector3; vel = new THREE.Vector3();
  constructor(readonly bones: THREE.Bone[], readonly rest: THREE.Vector3, readonly phase: number) { this.dir = rest.clone(); }
}

export class PenguinModel {
  readonly root = new THREE.Group(); // positioned at feet, yawed
  private model: THREE.Object3D;
  private t = {} as Record<BoneName, Target>;
  private lids: Record<Side, THREE.Bone>;
  private hatBone: THREE.Bone;
  private strands: Strand[] = [];
  private mittenMeshes: THREE.Mesh[] = [];
  private near: THREE.Mesh[] = []; private far: THREE.Mesh[] = []; // full-detail meshes, and the light copies used far away
  private farNow = false;
  private hat: THREE.Object3D | null = null;
  private hatName = '';
  private spinner: THREE.Object3D | null = null;
  private jiggles: { o: THREE.Object3D; rest: THREE.Quaternion; a: THREE.Vector2; v: THREE.Vector2 }[] = [];
  private splats: THREE.Mesh[] = [];
  private lump: THREE.Mesh;
  private tag: THREE.Sprite | null = null;
  private walkPhase = Math.random() * 10;
  private seed = Math.random() * 100;
  private mittenLevel = -1;
  private blink = 1 + Math.random() * 3;
  private lidNow: number;
  private rig: Rig;
  /** pose offsets are written for the penguin; bigger characters scale them by this */
  private S: number;
  private maxHealth: number;
  /** the giant snowball a yeti holds over its head while it winds up */
  private heldBall: THREE.Mesh | null = null;
  private landSquash = 0;
  private wasGrounded = true;
  private lastHealth = 99;
  private hitT = 9;
  private jawNow = 0;
  private hatWobble = new THREE.Vector2(); private hatVel = new THREE.Vector2();
  private lastVel = new THREE.Vector3();
  private snapPose = true;
  carriedBalls: THREE.Mesh[] = [];
  private board: THREE.Group | null = null;
  /** How far the camera is. The game sets it every frame; it picks the detail level and hides the name tag up close. */
  camDist = 0;
  private boardYaw = 0;

  constructor(public team: number, hat: string, name: string | null, private showTag = true, readonly cls: ClassId = 'penguin') {
    const rig = this.rig = rigFor(cls);
    const L = rig.looks, facts = rig.facts, def = CLASSES[cls];
    const S = this.S = rig.size;
    this.maxHealth = def.health;
    this.lidNow = facts.lidOpen;
    this.model = SkeletonUtils.clone(rig.src);
    this.model.scale.setScalar(rig.scale);
    this.root.add(this.model);
    this.model.traverse(o => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      const n = (m.material as THREE.Material).name;
      m.material = n === 'TeamJacket' ? L.jacket[team] : n === 'TeamScarf' ? L.scarf[team] : n === 'Mitten' ? L.mitten[team][0] : n === 'Eye' ? L.eye : L.other[n] ?? L.base;
      if (n === 'Mitten') this.mittenMeshes.push(m);
      (m.name.includes('LOD') || m.parent!.name.includes('LOD') ? this.far : this.near).push(m);
      m.castShadow = true;
      m.frustumCulled = false; // the skeleton moves the mesh well away from its rest box (belly slides, squashes)
    });
    for (const m of this.far) m.visible = false;
    // (a joint a model doesn't have gets a stand-in that moves nothing)
    const bone = (n: string) => (this.model.getObjectByName(n) as THREE.Bone | undefined) ?? new THREE.Bone();
    for (const n of BONES) { const b = bone(n); this.t[n] = { q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(1, 1, 1), bone: b, rest: b.position.clone() }; }
    this.lids = { L: bone('lidL'), R: bone('lidR') };
    this.hatBone = bone('hat');
    for (const [k, ch] of ['A', 'B'].entries()) {
      const bs = [1, 2, 3].map(i => bone(`scarf${ch}${i}`));
      if (bs.some(b => !b.parent)) continue;
      // the strand's rest direction: from its first joint to its last, in the chest's space
      const rest = bs[2].position.clone().add(bs[1].position).normalize();
      this.strands.push(new Strand(bs, rest, k * 1.9));
    }
    this.setHat(hat);

    // put something at a point given in the model's own space (feet at the origin) onto a joint, so it moves with it
    this.model.updateMatrixWorld(true);
    const onto = (b: BoneName, o: THREE.Object3D, x: number, y: number, z: number) => {
      const bn = this.t[b].bone;
      o.position.copy(bn.worldToLocal(_v.set(x, y, z).multiplyScalar(rig.scale)));
      bn.add(o);
    };

    // snow splat marks (show damage): clumps stuck to the jacket and the face
    const stuck: [BoneName, [number, number, number], number, number, number][] = [
      ['chest', facts.chestFront, 0.105, 0.085, 0.05], ['head', facts.cheek, 0.085, 0.07, 0.045], ['body', facts.belly, 0.11, 0.09, 0.05],
    ];
    for (const [b, at, sx, sy, sz] of stuck) {
      const s = new THREE.Mesh(G.splat, SNOW);
      s.scale.set(sx * S, sy * S, sz * S); s.rotation.set(0.3, at[0] * 2, 0.4);
      s.visible = false; s.castShadow = true;
      onto(b, s, at[0], at[1], at[2]);
      this.splats.push(s);
    }

    // the snow lump you become when splatted
    this.lump = new THREE.Mesh(G.lump, SNOW);
    this.lump.position.y = 0.2 * S;
    this.lump.visible = false;
    this.lump.castShadow = true;
    this.root.add(this.lump);

    // carried snowballs: tucked round the back of the jacket hem, so you can count them from behind
    const ballSize = def.ballRadius / CLASSES.penguin.ballRadius, belt = facts.belt;
    const n = Math.max(def.maxCarry, 1) + (cls === 'penguin' ? 1 : 0);
    const spread = Math.min(0.36 * Math.sqrt(ballSize), 2.2 / n);
    for (let i = 0; i < n; i++) {
      const b = new THREE.Mesh(G.ball, SNOW);
      const a = (i - (n - 1) / 2) * spread;
      b.scale.setScalar(ballSize > 1.5 ? ballSize * 0.62 : ballSize);
      b.rotation.set(i, i * 2, i * 3);
      b.castShadow = true;
      b.visible = false;
      onto('body', b, Math.sin(a) * belt.rx, belt.y + (i % 2) * 0.012, Math.cos(a) * belt.rz);
      this.carriedBalls.push(b);
    }

    if (def.splash > 0) {
      const hb = this.heldBall = new THREE.Mesh(G.giant, SNOW);
      hb.scale.setScalar(def.ballRadius);
      hb.castShadow = true; hb.visible = false;
      onto('chest', hb, 0, facts.height + def.ballRadius * 0.85, 0.2);
    }

    if (name && showTag) {
      this.tag = nameTag(name, team);
      this.tag.position.y = facts.height * rig.scale + 0.65;
      this.root.add(this.tag);
    }
  }

  setHat(name: string) {
    if (name === this.hatName) return;
    if (this.hat) this.hatBone.remove(this.hat);
    this.hat = makeHat(name);
    this.hatName = name;
    this.spinner = null; this.jiggles = [];
    if (!this.hat) return;
    this.hat.scale.setScalar(this.rig.facts.hatScale);
    this.hatBone.add(this.hat);
    this.hat.traverse(o => {
      if (o.name.startsWith('spin')) this.spinner = o;
      if (o.name.startsWith('jiggle')) this.jiggles.push({ o, rest: o.quaternion.clone(), a: new THREE.Vector2(), v: new THREE.Vector2() });
    });
  }

  setMittenLevel(level: number) {
    if (level === this.mittenLevel) return;
    this.mittenLevel = level;
    for (const m of this.mittenMeshes) m.material = this.rig.looks.mitten[this.team][level];
  }

  // ── pose helpers: they write this frame's target for a joint; update() eases the skeleton toward the targets ──
  private rot(b: BoneName, x: number, y: number, z: number) { this.t[b].q.setFromEuler(_e.set(x, y, z, 'XYZ')); }
  private addRot(b: BoneName, x: number, y: number, z: number) { this.t[b].q.multiply(_q.setFromEuler(_e.set(x, y, z, 'XYZ'))); }
  /** Point a flipper: out to its own side, up, and forward (any length; it is normalised). */
  private arm(side: Side, out: number, up: number, fwd: number) {
    _v.set(side === 'R' ? out : -out, up, -fwd).normalize();
    this.t[side === 'R' ? 'armR' : 'armL'].q.setFromUnitVectors(this.rig.armBind[side], _v);
  }
  /** Bend the elbow forward and/or in toward the belly. */
  private elbow(side: Side, forward: number, inward = 0) {
    const q = this.t[side === 'R' ? 'forearmR' : 'forearmL'].q.setFromAxisAngle(this.rig.elbowAxis[side], forward);
    if (inward) q.multiply(_q.setFromAxisAngle(Z, side === 'R' ? -inward : inward));
  }

  /** Pose the penguin for this frame. */
  update(p: Penguin, alpha: number, dt: number, time: number, isLocal: boolean) {
    const x = p.px + (p.x - p.px) * alpha, y = p.py + (p.y - p.py) * alpha, z = p.pz + (p.z - p.pz) * alpha;
    this.root.position.set(x, y, z);
    this.root.rotation.y = p.yaw;
    this.setMittenLevel(p.mitten);
    const speed = Math.hypot(p.vx, p.vz);
    const T = this.t;

    // landing squash, hit flinch
    if (p.grounded && !this.wasGrounded) this.landSquash = 0.25;
    this.wasGrounded = p.grounded;
    this.landSquash = Math.max(0, this.landSquash - dt * 1.5);
    if (p.health < this.lastHealth) this.hitT = 0;
    this.lastHealth = p.health;
    this.hitT += dt;

    this.lump.visible = false;

    // riding the surfboard
    if (p.surfing && p.alive) {
      if (!this.board) { this.board = makeSurfboard(); this.root.add(this.board); }
      this.board.visible = true;
      if (speed > 0.4) {
        const want = Math.atan2(-p.vx, -p.vz);
        let d = want - this.boardYaw; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
        this.boardYaw += d * Math.min(1, dt * 8);
      }
      this.board.rotation.set(0, this.boardYaw - p.yaw, 0);
      this.board.position.y = 0.06;
      // lean into turns
      this.board.rotation.z = Math.max(-0.3, Math.min(0.3, (p.input.moveX || 0) * -0.25));
    } else if (this.board) this.board.visible = false;

    if (!p.alive) {
      this.model.visible = false;
      this.lump.visible = true;
      const t = Math.min(1, (3.5 - p.downT) * 4);
      this.lump.scale.set(0.55 * t + 0.1, 0.45 * t + 0.05, 0.55 * t + 0.1).multiplyScalar(this.S);
      if (this.tag) this.tag.visible = false;
      this.snapPose = true;
      return;
    }
    if (this.tag) this.tag.visible = !isLocal && this.camDist > 3.5;
    // far-away penguins switch to the light copy (sooner on Fast graphics); the gap between the two numbers stops flicker
    const lodAt = lowQuality ? 9 : 20;
    const far = this.farNow ? this.camDist > lodAt - 1.5 : this.camDist > lodAt;
    if (far !== this.farNow) {
      this.farNow = far;
      for (const m of this.near) m.visible = !far;
      for (const m of this.far) m.visible = far;
    }

    // ── this frame's target pose ──
    for (const n of BONES) { const t = T[n]; t.q.identity(); t.p.set(0, 0, 0); t.s.set(1, 1, 1); }
    const breathe = Math.sin(time * 2.1 + this.seed);
    const LID_OPEN = this.rig.facts.lidOpen, S = this.S;
    const slider = CLASSES[this.cls].slide, overhead = !!this.heldBall;
    let lid = LID_OPEN, jaw = 0;
    let holding = false;
    let armsSet = false;
    const idleArms = () => { this.arm('L', 0.42, -1, 0.04); this.arm('R', 0.42, -1, 0.04); };
    idleArms();

    const sq = this.landSquash;
    T.body.s.set(1 + sq * 0.3, 1 - sq * 0.35, 1 + sq * 0.3);

    switch (p.action) {
      case 'rush': {
        // the polar bear's charge: head down, shoulders first, bounding along with the arms pumping
        this.walkPhase += dt * 13;
        const s = Math.sin(this.walkPhase * 2), c = Math.cos(this.walkPhase * 2);
        this.rot('body', -0.66 + s * 0.08, 0, 0);
        T.body.p.set(0, (0.03 + Math.abs(c) * 0.08) * S, 0);
        this.rot('head', 0.52, 0, 0);
        // in the leaning body's own frame, "down at the snow" is forward and a bit down
        this.arm('L', 0.22, -0.55 + s * 0.3, 0.85 + s * 0.35); this.arm('R', 0.22, -0.55 - s * 0.3, 0.85 - s * 0.35);
        this.elbow('L', 0.3); this.elbow('R', 0.3);
        T.footL.p.y += Math.max(0, s) * 0.13 * S; T.footL.p.z += (c * 0.2 - 0.14) * S;
        T.footR.p.y += Math.max(0, -s) * 0.13 * S; T.footR.p.z += (-c * 0.2 - 0.14) * S;
        T.footL.q.setFromEuler(_e.set(Math.max(0, s) * 0.6, 0, 0)); T.footR.q.setFromEuler(_e.set(Math.max(0, -s) * 0.6, 0, 0));
        this.rot('tail', 0.4, s * 0.3, 0);
        lid = LID_OPEN - 0.55; jaw = 0.75;
        armsSet = true;
        break;
      }
      case 'slide': {
        if (!slider) {
          // no belly slides for bears and yetis: on the playground slide they sit, lean back and throw their arms up
          this.rot('body', 0.3, 0, Math.sin(time * 8) * 0.04);
          T.body.p.set(0, -0.06 * S, 0.05 * S);
          this.rot('head', -0.15, 0, 0);
          this.arm('L', 0.7, 1, 0.15 + Math.sin(time * 15) * 0.1); this.arm('R', 0.7, 1, 0.15 - Math.sin(time * 15) * 0.1);
          for (const f of [T.footL, T.footR] as Target[]) { f.p.set(0, 0.1 * S, -0.3 * S); f.q.setFromEuler(_e.set(0.9, 0, 0)); }
          lid = LID_OPEN + 0.2; jaw = 0.8;
          armsSet = true;
          break;
        }
        // belly down, head first, flippers swept back like little wings, feet trailing with their soles up
        this.rot('body', -1.32, 0, Math.sin(time * 9) * 0.05);
        T.body.p.set(0, 0.33, 0.36);
        this.rot('head', 1.22, 0, 0);
        const flut = Math.sin(time * 16) * 0.08;
        this.arm('L', 0.62 + flut, -1, -0.42); this.arm('R', 0.62 - flut, -1, -0.42);
        for (const [i, f] of ([T.footL, T.footR] as Target[]).entries()) {
          f.p.set(0, 0.27, 0.44).sub(_v.set(0, 0, f.rest.z));
          f.q.setFromEuler(_e.set(-2.95 + Math.sin(time * 14 + i * 3) * 0.3, 0, 0));
        }
        this.rot('tail', 0.5, Math.sin(time * 11) * 0.3, 0);
        lid = LID_OPEN + 0.2; jaw = 0.5;
        armsSet = true;
        break;
      }
      case 'plow': {
        // lean in and shove with both mittens
        const push = Math.sin(time * 9) * 0.1;
        this.rot('body', -0.36, 0, 0);
        this.rot('head', 0.3, 0, 0);
        this.arm('L', 0.2, -0.3 + push, 1); this.arm('R', 0.2, -0.3 - push, 1);
        this.elbow('L', 0.25 - push, 0.15); this.elbow('R', 0.25 + push, 0.15);
        this.walk(speed * 1.6, dt, 0.07, false);
        lid = LID_OPEN - 0.45;
        armsSet = true;
        break;
      }
      case 'pack': {
        // crouch and pat-pat-pat a snowball together
        const pat = Math.abs(Math.sin(time * 14));
        this.rot('body', -0.46, 0, 0);
        T.body.s.y *= 0.93;
        this.rot('head', -0.12, 0, 0);
        this.arm('L', 0.34 - pat * 0.14, -0.72, 0.78); this.arm('R', 0.34 - pat * 0.14, -0.72, 0.78);
        this.elbow('L', 0.35, 0.5 + pat * 0.3); this.elbow('R', 0.35, 0.5 + pat * 0.3);
        armsSet = true;
        break;
      }
      case 'dig': {
        // reach in, then sweep the snow out behind
        const s = (time * 3.2) % 1;
        const k = s < 0.55 ? ease(s / 0.55) : 1 - ease((s - 0.55) / 0.45);
        this.rot('body', -0.5 + k * 0.28, 0, 0);
        this.rot('head', 0.12, 0, 0);
        for (const sd of ['L', 'R'] as Side[]) { this.arm(sd, 0.2 + k * 0.4, -0.75, 0.9 - k * 1.35); this.elbow(sd, 0.3 * (1 - k)); }
        this.walk(speed, dt, 0.05, false);
        armsSet = true;
        break;
      }
      case 'build': {
        // scoop low, fling it up onto the pile
        const s = (time * 3.5) % 1;
        const k = s < 0.5 ? ease(s / 0.5) : 1 - ease((s - 0.5) / 0.5);
        this.rot('body', -0.42 + k * 0.4, 0, 0);
        this.rot('head', 0.1 + k * 0.15, 0, 0);
        for (const sd of ['L', 'R'] as Side[]) { this.arm(sd, 0.3, -0.85 + k * 1.5, 0.6 + k * 0.4); this.elbow(sd, 0.4 * (1 - k)); }
        this.walk(speed, dt, 0.05, false);
        jaw = k * 0.3;
        armsSet = true;
        break;
      }
      case 'charge': {
        const c = p.charge;
        if (overhead) {
          // the yeti hoists a giant snowball over its head with both hands and leans back under it
          this.rot('body', 0.06 + 0.16 * c, 0, 0);
          this.rot('head', -0.12 - 0.1 * c, 0, 0);
          for (const sd of ['L', 'R'] as Side[]) { this.arm(sd, 0.2, 1, -0.02 - 0.22 * c); this.elbow(sd, 0.12, 0.1); }
          this.walk(speed, dt, 0.06, false);
          lid = LID_OPEN - 0.5; jaw = 0.3 * c;
          holding = true;
          armsSet = true;
          break;
        }
        // wind up: throwing flipper cocked back over the shoulder, the other one points at the target
        this.rot('body', 0.06 + 0.1 * c, 0, 0);
        this.rot('chest', 0, -0.3 - 0.3 * c, 0);
        this.rot('head', 0, 0.25 + 0.2 * c, 0);
        this.arm('R', 0.5, 0.75 + 0.2 * c, -0.45 - 0.35 * c); this.elbow('R', 0.7);
        this.arm('L', 0.25, -0.15, 1); 
        this.walk(speed, dt, 0.08, false);
        lid = LID_OPEN - 0.5;
        armsSet = true;
        break;
      }
      default: {
        if (p.surfing) {
          // surfer stance: low, flippers out for balance, no waddle
          const lean = (p.input.moveX || 0);
          this.rot('body', -0.12, 0.5, Math.sin(time * 3) * 0.05 - lean * 0.18);
          T.body.p.y += 0.1 * S; T.body.s.y *= 0.93;
          this.rot('head', 0, -0.45, 0);
          this.arm('L', 1, -0.1 + Math.sin(time * 4) * 0.12, 0.1); this.arm('R', 1, -0.1 + Math.sin(time * 4 + 1) * 0.12, 0.1);
          T.footL.p.y += 0.1 * S; T.footR.p.y += 0.1 * S;
          if (p.throwAnim > 0) this.throwPose(1 - p.throwAnim / 0.25);
          armsSet = true;
          break;
        }
        if (!p.grounded) {
          // in the air: flap! (the big ones just flail)
          const f = Math.sin(time * (slider ? 26 : 13));
          this.arm('L', 1, 0.15 + f * 0.45, 0.05); this.arm('R', 1, 0.15 - f * 0.45, 0.05);
          T.footL.q.setFromEuler(_e.set(-0.5 + f * 0.25, 0, 0)); T.footR.q.setFromEuler(_e.set(-0.5 - f * 0.25, 0, 0));
          T.footL.p.y += 0.03 * S; T.footR.p.y += 0.03 * S;
          T.body.s.y *= 1.04;
          lid = LID_OPEN + 0.25; jaw = 0.6;
          armsSet = true;
        }
        this.walk(speed, dt, 0.12, !armsSet);
        if (p.throwAnim > 0) this.throwPose(1 - p.throwAnim / 0.25);
        if (speed < 0.3 && p.grounded && p.throwAnim <= 0) {
          // standing about: breathe, glance around, a little tail wag
          T.chest.s.multiplyScalar(1 + breathe * 0.012);
          this.addRot('head', Math.sin(time * 0.9 + this.seed) * 0.04, Math.sin(time * 0.53 + this.seed * 2) * 0.16, 0);
          this.rot('tail', 0, Math.sin(time * 5 + this.seed) * 0.25 * clamp01(Math.sin(time * 0.7 + this.seed) * 2), 0);
        }
      }
    }
    if (p.throwAnim > 0) { jaw = Math.max(jaw, 0.7); lid = LID_OPEN - 0.35; }

    // look up / down with the head
    if (p.action !== 'slide') this.addRot('head', p.lookPitch * 0.4, 0, 0);

    // flinch when a snowball lands
    if (this.hitT < 0.32) {
      const k = 1 - this.hitT / 0.32;
      this.addRot('body', 0.22 * k, 0, 0);
      this.addRot('head', -0.3 * k, 0, 0.12 * k);
      T.body.s.multiply(_v.set(1 + 0.1 * k, 1 - 0.1 * k, 1 + 0.1 * k));
      lid = Math.min(lid, 0.5); jaw = Math.max(jaw, 0.5);
    }

    // ── ease the skeleton toward the pose ──
    const k = this.snapPose ? 1 : 1 - Math.exp(-dt * 20);
    this.snapPose = false;
    for (const n of BONES) {
      const t = T[n];
      t.bone.quaternion.slerp(t.q, k);
      t.bone.position.lerp(_v.copy(t.rest).add(t.p), k);
      t.bone.scale.lerp(t.s, k);
    }

    // blink
    this.blink -= dt;
    if (this.blink < 0) this.blink = 2 + Math.random() * 3.5;
    if (this.blink < 0.11) lid = 0.25;
    this.lidNow += (lid - this.lidNow) * Math.min(1, dt * 30);
    this.lids.L.quaternion.setFromAxisAngle(this.rig.lidAxis.L, -this.lidNow);
    this.lids.R.quaternion.setFromAxisAngle(this.rig.lidAxis.R, -this.lidNow);
    if (this.heldBall) this.heldBall.visible = holding;
    this.jawNow += (jaw - this.jawNow) * Math.min(1, dt * 14);
    T.jaw.bone.rotation.set(-0.42 * this.jawNow, 0, 0);

    this.secondary(p, dt, time, speed);

    // damage marks
    // (a class with more health gets its three snow marks spread over more hits)
    const marks = Math.ceil(this.splats.length * (this.maxHealth - p.health) / this.maxHealth);
    for (let i = 0; i < this.splats.length; i++) this.splats[i].visible = i < marks;
    // carried snowballs
    for (let i = 0; i < this.carriedBalls.length; i++) this.carriedBalls[i].visible = i < p.carried;
    // spawn protection blink
    this.model.visible = p.invuln <= 0 || Math.floor(time * 12) % 2 === 0;
    // propeller hat spins
    if (this.spinner) this.spinner.rotation.y += dt * (6 + speed * 4);
  }

  /** The follow-through of a throw. u: 0 at release → 1 when the flipper has swung through. */
  private throwPose(u: number) {
    const a = ease(u / 0.45), b = ease((u - 0.3) / 0.7);
    if (this.heldBall) {
      // the yeti's two-handed heave: from overhead, forward and down
      for (const sd of ['L', 'R'] as Side[]) { this.arm(sd, 0.25, 1 - 1.5 * a - 0.3 * b, -0.2 + 1.3 * a); this.elbow(sd, 0.1); }
      this.addRot('body', 0.2 - 0.62 * ease(u / 0.6), 0, 0);
      this.addRot('head', 0.2 * a, 0, 0);
      return;
    }
    // cocked back → whipping over the top → down across the body
    this.arm('R', 0.5 - 0.3 * a - 0.25 * b, 0.9 - 0.25 * a - 1.25 * b, -0.6 + 1.5 * a + 0.1 * b);
    this.elbow('R', 0.6 * (1 - a));
    this.arm('L', 0.45, -0.6 - 0.3 * a, 0.7 - 1.0 * a);
    this.addRot('chest', 0, -0.4 + 0.85 * ease(u / 0.6), 0);
    this.addRot('body', 0.1 - 0.34 * ease(u / 0.6), 0, 0);
    this.addRot('head', 0.1, 0.25 - 0.4 * ease(u / 0.6), 0);
  }

  /** The waddle: roll from foot to foot, little shuffling steps, flippers out for balance. */
  private walk(speed: number, dt: number, amount: number, arms: boolean) {
    const T = this.t;
    const moving = Math.min(1, speed / 3);
    this.walkPhase += dt * (4 + speed * 2.2);
    const ph = this.walkPhase * 2;
    const s = Math.sin(ph), c = Math.cos(ph);
    this.addRot('body', 0, 0, -s * amount * 1.5 * moving);
    const S = this.S;
    T.body.p.y += Math.abs(c) * 0.045 * moving * S;
    this.addRot('chest', 0, s * 0.1 * moving, 0);
    this.addRot('head', 0, 0, s * amount * 1.0 * moving); // the head stays level while the body rocks
    // left foot is in the air while s > 0, right foot while s < 0; each swings forward as it lifts
    T.footL.p.y += Math.max(0, s) * 0.075 * moving * S; T.footL.p.z += c * 0.085 * moving * S;
    T.footR.p.y += Math.max(0, -s) * 0.075 * moving * S; T.footR.p.z += -c * 0.085 * moving * S;
    T.footL.q.multiply(_q.setFromEuler(_e.set(Math.max(0, s) * 0.45 * moving, 0, 0)));
    T.footR.q.multiply(_q.setFromEuler(_e.set(Math.max(0, -s) * 0.45 * moving, 0, 0)));
    this.addRot('tail', 0, -s * 0.4 * moving, 0);
    if (arms && moving > 0.02) {
      this.arm('L', 0.42 + 0.3 * moving, -1, 0.04 - c * 0.38 * moving);
      this.arm('R', 0.42 + 0.3 * moving, -1, 0.04 + c * 0.38 * moving);
    }
  }

  /** Things that follow along by themselves: scarf tails, the hat's wobble, and anything on the hat that jiggles. */
  private secondary(p: Penguin, dt: number, time: number, speed: number) {
    const T = this.t;
    // the world, as the chest sees it
    const chestQ = _q2.copy(T.body.bone.quaternion).multiply(T.chest.bone.quaternion);
    const inv = chestQ.clone().invert();
    const cy = Math.cos(-p.yaw), sy = Math.sin(-p.yaw);
    const lvx = p.vx * cy + p.vz * sy, lvz = -p.vx * sy + p.vz * cy; // velocity in the penguin's own frame
    const h = Math.min(0.05, Math.max(dt, 1e-3));
    for (const st of this.strands) {
      const flap = Math.min(1, speed / 6);
      // gravity + the wind of moving + a flutter that grows with speed
      _v.set(-lvx * 0.13 + Math.sin(time * 9 + st.phase) * 0.22 * flap, -1 - p.vy * 0.06, -lvz * 0.13 + Math.cos(time * 7.3 + st.phase) * 0.12 * flap);
      _v.y += Math.min(0.75, speed * 0.05); // fast = streaming out nearly flat
      _v.applyQuaternion(inv);
      _v.z = Math.max(_v.z, 0.16 * _v.length()); // never through the back
      _v.normalize();
      // a soft spring on the direction
      st.vel.addScaledVector(_v2.copy(_v).sub(st.dir), 140 * h).multiplyScalar(Math.exp(-9 * h));
      st.dir.addScaledVector(st.vel, h).normalize();
      _q.setFromUnitVectors(st.rest, st.dir);
      const ident = _q2.identity();
      st.bones[0].quaternion.copy(ident).slerp(_q, 0.5);
      st.bones[1].quaternion.copy(ident).slerp(_q, 0.3);
      st.bones[2].quaternion.copy(ident).slerp(_q, 0.3);
    }
    // the hat lags a touch behind sudden moves
    const ax = (lvx - this.lastVel.x) / h, az = (lvz - this.lastVel.z) / h;
    this.lastVel.set(lvx, 0, lvz);
    this.hatVel.x += (-ax * 0.004 - this.hatWobble.x * 160) * h; this.hatVel.y += (-az * 0.004 - this.hatWobble.y * 160) * h;
    this.hatVel.multiplyScalar(Math.exp(-10 * h));
    this.hatWobble.addScaledVector(this.hatVel, h);
    this.hatWobble.clampScalar(-0.16, 0.16);
    this.hatBone.rotation.set(-this.hatWobble.y, 0, this.hatWobble.x);
    for (const j of this.jiggles) {
      j.v.x += (-ax * 0.02 - j.a.x * 90) * h; j.v.y += (-az * 0.02 - j.a.y * 90) * h;
      j.v.multiplyScalar(Math.exp(-5 * h));
      j.a.addScaledVector(j.v, h); j.a.clampScalar(-0.6, 0.6);
      j.o.quaternion.copy(j.rest).multiply(_q.setFromEuler(_e.set(-j.a.y, 0, j.a.x)));
    }
  }

  dispose(scene: THREE.Object3D) {
    scene.remove(this.root);
    if (this.tag) { (this.tag.material as THREE.SpriteMaterial).map?.dispose(); this.tag.material.dispose(); }
  }
}
