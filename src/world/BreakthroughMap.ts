// Map 3: "Peppermint Pass", built for Breakthrough. A long valley the attackers (Team Blizzard) fight their way up,
// west to east, one section at a time:
//   1. The Flats: open snow, a few mounds, stacks of ice blocks and a tree here and there.
//   2. Crumble Town: broken-down gingerbread houses and giant candy canes round a frozen lake with an iceberg in it.
//   3. The Summit: a steep, deep-snow hill with the defenders' village on top: cabins, gingerbread houses, cargo sleds.
// Between the sections are camps (a spawn line and two stockpile rings). When a section falls the attackers move up
// into the camp the defenders just lost, and the defenders fall back to the next one.
// Shared by client and server, so no Three.js here. NOT mirrored: this map has a front and a back.

import { SnowField } from './SnowField';
import { emptyPlayground } from './Playground';
import { MapDef, V3, Rock, Front, TeamBase, SectorDef, CapturePointDef, fbm, smooth, bump, gauss, fillField, scatterTrees } from './MapDef';
import { House, Prop, PropKind, makeIceberg, makePillar, makeGingerbreadHouse, makeCabin, makeProp, makeRamp, rampSnow, inRampLane, addLandmarkCollision } from './Landmarks';

const FIELD = { nx: 480, ny: 56, nz: 192, cell: 0.5, x0: -120, z0: -48 };
const RIM_X = 111, RIM_Z = 39.5;
/** the camps, west to east: the attackers' base, the two camps in between, and the defenders' last base */
const CAMPS = [-101, -31, 26, 101];
/** where the attackers wait before each section opens */
const LINES = [-88, -22, 36];
const HQ_Y = 8.4;
const LAKE = { x: 0, z: 6, rx: 18, rz: 9, y: 4.2 };
const CAP_R = 7.5;

// the objectives: two in each of the first two sections, and one at the very top
const FLATS_A = { x: -52, z: -17 }, FLATS_B = { x: -49, z: 18 };
const TOWN_A = { x: 1, z: -21 }, TOWN_B = { x: -1, z: 29 };
const TOP = { x: 85, z: 0 };

// houses you can run through: [x, z, turn, kind]
const HOUSES: [number, number, number, 'gingerbread' | 'cabin'][] = [
  [93, -14, 0.25, 'cabin'], [95.5, 12.5, -0.2, 'cabin'], [84, 30, 1.4, 'cabin'],
  [80.5, -25, 0.1, 'gingerbread'], [81, 17.5, -0.3, 'gingerbread'],
  [51.5, -30, 1.45, 'cabin'], // the halfway hut, on the lower bench
];

