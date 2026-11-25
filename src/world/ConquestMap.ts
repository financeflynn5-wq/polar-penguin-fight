// Map 2: "Glacier Gap", built for Conquest. Open, deep snow to build forts in, and three flags:
// A and C sit on a knoll in front of each base (yours to fortify), B is out in the south between the teams.
// Lookout Hill in the middle splits the map into a north way (straight between A and C, through the ice shards)
// and a south way (past B, with Slip Lake behind it for a fast flank).
// Shared by client and server, so no Three.js here. Mirror-symmetric across x = 0 so it's fair.

import { SnowField } from './SnowField';
import { emptyPlayground } from './Playground';
import { MapDef, V3, Rock, CapturePointDef, fbm, smooth, bump, gauss, fillField, makeBases, scatterTrees } from './MapDef';
import { Prop, makeIceberg, makePillar, makeRamp, rampSnow, inRampLane, addLandmarkCollision } from './Landmarks';

const FIELD = { nx: 288, ny: 52, nz: 208, cell: 0.5, x0: -72, z0: -52 };
const BASE_X = 55;
const BASE_Y = 10.2;
const HILL = { x: 0, z: -1, r: 12.5, h: 4.4 };
const HOME = { x: 27, z: -17, y: 6.3 }; // flag C (and A, mirrored)
const MID = { x: 0, z: 20, y: 5.5 }; // flag B
const LAKE = { x: 0, z: 39, rx: 22, rz: 6, y: 4.0 };
const SHARDS = { x: 0, z: -19 };
const FORT_R = 5.4; // the ruined snow wall around each flag
const CAP_R = 7;
// jump ramps on the east half (mirrored for the west): [x, z, the way you fly (PI = west)]
const GAP_RAMPS: [number, number, number][] = [
  [32.7, -2, Math.PI], // at the foot of the ramp off each base
  [31.7, 23, Math.PI], // off the hill in the south, toward flag B
];

const wrap = (a: number) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

/** A ring of old snow wall with gaps in it: a head start on your fort. `gaps` are [angle, half width] in radians. */
function fortWall(x: number, z: number, cx: number, cz: number, gaps: [number, number][]) {
  const d = Math.hypot(x - cx, z - cz);
  if (Math.abs(d - FORT_R) > 2.2) return 0;
  const ang = Math.atan2(z - cz, x - cx);
  let m = 1;
  for (const [a, w] of gaps) m *= smooth(w * 0.6, w, Math.abs(wrap(ang - a)));
  return 1.35 * gauss(d - FORT_R, 0.62) * m;
}

function lakeE(x: number, z: number) {
  const ex = (x - LAKE.x) / LAKE.rx, ez = (z - LAKE.z) / LAKE.rz;
  return ex * ex + ez * ez;
}

let gapRampList: Prop[] | null = null;
/** The jump ramps, the same on both sides (worked out once: the snow round each one is shaped to fit it). */
function gapRamps() {
  return gapRampList ??= [...GAP_RAMPS.map(([x, z, rot]) => makeRamp(landGround, x, z, rot)), ...GAP_RAMPS.map(([x, z, rot]) => makeRamp(landGround, -x, z, Math.PI - rot))];
}

export function conquestGround(x: number, z: number): number { return rampSnow(gapRamps(), x, z, landGround(x, z)); }

/** The land without the jump ramps. */
function landGround(x: number, z: number): number {
  const ax = Math.abs(x);
  let h = 4.8 + fbm(ax * 0.03 + 9.1, z * 0.03 + 4.2) * 1.5;
  h += fbm(ax * 0.09 + 1.7, z * 0.09 + 8.8) * 0.6;
  h += fbm(ax * 0.2, z * 0.2) * 0.18;
  // hills to slide down and roll giant snowballs off
  h += bump(ax, z, HILL.x, HILL.z, HILL.r) * HILL.h;
  h += bump(ax, z, 43, 24, 10.5) * 3.1;
  h += bump(ax, z, 41, -37, 9) * 2.4;
  h += bump(ax, z, 14, -38, 8) * 1.6;
  // flat ground under each flag so a fort has something to stand on
  h = h + (HOME.y - h) * smooth(12, 6.5, Math.hypot(ax - HOME.x, z - HOME.z));
  h = h + (MID.y - h) * smooth(12, 6.5, Math.hypot(x - MID.x, z - MID.z));
  // base plateaus with a long ramp to slide down
  h = h + (BASE_Y - h) * smooth(21, 8, Math.hypot(ax - BASE_X, z));
  // Slip Lake across the south
  h = h + (LAKE.y - h) * smooth(1.7, 0.92, lakeE(x, z));
  // the old forts: A and C are open toward their own base, B is open to both sides
  h += fortWall(ax, z, HOME.x, HOME.z, [[0, 0.62], [2.3, 0.3], [-2.3, 0.3]]);
  h += fortWall(ax, z, MID.x, MID.z, [[0, 0.5], [-Math.PI / 2, 0.42], [Math.PI / 2, 0.3]]);
  // arena rim
  const ex = Math.max(0, ax - 62) / 6, ez = Math.max(0, Math.abs(z) - 43.5) / 6;
  h += Math.min(13, (ex * ex + ez * ez) * 5.5 + fbm(x * 0.1, z * 0.1) * Math.min(1, ex + ez) * 2);
  return Math.min(22, h);
}

