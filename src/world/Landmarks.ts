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

export type PropKind = 'cane' | 'caneDown' | 'sled' | 'iceBlocks' | 'ruinA' | 'ruinB' | 'ramp';
/** A solid prop standing on the snow at (x, y, z), turned by rot (same sense as Box.rot). */
export interface Prop { kind: PropKind; x: number; y: number; z: number; rot: number; }

interface Shape {
  /** [x, z, half x, half z, y0, y1] in the prop's own frame */
  boxes: [number, number, number, number, number, number][];
  /** [x, z, radius, y0, y1] */
  cyls: [number, number, number, number, number][];
}

const DEEP = -1.2; // how far solid things reach below the snow they stand on, so a dug-out foot is still solid

/**
 * The jump ramp: a timber kicker with an ice deck. You ride up it and fly off the lip; the faster you arrive, the
 * further you go. In its own frame x runs from the low end (-len / 2) to the lip (+len / 2), and its y is the deck
 * at the low end. The deck curves up like the inside of a bowl: rise * (s / len)^2, s metres in from the low end.
 */
export const RAMP = { len: 5.6, width: 3.2, rise: 1.3 };
/** How steeply the deck is climbing at the lip (rise over run): what turns your speed into height. */
export const RAMP_LIP = 2 * RAMP.rise / RAMP.len;
/** Height of the deck above the ramp's y, s metres in from the low end. */
const RAMP_DEEP = -3.4; // how far down the trestle under the lip reaches
export const rampDeck = (s: number) => { const t = Math.max(0, Math.min(1, s / RAMP.len)); return RAMP.rise * t * t; };

/**
 * What's solid under the deck, for giant snowballs and anything else that only knows boxes: a row of blocks that stop
 * well short of the deck, so someone riding up it never touches them. (Penguins are kept out from under the deck
 * by rampPush, and snowballs by pointInRamps.)
 */
function rampBlocks(): Shape['boxes'] {
  const boxes: Shape['boxes'] = [];
  const step = 0.5;
  for (let s = 2.6; s < RAMP.len - 0.01; s += step) {
    const s1 = Math.min(RAMP.len, s + step);
    // down to well below the snow: on a slope the lip end stands on tall legs
    boxes.push([(s + s1) / 2 - RAMP.len / 2, 0, (s1 - s) / 2, RAMP.width / 2 - 0.06, RAMP_DEEP, rampDeck(s - 0.9) - 0.05]);
  }
  return boxes;
}

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
  // the jump ramp: see RAMP (the deck you ride on is rampGround, these are only what's underneath)
  ramp: { boxes: rampBlocks(), cyls: [] },
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

/**
 * A jump ramp with its middle at (x, z), climbing toward `rot` (0 = east, +x; same sense as Box.rot). `ground` is the
 * land before the ramp was there. Put it on flat or falling ground: at the foot of a slope, or on the edge of a drop.
 */
export function makeRamp(ground: Ground, x: number, z: number, rot = 0): Prop {
  const e = turned(x, z, rot, -RAMP.len / 2, 0);
  return { kind: 'ramp', x, y: ground(e.x, e.z), z, rot };
}

/**
 * The snow round a ramp: levelled where you ride onto it (so the low end sits just under the snow right across its
 * width, whatever the slope was doing), and dug out from under the deck so the ramp isn't half buried.
 * `h` is the height the land had at (x, z); returns the height it has with the ramps there.
 */
export function rampSnow(ramps: Prop[], x: number, z: number, h: number): number {
  for (const r of ramps) {
    if (Math.abs(x - r.x) > RAMP.len + 3 || Math.abs(z - r.z) > RAMP.len + 3) continue;
    rampLocal(r, x, z, rl);
    const half = RAMP.width / 2, aw = Math.abs(rl.w);
    // the pad at the low end
    const e = smoothstep(half + 2.4, half + 0.3, aw) * smoothstep(-4.2, -0.8, rl.s) * (1 - smoothstep(0.8, 2.6, rl.s));
    h += (r.y + 0.04 - h) * e;
    // nothing higher than just under the deck (rising gently again outside its edges)
    const out = Math.max(0, aw - half, rl.s - RAMP.len);
    if (rl.s > 0 && out < 1.6) h = Math.min(h, r.y + Math.max(0.04, rampDeck(rl.s) - 0.07) + out * 0.9);
  }
  return h;
}
const smoothstep = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** Is a tree (or anything else) at (x, z) in the way of a ramp: on the run-up, on the ramp, or where you come down? */
export function inRampLane(ramps: Prop[], x: number, z: number, r = 0) {
  for (const rp of ramps) {
    if (Math.abs(x - rp.x) > 30 || Math.abs(z - rp.z) > 30) continue;
    rampLocal(rp, x, z, rl);
    if (rl.s > -11 && rl.s < RAMP.len + 22 && Math.abs(rl.w) < RAMP.width / 2 + 1.5 + r) return true;
  }
  return false;
}

