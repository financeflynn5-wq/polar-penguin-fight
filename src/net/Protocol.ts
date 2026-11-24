// The online wire format, shared by the game server and the browser. No Three.js and no DOM.
//
// Browser → server: small JSON text messages.
//   { t: 'join', v, name, hat, size }            join a 5v5 or 10v10 match
//   { t: 'in', s, i: InputRow[] }                 one row per 60 Hz tick, s = sequence number of the first row
//   { t: 'ping', c }                              round-trip timer
//
// Server → browser:
//   JSON text: { t: 'roster', roster } when someone joins or leaves, { t: 'pong', c }, { t: 'joinErr', err }
//   binary MSG_MATCH: a match starts (or you just joined one): match info JSON + the whole snow field, deflated
//   binary MSG_SNAP: 30 times a second: every penguin, snowball, big ball, snowflake and the surfboard,
//                    the snow that changed, and what happened (hits, splats, throws...)
import type { World, Penguin, PenguinInput, Action, Phase, GameEvent, RosterEntry } from '../sim/World';

export const PROTOCOL = 1;
export const TICK_HZ = 60;
export const SNAP_EVERY = 2; // ticks per snapshot: 30 snapshots a second
export const MSG_MATCH = 1;
export const MSG_SNAP = 2;
export const TEAM_SIZES = [5, 10];

export interface MatchInfo {
  you: number; // your penguin's id
  size: number; // team size
  tick: number;
  roster: RosterEntry[];
  phase: Phase;
}

// ───────────────────────── inputs ─────────────────────────
export type InputRow = [number, number, number, number, number, number?, number?, number?];
const B = { jump: 1, slide: 2, fire: 4, plow: 8, pack: 16, dig: 32, build: 64, use: 128, roll: 256 };

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function packInput(i: PenguinInput): InputRow {
  const bits = (i.jump ? B.jump : 0) | (i.slide ? B.slide : 0) | (i.fire ? B.fire : 0) | (i.plow ? B.plow : 0) | (i.pack ? B.pack : 0)
    | (i.dig ? B.dig : 0) | (i.build ? B.build : 0) | (i.use ? B.use : 0) | (i.roll ? B.roll : 0);
  const row: InputRow = [i.moveX, i.moveZ, r3(i.yaw), r3(i.pitch), bits];
  if (i.aim) row.push(r3(i.aim.x), r3(i.aim.y), r3(i.aim.z));
  return row;
}

const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);

/** Read an input row from the network into `out`. Anything malformed becomes "standing still". */
export function unpackInput(row: unknown, out: PenguinInput) {
  const r = Array.isArray(row) ? row : [];
  out.moveX = num(r[0], -1, 1); out.moveZ = num(r[1], -1, 1);
  out.yaw = num(r[2], -1e4, 1e4); out.pitch = num(r[3], -1.6, 1.6);
  const bits = num(r[4], 0, 0xffff) | 0;
  out.jump = !!(bits & B.jump); out.slide = !!(bits & B.slide); out.fire = !!(bits & B.fire); out.plow = !!(bits & B.plow);
  out.pack = !!(bits & B.pack); out.dig = !!(bits & B.dig); out.build = !!(bits & B.build); out.use = !!(bits & B.use); out.roll = !!(bits & B.roll);
  out.aim = r.length >= 8 ? { x: num(r[5], -500, 500), y: num(r[6], -50, 200), z: num(r[7], -500, 500) } : null;
  return out;
}

export function copyInput(src: PenguinInput, out: PenguinInput) {
  out.moveX = src.moveX; out.moveZ = src.moveZ; out.yaw = src.yaw; out.pitch = src.pitch;
  out.jump = src.jump; out.slide = src.slide; out.fire = src.fire; out.plow = src.plow; out.pack = src.pack;
  out.dig = src.dig; out.build = src.build; out.use = src.use; out.roll = src.roll;
  out.aim = src.aim ? { x: src.aim.x, y: src.aim.y, z: src.aim.z } : null;
  return out;
}

// ───────────────────────── binary helpers ─────────────────────────
export class Writer {
  buf: Uint8Array;
  dv: DataView;
  o = 0;
  constructor(size = 4096) { this.buf = new Uint8Array(size); this.dv = new DataView(this.buf.buffer); }
  private need(n: number) {
    if (this.o + n <= this.buf.length) return;
    let s = this.buf.length * 2;
    while (s < this.o + n) s *= 2;
    const b = new Uint8Array(s); b.set(this.buf); this.buf = b; this.dv = new DataView(b.buffer);
  }
  u8(v: number) { this.need(1); this.dv.setUint8(this.o, v); this.o += 1; }
  i8(v: number) { this.need(1); this.dv.setInt8(this.o, v); this.o += 1; }
  u16(v: number) { this.need(2); this.dv.setUint16(this.o, v, true); this.o += 2; }
  i16(v: number) { this.need(2); this.dv.setInt16(this.o, v, true); this.o += 2; }
  u32(v: number) { this.need(4); this.dv.setUint32(this.o, v >>> 0, true); this.o += 4; }
  f32(v: number) { this.need(4); this.dv.setFloat32(this.o, v, true); this.o += 4; }
  bytes(b: Uint8Array) { this.need(b.length); this.buf.set(b, this.o); this.o += b.length; }
  done() { return this.buf.subarray(0, this.o); }
}

