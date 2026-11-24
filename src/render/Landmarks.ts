import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MapDef, mulberry32 } from '../world/MapDef';
import { IceShard, House } from '../world/Landmarks';
import { seeThrough } from './Environment';

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), tmpS = new THREE.Vector3(1, 1, 1);

/** Bake a transform into a geometry (and drop everything but position / normal / uv / colour so they can be merged). */
function place(g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  const out = g.index ? g.toNonIndexed() : g.clone();
  tmpQ.setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
  out.applyMatrix4(tmpM.compose(tmpV.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz)));
  return out;
}

function paint(g: THREE.BufferGeometry, color: number) {
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function merged(list: THREE.BufferGeometry[], mat: THREE.Material, shadow = true) {
  for (const g of list) { if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2)); }
  const geo = mergeGeometries(list, false)!;
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = shadow; m.receiveShadow = true;
  return m;
}

// ───────────────────────── ice ─────────────────────────

/** One shard: a six-sided column that narrows toward a slanted, broken-off top. Deep blue at the foot, frosty at the tip. */
function shardGeometry(s: IceShard) {
  const rand = mulberry32(s.seed * 7 + 3);
  const g = new THREE.CylinderGeometry(s.r * (0.5 + rand() * 0.16), s.r, s.h, 6, 3).toNonIndexed();
  const p = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  // the same nudge for every copy of a corner, so the column stays closed
  const nudge = new Map<string, [number, number]>();
  const slantX = (rand() - 0.5) * 0.9, slantZ = (rand() - 0.5) * 0.9;
  const deep = new THREE.Color(0x2f8fd6), mid = new THREE.Color(0x7cc4ee), frost = new THREE.Color(0xb9e2fb), c = new THREE.Color();
  for (let v = 0; v < p.count; v++) {
    let x = p.getX(v), y = p.getY(v), z = p.getZ(v);
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    let n = nudge.get(key);
    if (!n) { n = [0.88 + rand() * 0.24, (rand() - 0.5) * s.h * 0.06]; nudge.set(key, n); }
    const t = (y + s.h / 2) / s.h; // 0 at the foot, 1 at the top
    if (Math.hypot(x, z) > 1e-3) { x *= n[0]; z *= n[0]; if (t > 0.05 && t < 0.95) y += n[1]; }
    if (t > 0.95) y += x * slantX + z * slantZ; // broken-off top
    p.setXYZ(v, x, y + s.h / 2, z);
    if (t < 0.5) c.copy(deep).lerp(mid, t * 2); else c.copy(mid).lerp(frost, (t - 0.5) * 2);
    col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.rotateY(rand() * Math.PI);
  g.translate(s.x, s.y, s.z);
  return { geo: g, slantX, slantZ, rot: 0 };
}

function lumpGeometry(r: number, seed: number) {
  const g = new THREE.SphereGeometry(r, 12, 7);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let v = 0; v < p.count; v++) {
    const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
    const k = 1 + Math.sin(x * 4.1 + seed) * Math.sin(z * 3.7 + seed * 1.3) * 0.13;
    p.setXYZ(v, x * k, y, z * k);
  }
  return g;
}

// ───────────────────────── gingerbread ─────────────────────────

