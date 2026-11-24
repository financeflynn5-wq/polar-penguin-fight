// Big pieces of hard cover that sit on the map: ice pillars, icebergs (clusters of ice shards) and the gingerbread house.
// Shared collision data, no Three.js. Everything here is mirror-symmetric across x = 0 so neither team gets better cover.
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
}

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

export function makeGingerbreadHouse(ground: Ground, x: number, z: number): House {
  return { x, z, y: ground(x, z), hx: 3.6, hz: 2.8, wall: 0.3, wallH: 2.7, ridgeH: 4.5, doorW: 1.7, doorH: 2.0, winW: 2.2, sill: 0.9, winTop: 2.1 };
}

/** The boxes that make up a house: walls with door and window openings, and a stepped stand-in for the pitched roof. */
export function houseBoxes(h: House): Box[] {
  const boxes: Box[] = [];
  const solid = (x: number, z: number, hx: number, hz: number, y0: number, y1: number) =>
    boxes.push({ x: h.x + x, z: h.z + z, hx, hz, y0: h.y + y0, y1: h.y + y1, rot: 0, kind: 'solid' });
  const t = h.wall, deep = -1.2;
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
export function addLandmarkCollision(pg: Playground, shards: IceShard[], houses: House[]) {
  for (const s of shards) pg.cyls.push({ x: s.x, z: s.z, r: s.r * 0.86, y0: s.y - 1, y1: s.y + s.h });
  for (const h of houses) pg.boxes.push(...houseBoxes(h));
}