// everything else that's solid: [kind, x, z, turn]
const PROPS: [PropKind, number, number, number][] = [
  // The Flats: sawn ice blocks, the only hard cover out here
  ['iceBlocks', -58.5, -20.5, 0.3], ['iceBlocks', -55.5, -10.5, 1.4], ['iceBlocks', -47, -23.5, -0.5], ['iceBlocks', -56, 13, 1.2],
  ['iceBlocks', -52.5, 25.5, -0.2], ['iceBlocks', -44, 12.5, 0.6], ['iceBlocks', -67, -7, 1.7], ['iceBlocks', -71, 15, 1.35],
  ['iceBlocks', -62.5, 5.5, 1.9], ['iceBlocks', -76, -29, 0.9], ['iceBlocks', -74, 31, 2.2], ['iceBlocks', -80, -1.5, 1.55],
  ['iceBlocks', -39, -27, 1.1], ['iceBlocks', -38.5, 30, 2.0],
  // Crumble Town: what's left of the gingerbread houses
  ['ruinA', 9.5, -25, -0.35], ['ruinB', -8, -18, 0.2], ['ruinA', -3.5, -33.5, 1.3], ['ruinB', 15.5, -12, 1.75], ['ruinA', -17, -9, -0.2],
  ['ruinB', 7.5, 32, 2.9], ['ruinA', -10, 26.5, 0.5], ['ruinB', -18.5, 19.5, -1.2], ['ruinA', 15.5, 22, 0.15],
  // ... and its candy canes, standing and fallen
  ['cane', -10.5, -27.5, 0.4], ['cane', 5.5, -14.5, 2.1], ['cane', 12.5, -31.5, -0.8], ['cane', -2.5, -12.5, 1.2], ['cane', -14, 23, 0.3],
  ['cane', 9, 25.5, -1.9], ['cane', 21, -1, 2.6], ['cane', -22, 3.5, -0.4], ['cane', 3, 19.5, 1.0], ['cane', -24, -22, 0.2], ['cane', 21.5, 30.5, -2.4],
  ['caneDown', -0.5, -26.5, 0.6], ['caneDown', 13, -19, -1.1], ['caneDown', -5.5, 34, 0.2], ['caneDown', 4.5, 23.5, 2.0],
  ['caneDown', -23.5, -15.5, 1.3], ['caneDown', 22.5, 16, 1.8], ['caneDown', -13, 33.5, -0.6], ['caneDown', 19.5, -24.5, 0.4],
  // The Summit: ice blocks low on the slope, cargo sleds left across the benches and round the village
  ['iceBlocks', 43, -6.5, 1.5], ['iceBlocks', 44, 16.5, 1.8], ['iceBlocks', 42.5, -27, 1.3], ['iceBlocks', 56.5, -12, 1.65], ['iceBlocks', 57, 23, 1.4],
  ['iceBlocks', 67.5, 4, 1.7], ['iceBlocks', 55, 33.5, 1.2],
  ['sled', 49.5, -14, 1.75], ['sled', 50, 6.5, 1.45], ['sled', 49.5, 25, 1.7], ['sled', 62, -24.5, 1.5], ['sled', 62.5, -4.5, 1.68],
  ['sled', 62, 14.5, 1.42], ['sled', 78.5, 9.5, 1.2], ['sled', 79, -10.5, 1.9], ['sled', 89, 22, 0.3], ['sled', 90.5, -24.5, -0.2], ['sled', 96, -1.5, 1.6],
  ['cane', 76.5, -4.5, 0.5], ['cane', 76.5, 4.5, -0.5], ['cane', 99, -7.5, 2.4], ['cane', 99, 7.5, -2.4], ['cane', 87.5, -19.5, 1.1], ['cane', 88, 16, -1.3],
];

