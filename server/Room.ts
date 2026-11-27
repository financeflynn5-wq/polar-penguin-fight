// One online match: the server runs the real World (the same code the browser uses offline), bots fill every
// slot nobody is playing, and 30 times a second everyone gets a snapshot.
import { deflateRaw, deflateRawSync } from 'node:zlib';
import type { WebSocket } from 'ws';
import { buildMap, mapForMode, Mode, MapId } from '../src/world/Maps';
import { World, PenguinInput, GameEvent, emptyInput, Skin } from '../src/sim/World';
import { BotBrain } from '../src/sim/Bot';
import * as P from '../src/net/Protocol';

const DT = 1 / P.TICK_HZ;
const END_HOLD = 14; // seconds on the results screen before the next match
const MAX_QUEUE = 4; // inputs a player may be ahead before the oldest is merged away
const MAX_HELD = 240; // snapshots held for someone whose snow field is still being packed up
const BACKLOG = 1 << 20; // bytes waiting on a slow connection before we stop sending and resync them

export interface Client {
  ws: WebSocket;
  name: string;
  hat: string;
  skin: Skin;
  team: number;
  penguinId: number;
  queue: { seq: number; input: PenguinInput }[];
  last: PenguinInput;
  lastSeq: number; // newest input sequence number received
  ack: number; // newest input the sim has used
  held: Uint8Array[] | null; // snapshots waiting until their snow field has gone out
  resync: boolean;
  starve?: number; // ticks since their last input arrived
}

// The untouched map is the same for every match, so pack each one once.
const pristine = new Map<MapId, Uint8Array>();
function packField(d: Uint8Array, h: Uint8Array) {
  const all = new Uint8Array(d.length + h.length);
  all.set(d); all.set(h, d.length);
  return all;
}

export class Room {
  world!: World;
  readonly clients = new Set<Client>();
  private bots = new Map<number, BotBrain>();
  private tick = 0;
  private endT = 0;
  private shadowD!: Uint8Array;
  private shadowH!: Uint8Array;
  private dirty = new Set<number>();
  private events: GameEvent[] = [];
  private merged = new Map<string, GameEvent & { n?: number }>();
  private botSeed = 1;

  constructor(readonly size: number, readonly mode: Mode, readonly key: string, private log: (s: string) => void = console.log) {
    this.newMatch();
  }

  get humans() { return this.clients.size; }
  get open() { return this.clients.size < this.size * 2; }

  private rnd = () => { this.botSeed = (this.botSeed * 16807) % 2147483647; return this.botSeed / 2147483647; };

  /** A fresh map, all bots, then everyone already here takes a slot again (on the same team when there's room). */
  private newMatch() {
    const id = mapForMode(this.mode);
    const map = buildMap(id);
    this.world = new World(map, { teamSize: this.size, playerName: '', playerHat: '', allBots: true, mode: this.mode });
    this.bots.clear();
    const slots = [0, 0];
    this.world.penguins.forEach((p, i) => this.bots.set(p.id, new BotBrain(i, this.rnd, slots[p.team]++)));
    const f = this.world.field;
    let packed = pristine.get(id);
    if (!packed) { packed = new Uint8Array(deflateRawSync(packField(f.density, f.hard), { level: 6 })); pristine.set(id, packed); }
    this.shadowD = f.density.slice();
    this.shadowH = f.hard.slice();
    this.dirty.clear();
    this.events.length = 0; this.merged.clear();
    const bx = Math.ceil(f.nx / 8), by = Math.ceil(f.ny / 8), bz = Math.ceil(f.nz / 8);
    f.onDirty = (i0, j0, k0, i1, j1, k1) => {
      const ka = Math.max(0, k0 >> 3), kb = Math.min(bz - 1, k1 >> 3);
      const ia = Math.max(0, i0 >> 3), ib = Math.min(bx - 1, i1 >> 3);
      const ja = Math.max(0, j0 >> 3), jb = Math.min(by - 1, j1 >> 3);
      for (let k = ka; k <= kb; k++) for (let i = ia; i <= ib; i++) for (let j = ja; j <= jb; j++) this.dirty.add((k * bx + i) * by + j);
    };
    this.endT = 0;
    for (const c of this.clients) {
      const p = this.world.addHuman(c.name, c.hat, c.team, c.skin)!;
      this.seat(c, p.id, p.team);
    }
    for (const c of this.clients) this.sendMatch(c, packed, true);
  }

