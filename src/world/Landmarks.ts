// Big pieces of hard cover that sit on the map: ice pillars, icebergs (clusters of ice shards), houses you can run through
// (gingerbread houses and log cabins) and the smaller props: broken-down gingerbread houses, giant candy canes, cargo sleds
// and stacks of ice blocks. Shared collision data, no Three.js. What you see is modelled in Blender to these exact sizes
// (tools/blender), so if a number changes here the model has to change with it.
import { Box, Playground } from './Playground';

/** A tapered six-sided column of ice. Icebergs are clusters of big ones. */
export interface IceShard { x: number; z: number; y: number; r: number; h: number; seed: number; }

/** A little house you can run through: a door in each end wall, a hop-through window in each long wall. */
export interface House {
  x: number; z: number; y: number; // centre of the floor
  hx: number; hz: number; // half size (long axis along x)
  wall: number; // wall thickness
  wallH: number; ridgeH: number;
  doorW: number; doorH: number;
  winW: number; sill: number; winTop: number;
  /** turned about the vertical axis (0 = long axis along x); same sense as Box.rot */
  rot: number;
  style: 'gingerbread' | 'cabin';
}

export type PropKind = 'cane' | 'caneDown' | 'sled' | 'iceBlocks' | 'ruinA' | 'ruinB';
/** A solid prop standing on the snow at (x, y, z), turned by rot (same sense as Box.rot). */
export interface Prop { kind: PropKind; x: number; y: number; z: number; rot: number; }

interface Shape {
  /** [x, z, half x, half z, y0, y1] in the prop's own frame */
  boxes: [number, number, number, number, number, number][];
  /** [x, z, radius, y0, y1] */
  cyls: [number, number, number, number, number][];
}

const DEEP = -1.2; // how far solid things reach below the snow they stand on, so a dug-out foot is still solid

/** What each prop is made of, as far as bumping into it goes. Low pieces can be hopped onto or over. */
export const PROP_SHAPES: Record<PropKind, Shape> = {
  // a giant candy cane, standing: the hook is overhead
  cane: { boxes: [], cyls: [[0, 0, 0.36, DEEP, 4.3]] },
  // one that fell over and snapped: knee-high cover you can hop
  caneDown: { boxes: [[-0.15, 0, 2.2, 0.36, DEEP, 0.72]], cyls: [] },
  // a cargo sled loaded with crates and sacks under a snowy tarp
  sled: { boxes: [[0, 0, 1.75, 0.78, DEEP, 1.05], [-0.25, 0, 1.2, 0.66, 1.05, 1.5]], cyls: [] },
  // sawn blocks of lake ice: two side by side with a third on top
  iceBlocks: { boxes: [[0, 0, 1.3, 0.66, DEEP, 1.22], [-0.52, 0.03, 0.68, 0.62, 1.22, 2.36]], cyls: [] },
  // a gingerbread house with the roof gone and the walls bitten down to different heights
  ruinA: {
    boxes: [
      [-3.45, -1.825, 0.15, 0.975, DEEP, 2.7], [-3.45, 1.825, 0.15, 0.975, DEEP, 1.5], // west end wall, either side of the doorway
      [-2.1, -2.65, 1.5, 0.15, DEEP, 2.4], [0.4, -2.65, 1.0, 0.15, DEEP, 1.3], [2.5, -2.65, 1.1, 0.15, DEEP, 0.5], // north wall, stepping down
      [-2.6, 2.65, 1.0, 0.15, DEEP, 1.0], [2.3, 2.65, 1.3, 0.15, DEEP, 2.0], // south wall: a stub, a gap, a tall piece
      [3.45, -1.825, 0.15, 0.975, DEEP, 0.6], [3.45, 1.825, 0.15, 0.975, DEEP, 2.7], // east end wall
      [0.7, 0.3, 1.5, 1.1, DEEP, 0.5], // a slab of the roof lying inside
      [4.7, -1.5, 0.6, 0.5, DEEP, 0.6], [-1.0, 3.9, 0.8, 0.45, DEEP, 0.5], // chunks lying outside
    ],
    cyls: [],
  },
  // half a gingerbread house: the west half still has its roof, the east half has fallen in
  ruinB: {
    boxes: [
      [-3.45, -1.825, 0.15, 0.975, DEEP, 2.7], [-3.45, 1.825, 0.15, 0.975, DEEP, 2.7], [-3.45, 0, 0.15, 0.85, 2.0, 2.7], // west end wall with its doorway
      [-1.7, -2.65, 1.9, 0.15, DEEP, 2.7], [-1.7, 2.65, 1.9, 0.15, DEEP, 2.7], // the long walls of the standing half
      [1.1, -2.65, 0.9, 0.15, DEEP, 1.6], [2.8, -2.65, 0.8, 0.15, DEEP, 0.8], // north wall of the fallen half
      [1.1, 2.65, 0.9, 0.15, DEEP, 1.1], // south wall of the fallen half
      [3.45, -2.0, 0.15, 0.8, DEEP, 0.5], // what's left of the east end
      [2.0, 0.3, 1.0, 0.9, DEEP, 0.65], // the heap where the roof came down
      // the roof over the standing half (stepped, like the whole house's)
      [-1.75, 0, 2.2, 3.15, 2.7, 3.24], [-1.75, 0, 2.2, 1.74, 3.24, 3.92], [-1.75, 0, 2.2, 0.73, 3.92, 4.5],
    ],
    cyls: [],
  },
};

type Ground = (x: number, z: number) => number;

export function makePillar(ground: Ground, x: number, z: number, r: number, h: number): IceShard {
  return { x, z, y: ground(x, z) - 0.5, r, h: h + 0.5, seed: Math.round(Math.abs(x) * 37 + z * 19 + r * 101) };
}

