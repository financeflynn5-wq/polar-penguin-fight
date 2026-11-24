// The playground in the middle of the valley: a tower with a slide (and a launch lip at the bottom),
// swing sets, seesaws, monkey bars and low walls for cover. Shared collision data, no Three.js.

export interface Box {
  x: number; z: number; y0: number; y1: number; hx: number; hz: number; rot: number;
  kind: 'platform' | 'step' | 'rail' | 'wall' | 'seesaw' | 'post';
  color?: number;
}

export interface Cyl { x: number; z: number; r: number; y0: number; y1: number; }

export interface Slide {
  x: number; z0: number; // top of the slide (s = 0)
  dirZ: number; // +1: slides toward +z
  width: number;
  length: number; // total, including the lip
  samples: number[]; // y at s = 0, step, 2*step ...
  step: number;
}

export interface Playground {
  boxes: Box[];
  cyls: Cyl[];
  slide: Slide;
  tower: { x: number; z: number; ground: number; top: number; size: number };
  swings: { x: number; z: number; ground: number; rot: number }[];
  seesaws: { x: number; z: number; ground: number; rot: number }[];
  monkeyBars: { x: number; z: number; ground: number; rot: number; len: number }[];
}

export function slideY(sl: Slide, s: number) {
  const f = Math.max(0, Math.min(sl.samples.length - 1.001, s / sl.step));
  const i = Math.floor(f), t = f - i;
  return sl.samples[i] + (sl.samples[i + 1] - sl.samples[i]) * t;
}

export function buildPlayground(ground: (x: number, z: number) => number): Playground {
  const boxes: Box[] = [];
  const cyls: Cyl[] = [];
  const tx = 0, tz = -2.0, size = 1.7;
  const g0 = Math.max(ground(tx - 0.8, tz - 0.8), ground(tx + 0.8, tz - 0.8), ground(tx - 0.8, tz + 0.8), ground(tx + 0.8, tz + 0.8));
  const top = g0 + 2.4;
  // platform deck + posts
  boxes.push({ x: tx, z: tz, y0: top - 0.18, y1: top, hx: size / 2, hz: size / 2, rot: 0, kind: 'platform' });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    cyls.push({ x: tx + sx * (size / 2 - 0.08), z: tz + sz * (size / 2 - 0.08), r: 0.09, y0: ground(tx + sx * 0.8, tz + sz * 0.8) - 0.3, y1: top + 1.6 });
  }
  // side rails (the slide leaves from +z, the stairs arrive from -z)
  for (const sx of [-1, 1]) boxes.push({ x: tx + sx * (size / 2 - 0.04), z: tz, y0: top, y1: top + 0.6, hx: 0.04, hz: size / 2, rot: 0, kind: 'rail' });

  // stairs climbing down the back toward the hill
  let stepTop = top - 0.4;
  let z = tz - size / 2 - 0.22;
  for (let n = 0; n < 12 && stepTop > ground(tx, z) + 0.12; n++) {
    const gy = Math.min(ground(tx - 0.5, z), ground(tx + 0.5, z));
    boxes.push({ x: tx, z, y0: gy - 0.4, y1: stepTop, hx: 0.55, hz: 0.22, rot: 0, kind: 'step' });
    stepTop -= 0.38;
    z -= 0.44;
  }

  // the slide: smooth drop, then a lip that kicks you up into the air (toward the frozen pond)
  const z0 = tz + size / 2;
  const length = 6.4, step = 0.2;
  const lipLen = 0.9, lipRise = 0.45;
  const endZ = z0 + length;
  const bottom = ground(tx, endZ - lipLen) + 0.35;
  const samples: number[] = [];
  for (let s = 0; s <= length + 1e-6; s += step) {
    const main = length - lipLen;
    let y: number;
    if (s <= main) {
      const t = s / main;
      // steep start, flattening out
      const e = 1 - Math.pow(1 - t, 1.6);
      y = top + (bottom - top) * e;
    } else {
      const t = (s - main) / lipLen;
      y = bottom + t * t * lipRise;
    }
    samples.push(y);
  }
  const slide: Slide = { x: tx, z0, dirZ: 1, width: 0.95, length, samples, step };
  // slide support legs
  cyls.push({ x: tx - 0.5, z: z0 + length * 0.45, r: 0.06, y0: ground(tx, z0 + length * 0.45) - 0.3, y1: slideY(slide, length * 0.45) });
  cyls.push({ x: tx + 0.5, z: z0 + length * 0.45, r: 0.06, y0: ground(tx, z0 + length * 0.45) - 0.3, y1: slideY(slide, length * 0.45) });

  // mirrored odds and ends for cover
  const swings: Playground['swings'] = [];
  const seesaws: Playground['seesaws'] = [];
  const monkeyBars: Playground['monkeyBars'] = [];
  for (const s of [-1, 1]) {
    // swing set: A-frames at both ends
    const sx = s * 6.2, sz = 1.2;
    const sg = ground(sx, sz);
    swings.push({ x: sx, z: sz, ground: sg, rot: 0 });
    for (const end of [-1, 1]) {
      for (const leg of [-1, 1]) cyls.push({ x: sx + end * 1.6, z: sz + leg * 0.55, r: 0.08, y0: sg - 0.3, y1: sg + 2.3 });
    }
    // seesaw (low, you can hop over it)
    const ex = s * 5.0, ez = -5.2;
    const eg = ground(ex, ez);
    seesaws.push({ x: ex, z: ez, ground: eg, rot: 0 });
    boxes.push({ x: ex, z: ez, y0: eg - 0.2, y1: eg + 0.45, hx: 1.6, hz: 0.17, rot: 0, kind: 'seesaw' });
    // low snowy walls (cover)
    const wx = s * 3.2, wz = 5.0;
    const wg = Math.min(ground(wx - 1, wz), ground(wx + 1, wz));
    boxes.push({ x: wx, z: wz, y0: wg - 0.4, y1: wg + 0.95, hx: 1.1, hz: 0.22, rot: s * 0.35, kind: 'wall', color: s < 0 ? 0x3d95ff : 0xff7a3d });
    // monkey bars
    const mx = s * 9.0, mz = -1.5;
    const mg = ground(mx, mz);
    monkeyBars.push({ x: mx, z: mz, ground: mg, rot: Math.PI / 2, len: 3.2 });
    for (const end of [-1, 1]) for (const side of [-1, 1]) cyls.push({ x: mx + side * 0.45, z: mz + end * 1.6, r: 0.07, y0: mg - 0.3, y1: mg + 2.0 });
  }
  return { boxes, cyls, slide, tower: { x: tx, z: tz, ground: g0, top, size }, swings, seesaws, monkeyBars };
}