function candyTexture(kind: 'cane' | 'mint') {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fffdf8'; ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#e8413c';
  if (kind === 'cane') {
    for (let k = -2; k < 6; k++) { ctx.beginPath(); ctx.moveTo(0, k * 32); ctx.lineTo(128, k * 32 + 64); ctx.lineTo(128, k * 32 + 80); ctx.lineTo(0, k * 32 + 16); ctx.fill(); }
  } else {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(64, 64);
      for (let s = 0; s <= 10; s++) { const r = (s / 10) * 64, aa = a + (s / 10) * 0.9; ctx.lineTo(64 + Math.cos(aa) * r, 64 + Math.sin(aa) * r); }
      for (let s = 10; s >= 0; s--) { const r = (s / 10) * 64, aa = a + 0.5 + (s / 10) * 0.9; ctx.lineTo(64 + Math.cos(aa) * r, 64 + Math.sin(aa) * r); }
      ctx.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * The gingerbread house: brown biscuit walls piped with white icing, a snowy pitched roof dotted with gumdrops,
 * candy canes at both doors and a peppermint in each gable. Everything fades when it gets between the camera and
 * your penguin, so you can still see yourself inside.
 */
function buildHouse(h: House) {
  const g = new THREE.Group();
  const bread: THREE.BufferGeometry[] = [], icing: THREE.BufferGeometry[] = [], candy: THREE.BufferGeometry[] = [];
  const box = (w: number, hh: number, d: number) => new THREE.BoxGeometry(w, hh, d);
  const t = h.wall, foot = -0.5;
  const BREAD = 0xb9743a, DARK = 0x97582a;

  // walls, built the same way as their collision boxes
  for (const s of [-1, 1]) {
    const wx = s * (h.hx - t / 2), seg = (h.hz - h.doorW / 2) / 2;
    for (const k of [-1, 1]) bread.push(paint(place(box(t, h.wallH - foot, seg * 2), wx, (h.wallH + foot) / 2, k * (h.doorW / 2 + seg)), BREAD));
    bread.push(paint(place(box(t, h.wallH - h.doorH, h.doorW), wx, (h.wallH + h.doorH) / 2, 0), BREAD));
    // icing round the doorway
    const ox = s * (h.hx + 0.02);
    for (const k of [-1, 1]) icing.push(place(box(0.1, h.doorH + 0.1, 0.13), ox, h.doorH / 2, k * (h.doorW / 2 + 0.06)));
    icing.push(place(box(0.1, 0.13, h.doorW + 0.25), ox, h.doorH + 0.06, 0));
    // the gable above the end wall, with a peppermint in it
    const rise = h.ridgeH - h.wallH;
    const tri = new THREE.Shape();
    tri.moveTo(-h.hz, 0); tri.lineTo(h.hz, 0); tri.lineTo(0, rise * (h.hz / (h.hz + 0.35))); tri.closePath();
    const gable = new THREE.ExtrudeGeometry(tri, { depth: t, bevelEnabled: false });
    gable.rotateY(Math.PI / 2); // the triangle's x runs along z now
    bread.push(paint(place(gable, wx - t / 2, h.wallH, 0), DARK));
  }
  for (const s of [-1, 1]) {
    const wz = s * (h.hz - t / 2), seg = (h.hx - h.winW / 2) / 2;
    for (const k of [-1, 1]) bread.push(paint(place(box(seg * 2, h.wallH - foot, t), k * (h.winW / 2 + seg), (h.wallH + foot) / 2, wz), BREAD));
    bread.push(paint(place(box(h.winW, h.sill - foot, t), 0, (h.sill + foot) / 2, wz), BREAD));
    bread.push(paint(place(box(h.winW, h.wallH - h.winTop, t), 0, (h.wallH + h.winTop) / 2, wz), BREAD));
    // icing window frame and sill
    const oz = s * (h.hz + 0.02);
    for (const k of [-1, 1]) icing.push(place(box(0.13, h.winTop - h.sill + 0.2, 0.1), k * (h.winW / 2 + 0.06), (h.sill + h.winTop) / 2, oz));
    icing.push(place(box(h.winW + 0.3, 0.13, 0.1), 0, h.winTop + 0.06, oz));
    icing.push(place(box(h.winW + 0.4, 0.1, 0.34), 0, h.sill + 0.03, s * (h.hz - 0.02)));
    // a wavy line of icing piped along the wall, and gumdrops along the bottom
    for (let n = 0; n < 15; n++) {
      const x = -h.hx + 0.35 + n * ((h.hx * 2 - 0.7) / 14);
      if (Math.abs(x) < h.winW / 2 + 0.2) continue;
      icing.push(place(new THREE.SphereGeometry(0.09, 8, 6), x, 1.45 + Math.sin(n * 1.7) * 0.12, oz, 0, 0, 0, 1, 1, 0.5));
    }
  }
  // corner posts of darker biscuit
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bread.push(paint(place(box(0.42, h.wallH + 0.5, 0.42), sx * (h.hx - 0.14), h.wallH / 2 - 0.25, sz * (h.hz - 0.14)), DARK));

  // roof: two biscuit slabs under a thick layer of snowy icing, scalloped along the eaves
  const span = h.hz + 0.35, rise = h.ridgeH - h.wallH;
  const len = Math.hypot(span, rise) + 0.1, ang = Math.atan2(rise, span), wide = (h.hx + 0.45) * 2;
  for (const s of [-1, 1]) {
    const cz = s * span / 2, cy = h.wallH + rise / 2;
    bread.push(paint(place(box(wide, 0.16, len), 0, cy, cz, s * ang), DARK));
    icing.push(place(box(wide + 0.1, 0.17, len * 0.94), 0, cy + 0.15, cz * 0.94, s * ang));
    for (let n = 0; n < 13; n++) {
      const x = -wide / 2 + 0.3 + n * ((wide - 0.6) / 12);
      icing.push(place(new THREE.SphereGeometry(0.2, 8, 6), x, h.wallH + 0.02, s * (span + 0.02), 0, 0, 0, 1, 0.9, 0.8));
    }
    // gumdrops in rows up the roof
    const drops = [0xe8413c, 0x3cbf6b, 0xffc62e, 0x2f7ee8, 0xff7ab0];
    for (let row = 0; row < 2; row++) for (let n = 0; n < 6; n++) {
      const u = 0.3 + row * 0.36;
      const x = -wide / 2 + 0.9 + (n + row * 0.5) * ((wide - 1.8) / 5.5);
      candy.push(paint(place(new THREE.SphereGeometry(0.17, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), x, h.wallH + rise * (1 - u) + 0.26, s * span * u, s * ang), drops[(n + row * 2) % drops.length]));
    }
  }
  icing.push(place(new THREE.CylinderGeometry(0.2, 0.2, wide + 0.1, 8), 0, h.ridgeH + 0.2, 0, 0, 0, Math.PI / 2));
  // chimney
  bread.push(paint(place(box(0.7, 1.3, 0.7), h.hx * 0.45, h.ridgeH - 0.1, -h.hz * 0.45), BREAD));
  icing.push(place(box(0.86, 0.22, 0.86), h.hx * 0.45, h.ridgeH + 0.6, -h.hz * 0.45));

  const breadMat = seeThrough(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88 }));
  const icingMat = seeThrough(new THREE.MeshStandardMaterial({ color: 0xfffaf3, roughness: 0.45 }));
  const candyMat = seeThrough(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3 }));
  for (const list of [icing]) for (const geo of list) geo.deleteAttribute('color');
  g.add(merged(bread, breadMat), merged(icing, icingMat), merged(candy, candyMat));

  // candy canes either side of each door, and a peppermint in each gable
  const caneMat = seeThrough(new THREE.MeshStandardMaterial({ map: candyTexture('cane'), roughness: 0.3 }));
  (caneMat.map as THREE.Texture).repeat.set(1, 3);
  const mintMat = seeThrough(new THREE.MeshStandardMaterial({ map: candyTexture('mint'), roughness: 0.3 }));
  for (const s of [-1, 1]) {
    for (const k of [-1, 1]) {
      const cane = new THREE.Group();
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.9, 10), caneMat);
      stick.position.y = 0.95;
      const hook = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.09, 8, 14, Math.PI), caneMat);
      hook.position.set(0, 1.9, -k * 0.22);
      hook.rotation.y = Math.PI / 2;
      cane.add(stick, hook);
      cane.position.set(s * (h.hx + 0.45), -0.1, k * (h.doorW / 2 + 0.55));
      cane.rotation.x = k * 0.08;
      g.add(cane);
    }
    const mint = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.12, 24), [icingMat, mintMat, mintMat]);
    mint.rotation.z = Math.PI / 2;
    mint.position.set(s * (h.hx + 0.03), h.wallH + 0.72, 0);
    g.add(mint);
  }
  // warm light spilling out of the doors and windows
  const glow = new THREE.PointLight(0xffc27a, 9, 9, 1.6);
  glow.position.set(0, 1.9, 0);
  g.add(glow);

  g.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.position.set(h.x, h.y, h.z);
  return g;
}