export class Reader {
  dv: DataView;
  o = 0;
  constructor(public buf: Uint8Array) { this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  u8() { const v = this.dv.getUint8(this.o); this.o += 1; return v; }
  i8() { const v = this.dv.getInt8(this.o); this.o += 1; return v; }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  i16() { const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  bytes(n: number) { const b = this.buf.subarray(this.o, this.o + n); this.o += n; return b; }
  rest() { return this.buf.subarray(this.o); }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const clampI16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));
const clampU8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const clampU16 = (v: number) => Math.max(0, Math.min(65535, Math.round(v)));
const wrapA = (a: number) => { a = a % (Math.PI * 2); if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; };

// ───────────────────────── match start ─────────────────────────
/** MSG_MATCH: [u8 type][u32 json length][json][deflated density + hard] (the deflating is done by the caller). */
export function encodeMatch(info: MatchInfo, deflatedField: Uint8Array) {
  const json = enc.encode(JSON.stringify(info));
  const w = new Writer(9 + json.length + deflatedField.length);
  w.u8(MSG_MATCH); w.u32(json.length); w.bytes(json); w.bytes(deflatedField);
  return w.done();
}

export function decodeMatch(buf: Uint8Array): { info: MatchInfo; field: Uint8Array } {
  const r = new Reader(buf);
  r.u8();
  const n = r.u32();
  const info = JSON.parse(dec.decode(r.bytes(n))) as MatchInfo;
  return { info, field: r.rest() };
}

// ───────────────────────── snapshots ─────────────────────────
const ACTIONS: Action[] = ['idle', 'plow', 'pack', 'dig', 'build', 'charge', 'throw', 'slide', 'down'];
const PHASES: Phase[] = ['build', 'fight', 'end'];
const F = { alive: 1, grounded: 2, sliding: 4, surfing: 8, onIce: 16, onProp: 32, onSlide: 64, charging: 128, aimOk: 256, slumping: 512 };

export interface PenguinState {
  id: number;
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  yaw: number; lookYaw: number; lookPitch: number;
  alive: boolean; grounded: boolean; sliding: boolean; surfing: boolean; onIce: boolean; onProp: boolean; onSlide: boolean;
  charging: boolean; aimOk: boolean; slumping: boolean;
  action: Action; charge: number; throwAnim: number; throwCd: number;
  carried: number; health: number; mitten: number; invuln: number; downT: number; packProgress: number;
  buildBlock: number; noSnowT: number; slideSlowT: number; plowLoad: number; splats: number; downs: number; lastHitBy: number;
}
export interface BallState { id: number; team: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; }
export interface BigBallState { id: number; x: number; y: number; z: number; r: number; vx: number; vy: number; vz: number; grounded: boolean; }
export interface FlakeState { id: number; spot: number; x: number; y: number; z: number; active: boolean; }
export interface Snapshot {
  tick: number; ack: number;
  phase: Phase; phaseT: number; scores: [number, number]; piles: [number, number]; winner: number;
  penguins: PenguinState[];
  balls: BallState[];
  bigBalls: BigBallState[];
  flakes: FlakeState[];
  board: { active: boolean; holder: number; x: number; y: number; z: number; yaw: number };
  snow: Uint8Array; // 5 bytes per changed voxel: 24-bit index, density, hardness
  events: GameEvent[];
}

export const ACK_OFFSET = 5; // byte offset of the per-player ack in a snapshot

/**
 * The snapshot everyone gets. Only the ack (which of your inputs the server has used) differs per player:
 * it's patched in at ACK_OFFSET before sending.
 */
export function encodeSnapshot(w: World, tick: number, snow: Uint8Array, events: GameEvent[]) {
  const o = new Writer(2048 + snow.length);
  o.u8(MSG_SNAP); o.u32(tick); o.u32(0);
  o.u8(PHASES.indexOf(w.phase)); o.f32(w.phaseT);
  o.u16(clampU16(w.scores[0])); o.u16(clampU16(w.scores[1])); o.u16(clampU16(w.piles[0])); o.u16(clampU16(w.piles[1])); o.i8(w.winner);
  o.u8(w.penguins.length);
  for (const p of w.penguins) writePenguin(o, p);
  o.u16(w.snowballs.length);
  for (const b of w.snowballs) {
    o.u32(b.id); o.u8(b.team); o.f32(b.x); o.f32(b.y); o.f32(b.z);
    o.i16(clampI16(b.vx * 50)); o.i16(clampI16(b.vy * 50)); o.i16(clampI16(b.vz * 50));
  }
  o.u8(w.bigBalls.length);
  for (const b of w.bigBalls) {
    o.u32(b.id); o.f32(b.x); o.f32(b.y); o.f32(b.z); o.u16(clampU16(b.r * 1000));
    o.i16(clampI16(b.vx * 100)); o.i16(clampI16(b.vy * 100)); o.i16(clampI16(b.vz * 100)); o.u8(b.grounded ? 1 : 0);
  }
  o.u8(w.flakes.length);
  for (const f of w.flakes) { o.u32(f.id); o.u8(f.spot); o.f32(f.x); o.f32(f.y); o.f32(f.z); o.u8(f.active ? 1 : 0); }
  const bd = w.board;
  o.u8(bd.active ? 1 : 0); o.i16(bd.holder); o.f32(bd.x); o.f32(bd.y); o.f32(bd.z); o.i16(clampI16(wrapA(bd.yaw) * 10000));
  o.u32(snow.length / 5); o.bytes(snow);
  const ev = enc.encode(events.length ? JSON.stringify(events, (_k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)) : '');
  o.u32(ev.length); o.bytes(ev);
  return o.done();
}

function writePenguin(o: Writer, p: Penguin) {
  o.u16(p.id);
  o.f32(p.x); o.f32(p.y); o.f32(p.z);
  o.i16(clampI16(p.vx * 100)); o.i16(clampI16(p.vy * 100)); o.i16(clampI16(p.vz * 100));
  o.i16(clampI16(wrapA(p.yaw) * 10000)); o.i16(clampI16(wrapA(p.lookYaw) * 10000)); o.i16(clampI16(p.lookPitch * 10000));
  o.u16((p.alive ? F.alive : 0) | (p.grounded ? F.grounded : 0) | (p.sliding ? F.sliding : 0) | (p.surfing ? F.surfing : 0)
    | (p.onIce ? F.onIce : 0) | (p.onProp ? F.onProp : 0) | (p.onSlide ? F.onSlide : 0) | (p.charging ? F.charging : 0)
    | (p.aimOk ? F.aimOk : 0) | (p.slumping ? F.slumping : 0));
  o.u8(Math.max(0, ACTIONS.indexOf(p.action)));
  o.u8(clampU8(p.charge * 255)); o.u8(clampU8(p.throwAnim * 1000)); o.u8(clampU8(p.throwCd * 500));
  o.u8(clampU8(p.carried)); o.u8(clampU8(p.health)); o.u8(clampU8(p.mitten));
  o.u8(clampU8(p.invuln * 50)); o.u8(clampU8(p.downT * 50)); o.u8(clampU8(p.packProgress * 255));
  o.u8(clampU8(p.buildBlock)); o.u8(clampU8(p.noSnowT * 200)); o.u8(clampU8(p.slideSlowT * 200));
  o.u16(clampU16(p.plowLoad)); o.u16(clampU16(p.splats)); o.u16(clampU16(p.downs)); o.i16(clampI16(p.lastHitBy));
}

function readPenguin(r: Reader): PenguinState {
  const id = r.u16();
  const x = r.f32(), y = r.f32(), z = r.f32();
  const vx = r.i16() / 100, vy = r.i16() / 100, vz = r.i16() / 100;
  const yaw = r.i16() / 10000, lookYaw = r.i16() / 10000, lookPitch = r.i16() / 10000;
  const fl = r.u16();
  const action = ACTIONS[r.u8()] ?? 'idle';
  const charge = r.u8() / 255, throwAnim = r.u8() / 1000, throwCd = r.u8() / 500;
  const carried = r.u8(), health = r.u8(), mitten = r.u8();
  const invuln = r.u8() / 50, downT = r.u8() / 50, packProgress = r.u8() / 255;
  const buildBlock = r.u8(), noSnowT = r.u8() / 200, slideSlowT = r.u8() / 200;
  const plowLoad = r.u16(), splats = r.u16(), downs = r.u16(), lastHitBy = r.i16();
  return {
    id, x, y, z, vx, vy, vz, yaw, lookYaw, lookPitch,
    alive: !!(fl & F.alive), grounded: !!(fl & F.grounded), sliding: !!(fl & F.sliding), surfing: !!(fl & F.surfing),
    onIce: !!(fl & F.onIce), onProp: !!(fl & F.onProp), onSlide: !!(fl & F.onSlide), charging: !!(fl & F.charging),
    aimOk: !!(fl & F.aimOk), slumping: !!(fl & F.slumping),
    action, charge, throwAnim, throwCd, carried, health, mitten, invuln, downT, packProgress, buildBlock, noSnowT, slideSlowT,
    plowLoad, splats, downs, lastHitBy,
  };
}

export function decodeSnapshot(buf: Uint8Array): Snapshot {
  const r = new Reader(buf);
  r.u8();
  const tick = r.u32(), ack = r.u32();
  const phase = PHASES[r.u8()] ?? 'build';
  const phaseT = r.f32();
  const scores: [number, number] = [r.u16(), r.u16()];
  const piles: [number, number] = [r.u16(), r.u16()];
  const winner = r.i8();
  const penguins: PenguinState[] = [];
  for (let n = r.u8(); n > 0; n--) penguins.push(readPenguin(r));
  const balls: BallState[] = [];
  for (let n = r.u16(); n > 0; n--) {
    const id = r.u32(), team = r.u8(), x = r.f32(), y = r.f32(), z = r.f32();
    balls.push({ id, team, x, y, z, vx: r.i16() / 50, vy: r.i16() / 50, vz: r.i16() / 50 });
  }
  const bigBalls: BigBallState[] = [];
  for (let n = r.u8(); n > 0; n--) {
    const id = r.u32(), x = r.f32(), y = r.f32(), z = r.f32(), rad = r.u16() / 1000;
    bigBalls.push({ id, x, y, z, r: rad, vx: r.i16() / 100, vy: r.i16() / 100, vz: r.i16() / 100, grounded: r.u8() === 1 });
  }
  const flakes: FlakeState[] = [];
  for (let n = r.u8(); n > 0; n--) {
    const id = r.u32(), spot = r.u8(), x = r.f32(), y = r.f32(), z = r.f32();
    flakes.push({ id, spot, x, y, z, active: r.u8() === 1 });
  }
  const active = r.u8() === 1, holder = r.i16(), bx = r.f32(), by = r.f32(), bz = r.f32(), byaw = r.i16() / 10000;
  const snow = r.bytes(r.u32() * 5);
  const evLen = r.u32();
  const events = evLen ? JSON.parse(dec.decode(r.bytes(evLen))) as GameEvent[] : [];
  return {
    tick, ack, phase, phaseT, scores, piles, winner, penguins, balls, bigBalls, flakes,
    board: { active, holder, x: bx, y: by, z: bz, yaw: byaw }, snow, events,
  };
}

/** Copy a penguin's networked state onto a sim penguin. */
export function applyPenguinState(p: Penguin, s: PenguinState) {
  p.x = s.x; p.y = s.y; p.z = s.z; p.vx = s.vx; p.vy = s.vy; p.vz = s.vz;
  p.yaw = s.yaw; p.lookYaw = s.lookYaw; p.lookPitch = s.lookPitch;
  p.alive = s.alive; p.grounded = s.grounded; p.sliding = s.sliding; p.surfing = s.surfing; p.onIce = s.onIce;
  p.onProp = s.onProp; p.onSlide = s.onSlide; p.charging = s.charging; p.aimOk = s.aimOk; p.slumping = s.slumping;
  p.action = s.action; p.charge = s.charge; p.throwAnim = s.throwAnim; p.throwCd = s.throwCd;
  applyPenguinStats(p, s);
  p.slideSlowT = s.slideSlowT; p.plowLoad = s.plowLoad;
}

/** The parts the client never predicts (the server decides them). */
export function applyPenguinStats(p: Penguin, s: PenguinState) {
  p.carried = s.carried; p.health = s.health; p.mitten = s.mitten; p.invuln = s.invuln; p.downT = s.downT;
  p.packProgress = s.packProgress; p.buildBlock = s.buildBlock; p.noSnowT = s.noSnowT;
  p.splats = s.splats; p.downs = s.downs; p.lastHitBy = s.lastHitBy;
}

// ───────────────────────── snow changes ─────────────────────────
/** 5 bytes per voxel: 24-bit index, density, hardness. */
export function applySnow(field: { density: Uint8Array; hard: Uint8Array }, snow: Uint8Array, onCell?: (id: number) => void) {
  const D = field.density, H = field.hard, n = D.length;
  for (let o = 0; o + 5 <= snow.length; o += 5) {
    const id = snow[o] | (snow[o + 1] << 8) | (snow[o + 2] << 16);
    if (id >= n) continue;
    D[id] = snow[o + 3]; H[id] = snow[o + 4];
    onCell?.(id);
  }
}
