import * as THREE from 'three';
import { World, Turret } from '../sim/World';
import { CFG } from '../sim/config';
import { TEAM_COLORS, TEAM_CSS } from './Environment';

function lumpy(r: number, amp = 0.05) {
  const g = new THREE.IcosahedronGeometry(r, 3);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(1 + (Math.sin(v.x * 9.1) * Math.sin(v.y * 8.3) * Math.sin(v.z * 7.7)) * amp);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

const GEO = {
  base: lumpy(0.58), mid: lumpy(0.42), head: lumpy(0.29),
  coal: new THREE.SphereGeometry(0.035, 8, 6),
  nose: new THREE.ConeGeometry(0.05, 0.26, 8).rotateX(-Math.PI / 2),
  scarf: new THREE.TorusGeometry(0.27, 0.07, 8, 20).rotateX(Math.PI / 2),
  scarfTail: new THREE.BoxGeometry(0.13, 0.36, 0.05).translate(0, -0.16, 0),
  bucket: new THREE.CylinderGeometry(0.17, 0.23, 0.26, 14),
  brim: new THREE.CylinderGeometry(0.26, 0.26, 0.035, 14),
  barrel: new THREE.CylinderGeometry(0.15, 0.12, 0.78, 14).rotateX(-Math.PI / 2).translate(0, 0, -0.39),
  muzzle: new THREE.TorusGeometry(0.155, 0.045, 8, 16).translate(0, 0, -0.78),
  mount: new THREE.BoxGeometry(0.16, 0.2, 0.34),
  arm: new THREE.CylinderGeometry(0.022, 0.03, 0.55, 6).translate(0, 0.27, 0),
  ring: new THREE.RingGeometry(0.9, 1.0, 48).rotateX(-Math.PI / 2),
};
const MAT = {
  snow: new THREE.MeshStandardMaterial({ color: 0xf8fbff, roughness: 0.86 }),
  coal: new THREE.MeshStandardMaterial({ color: 0x151a22, roughness: 0.5 }),
  carrot: new THREE.MeshStandardMaterial({ color: 0xff8a1f, roughness: 0.5 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x6b4a33, roughness: 0.9 }),
  metal: new THREE.MeshStandardMaterial({ color: 0x8e9db0, roughness: 0.35, metalness: 0.7 }),
};
const teamMat = TEAM_COLORS.map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.65, emissive: c, emissiveIntensity: 0.25 }));

interface Model {
  root: THREE.Group; top: THREE.Group; gun: THREE.Group; base: THREE.Mesh; mid: THREE.Mesh; head: THREE.Group;
  label: THREE.Sprite | null; draw: ((ammo: number, health: number) => void) | null; lastKey: string; popT: number;
}

