// The classic penguin: the original hand-built Three.js penguin and hats from before the Blender remake
// (restored from commit c0ca96b). Players pick it as a skin in the menu; the default is the Blender one in
// PenguinModel.ts. It has the same public face as PenguinModel, so the game can use either.
import * as THREE from 'three';
import { Penguin } from '../sim/World';
import { TEAM_COLORS } from './Environment';
import { makeSurfboard } from './Props';

// shared materials
const M = {
  body: new THREE.MeshPhysicalMaterial({ color: 0x1b2232, roughness: 0.5, sheen: 1, sheenColor: new THREE.Color(0x7d95c8), sheenRoughness: 0.45 }),
  belly: new THREE.MeshStandardMaterial({ color: 0xfbfcff, roughness: 0.7 }),
  beak: new THREE.MeshStandardMaterial({ color: 0xffa21f, roughness: 0.42 }),
  foot: new THREE.MeshStandardMaterial({ color: 0xff9320, roughness: 0.5 }),
  eye: new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.2 }),
  shine: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  cheek: new THREE.MeshStandardMaterial({ color: 0xff9fb4, roughness: 0.8 }),
  snow: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
};
const teamMats = TEAM_COLORS.map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 }));
// puffy team jacket: bright enough to read at a glance, even in shade
const jacketMats = TEAM_COLORS.map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.62, emissive: c, emissiveIntensity: 0.22, side: THREE.DoubleSide }));
const jacketTrimMats = TEAM_COLORS.map(c => new THREE.MeshStandardMaterial({ color: new THREE.Color(c).lerp(new THREE.Color(0xffffff), 0.75), roughness: 0.8 }));
const MITTEN_MATS = [
  null, // level 0 = team colour
  new THREE.MeshStandardMaterial({ color: 0x7fe3ff, roughness: 0.4, emissive: 0x1a6a8a, emissiveIntensity: 0.5 }),
  new THREE.MeshStandardMaterial({ color: 0xe8f4ff, roughness: 0.25, metalness: 0.4, emissive: 0x8ab8ff, emissiveIntensity: 0.6 }),
  new THREE.MeshStandardMaterial({ color: 0xffd34d, roughness: 0.25, metalness: 0.6, emissive: 0xff9d00, emissiveIntensity: 0.8 }),
];
const teamMittenMats = TEAM_COLORS.map(c => new THREE.MeshStandardMaterial({ color: new THREE.Color(c).lerp(new THREE.Color(0xffffff), 0.15), roughness: 0.95 }));

const sph = (r: number, w = 16, h = 12) => new THREE.SphereGeometry(r, w, h);
const G = {
  head: sph(0.27, 24, 18),
  belly: sph(1, 20, 16),
  eye: sph(0.042, 10, 8),
  shine: sph(0.014, 6, 4),
  cheek: sph(0.04, 8, 6),
  beak: new THREE.ConeGeometry(0.065, 0.16, 10),
  foot: footGeometry(),
  leg: new THREE.CylinderGeometry(0.034, 0.04, 0.09, 8),
  tail: new THREE.ConeGeometry(0.075, 0.2, 10),
  flipper: sph(1, 12, 10),
  mitten: sph(0.095, 14, 10),
  thumb: sph(0.048, 10, 8),
  cuff: new THREE.TorusGeometry(0.075, 0.03, 8, 14),
  scarf: new THREE.TorusGeometry(0.235, 0.055, 10, 24),
  scarfTail: new THREE.BoxGeometry(0.11, 0.3, 0.04).translate(0, -0.12, 0),
  splat: sph(1, 10, 8),
};