// jump ramps: [x, z, the way you fly (0 = east, PI = west)]
const RAMPS: [number, number, number][] = [
  // at the foot of the attackers' bank: slide down it and jump out onto the Flats
  [-80.7, -24, 0], [-80.7, 23, 0],
  // on the two benches of the Summit, for coming back down the hill: each one throws you out over the slope below
  [63.2, 10.5, Math.PI], [50.7, 0, Math.PI],
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const wrap = (a: number) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
const lakeE = (x: number, z: number) => { const ex = (x - LAKE.x) / LAKE.rx, ez = (z - LAKE.z) / LAKE.rz; return ex * ex + ez * ez; };

/** A ring of old snow wall, radius r and `high` metres tall, with gaps in it. `gaps` are [angle, half width] in radians. */
function oldWall(x: number, z: number, cx: number, cz: number, r: number, high: number, gaps: [number, number][]) {
  const d = Math.hypot(x - cx, z - cz);
  if (Math.abs(d - r) > 2.2) return 0;
  const ang = Math.atan2(z - cz, x - cx);
  let m = 1;
  for (const [a, w] of gaps) m *= smooth(w * 0.6, w, Math.abs(wrap(ang - a)));
  return high * gauss(d - r, 0.62) * m;
}

/** The hill is not a straight wall: a gully cuts into it south of the middle and a spur pushes out to the north. */
const hillX = (x: number, z: number) => x - 5.5 * gauss(z - 21, 6.5) + 4 * gauss(z + 25, 7) - 2.2 * gauss(z + 2, 5);
/** How far up the Summit you are: 0 at the foot, 11.6 m on top, with two benches on the way. */
const climb = (hx: number) => 4.2 * smooth(37, 47, hx) + 3.4 * smooth(52, 60, hx) + 4.0 * smooth(64, 73, hx);

/** The lie of the land before anything is levelled for a building. */
function rawGround(x: number, z: number): number {
  const hx = hillX(x, z);
  const up = smooth(37, 73, hx);
  // rolling snow, calmer on the hill so the benches stay benches
  let h = 5.2 + (fbm(x * 0.03 + 5.3, z * 0.03 + 1.9) * 1.3 + fbm(x * 0.09 + 3.7, z * 0.09 + 6.1) * 0.55) * (1 - 0.6 * up) + fbm(x * 0.21, z * 0.21) * 0.16;
  // The Flats: a few snow mounds, for cover on the way in and to slide off
  h += bump(x, z, -68, 3, 8.5) * 2.7 + bump(x, z, -60, -30, 7) * 2.1 + bump(x, z, -63, 28, 7) * 1.9;
  h += bump(x, z, -41, -1, 7.5) * 2.3 + bump(x, z, -76, -17, 6) * 1.5 + bump(x, z, -36, 21, 6) * 1.3;
  // Crumble Town: low drifts between the houses
  h += bump(x, z, 22, -22, 6.5) * 1.5 + bump(x, z, -20, 30, 6) * 1.3 + bump(x, z, 24, 8, 5.5) * 1.1 + bump(x, z, -12, -2, 4.5) * 0.9;
  // the attackers' bank: a plateau across the whole west end with a long ramp down to slide in on
  h = lerp(h, HQ_Y, smooth(-84, -95, x));
  // level ground under the objectives
  for (const p of [FLATS_A, FLATS_B, TOWN_A, TOWN_B]) h = lerp(h, 5.3, smooth(12, 6.5, Math.hypot(x - p.x, z - p.z)));
  // the frozen lake
  h = lerp(h, LAKE.y, smooth(1.7, 0.92, lakeE(x, z)));
  // The Summit
  h += climb(hx);
  // a wind-packed lip along the top edge, with ways through it
  let lip = gauss(hx - 74.6, 1.15) * 0.95;
  for (const g of [-31, -12, 7, 27]) lip *= 1 - gauss(z - g, 2.3);
  h += lip;
  return h;
}

// level pads for the houses, at whatever height the land has there
let pads: [number, number, number][] | null = null;

let ramps: Prop[] | null = null;
/** The jump ramps (worked out once: the snow round each one is shaped to fit it). */
function passRamps() { return ramps ??= RAMPS.map(([x, z, rot]) => makeRamp(landGround, x, z, rot)); }

export function passGround(x: number, z: number): number { return rampSnow(passRamps(), x, z, landGround(x, z)); }

/** The land without the jump ramps. */
function landGround(x: number, z: number): number {
  let h = rawGround(x, z);
  if (!pads) pads = HOUSES.map(([hx, hz]) => [hx, hz, rawGround(hx, hz)]);
  for (const [px, pz, py] of pads) {
    const d = Math.hypot(x - px, z - pz);
    if (d < 9) h = lerp(h, py, smooth(9, 5.2, d));
  }
  // the old forts: low crescents on the Flats that face the attackers, a full ring round the last objective
  h += oldWall(x, z, FLATS_A.x, FLATS_A.z, 5.4, 0.95, [[0, 1.25], [2.5, 0.28], [-2.5, 0.28]]);
  h += oldWall(x, z, FLATS_B.x, FLATS_B.z, 5.4, 0.95, [[0, 1.25], [2.5, 0.28], [-2.5, 0.28]]);
  h = lerp(h, rawGround(TOP.x, TOP.z), smooth(13, 7, Math.hypot(x - TOP.x, z - TOP.z)));
  h += oldWall(x, z, TOP.x, TOP.z, 5.6, 1.35, [[0, 0.55], [Math.PI, 0.3], [1.9, 0.3], [-1.9, 0.3]]);
  // arena rim
  const ex = Math.max(0, Math.abs(x) - RIM_X) / 6, ez = Math.max(0, Math.abs(z) - RIM_Z) / 6;
  h += Math.min(13, (ex * ex + ez * ez) * 5.5 + fbm(x * 0.1, z * 0.1) * Math.min(1, ex + ez) * 2);
  return Math.min(26.5, h);
}

const passIce = (x: number, z: number) => lakeE(x, z) < 0.9;

/**
 * A camp: a spawn line across the valley with two stockpile rings in front of it. dir = +1 when it faces east.
 * `respawnX`, if given, is a second line further back (x for each z): the team starts at the camp, but whoever goes
 * down comes back there, with a longer way to the fight. `clear` says whether a penguin can stand at a spot.
 */
function camp(cx: number, dir: number, respawnX?: (z: number) => number, clear?: (x: number, z: number) => boolean): Front {
  const g = (x: number, z: number): V3 => ({ x, y: passGround(x, z), z });
  const spawns: V3[] = [];
  for (let n = 0; n < 12; n++) spawns.push(g(cx - dir * (n % 2 ? 5.5 : 3), -33 + n * 6));
  const front: Front = { center: g(cx, 0), spawns, stockpiles: [g(cx, -13), g(cx, 13)], facing: dir > 0 ? -Math.PI / 2 : Math.PI / 2 };
  if (respawnX) {
    front.respawns = [];
    for (let n = 0; n < 12; n++) {
      const z = -33 + n * 6, x = respawnX(z) - dir * (n % 2 ? 2.5 : 0);
      // step aside (further back first) if something solid stands there
      const tries: [number, number][] = [[0, 0], [-dir * 2, 0], [0, 1.8], [0, -1.8], [-dir * 2, 1.8], [-dir * 2, -1.8], [-dir * 4, 0], [dir * 2, 0], [0, 3], [0, -3]];
      const ok = tries.find(([dx, dz]) => !clear || clear(x + dx, z + dz));
      if (ok) front.respawns.push(g(x + ok[0], z + ok[1]));
    }
  }
  return front;
}

/**
 * How far back the defenders come back when they go down, section by section: behind the camp they are holding, so
 * losing a penguin costs the defence a long walk (or slide). At the Flats that is the near edge of Crumble Town,
 * at the town it is the first bench of the Summit, and on the Summit it is the back wall of the village.
 */
const DEFENDER_RESPAWN_X: ((z: number) => number)[] = [
  () => -12.5,
  z => 49.6 + 5.5 * gauss(z - 21, 6.5) - 4 * gauss(z + 25, 7) + 2.2 * gauss(z + 2, 5), // follows the bench round the hill
  () => 109.2,
];

export function buildBreakthroughMap(): MapDef {
  const ground = passGround;
  const field = new SnowField(FIELD);
  fillField(field, ground, passIce);
  const at = (x: number, z: number, up = 0): V3 => ({ x, y: ground(x, z) + up, z });

  const houses: House[] = HOUSES.map(([x, z, rot, kind]) => (kind === 'cabin' ? makeCabin : makeGingerbreadHouse)(ground, x, z, rot));
  const props: Prop[] = PROPS.map(([kind, x, z, rot]) => makeProp(ground, kind, x, z, rot));
  const ramps = passRamps();
  props.push(...ramps);
  const rocks: Rock[] = [];
  for (const [x, z, r] of [[-64, -18, 1.2], [-47, -5.5, 1.0], [-58, 20.5, 1.1], [-78, 9, 1.25], [-34, -14, 0.95], [-70, -34, 1.1], [-45, 34, 1.2],
    [-12, -36, 1.0], [23, -31, 1.2], [-26, 10, 1.05], [24.5, 23, 0.95], [5, 36.5, 1.1], [17, -3.5, 0.9],
    [41, 6, 1.2], [46, -21, 1.0], [54, 14, 1.15], [58, -31, 1.25], [66, 29, 1.0], [68, -15, 0.95], [45, 31, 1.1]]) {
    rocks.push({ x, z, y: ground(x, z), r, seed: Math.round(x * 31 + z * 17 + 400) });
  }

  // ice: a small berg frozen into the lake, pillars sticking out of the ice and standing about the town
  const shards = makeIceberg(ground, 3.5, 6, 0.62);
  for (const [x, z, r, h] of [
    [-10, 3.5, 0.95, 4.2], [12, 11, 1.0, 4.6], [-5, 12, 0.85, 3.4], [13.5, 1, 0.9, 3.8], [-13.5, 9.5, 0.8, 3.0],
    [-27, -4, 0.9, 3.6], [-66, 17, 0.9, 3.8], [-50, 2, 1.0, 4.4], [-73, -5, 0.85, 3.4], [29, -9, 0.9, 3.6],
  ]) shards.push(makePillar(ground, x, z, r, h));

  const igloos = [at(-108.5, 0), at(108.5, 0)];
  /** Can a penguin come back here? Not on the lake, in a house, on a ramp or up against anything solid. */
  const clear = (x: number, z: number) => {
    if (lakeE(x, z) < 1.25) return false;
    for (const h of houses) if (Math.hypot(x - h.x, z - h.z) < 6) return false;
    for (const p of props) if (Math.hypot(x - p.x, z - p.z) < (p.kind === 'ruinA' || p.kind === 'ruinB' ? 5.6 : p.kind === 'ramp' ? 4.2 : p.kind === 'cane' ? 1.3 : 2.6)) return false;
    for (const i of igloos) if (Math.hypot(x - i.x, z - i.z) < 3.6) return false;
    for (const r of rocks) if (Math.hypot(x - r.x, z - r.z) < r.r + 1) return false;
    for (const sh of shards) if (Math.hypot(x - sh.x, z - sh.z) < sh.r + 1) return false;
    return true;
  };

  // the two ends: each has an igloo and a flag like any base
  const ends = [camp(CAMPS[0], 1), camp(CAMPS[3], -1, DEFENDER_RESPAWN_X[2], clear)];
  const bases: TeamBase[] = ends.map((f, team) => {
    return { ...f, team, stockpile: f.stockpiles[0], igloo: igloos[team], flag: at((team === 0 ? -1 : 1) * 105.5, -6) };
  });

  const points: CapturePointDef[] = [
    { name: 'A', ...at(FLATS_A.x, FLATS_A.z), r: CAP_R, owner: 1 },
    { name: 'B', ...at(FLATS_B.x, FLATS_B.z), r: CAP_R, owner: 1 },
    { name: 'A', ...at(TOWN_A.x, TOWN_A.z), r: CAP_R, owner: 1 },
    { name: 'B', ...at(TOWN_B.x, TOWN_B.z), r: CAP_R, owner: 1 },
    { name: 'A', ...at(TOP.x, TOP.z), r: 8.5, owner: 1 },
  ];
  const sectors: SectorDef[] = [
    { name: 'The Flats', lineX: LINES[0], points: [0, 1], fronts: [bases[0], camp(CAMPS[1], -1, DEFENDER_RESPAWN_X[0], clear)] },
    { name: 'Crumble Town', lineX: LINES[1], points: [2, 3], fronts: [camp(CAMPS[1], 1), camp(CAMPS[2], -1, DEFENDER_RESPAWN_X[1], clear)] },
    { name: 'The Summit', lineX: LINES[2], points: [4], fronts: [camp(CAMPS[2], 1), bases[1]] },
  ];

  // giant snowballs: on the mounds of the Flats, in the town, and a row along the top of the hill to roll down it
  const bigBallSpawns: V3[] = [[-68, 3], [-41, -1], [-25, -31], [20, 31], [72.5, -19], [72, 1.5], [73.5, 23], [61.5, 31]].map(([x, z]) => at(x, z));

  const flakeSpots: V3[] = [
    [-62, -11], [-55, 3], [-45, -31], [-58, 33], [-40, 20.5], [-72, 21], [-80, -24],
    [-8, 9], [1, -21], [-12.5, -31], [14, 31], [20.5, -21], [-21, 27], [10, 4],
    [48, -4], [50.5, 30], [61, -14], [62.5, 27], [77, 0], [90, -27.5], [88.5, 27], [57, 5],
  ].map(([x, z]) => at(x, z, 1.1));

  // trees: hardly any on the Flats, stands of pines round the town, a few on the hill and a thick belt round the rim
  const keepOut: [number, number, number][] = [
    ...points.map(p => [p.x, p.z, p.r + 2.5] as [number, number, number]),
    ...houses.map(h => [h.x, h.z, 7] as [number, number, number]),
    ...props.map(p => [p.x, p.z, p.kind === 'ruinA' || p.kind === 'ruinB' ? 6.5 : p.kind === 'cane' ? 1.6 : 3.2] as [number, number, number]),
    ...bigBallSpawns.map(b => [b.x, b.z, 2.8] as [number, number, number]),
    ...flakeSpots.map(f => [f.x, f.z, 2.2] as [number, number, number]),
    ...rocks.map(r => [r.x, r.z, r.r + 1.4] as [number, number, number]),
    ...shards.map(sh => [sh.x, sh.z, sh.r + 1.6] as [number, number, number]),
  ];
  const density = (x: number, z: number) => {
    for (const [cx, cz, r] of keepOut) if (Math.hypot(x - cx, z - cz) < r) return 0;
    if (lakeE(x, z) < 1.45) return 0;
    const ex = Math.max(0, Math.abs(x) - RIM_X) / 6, ez = Math.max(0, Math.abs(z) - RIM_Z) / 6;
    if (ex + ez > 0.2) return 0.9; // rim belt
    for (const c of CAMPS) if (Math.abs(x - c) < 9) return 0; // the camps and their spawn lines
    if (x < -84 || x > 97) return 0; // both bases
    const n = fbm(x * 0.09 + 17.3, z * 0.09 + 31.1);
    const hx = hillX(x, z);
    if (x < LINES[1]) return n > 0.34 ? 0.06 : 0.004; // the Flats: a copse or two
    if (hx < 37) return n > 0.1 ? 0.085 : Math.abs(z) > 30 ? 0.05 : 0.014; // the town
    if (hx < 75) return Math.abs(z) > 31 ? 0.05 : n > 0.3 ? 0.04 : 0.005; // the slope: open, so it's a hard climb
    return n > 0.22 ? 0.05 : 0.008; // the village on top
  };
  // (trees in the way of a jump ramp or standing where the defenders come back are taken out afterwards, so the rest
  // of the forest is exactly as it was)
  const comeBack = [...sectors.map(sec => sec.fronts[1]), bases[1]].flatMap(f => f.respawns ?? []);
  const trees = scatterTrees(ground, density, 4711, 17500, 119, 47.5, false)
    .filter(t => !inRampLane(ramps, t.x, t.z, t.r) && !comeBack.some(c => Math.hypot(c.x - t.x, c.z - t.z) < t.r + 1.3));

  const playground = emptyPlayground();
  for (const r of rocks) playground.cyls.push({ x: r.x, z: r.z, r: r.r * 0.86, y0: r.y - 1.5, y1: r.y + r.r * 0.95 });
  addLandmarkCollision(playground, shards, houses, props);

  return {
    id: 'pass',
    name: 'Peppermint Pass',
    ground, creekAt: null, points, shards, houses, props, sectors,
    field, bases, bigBallSpawns, flakeSpots, trees, rocks, playground,
    // one surfboard, in whichever section is being fought over
    boardSpots: [
      { x: -58, z: -3, name: 'in the middle of the Flats', sector: 0 },
      { x: -1.5, z: 11, name: 'out on the frozen lake', sector: 1 },
      { x: 63.5, z: -14.5, name: 'half way up the Summit', sector: 2 },
    ],
    pond: null,
    bounds: { minX: -116.5, maxX: 116.5, minZ: -45.5, maxZ: 45.5 },
    midLineX: LINES[0],
    creek: [],
  };
}