/** A snowman with a team scarf and bucket hat, hugging a snowball cannon. Forward is -z. */
function makeSnowman(team: number, withLabel: boolean): Model {
  const root = new THREE.Group();
  const base = new THREE.Mesh(GEO.base, MAT.snow);
  base.position.y = 0.46; base.scale.y = 0.88;
  root.add(base);
  const top = new THREE.Group(); // turns to face the target
  root.add(top);
  const mid = new THREE.Mesh(GEO.mid, MAT.snow);
  mid.position.y = 1.12;
  top.add(mid);
  const head = new THREE.Group();
  head.position.y = 1.62;
  head.add(new THREE.Mesh(GEO.head, MAT.snow));
  for (const s of [-1, 1]) { const e = new THREE.Mesh(GEO.coal, MAT.coal); e.position.set(s * 0.1, 0.07, -0.255); head.add(e); }
  for (let k = 0; k < 5; k++) { const m = new THREE.Mesh(GEO.coal, MAT.coal); const a = (k - 2) * 0.2; m.position.set(Math.sin(a) * 0.15, -0.09 - Math.cos(a) * 0.04 + 0.04, -0.262); m.scale.setScalar(0.7); head.add(m); }
  const nose = new THREE.Mesh(GEO.nose, MAT.carrot);
  nose.position.set(0, 0, -0.38);
  head.add(nose);
  const bucket = new THREE.Mesh(GEO.bucket, teamMat[team]);
  bucket.position.y = 0.36; bucket.rotation.z = 0.12;
  const brim = new THREE.Mesh(GEO.brim, MAT.metal);
  brim.position.y = 0.24; brim.rotation.z = 0.12;
  head.add(bucket, brim);
  top.add(head);
  const scarf = new THREE.Mesh(GEO.scarf, teamMat[team]);
  scarf.position.y = 1.41;
  const tail = new THREE.Mesh(GEO.scarfTail, teamMat[team]);
  tail.position.set(0.2, 1.4, -0.2); tail.rotation.z = -0.25;
  top.add(scarf, tail);
  // the cannon, held out front on a little wooden mount, with stick arms reaching round it
  const gun = new THREE.Group();
  gun.position.set(0, 1.14, -0.3);
  gun.add(new THREE.Mesh(GEO.barrel, MAT.metal), new THREE.Mesh(GEO.muzzle, teamMat[team]));
  const mount = new THREE.Mesh(GEO.mount, MAT.wood);
  mount.position.set(0, -0.14, 0.02);
  gun.add(mount);
  top.add(gun);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(GEO.arm, MAT.wood);
    arm.position.set(s * 0.36, 1.2, -0.05);
    arm.rotation.set(-1.25, 0, -s * 0.55);
    top.add(arm);
  }
  root.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  let label: THREE.Sprite | null = null, draw: Model['draw'] = null;
  if (withLabel) {
    const c = document.createElement('canvas'); c.width = 160; c.height = 80;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    label.scale.set(1.5, 0.75, 1);
    label.position.y = 2.55;
    label.renderOrder = 9;
    root.add(label);
    draw = (ammo, health) => {
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, 160, 80);
      ctx.font = '700 38px Fredoka, Nunito, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(10,20,40,0.85)';
      const text = ammo > 0 ? String(ammo) : 'EMPTY';
      ctx.strokeText(text, 80, 28);
      ctx.fillStyle = ammo > 0 ? TEAM_CSS[team] : '#ff6b6b'; ctx.fillText(text, 80, 28);
      // health pips
      const n = CFG.turretHealth, w = 16, gap = 6, x0 = 80 - (n * w + (n - 1) * gap) / 2;
      for (let k = 0; k < n; k++) {
        ctx.fillStyle = 'rgba(10,20,40,0.85)'; ctx.fillRect(x0 + k * (w + gap) - 2, 56, w + 4, 14);
        ctx.fillStyle = k < health ? '#ffffff' : 'rgba(255,255,255,0.18)'; ctx.fillRect(x0 + k * (w + gap), 58, w, 10);
      }
      tex.needsUpdate = true;
    };
  }
  return { root, top, gun, base, mid, head, label, draw, lastKey: '', popT: 0.35 };
}

/** Snowman turrets, the snowmen still being built, and the warning ring where an Avalanche is about to land. */
export class TurretsView {
  readonly group = new THREE.Group();
  private models = new Map<number, Model>();
  private ghosts = new Map<number, Model>();
  private rings: { mesh: THREE.Mesh; beam: THREE.Mesh; t: number; life: number }[] = [];