/** A flat webbed foot with three toes, pointing forward (-z), heel at the origin. */
function footGeometry() {
  const sh = new THREE.Shape();
  // drawn in x / y, where +y is forward
  sh.moveTo(-0.04, -0.035);
  sh.quadraticCurveTo(-0.075, 0.05, -0.115, 0.165);
  sh.quadraticCurveTo(-0.085, 0.19, -0.055, 0.15);
  sh.quadraticCurveTo(-0.03, 0.2, 0, 0.215);
  sh.quadraticCurveTo(0.03, 0.2, 0.055, 0.15);
  sh.quadraticCurveTo(0.085, 0.19, 0.115, 0.165);
  sh.quadraticCurveTo(0.075, 0.05, 0.04, -0.035);
  sh.quadraticCurveTo(0, -0.06, -0.04, -0.035);
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.022, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2, curveSegments: 6 });
  g.rotateX(-Math.PI / 2); // lie flat: shape +y becomes -z (forward), thickness goes up
  g.computeVertexNormals();
  return g;
}

/** The team jacket: a shell just outside the body, open at the front so the white belly shows. */
function jacketGeometry() {
  const prof = [[0.352, 0.15], [0.372, 0.2], [0.392, 0.33], [0.372, 0.5], [0.322, 0.62], [0.292, 0.69], [0.27, 0.71]];
  const open = 1.05; // radians of gap either side of dead-front
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 26, Math.PI + open, Math.PI * 2 - open * 2);
  g.computeVertexNormals();
  return g;
}
const JACKET_GEO = jacketGeometry();

function bodyGeometry() {
  const pts: THREE.Vector2[] = [];
  const prof = [[0.0, 0.0], [0.2, 0.012], [0.3, 0.06], [0.355, 0.17], [0.372, 0.33], [0.35, 0.5], [0.3, 0.63], [0.25, 0.72], [0.0, 0.8]];
  for (const [r, y] of prof) pts.push(new THREE.Vector2(r, y));
  const curve = new THREE.SplineCurve(pts);
  const g = new THREE.LatheGeometry(curve.getPoints(24), 28);
  g.computeVertexNormals();
  return g;
}
const BODY_GEO = bodyGeometry();

