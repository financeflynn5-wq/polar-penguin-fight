import * as THREE from 'three';
import { SnowField, ISO } from '../world/SnowField';

// Marks pressed into the snow: penguin footprints, belly-slide grooves, surfboard tracks and scoop dents.
// They fade after a while, and vanish if the snow under them gets dug, pushed or smashed.

function makeTex(draw: (ctx: CanvasRenderingContext2D, s: number) => void, size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const shadow = 'rgba(70, 105, 150,';
/** fade the two ends of a strip so overlapping segments blend into one continuous track */
function softEnds(ctx: CanvasRenderingContext2D, s: number) {
  ctx.globalCompositeOperation = 'destination-in';
  const m = ctx.createLinearGradient(0, 0, 0, s);
  m.addColorStop(0, 'rgba(0,0,0,0)'); m.addColorStop(0.3, 'rgba(0,0,0,1)'); m.addColorStop(0.7, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = m; ctx.fillRect(0, 0, s, s);
  ctx.globalCompositeOperation = 'source-over';
}
const FOOT = makeTex((ctx, s) => {
  // a little three-toed penguin print, pointing up (+y in texture = forward)
  ctx.translate(s / 2, s / 2);
  const toe = (ang: number, len: number) => {
    ctx.save(); ctx.rotate(ang);
    const g = ctx.createLinearGradient(0, 0, 0, -len);
    g.addColorStop(0, shadow + '0.55)'); g.addColorStop(1, shadow + '0.15)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, -len / 2, s * 0.08, len / 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  };
  toe(-0.55, s * 0.42); toe(0, s * 0.46); toe(0.55, s * 0.42);
  const g = ctx.createRadialGradient(0, s * 0.05, 0, 0, s * 0.05, s * 0.18);
  g.addColorStop(0, shadow + '0.55)'); g.addColorStop(1, shadow + '0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, s * 0.05, s * 0.18, 0, Math.PI * 2); ctx.fill();
});
const GROOVE = makeTex((ctx, s) => {
  // a soft trough across x, continuous along y; bright rim on one side, shadow on the other
  const g = ctx.createLinearGradient(0, 0, s, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.1, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.2, shadow + '0.45)');
  g.addColorStop(0.5, shadow + '0.28)');
  g.addColorStop(0.8, shadow + '0.12)');
  g.addColorStop(0.9, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  softEnds(ctx, s);
});
const BOARD = makeTex((ctx, s) => {
  ctx.fillStyle = shadow + '0.35)';
  ctx.fillRect(s * 0.18, 0, s * 0.12, s); ctx.fillRect(s * 0.7, 0, s * 0.12, s);
  ctx.fillStyle = shadow + '0.12)';
  ctx.fillRect(s * 0.3, 0, s * 0.4, s);
  softEnds(ctx, s);
});
const DENT = makeTex((ctx, s) => {
  const g = ctx.createRadialGradient(s * 0.45, s * 0.42, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, shadow + '0.45)');
  g.addColorStop(0.65, shadow + '0.2)');
  g.addColorStop(0.85, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
});

class DecalSet {
  readonly mesh: THREE.InstancedMesh;
  private born: Float32Array;
  private life: Float32Array;
  private pos: Float32Array;
  private nrm: Float32Array;
  private mats: Float32Array; // base matrices
  private next = 0;
  private check = 0;
  private m = new THREE.Matrix4();
  private c = new THREE.Color();

  constructor(tex: THREE.Texture, private cap: number, private fadeTime: number) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      map: tex, transparent: true, depthWrite: false, roughness: 1,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.born = new Float32Array(cap).fill(-1e9);
    this.life = new Float32Array(cap);
    this.pos = new Float32Array(cap * 3);
    this.nrm = new Float32Array(cap * 3);
    this.mats = new Float32Array(cap * 16);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < cap; i++) { this.mesh.setMatrixAt(i, zero); this.mesh.setColorAt(i, this.c.set(1, 1, 1)); }
    this.mesh.count = cap;
  }

  add(time: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, yaw: number, sx: number, sz: number, life: number) {
    const i = this.next; this.next = (this.next + 1) % this.cap;
    const up = new THREE.Vector3(nx, ny, nz).normalize();
    // orient: plane's +y to the surface normal, then spin around it by yaw
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    q.multiply(spin);
    this.m.compose(new THREE.Vector3(x + up.x * 0.015, y + up.y * 0.015, z + up.z * 0.015), q, new THREE.Vector3(sx, 1, sz));
    this.m.toArray(this.mats, i * 16);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.setColorAt(i, this.c.setRGB(1, 1, 1));
    this.born[i] = time; this.life[i] = life;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.nrm[i * 3] = up.x; this.nrm[i * 3 + 1] = up.y; this.nrm[i * 3 + 2] = up.z;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(time: number, field: SnowField) {
    let dirtyM = false, dirtyC = false;
    // fade old marks toward plain snow; check a slice of them each frame against the snow
    const n = Math.min(this.cap, 60);
    for (let k = 0; k < n; k++) {
      const i = this.check; this.check = (this.check + 1) % this.cap;
      if (this.born[i] < -1e8) continue;
      const age = time - this.born[i];
      const x = this.pos[i * 3], y = this.pos[i * 3 + 1], z = this.pos[i * 3 + 2];
      const nx = this.nrm[i * 3], ny = this.nrm[i * 3 + 1], nz = this.nrm[i * 3 + 2];
      const gone = age > this.life[i] + this.fadeTime ||
        field.sample(x - nx * 0.12, y - ny * 0.12, z - nz * 0.12) < ISO - 20 ||
        field.sample(x + nx * 0.14, y + ny * 0.14, z + nz * 0.14) > ISO + 20;
      if (gone) {
        this.born[i] = -1e9;
        this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0)); dirtyM = true;
        continue;
      }
      if (age > this.life[i]) {
        const f = Math.min(1, (age - this.life[i]) / this.fadeTime);
        this.mesh.setColorAt(i, this.c.setRGB(1 + f * 2, 1 + f * 2, 1 + f * 2)); dirtyC = true;
        // shrink near the end
        if (f > 0.7) {
          this.m.fromArray(this.mats, i * 16);
          const s = 1 - (f - 0.7) / 0.3;
          const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
          this.m.decompose(p, q, sc); sc.multiplyScalar(Math.max(0.01, s)); this.m.compose(p, q, sc);
          this.mesh.setMatrixAt(i, this.m); dirtyM = true;
        }
      }
    }
    if (dirtyM) this.mesh.instanceMatrix.needsUpdate = true;
    if (dirtyC && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

export class Decals {
  readonly group = new THREE.Group();
  readonly feet = new DecalSet(FOOT, 1600, 6);
  readonly grooves = new DecalSet(GROOVE, 1400, 8);
  readonly boards = new DecalSet(BOARD, 600, 6);
  readonly dents = new DecalSet(DENT, 400, 10);
  private nrm = { x: 0, y: 1, z: 0 };

  constructor(private field: SnowField) {
    this.group.add(this.feet.mesh, this.grooves.mesh, this.boards.mesh, this.dents.mesh);
  }

  /** Find the snow surface under a point; null if it's not snow (ice, a prop, mid-air). */
  private surface(x: number, y: number, z: number) {
    const g = this.field.surfaceBelow(x, y + 0.25, z, 0.3, 0.5);
    if (g === null || Math.abs(g - y) > 0.3) return null;
    this.field.normalAt(x, g, z, this.nrm);
    if (this.nrm.y < 0.35) return null;
    return g;
  }

  footprint(time: number, x: number, y: number, z: number, yaw: number) {
    const g = this.surface(x, y, z); if (g === null) return;
    this.feet.add(time, x, g, z, this.nrm.x, this.nrm.y, this.nrm.z, yaw, 0.2, 0.26, 30);
  }
  groove(time: number, x: number, y: number, z: number, yaw: number, width = 0.62, len = 0.6) {
    const g = this.surface(x, y, z); if (g === null) return;
    this.grooves.add(time, x, g, z, this.nrm.x, this.nrm.y, this.nrm.z, yaw, width, len, 40);
  }
  boardTrack(time: number, x: number, y: number, z: number, yaw: number) {
    const g = this.surface(x, y, z); if (g === null) return;
    this.boards.add(time, x, g, z, this.nrm.x, this.nrm.y, this.nrm.z, yaw, 0.5, 0.6, 30);
  }
  dent(time: number, x: number, y: number, z: number, r: number) {
    const g = this.surface(x, y, z); if (g === null) return;
    this.dents.add(time, x, g, z, this.nrm.x, this.nrm.y, this.nrm.z, Math.random() * 6.28, r * 2, r * 2, 45);
  }

  update(time: number) {
    this.feet.update(time, this.field);
    this.grooves.update(time, this.field);
    this.boards.update(time, this.field);
    this.dents.update(time, this.field);
  }
}
