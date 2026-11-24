// Map 1: "Frostbite Bay". Two hilltop bases, a valley with a playground and a frozen pond, the Big Hill,
// Pine Ridge woods with a hidden trail across the north, south woods, and an icy sled run from each base to the pond.
// Shared by client and (later) server, so no Three.js here.

import { SnowField } from './SnowField';
import { buildPlayground, Playground } from './Playground';

export interface V3 { x: number; y: number; z: number; }

export interface TeamBase {
  team: number;
  center: V3;
  stockpile: V3;
  igloo: V3;
  spawns: V3[];
  flag: V3;
  facing: number; // yaw facing the middle
}

/** A pine: trunk radius r, total height h, with the boughs starting cb above the ground and cw wide at their base. */
export interface Tree { x: number; z: number; y: number; h: number; r: number; cb: number; cw: number; }
export interface Rock { x: number; z: number; y: number; r: number; seed: number; }

export interface MapDef {
  name: string;
  field: SnowField;
  bases: TeamBase[];
  bigBallSpawns: V3[];
  flakeSpots: V3[];
  trees: Tree[];
  rocks: Rock[];
  /** centre line of the sled run on the +x side (mirrored for -x); t runs 0 (top) to 1 (pond) */
  creek: { x: number; z: number; t: number }[];
  pond: { x: number; z: number; r: number; y: number };
  playground: Playground;
  boardSpots: { x: number; z: number; name: string }[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  midLineX: number;
}

// ── small deterministic noise ──
function hash2(x: number, y: number) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number) {
  let s = 0, a = 0.5, f = 1;
  for (let o = 0; o < 4; o++) { s += a * (vnoise(x * f, y * f) * 2 - 1); a *= 0.5; f *= 2.03; }
  return s;
}
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_X = 50;
const BASE_Y = 11.5;
const HILL = { x: 0, z: -15, r: 15, h: 8 };
const POND = { x: 0, z: 14, r: 8.5 };
const POND_Y = 3.1;
const FIELD = { nx: 288, ny: 52, nz: 208, cell: 0.5, x0: -72, z0: -52 };
const TRAIL_Z = -40; // the hidden north trail behind Pine Ridge
const RIDGE_Z = -33;
const PASS_X = 27; // gaps in the ridge

// ── the sled run: a frozen creek that runs from each base down a spur to the pond ──
// Defined for x > 0 and mirrored. Sampled into short segments once.
const CREEK_CTRL: [number, number][] = [[45, 8.5], [41, 16], [34, 23.5], [24.5, 27], [15, 24.5], [8.3, 16.4]];
const CREEK: { x: number; z: number; s: number }[] = (() => {
  const pts: { x: number; z: number; s: number }[] = [];
  const P = CREEK_CTRL;
  const at = (i: number) => P[Math.max(0, Math.min(P.length - 1, i))];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let n = 0; n < 10; n++) {
      const t = n / 10, t2 = t * t, t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      pts.push({ x: cr(p0[0], p1[0], p2[0], p3[0]), z: cr(p0[1], p1[1], p2[1], p3[1]), s: 0 });
    }
  }
  pts.push({ x: P[P.length - 1][0], z: P[P.length - 1][1], s: 0 });
  for (let i = 1; i < pts.length; i++) pts[i].s = pts[i - 1].s + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return pts;
})();
const CREEK_LEN = CREEK[CREEK.length - 1].s;
const creekOut = { d: 0, t: 0, tx: 0, tz: 0 };
/** Distance to the creek centre line (mirrored), how far along it we are (0 = top, 1 = pond), and which way is downhill. */
export function creekAt(x: number, z: number) {
  const ax = Math.abs(x);
  creekOut.d = 99; creekOut.t = 0; creekOut.tx = 0; creekOut.tz = 0;
  if (ax < -4 || ax > 58 || z < -4 || z > 40) return creekOut;
  let best = 1e9, bs = 0, bi = 0;
  for (let i = 0; i < CREEK.length - 1; i++) {
    const a = CREEK[i], b = CREEK[i + 1];
    const vx = b.x - a.x, vz = b.z - a.z;
    const l2 = vx * vx + vz * vz;
    let u = ((ax - a.x) * vx + (z - a.z) * vz) / l2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const dx = ax - (a.x + vx * u), dz = z - (a.z + vz * u);
    const d2 = dx * dx + dz * dz;
    if (d2 < best) { best = d2; bs = a.s + (b.s - a.s) * u; bi = i; }
  }
  creekOut.d = Math.sqrt(best); creekOut.t = bs / CREEK_LEN;
  // downhill direction of the run here (mirrored back to the side we're on)
  const a = CREEK[bi], b = CREEK[bi + 1], l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  creekOut.tx = (b.x - a.x) / l * (x < 0 ? -1 : 1); creekOut.tz = (b.z - a.z) / l;
  return creekOut;
}