  update(w: World, dt: number, time: number, cam: THREE.Vector3) {
    const seen = new Set<number>();
    for (const t of w.turrets) {
      if (!t.alive) continue;
      seen.add(t.id);
      let m = this.models.get(t.id);
      if (!m) { m = makeSnowman(t.team, true); this.group.add(m.root); this.models.set(t.id, m); }
      this.pose(m, t, dt, time);
      const key = `${t.ammo}|${t.health}`;
      if (m.lastKey !== key) { m.draw!(t.ammo, t.health); m.lastKey = key; }
      m.label!.visible = Math.hypot(cam.x - t.x, cam.z - t.z) < 38;
    }
    for (const [id, m] of this.models) if (!seen.has(id)) { this.group.remove(m.root); this.models.delete(id); }

    // snowmen going up: the base ball first, then the middle, then the head
    const building = new Set<number>();
    for (const p of w.penguins) {
      if (!p.turretAt || p.turretSnow <= 0 || !p.alive) continue;
      building.add(p.id);
      let m = this.ghosts.get(p.id);
      if (!m) { m = makeSnowman(p.team, false); this.group.add(m.root); this.ghosts.set(p.id, m); }
      const k = Math.min(1, p.turretSnow / CFG.turretCost);
      const part = (from: number, to: number) => Math.max(0, Math.min(1, (k - from) / (to - from)));
      m.root.position.set(p.turretAt.x, p.turretAt.y, p.turretAt.z);
      m.root.rotation.y = p.lookYaw;
      const b = part(0, 0.45), mm = part(0.4, 0.78), hh = part(0.74, 1);
      m.base.scale.set(0.25 + b * 0.75, (0.25 + b * 0.75) * 0.88, 0.25 + b * 0.75);
      m.base.position.y = 0.46 * (0.25 + b * 0.75);
      m.mid.visible = mm > 0; m.mid.scale.setScalar(0.3 + mm * 0.7);
      m.head.visible = hh > 0; m.head.scale.setScalar(0.3 + hh * 0.7);
      m.gun.visible = false;
      m.top.children.forEach(c => { if (c !== m!.mid && c !== m!.head && c !== m!.gun) c.visible = hh > 0.6; });
    }
    for (const [id, m] of this.ghosts) if (!building.has(id)) { this.group.remove(m.root); this.ghosts.delete(id); }

    // Avalanche warning rings
    for (const r of this.rings) {
      r.t += dt;
      const k = r.t / r.life;
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = (0.55 + Math.sin(time * 14) * 0.25) * (1 - Math.max(0, k - 0.85) / 0.15);
      r.beam.rotation.y = time * 2;
      (r.beam.material as THREE.MeshBasicMaterial).opacity = 0.16 * (1 - Math.max(0, k - 0.85) / 0.15);
    }
    for (const r of this.rings) if (r.t >= r.life) { this.group.remove(r.mesh, r.beam); }
    this.rings = this.rings.filter(r => r.t < r.life);
  }

  private pose(m: Model, t: Turret, dt: number, time: number) {
    m.popT = Math.max(0, m.popT - dt);
    const pop = 1 + Math.sin((1 - m.popT / 0.35) * Math.PI) * 0.18 * (m.popT > 0 ? 1 : 0);
    m.root.position.set(t.x, t.y - 0.06, t.z);
    m.root.scale.setScalar(pop);
    m.top.rotation.y = t.yaw;
    // a jolt back with every throw, and a little idle bob
    const kick = t.fireT / 0.3;
    m.gun.position.z = -0.3 + kick * 0.2;
    m.head.rotation.x = -kick * 0.18 + Math.sin(time * 1.7 + t.id) * 0.03;
    m.head.rotation.z = Math.sin(time * 1.3 + t.id * 2) * 0.04;
    // out of snowballs: the cannon droops
    m.gun.rotation.x = t.ammo > 0 ? 0 : -0.5;
  }

  /** Show where an Avalanche is about to come down. */
  barrage(x: number, y: number, z: number, team: number, life: number) {
    const col = TEAM_COLORS[team];
    const mesh = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7, depthTest: false, side: THREE.DoubleSide }));
    mesh.scale.setScalar(CFG.avalancheRadius);
    mesh.position.set(x, y + 0.25, z);
    mesh.renderOrder = 8;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(CFG.avalancheRadius, CFG.avalancheRadius, 26, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    beam.position.set(x, y + 13, z);
    this.group.add(mesh, beam);
    this.rings.push({ mesh, beam, t: 0, life });
  }
}
