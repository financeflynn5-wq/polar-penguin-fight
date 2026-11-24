// Map 1: "Frostbite Bay". Two hilltop bases, a valley with a frozen pond, and one Big Hill for rolling snowballs.
// Shared by client and (later) server, so no Three.js here.

import { SnowField } from './SnowField';

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

export interface Tree { x: number; z: number; y: number; h: number; r: number; }

export interface MapDef {
  name: string;
  field: SnowField;
  bases: TeamBase[];
  bigBallSpawns: V3[];
  flakeSpots: V3[];
  trees: Tree[];
  pond: { x: number; z: number; r: number; y: number };
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

const BASE_X = 37;
const HILL = { x: 0, z: -15, r: 15, h: 7.5 };
const POND = { x: 0, z: 13, r: 7.5 };
const POND_Y = 3.1;

/** Ground height (before anyone touches the snow). Mirror-symmetric across x = 0 so it's fair. */
export function groundHeight(x: number, z: number): number {
  const ax = Math.abs(x);
  let h = 4.2 + fbm(ax * 0.045 + 3.1, z * 0.045 + 7.7) * 1.4;
  // little rolling bumps
  h += fbm(ax * 0.16, z * 0.16) * 0.25;
  // base plateaus
  const db = Math.hypot(ax - BASE_X, z);
  h = h + (9.2 - h) * smooth(15, 7.5, db);
  // ramps off the plateau toward the middle are softer on the flanks
  // the Big Hill
  const dh = Math.hypot(x - HILL.x, (z - HILL.z) * 1.1);
  const hill = dh < HILL.r ? 0.5 + 0.5 * Math.cos(Math.PI * dh / HILL.r) : 0;
  h += hill * HILL.h;
  // frozen pond depression
  const dp = Math.hypot(x - POND.x, z - POND.z);
  h = h + (POND_Y - h) * smooth(POND.r + 3, POND.r - 0.3, dp);
  // arena rim
  const ex = Math.max(0, ax - 41) / 5, ez = Math.max(0, Math.abs(z) - 25) / 5;
  h += Math.min(11, (ex * ex + ez * ez) * 5.5 + fbm(x * 0.1, z * 0.1) * Math.min(1, ex + ez) * 2);
  return Math.min(19, h);
}

export function buildMap(): MapDef {
  const cell = 0.5;
  const nx = 192, nz = 128, ny = 48;
  const field = new SnowField({ nx, ny, nz, cell, x0: -48, z0: -32 });

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
      const dp = Math.hypot(x - POND.x, z - POND.z);
      field.bedrock[col] = dp < POND.r - 0.2 ? h - 0.05 : h - 1.6;
      const base = col * ny;
      for (let j = 0; j < ny; j++) {
        const y = j * cell;
        const d = 128 + ((h - y) * slopeK / cell) * 80;
        field.density[base + j] = d <= 0 ? 0 : d >= 255 ? 255 : Math.round(d);
      }
      if (dp < POND.r - 0.2) {
        for (let j = 0; j < ny; j++) field.hard[base + j] = 255;
      }
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
    { x: -BASE_X + 8, y: 0, z: -9 }, { x: BASE_X - 8, y: 0, z: -9 },
    { x: -BASE_X + 8, y: 0, z: 9 }, { x: BASE_X - 8, y: 0, z: 9 },
  ].map(p => ({ ...p, y: groundHeight(p.x, p.z) }));

  const flakeSpots: V3[] = [
    { x: 0, z: HILL.z }, { x: 0, z: 2 }, { x: -9, z: 13 }, { x: 9, z: 13 }, { x: 0, z: 22 },
    { x: -14, z: -4 }, { x: 14, z: -4 }, { x: -18, z: 18 }, { x: 18, z: 18 }, { x: -12, z: -24 }, { x: 12, z: -24 },
  ].map(p => ({ x: p.x, y: groundHeight(p.x, p.z) + 1.1, z: p.z }));

  // trees: mostly on the rim, a few clusters for cover (mirrored)
  const rand = mulberry32(1337);
  const trees: Tree[] = [];
  const tryTree = (x: number, z: number, h: number) => {
    for (const t of trees) if (Math.hypot(t.x - x, t.z - z) < 2.2) return;
    if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 1.5) return;
    if (Math.hypot(Math.abs(x) - BASE_X, z) < 10) return;
    if (Math.hypot(x - HILL.x, z - HILL.z) < 6) return;
    trees.push({ x, z, y: groundHeight(x, z) - 0.3, h, r: 0.32 });
  };
  for (let n = 0; n < 70; n++) {
    // rim belt
    const side = rand();
    let x: number, z: number;
    if (side < 0.5) { x = (rand() * 2 - 1) * 44; z = (rand() < 0.5 ? -1 : 1) * (25 + rand() * 5); }
    else { x = (rand() < 0.5 ? -1 : 1) * (40 + rand() * 6); z = (rand() * 2 - 1) * 29; }
    const h = 3.5 + rand() * 3;
    tryTree(x, z, h); tryTree(-x, z, h);
  }
  const clusters = [[-20, 8], [-24, -14], [-11, 24]];
  for (const [cx, cz] of clusters) {
    for (let n = 0; n < 4; n++) {
      const x = cx + (rand() * 2 - 1) * 3, z = cz + (rand() * 2 - 1) * 3, h = 3 + rand() * 2.5;
      tryTree(x, z, h); tryTree(-x, z, h);
    }
  }

  return {
    name: 'Frostbite Bay',
    field, bases, bigBallSpawns, flakeSpots, trees,
    pond: { x: POND.x, z: POND.z, r: POND.r, y: POND_Y },
    bounds: { minX: -46.5, maxX: 46.5, minZ: -30.5, maxZ: 30.5 },
    midLineX: 0,
  };
}