const bump = (x: number, z: number, cx: number, cz: number, r: number) => {
  const d = Math.hypot(x - cx, z - cz);
  return d < r ? 0.5 + 0.5 * Math.cos(Math.PI * d / r) : 0;
};
const gauss = (v: number, w: number) => Math.exp(-(v * v) / (w * w));

/** Terrain before the sled run is cut into it. */
function rawHeight(ax: number, x: number, z: number): number {
  let h = 4.6 + fbm(ax * 0.035 + 3.1, z * 0.035 + 7.7) * 1.9;
  // rollers and little bumps: something to slide over everywhere
  h += fbm(ax * 0.085 + 11.3, z * 0.085 + 2.9) * 0.9;
  h += fbm(ax * 0.2, z * 0.2) * 0.22;
  // the Knuckles (mid-lane humps), a bowl, and the south woods hills
  h += bump(ax, z, 25, -8, 9.5) * 3.4;
  h -= bump(ax, z, 21, 7, 8) * 1.3;
  h += bump(ax, z, 31, 33, 10.5) * 3.8;
  h += bump(ax, z, 13, 35, 7) * 1.8;
  h += bump(ax, z, 56, -22, 9) * 2.2;
  // Pine Ridge across the north, with two passes through it and a sunken trail behind it
  const ridgeMask = smooth(54, 44, ax) * (1 - 0.92 * gauss(ax - PASS_X, 3.4));
  h += gauss(z - RIDGE_Z, 3.8) * 4.8 * ridgeMask;
  h -= gauss(z - TRAIL_Z, 2.6) * 0.9 * smooth(60, 50, ax);
  // base plateaus with long ramps to slide down
  const db = Math.hypot(ax - BASE_X, z);
  h = h + (BASE_Y - h) * smooth(22, 8, db);
  // the Big Hill
  const dh = Math.hypot(x - HILL.x, (z - HILL.z) * 1.1);
  h += (dh < HILL.r ? 0.5 + 0.5 * Math.cos(Math.PI * dh / HILL.r) : 0) * HILL.h;
  return h;
}

/** Height of the sled run's ice at a point along it. */
let creekTop = NaN;
function creekY(t: number) {
  if (creekTop !== creekTop) creekTop = rawHeight(CREEK[0].x, CREEK[0].x, CREEK[0].z) - 0.35;
  const top = creekTop;
  const e = t * (0.75 + 0.25 * t); // a touch steeper at the bottom
  return top + (POND_Y + 0.02 - top) * e;
}

/** Ground height (before anyone touches the snow). Mirror-symmetric across x = 0 so it's fair. */
export function groundHeight(x: number, z: number): number {
  const ax = Math.abs(x);
  let h = rawHeight(ax, x, z);
  // the sled run rides down a spur from each base, with banked sides
  const c = creekAt(x, z);
  if (c.d < 11) {
    const cy = creekY(c.t);
    h = h + (cy + 0.25 - h) * smooth(11, 4.2, c.d) * 0.92;
    h += gauss(c.d - 3.7, 0.95) * 0.9; // banks to keep sliders in
    h = h + (cy - h) * smooth(3.1, 1.7, c.d);
  }
  // frozen pond depression
  const dp = Math.hypot(x - POND.x, z - POND.z);
  h = h + (POND_Y - h) * smooth(POND.r + 3.5, POND.r - 0.3, dp);
  // arena rim
  const ex = Math.max(0, ax - 62) / 6, ez = Math.max(0, Math.abs(z) - 43.5) / 6;
  h += Math.min(13, (ex * ex + ez * ez) * 5.5 + fbm(x * 0.1, z * 0.1) * Math.min(1, ex + ez) * 2);
  return Math.min(22, h);
}

export function isIceSpot(x: number, z: number) {
  if (Math.hypot(x - POND.x, z - POND.z) < POND.r - 0.2) return true;
  return creekAt(x, z).d < 1.7;
}