const conquestIce = (x: number, z: number) => lakeE(x, z) < 0.9;

export function buildConquestMap(): MapDef {
  const ground = conquestGround;
  const field = new SnowField(FIELD);
  fillField(field, ground, conquestIce);
  const bases = makeBases(ground, BASE_X);
  const at = (x: number, z: number, up = 0): V3 => ({ x, y: ground(x, z) + up, z });

  const points: CapturePointDef[] = [
    { name: 'A', ...at(-HOME.x, HOME.z), r: CAP_R, owner: 0 },
    { name: 'B', ...at(MID.x, MID.z), r: CAP_R, owner: -1 },
    { name: 'C', ...at(HOME.x, HOME.z), r: CAP_R, owner: 1 },
  ];

  const bigBallSpawns: V3[] = [[2.4, HILL.z], [43, 24], [41, -37], [BASE_X - 9, -9]]
    .flatMap(([x, z]) => [at(-x, z), at(x, z)]);

  const flakeSpots: V3[] = [
    [0, HILL.z], [0, SHARDS.z + 7.5], [0, 39], [0, 30.5], [0, -41],
    ...[[13, 8], [15, -8], [19, 33], [36, 14], [38, -30], [14, -32], [30, 0], [9, -27]].flatMap(([x, z]) => [[-x, z], [x, z]]),
  ].map(([x, z]) => at(x, z, 1.1));

  const rocks: Rock[] = [];
  for (const [x, z, r] of [[21, 3, 1.2], [38, 5, 1.05], [9.5, 10, 1.0], [29, 27, 1.15], [46, -22, 1.3], [16, -33, 1.1], [35, -27, 0.95], [12.5, 26.5, 0.9], [50, 20, 1.2]]) {
    for (const s of [-1, 1]) rocks.push({ x: s * x, z, y: ground(s * x, z), r, seed: Math.round(x * 29 + z * 13) });
  }

  // the Shards: a small iceberg with pillars round it, right on the straight line between A and C
  const shards = makeIceberg(ground, SHARDS.x, SHARDS.z, 0.8);
  for (const [x, z, r, h] of [
    [8, -14.5, 1.0, 4.4], [6.5, -26, 0.9, 3.8], [13.5, -21, 1.1, 5.2], [16.5, 13, 0.95, 4.0], [40, -6.5, 0.9, 3.6],
    [37, 16, 0.85, 3.4], [21, -34, 1.0, 4.4], [10.5, 31.5, 0.9, 3.6], [24, 30, 1.0, 4.6], [17, -6, 0.85, 3.2],
  ]) for (const s of [-1, 1]) shards.push(makePillar(ground, s * x, z, r, h));

  const props: Prop[] = gapRamps();

  const keepOut: [number, number, number][] = [
    [BASE_X, 0, 16], [HILL.x, HILL.z, 7], [HOME.x, HOME.z, 12.5], [MID.x, MID.z, 12.5],
    ...bigBallSpawns.map(b => [Math.abs(b.x), b.z, 2.8] as [number, number, number]),
    ...flakeSpots.map(f => [Math.abs(f.x), f.z, 2.2] as [number, number, number]),
    ...rocks.map(r => [Math.abs(r.x), r.z, r.r + 1.4] as [number, number, number]),
    ...shards.map(sh => [Math.abs(sh.x), sh.z, sh.r + 1.6] as [number, number, number]),
  ];
  const density = (x: number, z: number) => {
    for (const [cx, cz, r] of keepOut) if (Math.hypot(x - cx, z - cz) < r) return 0;
    if (lakeE(x, z) < 1.5) return 0;
    if (Math.hypot(x - BASE_X, z) < 26 && Math.abs(z) < 9) return 0; // the ramp off each base
    const ex = Math.max(0, x - 62) / 6, ez = Math.max(0, Math.abs(z) - 43.5) / 6;
    if (ex + ez > 0.2) return 0.9; // rim belt
    const n = fbm(x * 0.08 + 21.4, z * 0.08 + 5.3);
    if (n > 0.28) return 0.07; // small stands of pines
    return 0.006;
  };
  const trees = scatterTrees(ground, density, 2024, 5200).filter(t => !inRampLane(props, t.x, t.z, t.r));

  const playground = emptyPlayground();
  for (const r of rocks) playground.cyls.push({ x: r.x, z: r.z, r: r.r * 0.86, y0: r.y - 1.5, y1: r.y + r.r * 0.95 });
  addLandmarkCollision(playground, shards, [], props);

  return {
    id: 'gap',
    name: 'Glacier Gap',
    ground, creekAt: null, points, shards, houses: [], props, sectors: [],
    field, bases, bigBallSpawns, flakeSpots, trees, rocks, playground,
    boardSpots: [
      { x: 0, z: 39, name: 'out on Slip Lake' },
      { x: 0, z: HILL.z, name: 'on top of Lookout Hill' },
      { x: 0, z: SHARDS.z + 7.5, name: 'by the Shards' },
    ],
    pond: null,
    bounds: { minX: -70.5, maxX: 70.5, minZ: -50.5, maxZ: 50.5 },
    midLineX: 0,
    creek: [],
  };
}
