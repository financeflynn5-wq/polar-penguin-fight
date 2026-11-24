// Surface Nets mesher: turns the snow density grid into smooth, blobby snow meshes (one per 16³ chunk).
import { SnowField, ISO } from '../world/SnowField';

export const CHUNK = 16;

export interface ChunkMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  ice: Float32Array;
  indices: Uint32Array;
}

const V = CHUNK + 1; // vertex cells per axis (one extra on the low side)
const vertIndex = new Int32Array(V * V * V);
// scratch output (grown on demand)
let pos = new Float32Array(30000 * 3);
let nor = new Float32Array(30000 * 3);
let col = new Float32Array(30000 * 3);
let ice = new Float32Array(30000);
let idx = new Uint32Array(60000 * 3);

// directions for ambient-occlusion probes (roughly uniform on a sphere)
const AO_DIRS: number[] = [];
for (let n = 0; n < 10; n++) {
  const y = 1 - (n + 0.5) / 10 * 2, r = Math.sqrt(1 - y * y), a = n * 2.39996;
  AO_DIRS.push(Math.cos(a) * r, y, Math.sin(a) * r);
}

const EDGES: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7], // x edges
  [0, 2], [1, 3], [4, 6], [5, 7], // y edges
  [0, 4], [1, 5], [2, 6], [3, 7], // z edges
];
// corner c → offsets (bit0 = x, bit1 = y, bit2 = z)