export function buildMap(): MapDef {
  const { nx, ny, nz, cell } = FIELD;
  const field = new SnowField(FIELD);

  const H = new Float32Array(nx * nz);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) H[k * nx + i] = groundHeight(field.wx(i), field.wz(k));
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      const x = field.wx(i), z = field.wz(k);
      const h = H[k * nx + i];
      // slope-corrected distance to the surface keeps slopes smooth (no terracing)
      const hx = (H[k * nx + Math.min(nx - 1, i + 1)] - H[k * nx + Math.max(0, i - 1)]) / (2 * cell);
      const hz = (H[Math.min(nz - 1, k + 1) * nx + i] - H[Math.max(0, k - 1) * nx + i]) / (2 * cell);
      const slopeK = 1 / Math.sqrt(1 + hx * hx + hz * hz);
      const col = k * nx + i;
      field.baseHeight[col] = h;
      const ice = isIceSpot(x, z);
      field.bedrock[col] = ice ? h - 0.05 : h - 1.6;
      field.ice[col] = ice ? 1 : 0;
      const base = col * ny;
      for (let j = 0; j < ny; j++) {
        const y = j * cell;
        const d = 128 + ((h - y) * slopeK / cell) * 80;
        field.density[base + j] = d <= 0 ? 0 : d >= 255 ? 255 : Math.round(d);
      }
      if (ice) for (let j = 0; j < ny; j++) field.hard[base + j] = 255;
    }
  }

  const bases: TeamBase[] = [0, 1].map(team => {
    const s = team === 0 ? -1 : 1;
    const cx = s * BASE_X;
    const g = (x: number, z: number): V3 => ({ x, y: groundHeight(x, z), z });
    return {
      team,
      center: g(cx, 0),
      stockpile: g(cx - s * -2.5, 3.2),
      igloo: g(cx + s * 4.5, -1.5),
      flag: g(cx + s * 1.5, -5),
      spawns: [g(cx + s * 2, 2), g(cx + s * 2, -2), g(cx + s * 3.5, 0), g(cx + s * 1, 4.5), g(cx + s * 1, -4.5),
        g(cx + s * 4, 3.5), g(cx + s * 4, -3.5), g(cx, 6), g(cx, -6), g(cx + s * 5, 1)],
      facing: team === 0 ? -Math.PI / 2 : Math.PI / 2,
    };
  });

  const bigBallSpawns: V3[] = [
    { x: -2.2, y: 0, z: HILL.z - 1 }, { x: 2.2, y: 0, z: HILL.z - 1 },
    { x: -BASE_X + 9, y: 0, z: -10 }, { x: BASE_X - 9, y: 0, z: -10 },
    { x: -25, y: 0, z: -8 }, { x: 25, y: 0, z: -8 },
    { x: -31, y: 0, z: 33 }, { x: 31, y: 0, z: 33 },
  ].map(p => ({ ...p, y: groundHeight(p.x, p.z) }));

  const flakeSpots: V3[] = [
    { x: 0, z: HILL.z }, { x: 2.6, z: 2.5 }, { x: -10.5, z: 14 }, { x: 10.5, z: 14 }, { x: 0, z: 26 },
    { x: -16, z: -3 }, { x: 16, z: -3 }, { x: -20, z: 19 }, { x: 20, z: 19 }, { x: -12, z: -27 }, { x: 12, z: -27 },
    { x: 0, z: TRAIL_Z }, { x: -PASS_X, z: RIDGE_Z }, { x: PASS_X, z: RIDGE_Z }, { x: 0, z: 37 }, { x: -22, z: 36 }, { x: 22, z: 36 },
  ].map(p => ({ x: p.x, y: groundHeight(p.x, p.z) + 1.1, z: p.z }));

  // boulders: hard cover that snowballs can't chew through (mirrored)
  const rocks: Rock[] = [];
  for (const [x, z, r] of [[16, -4.5, 1.25], [33, 3, 1.05], [21, 15, 0.95], [38, -15, 1.35], [11, 30, 1.1], [44, -31, 1.3], [8, -25, 1.0], [29, 20.5, 0.9], [52, 27, 1.2]]) {
    for (const s of [-1, 1]) rocks.push({ x: s * x, z, y: groundHeight(s * x, z), r, seed: Math.round(x * 31 + z * 17) });
  }

  // trees: thick woods across the north and south, a belt around the rim, and little copses for cover (mirrored)
  const rand = mulberry32(1337);
  const trees: Tree[] = [];
  const keepOut: [number, number, number][] = [
    [BASE_X, 0, 15], [HILL.x, HILL.z, 6.5], [POND.x, POND.z, POND.r + 2.2],
    ...bigBallSpawns.map(b => [Math.abs(b.x), b.z, 2.8] as [number, number, number]),
    ...flakeSpots.map(f => [Math.abs(f.x), f.z, 2.2] as [number, number, number]),
    ...rocks.map(r => [Math.abs(r.x), r.z, r.r + 1.4] as [number, number, number]),
  ];
  const density = (x: number, z: number) => {
    // x >= 0 here
    for (const [cx, cz, r] of keepOut) if (Math.hypot(x - cx, z - cz) < r) return 0;
    if (x < 13 && z > -9 && z < 9) return 0; // playground
    if (creekAt(x, z).d < 5.2) return 0; // sled run
    if (Math.abs(z - TRAIL_Z) < 2.3 && x < 60) return 0; // north trail
    if (Math.abs(x - PASS_X) < 3.2 && z < -27 && z > TRAIL_Z) return 0; // ridge passes
    if (Math.hypot(x - BASE_X, z) < 24 && Math.abs(z) < 9) return 0; // the main ramp off each base
    const ex = Math.max(0, x - 62) / 6, ez = Math.max(0, Math.abs(z) - 43.5) / 6;
    if (ex + ez > 0.2) return 0.9; // rim belt
    if (z < -28.5) return 0.85; // Pine Ridge woods
    if (z > 28) return 0.62; // south woods
    const n = fbm(x * 0.09 + 40.2, z * 0.09 + 13.7);
    if (x > 9 && n > 0.2) return 0.5; // copses
    return 0.012;
  };
  const cellSize = 2.3;
  const grid = new Map<number, Tree[]>();
  const gkey = (x: number, z: number) => Math.floor(x / cellSize) * 4096 + Math.floor(z / cellSize) + 2048;
  const tooClose = (x: number, z: number, min: number) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const l = grid.get(gkey(x + a * cellSize, z + b * cellSize));
      if (l) for (const t of l) if (Math.hypot(t.x - x, t.z - z) < min) return true;
    }
    return false;
  };
  for (let n = 0; n < 5200; n++) {
    const x = 1.3 + rand() * 69.5, z = (rand() * 2 - 1) * 51;
    const d = density(x, z);
    if (rand() > d) continue;
    const min = d > 0.8 ? 2.05 : 2.3;
    if (tooClose(x, z, min)) continue;
    const big = rand();
    const h = 3.4 + big * big * 5.2 + (d > 0.8 ? 0.8 : 0);
    // tall bare trunks in the thick woods, so you can see (and throw) under the boughs
    const cb = d > 0.55 ? 1.9 + h * 0.2 : 1.0 + h * 0.16;
    const t: Tree = { x, z, y: groundHeight(x, z) - 0.3, h: h + (d > 0.55 ? 1.5 : 0), r: 0.26 + h * 0.022, cb, cw: 0.9 + h * 0.2 };
    trees.push(t, { ...t, x: -x });
    const key = gkey(x, z);
    const l = grid.get(key); if (l) l.push(t); else grid.set(key, [t]);
  }

  const playground = buildPlayground(groundHeight);
  for (const r of rocks) playground.cyls.push({ x: r.x, z: r.z, r: r.r * 0.86, y0: r.y - 1.5, y1: r.y + r.r * 0.95 });
  const boardSpots = [
    { x: 0, z: HILL.z - 2, name: 'on top of the Big Hill' },
    { x: 0, z: POND.z, name: 'out on the frozen pond' },
    { x: 0, z: 36, name: 'in the south woods' },
    { x: -2.5, z: -6.5, name: 'behind the playground' },
    { x: 0, z: TRAIL_Z, name: 'on the Pine Ridge trail' },
  ];

  return {
    name: 'Frostbite Bay',
    field, bases, bigBallSpawns, flakeSpots, trees, rocks, playground, boardSpots,
    pond: { x: POND.x, z: POND.z, r: POND.r, y: POND_Y },
    bounds: { minX: -70.5, maxX: 70.5, minZ: -50.5, maxZ: 50.5 },
    midLineX: 0,
    creek: CREEK.map(p => ({ x: p.x, z: p.z, t: p.s / CREEK_LEN })),
  };
}