/** A jagged mass of ice about 12 m wide: one tall spire with lower blocks crowding round it. */
export function makeIceberg(ground: Ground, cx: number, cz: number, scale = 1): IceShard[] {
  const parts: [number, number, number, number][] = [
    // x offset, z offset, radius, height (pairs are mirrored)
    [0, 0, 3.3, 8.6], [0, 3.1, 2.3, 3.8], [0, -3.2, 1.9, 5.2],
    [2.9, 0.9, 2.4, 5.9], [1.7, -2.6, 2.0, 4.4], [4.5, -1.2, 1.5, 2.7], [3.6, 3.1, 1.3, 2.1],
  ];
  const out: IceShard[] = [];
  for (const [ox, oz, r, h] of parts) {
    for (const s of ox === 0 ? [1] : [-1, 1]) out.push(makePillar(ground, cx + s * ox * scale, cz + oz * scale, r * scale, h * scale));
  }
  return out;
}

export function makeGingerbreadHouse(ground: Ground, x: number, z: number, rot = 0): House {
  return { x, z, y: ground(x, z), hx: 3.6, hz: 2.8, wall: 0.3, wallH: 2.7, ridgeH: 4.5, doorW: 1.7, doorH: 2.0, winW: 2.2, sill: 0.9, winTop: 2.1, rot, style: 'gingerbread' };
}

/** A little log cabin: the same run-through layout as the gingerbread house (a door in each end, a window in each side). */
export function makeCabin(ground: Ground, x: number, z: number, rot = 0): House {
  return { x, z, y: ground(x, z), hx: 3.3, hz: 2.6, wall: 0.34, wallH: 2.5, ridgeH: 4.3, doorW: 1.6, doorH: 2.0, winW: 1.9, sill: 0.95, winTop: 2.0, rot, style: 'cabin' };
}

export function makeProp(ground: Ground, kind: PropKind, x: number, z: number, rot = 0): Prop {
  return { kind, x, y: ground(x, z), z, rot };
}

/** A point in something's own frame (turned by rot about its centre) out in the world. */
export function turned(cx: number, cz: number, rot: number, lx: number, lz: number) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return { x: cx + lx * c - lz * s, z: cz + lx * s + lz * c };
}

/** A world point in a house's own frame (x along its length, z across it). */
export function houseLocal(h: House, x: number, z: number) {
  const c = Math.cos(-h.rot), s = Math.sin(-h.rot);
  return { x: (x - h.x) * c - (z - h.z) * s, z: (x - h.x) * s + (z - h.z) * c };
}

/** The boxes that make up a house: walls with door and window openings, and a stepped stand-in for the pitched roof. */
export function houseBoxes(h: House): Box[] {
  const boxes: Box[] = [];
  const solid = (x: number, z: number, hx: number, hz: number, y0: number, y1: number) => {
    const w = turned(h.x, h.z, h.rot, x, z);
    boxes.push({ x: w.x, z: w.z, hx, hz, y0: h.y + y0, y1: h.y + y1, rot: h.rot, kind: 'solid' });
  };
  const t = h.wall, deep = DEEP;
  // end walls (door in the middle of each)
  for (const s of [-1, 1]) {
    const wx = s * (h.hx - t / 2);
    const seg = (h.hz - h.doorW / 2) / 2;
    for (const k of [-1, 1]) solid(wx, k * (h.doorW / 2 + seg), t / 2, seg, deep, h.wallH);
    solid(wx, 0, t / 2, h.doorW / 2, h.doorH, h.wallH);
  }
  // long walls (window in the middle of each)
  for (const s of [-1, 1]) {
    const wz = s * (h.hz - t / 2);
    const seg = (h.hx - h.winW / 2) / 2;
    for (const k of [-1, 1]) solid(k * (h.winW / 2 + seg), wz, seg, t / 2, deep, h.wallH);
    solid(0, wz, h.winW / 2, t / 2, deep, h.sill);
    solid(0, wz, h.winW / 2, t / 2, h.winTop, h.wallH);
  }
  // roof: three stacked slabs under the pitched roof you see
  const rise = h.ridgeH - h.wallH;
  solid(0, 0, h.hx + 0.35, h.hz + 0.35, h.wallH, h.wallH + rise * 0.3);
  solid(0, 0, h.hx + 0.35, h.hz * 0.62, h.wallH + rise * 0.3, h.wallH + rise * 0.68);
  solid(0, 0, h.hx + 0.35, h.hz * 0.26, h.wallH + rise * 0.68, h.ridgeH);
  return boxes;
}

/** Add the landmarks' collision to the map's solid props (penguins, snowballs and giant snowballs all use these). */
export function addLandmarkCollision(pg: Playground, shards: IceShard[], houses: House[], props: Prop[] = []) {
  for (const s of shards) pg.cyls.push({ x: s.x, z: s.z, r: s.r * 0.86, y0: s.y - 1, y1: s.y + s.h });
  for (const h of houses) pg.boxes.push(...houseBoxes(h));
  for (const p of props) {
    const sh = PROP_SHAPES[p.kind];
    for (const [x, z, hx, hz, y0, y1] of sh.boxes) {
      const w = turned(p.x, p.z, p.rot, x, z);
      pg.boxes.push({ x: w.x, z: w.z, hx, hz, y0: p.y + y0, y1: p.y + y1, rot: p.rot, kind: 'solid' });
    }
    for (const [x, z, r, y0, y1] of sh.cyls) {
      const w = turned(p.x, p.z, p.rot, x, z);
      pg.cyls.push({ x: w.x, z: w.z, r, y0: p.y + y0, y1: p.y + y1 });
    }
  }
}