/** Where a world point is on a ramp: s metres in from the low end, w metres off its centre line. */
export function rampLocal(r: Prop, x: number, z: number, out: { s: number; w: number }) {
  const c = Math.cos(-r.rot), s = Math.sin(-r.rot);
  out.s = (x - r.x) * c - (z - r.z) * s + RAMP.len / 2;
  out.w = (x - r.x) * s + (z - r.z) * c;
  return out;
}

const rl = { s: 0, w: 0 };

/** The deck of the highest ramp under (x, z) that's not above y + stepUp or more than `down` below y. */
export function rampGround(ramps: Prop[], x: number, z: number, y: number, stepUp: number, down: number): number | null {
  let best: number | null = null;
  for (const r of ramps) {
    if (Math.abs(x - r.x) > RAMP.len || Math.abs(z - r.z) > RAMP.len) continue;
    rampLocal(r, x, z, rl);
    if (rl.s < 0 || rl.s > RAMP.len || Math.abs(rl.w) > RAMP.width / 2) continue;
    const d = r.y + rampDeck(rl.s);
    if (d > y + stepUp || d < y - down) continue;
    if (best === null || d > best) best = d;
  }
  return best;
}

/** The ramp whose deck (x, y, z) is standing on, or null. */
export function rampUnder(ramps: Prop[], x: number, y: number, z: number): Prop | null {
  for (const r of ramps) {
    if (Math.abs(x - r.x) > RAMP.len || Math.abs(z - r.z) > RAMP.len) continue;
    rampLocal(r, x, z, rl);
    if (rl.s < 0 || rl.s > RAMP.len || Math.abs(rl.w) > RAMP.width / 2) continue;
    if (Math.abs(r.y + rampDeck(rl.s) - y) < 0.12) return r;
  }
  return null;
}

/** Is this point inside a ramp (under its deck)? For snowballs, and for bots looking where they're going. */
export function pointInRamps(ramps: Prop[], x: number, y: number, z: number, pad: number) {
  for (const r of ramps) {
    if (Math.abs(x - r.x) > RAMP.len || Math.abs(z - r.z) > RAMP.len) continue;
    rampLocal(r, x, z, rl);
    if (rl.s < -pad || rl.s > RAMP.len + pad || Math.abs(rl.w) > RAMP.width / 2 + pad) continue;
    if (y < r.y + rampDeck(rl.s) + pad && y > r.y + RAMP_DEEP) return true;
  }
  return false;
}

/**
 * Keep a penguin (feet y0, head y1, radius r) out from under a ramp's deck: whoever is in its footprint with the deck
 * more than a step (`stepUp`) above their feet is pushed out through the nearest side, or out past the lip.
 */
export function rampPush(ramps: Prop[], x: number, z: number, y0: number, y1: number, r: number, stepUp: number, out: { x: number; z: number }): boolean {
  for (const rp of ramps) {
    if (Math.abs(x - rp.x) > RAMP.len || Math.abs(z - rp.z) > RAMP.len) continue;
    rampLocal(rp, x, z, rl);
    const half = RAMP.width / 2;
    if (rl.s < 0 || rl.s > RAMP.len + r || Math.abs(rl.w) > half + r) continue;
    if (y0 + stepUp >= rp.y + rampDeck(rl.s) || y1 < rp.y + RAMP_DEEP) continue;
    const side = half + r - Math.abs(rl.w), front = RAMP.len + r - rl.s;
    let ps = 0, pw = 0;
    if (front < side) ps = front; else pw = Math.sign(rl.w || 1) * side;
    const c = Math.cos(rp.rot), s = Math.sin(rp.rot);
    out.x = ps * c - pw * s; out.z = ps * s + pw * c;
    return true;
  }
  return false;
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