export function makeClassicHat(name: string): THREE.Object3D {
  const g = new THREE.Group();
  const mat = (c: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, ...extra });
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); mesh.castShadow = true; g.add(mesh); return mesh;
  };
  switch (name) {
    case 'beanie': {
      const m = mat(0xe8384f);
      add(new THREE.SphereGeometry(0.25, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), m, 0, -0.05, 0);
      add(new THREE.TorusGeometry(0.235, 0.045, 8, 22), mat(0xffffff), 0, -0.04, 0).rotation.x = Math.PI / 2;
      add(sph(0.075), mat(0xffffff), 0, 0.22, 0);
      break;
    }
    case 'tophat': {
      const m = mat(0x15151c, { roughness: 0.4 });
      add(new THREE.CylinderGeometry(0.3, 0.3, 0.025, 24), m, 0, -0.02, 0);
      add(new THREE.CylinderGeometry(0.17, 0.18, 0.32, 24), m, 0, 0.15, 0);
      add(new THREE.CylinderGeometry(0.182, 0.182, 0.06, 24), mat(0xc0283a), 0, 0.03, 0);
      break;
    }
    case 'propeller': {
      const quarters = [0xff4757, 0x2ed573, 0x1e90ff, 0xffd32a];
      quarters.forEach((c, i) => add(new THREE.SphereGeometry(0.25, 10, 10, i * Math.PI / 2, Math.PI / 2, 0, Math.PI / 2), mat(c), 0, -0.05, 0));
      add(new THREE.CylinderGeometry(0.015, 0.015, 0.12, 6), mat(0x888888), 0, 0.24, 0);
      const prop = new THREE.Group();
      const blade = new THREE.BoxGeometry(0.42, 0.01, 0.06);
      prop.add(new THREE.Mesh(blade, mat(0xffd32a)));
      prop.position.y = 0.3;
      prop.name = 'spin';
      g.add(prop);
      break;
    }
    case 'viking': {
      const m = mat(0x9aa3ad, { metalness: 0.6, roughness: 0.35 });
      add(new THREE.SphereGeometry(0.26, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), m, 0, -0.06, 0);
      add(new THREE.TorusGeometry(0.255, 0.03, 6, 22), mat(0x8a6a3a), 0, -0.05, 0).rotation.x = Math.PI / 2;
      for (const s of [-1, 1]) {
        const horn = add(new THREE.ConeGeometry(0.06, 0.26, 10), mat(0xf3ead2), s * 0.27, 0.1, 0);
        horn.rotation.z = -s * 0.9;
      }
      break;
    }
    case 'crown': {
      const m = mat(0xffcf3a, { metalness: 0.8, roughness: 0.25, emissive: 0x553300, emissiveIntensity: 0.3 });
      add(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 20, 1, true), m, 0, 0.02, 0).material.side = THREE.DoubleSide;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        add(new THREE.ConeGeometry(0.04, 0.1, 6), m, Math.cos(a) * 0.19, 0.12, Math.sin(a) * 0.19);
        add(sph(0.022, 8, 6), mat(i % 2 ? 0xff3355 : 0x33aaff, { emissive: i % 2 ? 0x550011 : 0x002255 }), Math.cos(a) * 0.2, 0.02, Math.sin(a) * 0.2);
      }
      break;
    }
    case 'fish': {
      const body = add(sph(1, 16, 10), mat(0x7fb3d5, { metalness: 0.3, roughness: 0.35 }), 0, 0.06, 0);
      body.scale.set(0.11, 0.09, 0.26);
      const tail = add(new THREE.ConeGeometry(0.1, 0.14, 4), mat(0x5d8fb5), 0, 0.06, 0.3);
      tail.rotation.x = -Math.PI / 2; tail.scale.set(1, 1, 0.3);
      add(sph(0.022, 8, 6), M.eye, 0.07, 0.09, -0.16);
      add(sph(0.022, 8, 6), M.eye, -0.07, 0.09, -0.16);
      g.rotation.y = 0.4;
      break;
    }
    case 'party': {
      const cone = add(new THREE.ConeGeometry(0.15, 0.38, 18), mat(0xb84dff), 0, 0.15, 0);
      cone.rotation.z = 0.15;
      add(sph(0.05), mat(0xffe14d), -0.03, 0.35, 0);
      break;
    }
    case 'chef': {
      const m = mat(0xffffff, { roughness: 0.9 });
      add(new THREE.CylinderGeometry(0.19, 0.2, 0.16, 20), m, 0, 0.04, 0);
      for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; add(sph(0.12), m, Math.cos(a) * 0.1, 0.2, Math.sin(a) * 0.1); }
      add(sph(0.14), m, 0, 0.25, 0);
      break;
    }
    case 'cone': {
      add(new THREE.ConeGeometry(0.2, 0.42, 18), mat(0xff6a00), 0, 0.17, 0);
      add(new THREE.CylinderGeometry(0.12, 0.145, 0.07, 18), mat(0xffffff), 0, 0.12, 0);
      add(new THREE.BoxGeometry(0.42, 0.03, 0.42), mat(0xff6a00), 0, -0.03, 0);
      break;
    }
    default: break;
  }
  return g;
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

export class ClassicPenguinModel {
  readonly root = new THREE.Group(); // positioned at feet, yawed
  private body = new THREE.Group(); // leans / waddles
  private flipperL = new THREE.Group();
  private flipperR = new THREE.Group();
  private mittens: THREE.Mesh[] = [];
  private feet: THREE.Group[] = [];
  private hat: THREE.Object3D;
  private hatName: string;
  private headGroup = new THREE.Group();
  private splats: THREE.Mesh[] = [];
  private tag: THREE.Sprite | null = null;
  private scarfTail: THREE.Mesh;
  private walkPhase = Math.random() * 10;
  private mittenLevel = -1;
  private blink = 0;
  private landSquash = 0;
  private wasGrounded = true;
  carriedBalls: THREE.Mesh[] = [];
  private board: THREE.Group | null = null;
  camDist = 99;
  private boardYaw = 0;

