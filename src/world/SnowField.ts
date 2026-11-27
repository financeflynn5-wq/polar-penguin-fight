// The snow field: a 3D grid of snow density. Everything you can push, pile, pat, dig or smash lives here.
// Pure data + math, no Three.js, so the same code can run on the game server later.

export const ISO = 128; // density above this is "solid snow"

export interface FieldSpec {
  nx: number; ny: number; nz: number;
  cell: number; // metres per voxel
  x0: number; z0: number; // world position of voxel (0, *, 0)
}

export interface RayHit { t: number; x: number; y: number; z: number; }

export type DirtyListener = (i0: number, j0: number, k0: number, i1: number, j1: number, k1: number) => void;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export class SnowField {
  readonly nx: number; readonly ny: number; readonly nz: number;
  readonly cell: number; readonly x0: number; readonly z0: number;
  readonly density: Uint8Array;
  readonly hard: Uint8Array; // how packed the snow is (0 = fluffy, 255 = ice-hard)
  readonly baseHeight: Float32Array; // original ground height per column
  readonly bedrock: Float32Array; // can't dig below this height per column
  readonly ice: Uint8Array; // 1 where the column is frozen water (pond, sled run)
  onDirty: DirtyListener | null = null;

  // scratch buffers for ops
  private scratchIdx = new Int32Array(4096);
  private scratchW = new Float32Array(4096);

  constructor(spec: FieldSpec) {
    this.nx = spec.nx; this.ny = spec.ny; this.nz = spec.nz;
    this.cell = spec.cell; this.x0 = spec.x0; this.z0 = spec.z0;
    this.density = new Uint8Array(this.nx * this.ny * this.nz);
    this.hard = new Uint8Array(this.nx * this.ny * this.nz);
    this.baseHeight = new Float32Array(this.nx * this.nz);
    this.bedrock = new Float32Array(this.nx * this.nz);
    this.ice = new Uint8Array(this.nx * this.nz);
  }

  idx(i: number, j: number, k: number) { return (k * this.nx + i) * this.ny + j; }

  /** Density at a voxel, with the world closed off below and open at the sides/top. */
  get(i: number, j: number, k: number): number {
    if (j < 0) return 255;
    if (j >= this.ny || i < 0 || k < 0 || i >= this.nx || k >= this.nz) return 0;
    return this.density[(k * this.nx + i) * this.ny + j];
  }

  getHard(i: number, j: number, k: number): number {
    if (j < 0 || j >= this.ny || i < 0 || k < 0 || i >= this.nx || k >= this.nz) return 0;
    return this.hard[(k * this.nx + i) * this.ny + j];
  }

  /** World x/z → fractional voxel coords */
  fx(x: number) { return (x - this.x0) / this.cell; }
  fy(y: number) { return y / this.cell; }
  fz(z: number) { return (z - this.z0) / this.cell; }
  wx(i: number) { return this.x0 + i * this.cell; }
  wy(j: number) { return j * this.cell; }
  wz(k: number) { return this.z0 + k * this.cell; }

  inBoundsXZ(x: number, z: number, margin = 0) {
    const i = this.fx(x), k = this.fz(z);
    return i >= margin && k >= margin && i <= this.nx - 1 - margin && k <= this.nz - 1 - margin;
  }

  colIndex(x: number, z: number) {
    const i = clamp(Math.round(this.fx(x)), 0, this.nx - 1);
    const k = clamp(Math.round(this.fz(z)), 0, this.nz - 1);
    return k * this.nx + i;
  }

  /** Trilinear density sample at a world point. */
  sample(x: number, y: number, z: number): number {
    const fx = this.fx(x), fy = this.fy(y), fz = this.fz(z);
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const c000 = this.get(i, j, k), c100 = this.get(i + 1, j, k);
    const c010 = this.get(i, j + 1, k), c110 = this.get(i + 1, j + 1, k);
    const c001 = this.get(i, j, k + 1), c101 = this.get(i + 1, j, k + 1);
    const c011 = this.get(i, j + 1, k + 1), c111 = this.get(i + 1, j + 1, k + 1);
    const x00 = c000 + (c100 - c000) * tx, x10 = c010 + (c110 - c010) * tx;
    const x01 = c001 + (c101 - c001) * tx, x11 = c011 + (c111 - c011) * tx;
    const y0 = x00 + (x10 - x00) * ty, y1 = x01 + (x11 - x01) * ty;
    return y0 + (y1 - y0) * tz;
  }

  solid(x: number, y: number, z: number) { return this.sample(x, y, z) > ISO; }

  /** Bilinear density of a column at voxel level j */
  private colDensity(fx: number, fz: number, j: number) {
    const i = Math.floor(fx), k = Math.floor(fz);
    const tx = fx - i, tz = fz - k;
    const a = this.get(i, j, k), b = this.get(i + 1, j, k);
    const c = this.get(i, j, k + 1), d = this.get(i + 1, j, k + 1);
    const ab = a + (b - a) * tx, cd = c + (d - c) * tx;
    return ab + (cd - ab) * tz;
  }

  /**
   * Height of the first snow surface found scanning down from y+up to y-down.
   * Works inside tunnels: ceilings above y+up are ignored.
   */
  surfaceBelow(x: number, y: number, z: number, up = 0.45, down = 3): number | null {
    const fx = this.fx(x), fz = this.fz(z);
    let j = Math.floor(this.fy(y + up));
    const jEnd = Math.floor(this.fy(y - down)) - 1;
    if (j >= this.ny) j = this.ny - 1;
    let above = this.colDensity(fx, fz, j + 1);
    if (above > ISO) {
      // we start inside snow: still find the top of this solid run (limited to the scan window)
    }
    for (; j >= jEnd; j--) {
      const d = j < 0 ? 255 : this.colDensity(fx, fz, j);
      if (d > ISO && above <= ISO) {
        // crossing between j and j+1
        const t = (d - ISO) / Math.max(1e-3, d - above);
        return (j + t) * this.cell;
      }
      above = d;
    }
    return null;
  }

  /** Outward surface normal (points from snow into air). */
  normalAt(x: number, y: number, z: number, out: { x: number; y: number; z: number }) {
    const e = this.cell * 0.75;
    const gx = this.sample(x + e, y, z) - this.sample(x - e, y, z);
    const gy = this.sample(x, y + e, z) - this.sample(x, y - e, z);
    const gz = this.sample(x, y, z + e) - this.sample(x, y, z - e);
    const len = Math.hypot(gx, gy, gz) || 1;
    out.x = -gx / len; out.y = -gy / len; out.z = -gz / len;
    if (len < 1e-3) { out.x = 0; out.y = 1; out.z = 0; }
    return out;
  }

  /** March a ray into the snow. Returns the first hit with the snow surface. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, step = 0.2): RayHit | null {
    let prevT = 0;
    let prevSolid = this.sample(ox, oy, oz) > ISO;
    if (prevSolid) return { t: 0, x: ox, y: oy, z: oz };
    for (let t = step; t <= maxDist + step; t += step) {
      const tt = Math.min(t, maxDist);
      const x = ox + dx * tt, y = oy + dy * tt, z = oz + dz * tt;
      if (y < -1) return { t: tt, x, y: 0, z };
      if (this.sample(x, y, z) > ISO) {
        // refine
        let a = prevT, b = tt;
        for (let n = 0; n < 6; n++) {
          const m = (a + b) * 0.5;
          if (this.sample(ox + dx * m, oy + dy * m, oz + dz * m) > ISO) b = m; else a = m;
        }
        return { t: b, x: ox + dx * b, y: oy + dy * b, z: oz + dz * b };
      }
      prevT = tt;
      if (tt >= maxDist) break;
    }
    return null;
  }

  private markDirty(i0: number, j0: number, k0: number, i1: number, j1: number, k1: number) {
    if (this.onDirty) this.onDirty(i0, j0, k0, i1, j1, k1);
  }

  /** Scan up from a point inside the snow to the top of that solid run (the first air above it). */
  topAbove(x: number, y: number, z: number, maxUp = 5): number {
    const fx = this.fx(x), fz = this.fz(z);
    let j = Math.floor(this.fy(y));
    const jEnd = Math.min(this.ny - 1, Math.ceil(this.fy(y + maxUp)));
    let below = j < 0 ? 255 : this.colDensity(fx, fz, j);
    if (below <= ISO) return y;
    for (j = j + 1; j <= jEnd; j++) {
      const d = this.colDensity(fx, fz, j);
      if (d <= ISO) return (j - 1 + (below - ISO) / Math.max(1e-3, below - d)) * this.cell;
      below = d;
    }
    return y + maxUp;
  }

  // ───────────────────────── stability: snow with nothing under it falls ─────────────────────────
  private static readonly TILE = 8;
  private static readonly SPAN = 2; // how many cells an overhang can reach from snow that stands on the ground
  /** 8x8-column tiles where snow was removed, so something above may have lost its support */
  readonly unstable = new Set<number>();
  private gScratch = new Int16Array((SnowField.TILE + 2 * SnowField.SPAN) ** 2);

  private markUnstable(i0: number, k0: number, i1: number, k1: number) {
    const T = SnowField.TILE, tx = Math.ceil(this.nx / T);
    const a0 = Math.max(0, Math.floor((i0 - 2) / T)), a1 = Math.min(tx - 1, Math.floor((i1 + 2) / T));
    const b0 = Math.max(0, Math.floor((k0 - 2) / T)), b1 = Math.min(Math.ceil(this.nz / T) - 1, Math.floor((k1 + 2) / T));
    for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) this.unstable.add(b * tx + a);
  }

  /** index of the first non-solid voxel above the ground in a column (everything below it stands on the ground) */
  private groundedTop(i: number, k: number): number {
    if (i < 0 || k < 0 || i >= this.nx || k >= this.nz) return 0;
    const col = k * this.nx + i, base = col * this.ny;
    let j = Math.max(0, Math.ceil(this.bedrock[col] / this.cell) - 1);
    while (j < this.ny && this.density[base + j] > ISO) j++;
    return j;
  }

  /**
   * Check a few unstable tiles: any snow hanging in the air further than SPAN cells from grounded snow drops straight down.
   * Calls onFall once per tile that had a collapse (centre of the fallen snow, how far it fell, and how much).
   */
  settle(maxTiles: number, onFall: (x: number, y: number, z: number, drop: number, mass: number) => void) {
    if (this.unstable.size === 0) return;
    const T = SnowField.TILE, S = SnowField.SPAN, W = T + 2 * S, tx = Math.ceil(this.nx / T);
    const G = this.gScratch;
    let done = 0;
    for (const tile of this.unstable) {
      this.unstable.delete(tile);
      const i0 = (tile % tx) * T, k0 = Math.floor(tile / tx) * T;
      for (let b = 0; b < W; b++) for (let a = 0; a < W; a++) G[b * W + a] = this.groundedTop(i0 - S + a, k0 - S + b);
      let fell = 0, sx = 0, sy = 0, sz = 0, sdrop = 0, jMin = this.ny, jMax = 0;
      for (let b = S; b < S + T; b++) for (let a = S; a < S + T; a++) {
        const i = i0 - S + a, k = k0 - S + b;
        if (i >= this.nx || k >= this.nz) continue;
        const base = (k * this.nx + i) * this.ny;
        let g = G[b * W + a];
        for (let j = g + 1; j < this.ny; j++) {
          if (this.density[base + j] <= ISO) continue;
          // a solid run starting at j with air under it
          let top = j; while (top < this.ny && this.density[base + top] > ISO) top++;
          let ok = false;
          for (let db = -S; db <= S && !ok; db++) for (let da = -S; da <= S; da++) {
            if (da * da + db * db > S * S) continue;
            if (G[(b + db) * W + a + da] > j) { ok = true; break; }
          }
          if (ok) { j = top; continue; }
          // unsupported: gather everything from the grounded top up to the run's top and drop it
          const end = Math.min(this.ny - 1, top);
          let mass = 0, runMass = 0;
          for (let q = g; q <= end; q++) { const d = this.density[base + q]; mass += d; if (q >= j) runMass += d; this.density[base + q] = 0; this.hard[base + q] = 0; }
          let q = g, left = mass;
          while (left > 0 && q < this.ny) { const put = Math.min(255, left); this.density[base + q] = put; left -= put; q++; }
          if (g < jMin) jMin = g; if (end > jMax) jMax = end;
          fell += runMass; sx += this.wx(i) * runMass; sy += j * this.cell * runMass; sz += this.wz(k) * runMass; sdrop += (j - g) * this.cell * runMass;
          while (g < this.ny && this.density[base + g] > ISO) g++;
          G[b * W + a] = g;
          j = Math.max(g, j);
        }
      }
      if (fell > 0) {
        this.markDirty(i0, Math.max(0, jMin - 1), k0, i0 + T - 1, jMax, k0 + T - 1);
        onFall(sx / fell, sy / fell, sz / fell, sdrop / fell, fell);
      }
      if (++done >= maxTiles) break;
    }
  }

  private canRemove(i: number, j: number, k: number) {
    return j * this.cell >= this.bedrock[k * this.nx + i] - 1e-4;
  }

  // ───────────────────────── edit operations ─────────────────────────
  // All ops move "mass" measured in density units (255 = one full voxel). They return how much they actually moved.

  /** Add up to `mass` snow inside a sphere, filling the air side first (snow sticks to whatever is there). */
  addMass(x: number, y: number, z: number, r: number, mass: number, hardAdd = 0): number {
    if (mass <= 0) return 0;
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((x - r - this.x0) / c)), i1 = Math.min(this.nx - 1, Math.ceil((x + r - this.x0) / c));
    const j0 = Math.max(0, Math.floor((y - r) / c)), j1 = Math.min(this.ny - 2, Math.ceil((y + r) / c));
    const k0 = Math.max(0, Math.floor((z - r - this.z0) / c)), k1 = Math.min(this.nz - 1, Math.ceil((z + r - this.z0) / c));
    let n = 0, sumW = 0;
    const r2 = r * r;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const dx = this.x0 + i * c - x, dz = this.z0 + k * c - z;
      for (let j = j0; j <= j1; j++) {
        const dy = j * c - y;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const id = (k * this.nx + i) * this.ny + j;
        const cap = 255 - this.density[id];
        if (cap <= 0) continue;
        const fall = 1 - d2 / r2;
        // fill near-solid voxels first so snow grows from surfaces instead of floating
        const support = this.get(i, j - 1, k) > ISO || this.get(i + 1, j, k) > ISO || this.get(i - 1, j, k) > ISO ||
          this.get(i, j, k + 1) > ISO || this.get(i, j, k - 1) > ISO || this.density[id] > 20 ? 1 : 0.15;
        const w = fall * fall * support * (cap / 255);
        if (n >= this.scratchIdx.length) break;
        this.scratchIdx[n] = id; this.scratchW[n] = w; n++; sumW += w;
      }
    }
    if (n === 0 || sumW <= 0) return 0;
    let added = 0;
    for (let p = 0; p < n; p++) {
      const id = this.scratchIdx[p];
      const want = mass * this.scratchW[p] / sumW;
      const cur = this.density[id];
      const nv = Math.min(255, cur + want);
      const add = Math.floor(nv) - cur;
      if (add > 0) {
        this.density[id] = cur + add;
        added += add;
      }
      if (hardAdd > 0) this.hard[id] = Math.min(255, Math.max(this.hard[id], 0) + hardAdd * this.scratchW[p] / (this.scratchW[p] + 0.2));
    }
    this.markDirty(i0, j0, k0, i1, j1, k1);
    return added;
  }

  /** Remove up to `mass` snow inside a sphere (never below bedrock). Packed snow resists by `hardResist` (0..1). */
  removeMass(x: number, y: number, z: number, r: number, mass: number, hardResist = 0, depthLimit = Infinity): number {
    if (mass <= 0) return 0;
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((x - r - this.x0) / c)), i1 = Math.min(this.nx - 1, Math.ceil((x + r - this.x0) / c));
    const j0 = Math.max(0, Math.floor((y - r) / c)), j1 = Math.min(this.ny - 1, Math.ceil((y + r) / c));
    const k0 = Math.max(0, Math.floor((z - r - this.z0) / c)), k1 = Math.min(this.nz - 1, Math.ceil((z + r - this.z0) / c));
    let n = 0, sumW = 0;
    const r2 = r * r;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const dx = this.x0 + i * c - x, dz = this.z0 + k * c - z;
      const col = k * this.nx + i;
      // depthLimit: only scoop this far below the original ground (keeps dents shallow)
      const bed = Math.max(this.bedrock[col], this.baseHeight[col] - depthLimit);
      for (let j = j0; j <= j1; j++) {
        if (j * c < bed) continue;
        const dy = j * c - y;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const id = (k * this.nx + i) * this.ny + j;
        const cur = this.density[id];
        if (cur <= 0) continue;
        const fall = 1 - d2 / r2;
        // surface voxels go first (dig from the outside in)
        const exposed = this.get(i, j + 1, k) <= ISO || this.get(i + 1, j, k) <= ISO || this.get(i - 1, j, k) <= ISO ||
          this.get(i, j, k + 1) <= ISO || this.get(i, j, k - 1) <= ISO || this.get(i, j - 1, k) <= ISO || cur < 250 ? 1 : 0.25;
        const res = 1 - hardResist * (this.hard[id] / 255);
        const w = fall * exposed * res * (cur / 255);
        if (n >= this.scratchIdx.length) break;
        this.scratchIdx[n] = id; this.scratchW[n] = w; n++; sumW += w;
      }
    }
    if (n === 0 || sumW <= 0) return 0;
    let removed = 0;
    for (let p = 0; p < n; p++) {
      const id = this.scratchIdx[p];
      const want = mass * this.scratchW[p] / sumW;
      const cur = this.density[id];
      const take = Math.min(cur, Math.ceil(want));
      if (take > 0) {
        this.density[id] = cur - take;
        removed += take;
        if (this.density[id] < 30) this.hard[id] = 0;
      }
    }
    this.markDirty(i0, j0, k0, i1, j1, k1);
    if (removed > 0) this.markUnstable(i0, k0, i1, k1);
    return removed;
  }

  /** Pat snow down: packs it harder and sharpens the surface a little. */
  pack(x: number, y: number, z: number, r: number, amount: number) {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((x - r - this.x0) / c)), i1 = Math.min(this.nx - 1, Math.ceil((x + r - this.x0) / c));
    const j0 = Math.max(0, Math.floor((y - r) / c)), j1 = Math.min(this.ny - 1, Math.ceil((y + r) / c));
    const k0 = Math.max(0, Math.floor((z - r - this.z0) / c)), k1 = Math.min(this.nz - 1, Math.ceil((z + r - this.z0) / c));
    const r2 = r * r;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const dx = this.x0 + i * c - x, dz = this.z0 + k * c - z;
      for (let j = j0; j <= j1; j++) {
        const dy = j * c - y;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const id = (k * this.nx + i) * this.ny + j;
        if (this.density[id] > 60) this.hard[id] = Math.min(255, this.hard[id] + amount * (1 - d2 / r2));
      }
    }
    this.markDirty(i0, j0, k0, i1, j1, k1);
  }

  /**
   * A snowplow with its blade down. Everything in the box ahead of it, and a skim off the ground underneath, is
   * heaped up just in front of the blade and so gets carried along as it drives: the heap grows until it stands
   * `heapTop` above the ground, and what it can't hold after that rolls off the ends of the blade into a bank each
   * side. Stop, and the heap is a wall. Returns the snow moved; `out` gets its centre, for the particles.
   */
  shove(px: number, pz: number, fx: number, fz: number, halfW: number, near: number, far: number, top: number,
    skim: number, heapTop: number, rate: number, out: { mass: number; cx: number; cy: number; cz: number }): number {
    out.mass = 0; out.cx = px + fx * far; out.cy = top; out.cz = pz + fz * far;
    const c = this.cell;
    const rx = -fz, rz = fx;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const f of [near, far]) for (const u of [-halfW, halfW]) {
      const x = px + fx * f + rx * u, z = pz + fz * f + rz * u;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const i0 = Math.max(0, Math.floor((minX - this.x0) / c)), i1 = Math.min(this.nx - 1, Math.ceil((maxX - this.x0) / c));
    const k0 = Math.max(0, Math.floor((minZ - this.z0) / c)), k1 = Math.min(this.nz - 1, Math.ceil((maxZ - this.z0) / c));
    const j1 = Math.min(this.ny - 1, Math.ceil(top / c));
    let mass = 0, sx = 0, sy = 0, sz = 0, jMin = this.ny, lowest = Infinity;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const wx = this.x0 + i * c - px, wz = this.z0 + k * c - pz;
      const f = wx * fx + wz * fz, u = wx * rx + wz * rz;
      if (f < near || f > far || Math.abs(u) > halfW) continue;
      const col = k * this.nx + i;
      const base = this.baseHeight[col];
      if (base < lowest) lowest = base;
      // the blade bites a little way into the ground, which is where the snow for the wall comes from
      const jStart = Math.max(0, Math.ceil(Math.max(this.bedrock[col], base - skim) / c));
      if (jStart < jMin) jMin = jStart;
      for (let j = jStart; j <= j1; j++) {
        const id = col * this.ny + j;
        const cur = this.density[id];
        if (cur === 0) continue;
        const res = 1 - 0.6 * (this.hard[id] / 255);
        const take = Math.min(cur, Math.ceil(cur * rate * res));
        this.density[id] = cur - take;
        if (this.density[id] < 30) this.hard[id] = 0;
        mass += take; sx += (this.x0 + i * c) * take; sy += j * c * take; sz += (this.z0 + k * c) * take;
      }
    }
    if (mass <= 0) return 0;
    out.mass = mass; out.cx = sx / mass; out.cy = sy / mass; out.cz = sz / mass;
    this.markDirty(i0, Math.max(0, jMin - 1), k0, i1, j1, k1);
    this.markUnstable(i0, k0, i1, k1);
    // the heap, right across the front of the blade
    let left = mass;
    const ahead = far + 1.15, n = 4;
    for (let q = 0; q < n; q++) {
      const u = ((q + 0.5) / n * 2 - 1) * (halfW - 0.25);
      left -= this.pourColumns(px + fx * ahead + rx * u, pz + fz * ahead + rz * u, 1.35, mass / n, lowest - skim, lowest + heapTop);
    }
    // full: the rest rolls off the ends
    if (left > 1) {
      const side = halfW + 0.9, each = left * 0.5;
      for (const sgn of [-1, 1]) left -= this.pourColumns(px + fx * (far - 0.2) + rx * side * sgn, pz + fz * (far - 0.2) + rz * side * sgn, 0.9, each, lowest - skim, lowest + heapTop * 0.6);
    }
    return mass;
  }

  /**
   * Pour `mass` snow onto the ground in a disc, stacking from the surface upward like sand.
   * Columns taller than `maxTop` spill to their neighbours. Returns mass placed.
   */
  pourColumns(x: number, z: number, r: number, mass: number, baseY: number, maxTop: number): number {
    if (mass <= 0) return 0;
    const c = this.cell;
    const i0 = Math.max(1, Math.floor((x - r - this.x0) / c)), i1 = Math.min(this.nx - 2, Math.ceil((x + r - this.x0) / c));
    const k0 = Math.max(1, Math.floor((z - r - this.z0) / c)), k1 = Math.min(this.nz - 2, Math.ceil((z + r - this.z0) / c));
    const cols: number[] = [];
    const ws: number[] = [];
    let sumW = 0;
    const r2 = r * r;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const dx = this.x0 + i * c - x, dz = this.z0 + k * c - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const w = 1 - d2 / r2;
      cols.push(i, k); ws.push(w); sumW += w;
    }
    if (!cols.length) return 0;
    let placed = 0;
    const jBase = Math.max(0, Math.floor(this.fy(baseY - 0.6)));
    const jTop = Math.min(this.ny - 2, Math.floor(this.fy(maxTop)));
    let minJ = this.ny, maxJ = 0;
    for (let p = 0; p < ws.length; p++) {
      const i = cols[p * 2], k = cols[p * 2 + 1];
      let left = mass * ws[p] / sumW;
      // start from the first non-full voxel at/after the column's surface near baseY
      let j = jBase;
      while (j <= jTop && this.density[(k * this.nx + i) * this.ny + j] >= 250) j++;
      for (; j <= jTop && left > 0.5; j++) {
        const id = (k * this.nx + i) * this.ny + j;
        const cur = this.density[id];
        const add = Math.min(255 - cur, Math.ceil(left));
        if (add > 0) {
          this.density[id] = cur + add;
          left -= add; placed += add;
          if (j < minJ) minJ = j;
          if (j > maxJ) maxJ = j;
        }
      }
    }
    if (placed > 0) this.markDirty(i0, minJ, k0, i1, maxJ, k1);
    return placed;
  }

  /**
   * The bulldozer: scrape snow from the box in front of a pusher and shove it further ahead.
   * Snow higher than the pusher can reach spills to the sides, making berms.
   * Returns how much snow moved, plus the centre of the scraped snow for particle effects.
   */
  plow(px: number, py: number, pz: number, fx: number, fz: number, width: number, depth: number,
    reachUp: number, rate: number, out: { mass: number; cx: number; cy: number; cz: number }): number {
    out.mass = 0; out.cx = px; out.cy = py; out.cz = pz;
    if (rate <= 0) return 0;
    const c = this.cell;
    const rx = -fz, rz = fx; // right vector
    const near = 0.32, far = near + depth;
    const halfW = width * 0.5;
    // AABB of scrape box
    const corners = [
      [px + fx * near + rx * halfW, pz + fz * near + rz * halfW],
      [px + fx * near - rx * halfW, pz + fz * near - rz * halfW],
      [px + fx * far + rx * halfW, pz + fz * far + rz * halfW],
      [px + fx * far - rx * halfW, pz + fz * far - rz * halfW],
    ];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of corners) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    const i0 = Math.max(0, Math.floor((minX - this.x0) / c)), i1 = Math.min(this.nx - 1, Math.ceil((maxX - this.x0) / c));
    const k0 = Math.max(0, Math.floor((minZ - this.z0) / c)), k1 = Math.min(this.nz - 1, Math.ceil((maxZ - this.z0) / c));
    const yTop = py + reachUp;
    const j1 = Math.min(this.ny - 1, Math.ceil(yTop / c));
    let mass = 0, sx = 0, sy = 0, sz = 0;
    const taken: number[] = [];
    let jMin = this.ny;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const wx = this.x0 + i * c - px, wz = this.z0 + k * c - pz;
      const f = wx * fx + wz * fz;
      const u = wx * rx + wz * rz;
      if (f < near || f > far || Math.abs(u) > halfW) continue;
      const col = k * this.nx + i;
      // scrape floor: a little below the original ground, or a bit below the pusher's feet when on top of a pile
      const floorY = Math.max(this.bedrock[col], Math.max(py - 0.3, this.baseHeight[col] - 0.2));
      const jStart = Math.max(0, Math.ceil(floorY / c));
      if (jStart < jMin) jMin = jStart;
      for (let j = jStart; j <= j1; j++) {
        const id = (k * this.nx + i) * this.ny + j;
        const cur = this.density[id];
        if (cur === 0) continue;
        const res = 1 - 0.85 * (this.hard[id] / 255);
        const take = Math.min(cur, Math.ceil(cur * rate * res));
        if (take <= 0) continue;
        this.density[id] = cur - take;
        if (this.density[id] < 30) this.hard[id] = 0;
        taken.push(id, take);
        mass += take; sx += (this.x0 + i * c) * take; sy += j * c * take; sz += (this.z0 + k * c) * take;
      }
    }
    if (mass <= 0) return 0;
    out.cx = sx / mass; out.cy = sy / mass; out.cz = sz / mass;
    // shove it ahead: main pile in front, overflow into side berms
    const ax = px + fx * (far + 0.3), az = pz + fz * (far + 0.3);
    let left = mass;
    left -= this.pourColumns(ax, az, halfW + 0.2, left, py, py + reachUp);
    if (left > 1) {
      const side = halfW + 0.55;
      const l = this.pourColumns(px + fx * far + rx * side, pz + fz * far + rz * side, 0.55, left * 0.5, py, py + reachUp + 0.3);
      const r = this.pourColumns(px + fx * far - rx * side, pz + fz * far - rz * side, 0.55, left * 0.5, py, py + reachUp + 0.3);
      left -= l + r;
    }
    if (left > 1) {
      // nowhere to go: put it back where it came from
      for (let p = 0; p < taken.length && left > 0; p += 2) {
        const id = taken[p];
        const back = Math.min(taken[p + 1], 255 - this.density[id], Math.ceil(left));
        this.density[id] += back; left -= back;
      }
      mass -= Math.max(0, mass - (mass - left));
    }
    this.markDirty(i0, Math.max(0, jMin - 1), k0, i1, j1, k1);
    out.mass = mass;
    return mass;
  }

  /**
   * The snowplow's blade: clear the box `near`..`far` ahead of (px, pz) and `halfW` to each side, from just under the
   * original ground up to `top`, and heap what it cut into a windrow along each side (some of it is lost as spray).
   * Unlike plow() it doesn't dig: it takes built-up snow (walls, mounds, forts) back down to the ground it stood on.
   * Returns how much snow it cut, plus the centre of the cut for the spray.
   */
  bulldoze(px: number, pz: number, fx: number, fz: number, halfW: number, near: number, far: number, top: number,
    rate: number, out: { mass: number; cx: number; cy: number; cz: number }): number {
    out.mass = 0; out.cx = px + fx * far; out.cy = top; out.cz = pz + fz * far;
    const c = this.cell;
    const rx = -fz, rz = fx;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const f of [near, far]) for (const u of [-halfW, halfW]) {
      const x = px + fx * f + rx * u, z = pz + fz * f + rz * u;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const i0 = Math.max(0, Math.floor((minX - this.x0) / c)), i1 = Math.min(this.nx - 1, Math.ceil((maxX - this.x0) / c));
    const k0 = Math.max(0, Math.floor((minZ - this.z0) / c)), k1 = Math.min(this.nz - 1, Math.ceil((maxZ - this.z0) / c));
    const j1 = Math.min(this.ny - 1, Math.ceil(top / c));
    let mass = 0, sx = 0, sy = 0, sz = 0, jMin = this.ny, lowest = Infinity;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const wx = this.x0 + i * c - px, wz = this.z0 + k * c - pz;
      const f = wx * fx + wz * fz, u = wx * rx + wz * rz;
      if (f < near || f > far || Math.abs(u) > halfW) continue;
      const col = k * this.nx + i;
      const base = this.baseHeight[col];
      if (base < lowest) lowest = base;
      // leave the ground as it was: only what stands above it goes
      const jStart = Math.max(0, Math.ceil((Math.max(this.bedrock[col], base) + 0.12) / c));
      if (jStart < jMin) jMin = jStart;
      for (let j = jStart; j <= j1; j++) {
        const id = col * this.ny + j;
        const cur = this.density[id];
        if (cur === 0) continue;
        const res = 1 - 0.6 * (this.hard[id] / 255);
        const take = Math.min(cur, Math.ceil(cur * rate * res));
        this.density[id] = cur - take;
        if (this.density[id] < 30) this.hard[id] = 0;
        mass += take; sx += (this.x0 + i * c) * take; sy += j * c * take; sz += (this.z0 + k * c) * take;
      }
    }
    if (mass <= 0) return 0;
    out.mass = mass; out.cx = sx / mass; out.cy = sy / mass; out.cz = sz / mass;
    this.markDirty(i0, Math.max(0, jMin - 1), k0, i1, j1, k1);
    this.markUnstable(i0, k0, i1, k1);
    // the windrows: most of it rolls off the ends of the blade
    const side = halfW + 1.0, back = near - 0.4;
    for (const s of [-1, 1]) this.pourColumns(px + fx * back + rx * side * s, pz + fz * back + rz * side * s, 1.0, mass * 0.4, lowest, lowest + 1.7);
    return mass;
  }

  // ───────────────────────── snapshots (for late joiners online) ─────────────────────────
  snapshot(): Uint8Array { return this.density.slice(); }
}