  private seat(c: Client, id: number, team: number) {
    this.bots.delete(id);
    c.penguinId = id; c.team = team;
    c.queue.length = 0; c.last = emptyInput(); c.ack = c.lastSeq;
  }

  /** Someone joins: they take a bot's place. Returns false if every slot is taken. */
  join(c: Client) {
    const p = this.world.addHuman(c.name, c.hat, c.team, c.skin);
    if (!p) return false;
    this.clients.add(c);
    this.seat(c, p.id, p.team);
    this.log(`[${this.key}] ${c.name} joined team ${p.team} (${this.humans} here)`);
    this.sendField(c);
    this.broadcastRoster(c);
    return true;
  }

  leave(c: Client) {
    if (!this.clients.delete(c)) return;
    this.world.removeHuman(c.penguinId);
    const p = this.world.penguin(c.penguinId);
    if (p && p.bot) this.bots.set(p.id, new BotBrain(this.world.penguins.indexOf(p), this.rnd, Math.floor(this.rnd() * 10)));
    this.log(`[${this.key}] ${c.name} left (${this.humans} here)`);
    this.broadcastRoster();
  }

  /** The snow as it is right now, packed up off the main thread; their snapshots wait until it has gone out. */
  private sendField(c: Client) {
    const f = this.world.field;
    const raw = packField(f.density, f.hard);
    c.held = [];
    const world = this.world;
    deflateRaw(raw, { level: 4 }, (err, out) => {
      if (!this.clients.has(c) || this.world !== world) return; // left, or a new match already sent them a field
      if (err) { this.log(`[${this.key}] could not pack the snow: ${err.message}`); c.ws.close(1011, 'server error'); return; }
      this.sendMatch(c, new Uint8Array(out), false);
    });
  }

  private sendMatch(c: Client, field: Uint8Array, fresh: boolean) {
    const info: P.MatchInfo = { you: c.penguinId, size: this.size, tick: this.tick, roster: this.world.roster(), phase: this.world.phase, mode: this.mode };
    const held = fresh ? [] : c.held ?? [];
    c.held = null;
    c.resync = false;
    this.send(c, P.encodeMatch(info, field));
    for (const s of held) this.sendSnap(c, s);
  }

  private broadcastRoster(except?: Client) {
    const msg = JSON.stringify({ t: 'roster', roster: this.world.roster() });
    for (const c of this.clients) if (c !== except && !c.held) this.sendText(c, msg);
  }

  /** Inputs arrive in batches, one row per tick, numbered so repeats and stragglers are ignored. */
  onInput(c: Client, first: number, rows: unknown[]) {
    if (!Number.isInteger(first) || first < 0) return;
    for (let n = 0; n < rows.length && n < 16; n++) {
      const seq = first + n;
      if (seq <= c.lastSeq) continue;
      c.lastSeq = seq;
      c.queue.push({ seq, input: P.unpackInput(rows[n], emptyInput()) });
    }
    // too far ahead (a laggy burst): fold the oldest into the next, keeping its hop and any reward it used
    while (c.queue.length > MAX_QUEUE) {
      const old = c.queue.shift()!;
      if (old.input.jump) c.queue[0].input.jump = true;
      if (old.input.reward && !c.queue[0].input.reward) c.queue[0].input.reward = old.input.reward;
    }
  }

  step() {
    const w = this.world;
    this.tick++;
    for (const c of this.clients) {
      const p = w.penguin(c.penguinId);
      if (!p) continue;
      const next = c.queue.shift();
      if (next) { P.copyInput(next.input, p.input); P.copyInput(next.input, c.last); c.ack = next.seq; c.starve = 0; }
      else {
        // nothing new yet: keep doing the same thing for a moment, then stand still (a hidden tab sends nothing)
        c.starve = (c.starve ?? 0) + 1;
        if (c.starve > 15) { const yaw = c.last.yaw, pitch = c.last.pitch; c.last = emptyInput(); c.last.yaw = yaw; c.last.pitch = pitch; }
        P.copyInput(c.last, p.input); p.input.jump = false; c.last.jump = false; p.input.reward = 0; c.last.reward = 0;
      }
    }
    for (const [id, brain] of this.bots) {
      const p = w.penguin(id);
      if (p) brain.think(w, p, DT);
    }
    w.step(DT);
    for (const e of w.events) this.collect(e);
    w.events.length = 0;
    if (this.tick % P.SNAP_EVERY === 0) this.snapshot();
    if (w.phase === 'end') {
      this.endT += DT;
      if (this.endT > END_HOLD && this.clients.size) this.newMatch();
    }
  }

