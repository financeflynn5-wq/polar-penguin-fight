import * as THREE from 'three';
import { Penguin } from '../sim/World';
import { TEAM_COLORS } from './Environment';
import { makeSurfboard } from './Props';

// shared materials
const M = {
  body: new THREE.MeshStandardMaterial({ color: 0x1c2333, roughness: 0.55 }),
  belly: new THREE.MeshStandardMaterial({ color: 0xfbfcff, roughness: 0.7 }),
  beak: new THREE.MeshStandardMaterial({ color: 0xffa21f, roughness: 0.5 }),
  eye: new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.2 }),
  shine: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  cheek: new THREE.MeshStandardMaterial({ color: 0xff9fb4, roughness: 0.8 }),
  snow: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
};
const teamMats = TEAM_COLORS.map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 }));
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
  foot: sph(1, 10, 6),
  flipper: sph(1, 12, 10),
  mitten: sph(0.095, 14, 10),
  thumb: sph(0.048, 10, 8),
  cuff: new THREE.TorusGeometry(0.075, 0.03, 8, 14),
  scarf: new THREE.TorusGeometry(0.235, 0.055, 10, 24),
  scarfTail: new THREE.BoxGeometry(0.11, 0.3, 0.04).translate(0, -0.12, 0),
  splat: sph(1, 10, 8),
  lump: sph(1, 18, 12),
};

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

export function makeHat(name: string): THREE.Object3D {
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

function nameTag(text: string, color: string) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.font = '700 30px Fredoka, Nunito, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(10,20,40,0.85)';
  ctx.strokeText(text, 128, 34);
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
  s.scale.set(1.6, 0.4, 1);
  return s;
}

export class PenguinModel {
  readonly root = new THREE.Group(); // positioned at feet, yawed
  private body = new THREE.Group(); // leans / waddles
  private flipperL = new THREE.Group();
  private flipperR = new THREE.Group();
  private mittens: THREE.Mesh[] = [];
  private feet: THREE.Mesh[] = [];
  private hat: THREE.Object3D;
  private hatName: string;
  private headGroup = new THREE.Group();
  private splats: THREE.Mesh[] = [];
  private lump: THREE.Mesh;
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

  constructor(public team: number, hat: string, name: string | null, private showTag = true) {
    this.root.add(this.body);
    const bodyMesh = new THREE.Mesh(BODY_GEO, M.body);
    bodyMesh.castShadow = true;
    this.body.add(bodyMesh);
    const belly = new THREE.Mesh(G.belly, M.belly);
    belly.scale.set(0.28, 0.33, 0.2);
    belly.position.set(0, 0.34, -0.17);
    this.body.add(belly);

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
      grp.position.set(s * 0.32, 0.6, 0);
      const fl = new THREE.Mesh(G.flipper, M.body);
      fl.scale.set(0.06, 0.24, 0.12);
      fl.position.set(0, -0.2, 0);
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
    // feet (not part of body lean)
    for (const s of [-1, 1]) {
      const f = new THREE.Mesh(G.foot, M.beak);
      f.scale.set(0.1, 0.045, 0.17);
      f.position.set(s * 0.13, 0.03, -0.1);
      f.castShadow = true;
      this.root.add(f);
      this.feet.push(f);
    }
    this.hatName = hat;
    this.hat = makeHat(hat);
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

    // the snow lump you become when splatted
    this.lump = new THREE.Mesh(G.lump, M.snow);
    this.lump.scale.set(0.55, 0.42, 0.55);
    this.lump.position.y = 0.2;
    this.lump.visible = false;
    this.lump.castShadow = true;
    this.root.add(this.lump);

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
      this.tag = nameTag(name, team === 0 ? '#9fd0ff' : '#ffc29a');
      this.tag.position.y = 1.65;
      this.root.add(this.tag);
    }
    this.root.traverse(o => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
  }

  setHat(name: string) {
    if (name === this.hatName) return;
    this.headGroup.remove(this.hat);
    this.hat = makeHat(name);
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
    for (const f of this.feet) { f.visible = true; f.position.y = 0.03; f.rotation.set(0, 0, 0); }
    this.lump.visible = false;
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
      b.visible = false;
      for (const f of this.feet) f.visible = false;
      this.lump.visible = true;
      const t = Math.min(1, (3.5 - p.downT) * 4);
      this.lump.scale.set(0.55 * t + 0.1, 0.45 * t + 0.05, 0.55 * t + 0.1);
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
        for (const [i, f] of this.feet.entries()) { f.position.set((i ? 1 : -1) * 0.13, 0.25, 0.72); f.rotation.x = 1.2 + Math.sin(time * 14 + i * 3) * 0.2; }
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
          for (const f of this.feet) f.position.y = 0.13;
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
    this.feet[0].position.y = 0.03 + Math.max(0, s) * 0.07 * moving;
    this.feet[1].position.y = 0.03 + Math.max(0, -s) * 0.07 * moving;
    this.flipperL.rotation.z += 0.25 * moving + s * 0.15 * moving;
    this.flipperR.rotation.z -= 0.25 * moving - s * 0.15 * moving;
  }

  dispose(scene: THREE.Object3D) {
    scene.remove(this.root);
    if (this.tag) { (this.tag.material as THREE.SpriteMaterial).map?.dispose(); this.tag.material.dispose(); }
  }
}
