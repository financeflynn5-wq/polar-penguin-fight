import * as THREE from 'three';
import { Playground, slideY } from '../world/Playground';

const mat = (c: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, ...extra });
const RED = mat(0xe8413c), YEL = mat(0xffc62e), BLU = mat(0x2f7ee8), GRN = mat(0x3cbf6b), METAL = mat(0x9aa7b4, { metalness: 0.7, roughness: 0.35 });
const SNOW = mat(0xf7fbff, { roughness: 0.9 });
const WOOD = mat(0x8a5a3a, { roughness: 0.85 });

/** Bright plastic playground, dusted with snow. */
export class PlaygroundView {
  readonly group = new THREE.Group();
  private swings: THREE.Group[] = [];
  private seesaws: THREE.Mesh[] = [];

  constructor(pg: Playground) {
    const add = (m: THREE.Object3D) => { m.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } }); this.group.add(m); return m; };
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, rotY = 0) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.rotation.y = rotY; return add(b) as THREE.Mesh;
    };
    const pole = (x: number, z: number, y0: number, y1: number, r: number, m: THREE.Material) => {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, y1 - y0, 10), m); c.position.set(x, (y0 + y1) / 2, z); return add(c);
    };

    // tower
    const t = pg.tower;
    box(t.size, 0.18, t.size, YEL, t.x, t.top - 0.09, t.z);
    box(t.size - 0.1, 0.06, t.size - 0.1, SNOW, t.x, t.top + 0.02, t.z);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) pole(t.x + sx * (t.size / 2 - 0.08), t.z + sz * (t.size / 2 - 0.08), t.ground - 0.3, t.top + 1.6, 0.09, BLU);
    for (const sx of [-1, 1]) {
      box(0.06, 0.08, t.size, RED, t.x + sx * (t.size / 2 - 0.04), t.top + 0.6, t.z);
      for (let k = 0; k < 4; k++) pole(t.x + sx * (t.size / 2 - 0.04), t.z - t.size / 2 + 0.25 + k * 0.4, t.top, t.top + 0.6, 0.025, RED);
    }
    // roof
    const roof = new THREE.Mesh(new THREE.ConeGeometry(t.size * 0.82, 0.9, 4), RED);
    roof.position.set(t.x, t.top + 2.05, t.z); roof.rotation.y = Math.PI / 4;
    add(roof);
    const roofSnow = new THREE.Mesh(new THREE.ConeGeometry(t.size * 0.6, 0.5, 4), SNOW);
    roofSnow.position.set(t.x, t.top + 2.3, t.z); roofSnow.rotation.y = Math.PI / 4;
    add(roofSnow);

    // steps (from the collision boxes)
    for (const b of pg.boxes) {
      if (b.kind === 'step') {
        box(b.hx * 2, b.y1 - b.y0, b.hz * 2, GRN, b.x, (b.y0 + b.y1) / 2, b.z);
        box(b.hx * 2 - 0.05, 0.05, b.hz * 2 - 0.05, SNOW, b.x, b.y1 + 0.02, b.z);
      } else if (b.kind === 'wall') {
        const wallMat = mat(b.color ?? 0x888888);
        const w = box(b.hx * 2, b.y1 - b.y0, b.hz * 2, wallMat, b.x, (b.y0 + b.y1) / 2, b.z, -b.rot);
        void w;
        box(b.hx * 2 + 0.04, 0.1, b.hz * 2 + 0.06, SNOW, b.x, b.y1 + 0.04, b.z, -b.rot);
      }
    }

    // the slide: a ribbon following the profile, with side rails
    const sl = pg.slide;
    const n = sl.samples.length;
    const pos: number[] = [], idx: number[] = [];
    const railPts: THREE.Vector3[][] = [[], []];
    for (let i = 0; i < n; i++) {
      const s = i * sl.step;
      const z = sl.z0 + s * sl.dirZ;
      const y = slideY(sl, s);
      pos.push(sl.x - sl.width / 2, y, z, sl.x + sl.width / 2, y, z);
      if (i < n - 1) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      railPts[0].push(new THREE.Vector3(sl.x - sl.width / 2, y + 0.18, z));
      railPts[1].push(new THREE.Vector3(sl.x + sl.width / 2, y + 0.18, z));
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    sg.setIndex(idx);
    sg.computeVertexNormals();
    const slideMesh = new THREE.Mesh(sg, mat(0x2fb0ff, { roughness: 0.25, metalness: 0.1, side: THREE.DoubleSide }));
    add(slideMesh);
    // underside thickness
    const under = new THREE.Mesh(sg, mat(0x1d6fb0, { side: THREE.DoubleSide }));
    under.position.y = -0.06;
    add(under);
    for (const pts of railPts) {
      const curve = new THREE.CatmullRomCurve3(pts);
      add(new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.05, 6), YEL));
      // side walls
      const wallPos: number[] = [], wallIdx: number[] = [];
      pts.forEach((p, i) => { wallPos.push(p.x, p.y - 0.2, p.z, p.x, p.y, p.z); if (i < pts.length - 1) { const a = i * 2; wallIdx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); } });
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
      wg.setIndex(wallIdx); wg.computeVertexNormals();
      add(new THREE.Mesh(wg, mat(0x2fb0ff, { side: THREE.DoubleSide })));
    }
    // legs under the slide
    for (const c of pg.cyls) {
      if (Math.abs(c.x - sl.x) <= sl.width / 2 + 0.05 && (c.z - sl.z0) * sl.dirZ > 0 && c.r < 0.08) pole(c.x, c.z, c.y0, c.y1, c.r, METAL);
    }

    // swing sets
    for (const sw of pg.swings) {
      const g = new THREE.Group();
      g.position.set(sw.x, sw.ground, sw.z);
      for (const end of [-1, 1]) {
        for (const leg of [-1, 1]) {
          const legMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.7, 8), RED);
          legMesh.position.set(end * 1.6, 1.0, leg * 0.3);
          legMesh.rotation.x = leg * 0.25;
          g.add(legMesh);
        }
      }
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.4, 8), YEL);
      bar.rotation.z = Math.PI / 2; bar.position.y = 2.28;
      g.add(bar);
      const barSnow = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.06, 0.12), SNOW);
      barSnow.position.y = 2.36;
      g.add(barSnow);
      for (const sx of [-0.7, 0.7]) {
        const swing = new THREE.Group();
        swing.position.set(sx, 2.25, 0);
        for (const cx of [-0.22, 0.22]) {
          const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.75, 4), METAL);
          chain.position.set(cx, -0.88, 0);
          swing.add(chain);
        }
        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.05, 0.22), BLU);
        seat.position.y = -1.75;
        swing.add(seat);
        g.add(swing);
        this.swings.push(swing);
      }
      add(g);
    }

    // seesaws
    for (const ss of pg.seesaws) {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 0.45, 8), YEL);
      base.position.set(ss.x, ss.ground + 0.2, ss.z);
      add(base);
      const plank = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.08, 0.32), GRN);
      plank.position.set(ss.x, ss.ground + 0.45, ss.z);
      add(plank);
      for (const e of [-1.45, 1.45]) {
        const handle = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.025, 6, 12, Math.PI), RED);
        handle.position.set(e, 0.12, 0);
        plank.add(handle);
      }
      this.seesaws.push(plank);
    }

    // monkey bars
    for (const mb of pg.monkeyBars) {
      for (const end of [-1, 1]) for (const side of [-1, 1]) pole(mb.x + side * 0.45, mb.z + end * 1.6, mb.ground - 0.3, mb.ground + 2.0, 0.07, BLU);
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.3, 8), YEL);
        rail.rotation.x = Math.PI / 2; rail.position.set(mb.x + side * 0.45, mb.ground + 2.0, mb.z);
        add(rail);
      }
      for (let k = 0; k < 8; k++) {
        const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6), METAL);
        rung.rotation.z = Math.PI / 2; rung.position.set(mb.x, mb.ground + 2.0, mb.z - 1.4 + k * 0.4);
        add(rung);
      }
    }

    // a little sign
    const signPost = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6), WOOD);
    signPost.position.set(2.2, pg.tower.ground + 0.6, pg.tower.z + 2.6);
    add(signPost);
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffd34d'; ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = '#1b2433'; ctx.font = '700 40px Fredoka, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('PENGUIN', 128, 54); ctx.fillText('PARK', 128, 100);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.5, 0.06), [WOOD, WOOD, WOOD, WOOD, new THREE.MeshStandardMaterial({ map: tex }), new THREE.MeshStandardMaterial({ map: tex })]);
    sign.position.set(2.2, pg.tower.ground + 1.45, pg.tower.z + 2.6);
    sign.rotation.y = 0.5;
    add(sign);
  }

  update(time: number) {
    this.swings.forEach((s, i) => { s.rotation.x = Math.sin(time * 1.3 + i * 1.7) * 0.25; });
    this.seesaws.forEach((p, i) => { p.rotation.z = Math.sin(time * 0.8 + i * 2) * 0.18; });
  }
}