  /** always the penguin class: the classic look is only for penguins */
  readonly cls = 'penguin' as const;
  constructor(public team: number, hat: string, name: string | null, private showTag = true) {
    this.root.add(this.body);
    const bodyMesh = new THREE.Mesh(BODY_GEO, M.body);
    bodyMesh.castShadow = true;
    this.body.add(bodyMesh);
    const belly = new THREE.Mesh(G.belly, M.belly);
    belly.scale.set(0.27, 0.34, 0.25);
    belly.position.set(0, 0.35, -0.165);
    this.body.add(belly);

    const jacket = new THREE.Mesh(JACKET_GEO, jacketMats[team]);
    this.body.add(jacket);
    // white fluffy hem + collar so the jacket reads as clothing
    for (const [y, r, tube] of [[0.16, 0.358, 0.03], [0.705, 0.268, 0.034]]) {
      const trim = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 28, Math.PI * 2 - 2.1), jacketTrimMats[team]);
      trim.rotation.x = Math.PI / 2; trim.rotation.z = -Math.PI / 2 + 1.05; trim.position.y = y;
      this.body.add(trim);
    }
    const tail = new THREE.Mesh(G.tail, M.body);
    tail.position.set(0, 0.09, 0.3); tail.rotation.x = -2.0;
    this.body.add(tail);

    // head
    this.headGroup.position.set(0, 0.86, 0);
    this.body.add(this.headGroup);
    const head = new THREE.Mesh(G.head, M.body);
    head.castShadow = true;
    this.headGroup.add(head);
    const face = new THREE.Mesh(G.belly, M.belly);
    face.scale.set(0.19, 0.15, 0.12);
    face.position.set(0, -0.02, -0.16);
    this.headGroup.add(face);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(G.eye, M.eye);
      eye.position.set(s * 0.085, 0.05, -0.235);
      eye.scale.set(1, 1.25, 0.7);
      eye.name = 'eye';
      this.headGroup.add(eye);
      const sh = new THREE.Mesh(G.shine, M.shine);
      sh.position.set(s * 0.085 + 0.012, 0.068, -0.262);
      this.headGroup.add(sh);
      const cheek = new THREE.Mesh(G.cheek, M.cheek);
      cheek.position.set(s * 0.14, -0.035, -0.2);
      cheek.scale.set(1, 0.6, 0.5);
      this.headGroup.add(cheek);
    }
    const beak = new THREE.Mesh(G.beak, M.beak);
    beak.rotation.x = -Math.PI / 2;
    beak.position.set(0, -0.025, -0.3);
    beak.scale.set(1, 1, 0.7);
    beak.castShadow = true;
    this.headGroup.add(beak);

    // scarf
    const scarf = new THREE.Mesh(G.scarf, teamMats[team]);
    scarf.rotation.x = Math.PI / 2;
    scarf.position.set(0, 0.7, 0);
    scarf.scale.set(1.08, 1.08, 1);
    scarf.castShadow = true;
    this.body.add(scarf);
    this.scarfTail = new THREE.Mesh(G.scarfTail, teamMats[team]);
    this.scarfTail.position.set(0.14, 0.68, 0.2);
    this.scarfTail.castShadow = true;
    this.body.add(this.scarfTail);

    // flippers + mittens
    for (const [grp, s] of [[this.flipperL, -1], [this.flipperR, 1]] as [THREE.Group, number][]) {
      // the flippers wear the jacket's sleeves, so they sit just outside it
      grp.position.set(s * 0.375, 0.61, 0);
      const fl = new THREE.Mesh(G.flipper, jacketMats[team]);
      fl.scale.set(0.075, 0.23, 0.125);
      fl.position.set(0, -0.19, 0);
      fl.castShadow = true;
      grp.add(fl);
      const mit = new THREE.Mesh(G.mitten, teamMittenMats[team]);
      mit.position.set(0, -0.43, 0);
      mit.scale.set(1, 1.1, 0.9);
      mit.castShadow = true;
      const thumb = new THREE.Mesh(G.thumb, teamMittenMats[team]);
      thumb.position.set(-s * 0.06, 0.03, -0.06);
      mit.add(thumb);
      const cuff = new THREE.Mesh(G.cuff, M.belly);
      cuff.rotation.x = Math.PI / 2;
      cuff.position.set(0, 0.08, 0);
      mit.add(cuff);
      grp.add(mit);
      this.mittens.push(mit);
      this.body.add(grp);
    }
    // legs + webbed feet: tucked under the body, toes turned out a little. They hang off the body so they follow
    // the waddle, and update() keeps them flat on the ground when the body leans.
    for (const s of [-1, 1]) {
      const f = new THREE.Group();
      const leg = new THREE.Mesh(G.leg, M.foot);
      leg.position.set(0, 0.05, 0);
      f.add(leg);
      const foot = new THREE.Mesh(G.foot, M.foot);
      foot.rotation.y = -s * 0.32;
      foot.position.set(0, 0, -0.02);
      f.add(foot);
      f.userData.side = s;
      this.body.add(f);
      this.feet.push(f);
    }
    this.hatName = hat;
    this.hat = makeClassicHat(hat);
    this.hat.position.set(0, 0.2, 0);
    this.headGroup.add(this.hat);

    // snow splat marks (show damage)
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(G.splat, M.snow);
      s.visible = false;
      this.body.add(s);
      this.splats.push(s);
    }
    this.splats[0].position.set(0.12, 0.45, -0.3); this.splats[0].scale.set(0.11, 0.09, 0.06);
    this.splats[1].position.set(-0.14, 0.9, -0.22); this.splats[1].scale.set(0.1, 0.08, 0.06);
    this.splats[2].position.set(-0.2, 0.3, -0.25); this.splats[2].scale.set(0.12, 0.1, 0.06);


    // carried snowballs on a little belt
    const ballGeo = sph(0.07, 10, 8);
    for (let i = 0; i < 6; i++) {
      const b = new THREE.Mesh(ballGeo, M.snow);
      const a = Math.PI * (0.25 + i * 0.1);
      b.position.set(Math.cos(a + Math.PI / 2) * 0.36, 0.22, Math.sin(a + Math.PI / 2) * 0.36 * 0.9);
      b.castShadow = true;
      b.visible = false;
      this.body.add(b);
      this.carriedBalls.push(b);
    }

    if (name && showTag) {
      this.tag = nameTag(name, team);
      this.tag.position.y = 1.75;
      this.root.add(this.tag);
    }
    this.root.traverse(o => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
  }

  setHat(name: string) {
    if (name === this.hatName) return;
    this.headGroup.remove(this.hat);
    this.hat = makeClassicHat(name);
    this.hat.position.set(0, 0.2, 0);
    this.headGroup.add(this.hat);
    this.hatName = name;
  }

  setMittenLevel(level: number) {
    if (level === this.mittenLevel) return;
    this.mittenLevel = level;
    const m = level === 0 ? teamMittenMats[this.team] : MITTEN_MATS[level]!;
    for (const mit of this.mittens) {
      mit.material = m;
      mit.children.forEach(c => { if ((c as THREE.Mesh).geometry === G.thumb) (c as THREE.Mesh).material = m; });
    }
  }

  /** Pose the penguin for this frame. */
  update(p: Penguin, alpha: number, dt: number, time: number, isLocal: boolean) {
    const x = p.px + (p.x - p.px) * alpha, y = p.py + (p.y - p.py) * alpha, z = p.pz + (p.z - p.pz) * alpha;
    this.root.position.set(x, y, z);
    this.root.rotation.y = p.yaw;
    this.setMittenLevel(p.mitten);
    const speed = Math.hypot(p.vx, p.vz);

    // landing squash
    if (p.grounded && !this.wasGrounded) this.landSquash = 0.25;
    this.wasGrounded = p.grounded;
    this.landSquash = Math.max(0, this.landSquash - dt * 1.5);

    // reset pose
    const b = this.body;
    b.position.set(0, 0, 0); b.rotation.set(0, 0, 0); b.scale.set(1, 1, 1);
    this.flipperL.rotation.set(0, 0, 0.18); this.flipperR.rotation.set(0, 0, -0.18);
    this.headGroup.rotation.set(0, 0, 0);
    for (const f of this.feet) { f.visible = true; f.position.set(f.userData.side * 0.135, 0.0, -0.04); f.rotation.set(0, 0, 0); }
    b.visible = true;

    // riding the surfboard
    if (p.surfing && p.alive) {
      if (!this.board) { this.board = makeSurfboard(); this.root.add(this.board); }
      this.board.visible = true;
      const sp = Math.hypot(p.vx, p.vz);
      if (sp > 0.4) {
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
      // splatted: you vanish in a poof of snow (the 'splat' event draws the cloud), nothing is left behind
      b.visible = false;
      if (this.tag) this.tag.visible = false;
      return;
    }
    if (this.tag) this.tag.visible = !isLocal && this.camDist > 3.5;

    const sq = this.landSquash;
    b.scale.set(1 + sq * 0.3, 1 - sq * 0.35, 1 + sq * 0.3);

    switch (p.action) {
      case 'slide': {
        // belly down, head first, flippers swept back, feet kicking up behind
        b.rotation.x = -1.42;
        b.position.set(0, 0.36, 0.38);
        this.headGroup.rotation.x = 0.9;
        this.flipperL.rotation.set(1.3, 0, 0.5); this.flipperR.rotation.set(1.3, 0, -0.5);
        // feet trail straight out behind the body, soles up, paddling
        for (const [i, f] of this.feet.entries()) { f.position.set((i ? 1 : -1) * 0.11, 0.03, 0.03); f.rotation.x = -1.5 + Math.sin(time * 14 + i * 3) * 0.28; }
        b.rotation.z = Math.sin(time * 9) * 0.05;
        break;
      }
      case 'plow': {
        // lean in and shove with both mittens
        const push = Math.sin(time * 9) * 0.06;
        b.rotation.x = -0.42;
        this.flipperL.rotation.set(-1.45 + push, 0, -0.35); this.flipperR.rotation.set(-1.45 - push, 0, 0.35);
        this.walk(speed * 1.6, dt, 0.07);
        break;
      }
      case 'pack': {
        // crouch and pat-pat-pat a snowball together
        const pat = Math.abs(Math.sin(time * 14));
        b.rotation.x = -0.55; b.position.y = -0.06; b.scale.y *= 0.92;
        this.flipperL.rotation.set(-1.0, 0, -0.65 + pat * 0.35); this.flipperR.rotation.set(-1.0, 0, 0.65 - pat * 0.35);
        this.headGroup.rotation.x = 0.35;
        break;
      }
      case 'dig': {
        const s = (time * 3.2) % 1;
        const swing = s < 0.55 ? -0.9 - s * 1.2 : -1.56 + (s - 0.55) * 7;
        b.rotation.x = -0.35 + (s > 0.55 ? 0.25 : 0);
        this.flipperL.rotation.set(swing, 0, -0.3); this.flipperR.rotation.set(swing, 0, 0.3);
        this.walk(speed, dt, 0.05);
        break;
      }
      case 'build': {
        const s = (time * 3.5) % 1;
        const fling = s < 0.5 ? -0.4 - s * 1.4 : -1.1 - (s - 0.5) * 1.6;
        b.rotation.x = s < 0.5 ? -0.45 : -0.1;
        this.flipperL.rotation.set(fling, 0, -0.25); this.flipperR.rotation.set(fling, 0, 0.25);
        this.walk(speed, dt, 0.05);
        break;
      }
      case 'charge': {
        // right flipper cocked back over the head
        this.flipperR.rotation.set(-2.6 - p.charge * 0.5, 0, -0.2);
        this.flipperL.rotation.set(-0.9, 0, -0.2);
        b.rotation.y = 0.35 * p.charge; b.rotation.x = 0.1 * p.charge;
        this.walk(speed, dt, 0.08);
        break;
      }
      default: {
        if (p.surfing) {
          // surfer stance: low, flippers out for balance, no waddle
          b.position.y += 0.12; b.scale.y *= 0.93;
          b.rotation.z = Math.sin(time * 3) * 0.05 + (p.input.moveX || 0) * -0.18;
          b.rotation.x = -0.12;
          this.flipperL.rotation.z = 1.1 + Math.sin(time * 4) * 0.12; this.flipperR.rotation.z = -1.1 + Math.sin(time * 4 + 1) * 0.12;
          if (p.throwAnim > 0) this.flipperR.rotation.set(-1.2, 0, -0.3);
          break;
        }
        this.walk(speed, dt, 0.12);
        if (p.throwAnim > 0) {
          const t = p.throwAnim / 0.25;
          this.flipperR.rotation.set(-1.6 + (1 - t) * 1.2 * 0 - t * 0.2 + (1 - t) * 0.4, 0, -0.3);
          b.rotation.y = -0.35 * t;
          b.rotation.x = -0.2 * t;
        }
        if (!p.grounded) {
          this.flipperL.rotation.z = 0.9 + Math.sin(time * 30) * 0.4;
          this.flipperR.rotation.z = -0.9 - Math.sin(time * 30) * 0.4;
        }
      }
    }
    // keep the feet flat on the snow however the body leans (the slide pose sets its own)
    if (p.action !== 'slide') for (const f of this.feet) { f.rotation.x += -b.rotation.x; f.rotation.z += -b.rotation.z * 0.6; f.position.y -= b.position.y; }

    // look up/down with the head a little
    if (p.action !== 'slide') this.headGroup.rotation.x += -p.lookPitch * 0.35;

    // blink
    this.blink -= dt;
    const blinking = this.blink < 0.12 && this.blink > 0;
    if (this.blink < 0) this.blink = 2 + Math.random() * 3;
    this.headGroup.children.forEach(c => { if (c.name === 'eye') c.scale.y = blinking ? 0.15 : 1.25; });

    // damage marks
    for (let i = 0; i < this.splats.length; i++) this.splats[i].visible = i < 3 - p.health;
    // carried snowballs
    for (let i = 0; i < this.carriedBalls.length; i++) this.carriedBalls[i].visible = i < p.carried;
    // spawn protection blink
    b.visible = p.invuln <= 0 || Math.floor(time * 12) % 2 === 0;
    // propeller hat spins
    const spin = this.hat.getObjectByName('spin');
    if (spin) spin.rotation.y += dt * (6 + speed * 4);
    // scarf tail flaps with speed
    this.scarfTail.rotation.x = 0.2 + Math.min(1.2, speed * 0.12) + Math.sin(time * 12) * 0.08 * Math.min(1, speed);
  }

  private walk(speed: number, dt: number, amount: number) {
    const moving = Math.min(1, speed / 3);
    this.walkPhase += dt * (4 + speed * 2.2);
    const s = Math.sin(this.walkPhase * 2);
    this.body.rotation.z += s * amount * moving * 1.5;
    this.body.position.y += Math.abs(Math.cos(this.walkPhase * 2)) * 0.05 * moving;
    // little shuffling steps: lift and swing each foot in turn
    this.feet[0].position.y += Math.max(0, s) * 0.07 * moving; this.feet[0].position.z += -s * 0.07 * moving; this.feet[0].rotation.x += Math.max(0, s) * 0.5 * moving;
    this.feet[1].position.y += Math.max(0, -s) * 0.07 * moving; this.feet[1].position.z += s * 0.07 * moving; this.feet[1].rotation.x += Math.max(0, -s) * 0.5 * moving;
    this.flipperL.rotation.z += 0.25 * moving + s * 0.15 * moving;
    this.flipperR.rotation.z -= 0.25 * moving - s * 0.15 * moving;
  }

  dispose(scene: THREE.Object3D) {
    scene.remove(this.root);
    if (this.tag) { (this.tag.material as THREE.SpriteMaterial).map?.dispose(); this.tag.material.dispose(); }
  }
}