export function meshChunk(field: SnowField, cx: number, cy: number, cz: number): ChunkMesh | null {
  const i0 = cx * CHUNK, j0 = cy * CHUNK, k0 = cz * CHUNK;
  const cell = field.cell;
  const d = new Float32Array(8);
  const h = new Float32Array(8);

  // quick reject: all solid or all empty in the padded range
  let anySolid = false, anyAir = false;
  outer: for (let k = k0 - 1; k <= k0 + CHUNK; k++) for (let i = i0 - 1; i <= i0 + CHUNK; i++) for (let j = j0 - 1; j <= j0 + CHUNK; j++) {
    const v = field.get(i, j, k) > ISO;
    if (v) anySolid = true; else anyAir = true;
    if (anySolid && anyAir) break outer;
  }
  if (!anySolid || !anyAir) return null;

  let nv = 0, ni = 0;
  vertIndex.fill(-1);

  for (let lk = 0; lk < V; lk++) {
    const k = k0 - 1 + lk;
    for (let li = 0; li < V; li++) {
      const i = i0 - 1 + li;
      for (let lj = 0; lj < V; lj++) {
        const j = j0 - 1 + lj;
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = field.get(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1));
          d[c] = v;
          h[c] = field.getHard(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1));
          if (v > ISO) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        // vertex = average of edge crossings
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e][0], b = EDGES[e][1];
          const sa = (mask >> a) & 1, sb = (mask >> b) & 1;
          if (sa === sb) continue;
          const t = (ISO - d[a]) / (d[b] - d[a]);
          sx += (a & 1) + (((b & 1) - (a & 1)) * t);
          sy += ((a >> 1) & 1) + ((((b >> 1) & 1) - ((a >> 1) & 1)) * t);
          sz += ((a >> 2) & 1) + ((((b >> 2) & 1) - ((a >> 2) & 1)) * t);
          cnt++;
        }
        sx /= cnt; sy /= cnt; sz /= cnt;
        if (nv * 3 + 3 > pos.length) grow();
        const wx = field.x0 + (i + sx) * cell, wy = (j + sy) * cell, wz = field.z0 + (k + sz) * cell;
        pos[nv * 3] = wx; pos[nv * 3 + 1] = wy; pos[nv * 3 + 2] = wz;
        // normal from density gradient (outward = toward lower density)
        const e = cell * 0.9;
        // two stencil sizes blended: the wide one irons out the creases that 8-bit density would leave in the lighting
        const e2 = cell * 1.9;
        let gx = field.sample(wx + e, wy, wz) - field.sample(wx - e, wy, wz) + (field.sample(wx + e2, wy, wz) - field.sample(wx - e2, wy, wz)) * 0.6;
        let gy = field.sample(wx, wy + e, wz) - field.sample(wx, wy - e, wz) + (field.sample(wx, wy + e2, wz) - field.sample(wx, wy - e2, wz)) * 0.6;
        let gz = field.sample(wx, wy, wz + e) - field.sample(wx, wy, wz - e) + (field.sample(wx, wy, wz + e2) - field.sample(wx, wy, wz - e2)) * 0.6;
        if (Math.abs(gx) + Math.abs(gy) + Math.abs(gz) < 1) {
          gx = (d[1] + d[3] + d[5] + d[7]) - (d[0] + d[2] + d[4] + d[6]);
          gy = (d[2] + d[3] + d[6] + d[7]) - (d[0] + d[1] + d[4] + d[5]);
          gz = (d[4] + d[5] + d[6] + d[7]) - (d[0] + d[1] + d[2] + d[3]);
        }
        const gl = Math.hypot(gx, gy, gz) || 1;
        nor[nv * 3] = -gx / gl; nor[nv * 3 + 1] = -gy / gl; nor[nv * 3 + 2] = -gz / gl;
        // ambient occlusion from the local neighbourhood
        // sample the field on a small shell around the vertex: smooth, no voxel stepping
        const nxv = -gx / gl, nyv = -gy / gl, nzv = -gz / gl;
        let occ = 0;
        for (let a = 0; a < AO_DIRS.length; a += 3) {
          let dx = AO_DIRS[a], dy = AO_DIRS[a + 1], dz = AO_DIRS[a + 2];
          // bend sample directions into the normal hemisphere
          const dn = dx * nxv + dy * nyv + dz * nzv;
          if (dn < 0) { dx -= 2 * dn * nxv; dy -= 2 * dn * nyv; dz -= 2 * dn * nzv; }
          occ += Math.min(255, field.sample(wx + dx * 1.1 + nxv * 0.25, wy + dy * 1.1 + nyv * 0.25, wz + dz * 1.1 + nzv * 0.25)) / 255;
        }
        const f = 0.3 + occ / (AO_DIRS.length / 3) * 0.55;
        let ao = Math.min(1.08, Math.max(0.5, 1.32 - f * 0.95)) / 0.86;
        ao = Math.min(1.12, ao);
        // packed snow reads a touch icier blue; deep snow slightly warmer
        let hard = 0;
        for (let c = 0; c < 8; c++) hard += h[c];
        hard /= 8 * 255;
        // frozen water (pond, sled run): the shader turns these glossy and blue
        let iceV = 0;
        if (hard > 0.9 && nyv > 0.6) {
          const fi = field.fx(wx), fk = field.fz(wz);
          const i0c = Math.max(0, Math.min(field.nx - 2, Math.floor(fi))), k0c = Math.max(0, Math.min(field.nz - 2, Math.floor(fk)));
          const tx = Math.min(1, Math.max(0, fi - i0c)), tz = Math.min(1, Math.max(0, fk - k0c));
          const c00 = k0c * field.nx + i0c;
          const I = field.ice;
          iceV = (I[c00] * (1 - tx) + I[c00 + 1] * tx) * (1 - tz) + (I[c00 + field.nx] * (1 - tx) + I[c00 + field.nx + 1] * tx) * tz;
          if (Math.abs(wy - field.baseHeight[c00]) > 0.45) iceV = 0;
        }
        ice[nv] = iceV;
        let r = 0.93, g = 0.96, b = 1.0;
        if (iceV > 0) { /* plain */ }
        else if (hard > 0.02) { const t = Math.min(1, hard * 1.4); r -= 0.12 * t; g -= 0.05 * t; b += 0.0; }
        // slight height tint so the rim reads as distant hills
        col[nv * 3] = r * ao; col[nv * 3 + 1] = g * ao; col[nv * 3 + 2] = b * ao;
        vertIndex[(lk * V + li) * V + lj] = nv;
        nv++;
      }
    }
  }

  const vi = (li: number, lj: number, lk: number) => vertIndex[(lk * V + li) * V + lj];
  const quad = (a: number, b: number, c: number, e: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || e < 0) return;
    if (ni + 6 > idx.length) { const n = new Uint32Array(idx.length * 2); n.set(idx); idx = n; }
    if (!flip) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = e; }
    else { idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; idx[ni++] = a; idx[ni++] = e; idx[ni++] = c; }
  };

  for (let lk = 1; lk < V; lk++) {
    const k = k0 - 1 + lk;
    for (let li = 1; li < V; li++) {
      const i = i0 - 1 + li;
      for (let lj = 1; lj < V; lj++) {
        const j = j0 - 1 + lj;
        const s0 = field.get(i, j, k) > ISO;
        // x edge
        const sx = field.get(i + 1, j, k) > ISO;
        if (s0 !== sx) quad(vi(li, lj - 1, lk - 1), vi(li, lj, lk - 1), vi(li, lj, lk), vi(li, lj - 1, lk), !s0);
        // y edge
        const sy = field.get(i, j + 1, k) > ISO;
        if (s0 !== sy) quad(vi(li - 1, lj, lk - 1), vi(li - 1, lj, lk), vi(li, lj, lk), vi(li, lj, lk - 1), !s0);
        // z edge
        const sz = field.get(i, j, k + 1) > ISO;
        if (s0 !== sz) quad(vi(li - 1, lj - 1, lk), vi(li, lj - 1, lk), vi(li, lj, lk), vi(li - 1, lj, lk), !s0);
      }
    }
  }
  if (ni === 0) return null;
  return {
    positions: pos.slice(0, nv * 3),
    normals: nor.slice(0, nv * 3),
    colors: col.slice(0, nv * 3),
    ice: ice.slice(0, nv),
    indices: idx.slice(0, ni),
  };
}

function grow() {
  const n = pos.length * 2;
  const p = new Float32Array(n); p.set(pos); pos = p;
  const q = new Float32Array(n); q.set(nor); nor = q;
  const c = new Float32Array(n); c.set(col); col = c;
  const ic = new Float32Array(n / 3); ic.set(ice); ice = ic;
}