  /** The many-per-second effects (snow flying off mittens) are merged per penguin per snapshot. */
  private collect(e: GameEvent) {
    if (e.type === 'plow' || e.type === 'dig' || e.type === 'build' || e.type === 'packTick') {
      const k = e.type + e.pid;
      const m = this.merged.get(k);
      if (m && 'mass' in m && 'mass' in e) { const mass = m.mass + e.mass; Object.assign(m, e); m.mass = mass; m.n = (m.n ?? 1) + 1; }
      else if (!m) { const copy = { ...e }; this.merged.set(k, copy); this.events.push(copy); }
      return;
    }
    this.events.push(e);
  }

  private snapshot() {
    const snow = this.snowChanges();
    const buf = P.encodeSnapshot(this.world, this.tick, snow, this.events);
    this.events.length = 0; this.merged.clear();
    for (const c of this.clients) this.sendSnap(c, buf);
  }

  private sendSnap(c: Client, shared: Uint8Array) {
    if (c.held) {
      c.held.push(shared);
      if (c.held.length > MAX_HELD) c.ws.close(1011, 'too slow');
      return;
    }
    if (c.ws.bufferedAmount > BACKLOG) {
      // their connection can't keep up: stop sending, then start them over with a fresh copy of the snow
      if (!c.resync) { c.resync = true; this.log(`[${this.key}] ${c.name} is lagging, will resync`); }
      return;
    }
    if (c.resync) { this.sendField(c); c.held!.push(shared); return; }
    const b = shared.slice();
    new DataView(b.buffer).setUint32(P.ACK_OFFSET, c.ack >>> 0, true);
    this.send(c, b);
  }

  /** Every voxel whose snow changed since the last snapshot: 5 bytes each (24-bit index, density, hardness). */
  private snowChanges() {
    if (!this.dirty.size) return new Uint8Array(0);
    const f = this.world.field, D = f.density, H = f.hard, sd = this.shadowD, sh = this.shadowH;
    const bx = Math.ceil(f.nx / 8), by = Math.ceil(f.ny / 8);
    const out = new P.Writer(4096);
    for (const key of this.dirty) {
      const bj = key % by, rest = (key - bj) / by, bi = rest % bx, bk = (rest - bi) / bx;
      const i0 = bi * 8, j0 = bj * 8, k0 = bk * 8;
      const i1 = Math.min(f.nx, i0 + 8), j1 = Math.min(f.ny, j0 + 8), k1 = Math.min(f.nz, k0 + 8);
      for (let k = k0; k < k1; k++) for (let i = i0; i < i1; i++) {
        const base = (k * f.nx + i) * f.ny;
        for (let j = j0; j < j1; j++) {
          const id = base + j;
          if (D[id] === sd[id] && H[id] === sh[id]) continue;
          sd[id] = D[id]; sh[id] = H[id];
          out.u8(id & 255); out.u8((id >> 8) & 255); out.u8((id >> 16) & 255); out.u8(D[id]); out.u8(H[id]);
        }
      }
    }
    this.dirty.clear();
    return out.done().slice();
  }

  private send(c: Client, b: Uint8Array) {
    if (c.ws.readyState !== 1) return;
    try { c.ws.send(b); } catch { /* closing */ }
  }

  private sendText(c: Client, s: string) {
    if (c.ws.readyState !== 1) return;
    try { c.ws.send(s); } catch { /* closing */ }
  }

  /** For the hub's moderation page and the menu's head count. */
  players() {
    return [...this.clients].map(c => ({ c, name: c.name, team: c.team }));
  }
}