/** Ice pillars, icebergs and gingerbread houses. */
export class LandmarksView {
  readonly group = new THREE.Group();

  constructor(map: MapDef) {
    if (map.shards.length) {
      const ice: THREE.BufferGeometry[] = [], snow: THREE.BufferGeometry[] = [];
      for (const s of map.shards) {
        const sh = shardGeometry(s);
        ice.push(sh.geo);
        // snow on the broken top, and drifted up round the foot
        const topR = s.r * 0.5;
        snow.push(place(lumpGeometry(1, s.seed), s.x, s.y + s.h + 0.02, s.z, sh.slantZ * 0.7, 0, -sh.slantX * 0.7, topR, topR * 0.3, topR));
        snow.push(place(lumpGeometry(1, s.seed + 5), s.x, s.y + 0.45, s.z, 0, 0, 0, s.r * 1.35, 0.42, s.r * 1.35));
      }
      const iceMat = seeThrough(new THREE.MeshPhysicalMaterial({
        vertexColors: true, flatShading: true, roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12,
        emissive: 0x1f6fb0, emissiveIntensity: 0.14, envMapIntensity: 1.2,
      }));
      const iceGeo = mergeGeometries(ice, false)!;
      const iceMesh = new THREE.Mesh(iceGeo, iceMat);
      iceMesh.castShadow = true; iceMesh.receiveShadow = true;
      this.group.add(iceMesh);
      this.group.add(merged(snow, seeThrough(new THREE.MeshStandardMaterial({ color: 0xf6faff, roughness: 0.85 }))));
    }
    for (const h of map.houses) this.group.add(buildHouse(h));
  }
}