// ── collision helpers ──

/** Top of the highest box under (x, z) that's not above y + stepUp. */
export function boxGround(boxes: Box[], x: number, z: number, y: number, stepUp: number, down: number, margin: number): number | null {
  let best: number | null = null;
  for (const b of boxes) {
    if (b.y1 > y + stepUp || b.y1 < y - down) continue;
    const c = Math.cos(-b.rot), s = Math.sin(-b.rot);
    const lx = (x - b.x) * c - (z - b.z) * s, lz = (x - b.x) * s + (z - b.z) * c;
    if (Math.abs(lx) <= b.hx + margin && Math.abs(lz) <= b.hz + margin) {
      if (best === null || b.y1 > best) best = b.y1;
    }
  }
  return best;
}

/** Push a vertical capsule (feet y0, head y1, radius r) out of boxes. Returns push in x/z (or null). */
export function boxPush(boxes: Box[], x: number, z: number, y0: number, y1: number, r: number, out: { x: number; z: number }): boolean {
  let hit = false;
  out.x = 0; out.z = 0;
  for (const b of boxes) {
    if (y1 <= b.y0 || y0 >= b.y1 - 0.06) continue; // standing on top or below it
    const c = Math.cos(-b.rot), s = Math.sin(-b.rot);
    const lx = (x - b.x) * c - (z - b.z) * s, lz = (x - b.x) * s + (z - b.z) * c;
    const cx = Math.max(-b.hx, Math.min(b.hx, lx)), cz = Math.max(-b.hz, Math.min(b.hz, lz));
    let dx = lx - cx, dz = lz - cz;
    let d = Math.hypot(dx, dz);
    let px = 0, pz = 0;
    if (d < 1e-5) {
      // inside: push out along the shallowest side
      const ex = b.hx - Math.abs(lx), ez = b.hz - Math.abs(lz);
      if (ex < ez) { px = Math.sign(lx || 1) * (ex + r); } else { pz = Math.sign(lz || 1) * (ez + r); }
    } else if (d < r) {
      px = dx / d * (r - d); pz = dz / d * (r - d);
    } else continue;
    // back to world space
    const c2 = Math.cos(b.rot), s2 = Math.sin(b.rot);
    out.x += px * c2 - pz * s2; out.z += px * s2 + pz * c2;
    hit = true;
  }
  return hit;
}

export function pointInBoxes(boxes: Box[], x: number, y: number, z: number, pad: number) {
  for (const b of boxes) {
    if (y < b.y0 - pad || y > b.y1 + pad) continue;
    const c = Math.cos(-b.rot), s = Math.sin(-b.rot);
    const lx = (x - b.x) * c - (z - b.z) * s, lz = (x - b.x) * s + (z - b.z) * c;
    if (Math.abs(lx) <= b.hx + pad && Math.abs(lz) <= b.hz + pad) return true;
  }
  return false;
}
