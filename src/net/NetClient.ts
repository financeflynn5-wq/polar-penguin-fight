// The browser side of online play.
//
// The server runs the real match. This keeps a mirror World in step with it:
//  - your own penguin is predicted: it moves the moment you press a key, using the same movement code as the
//    server, and is quietly corrected whenever the server's version (30 times a second) disagrees;
//  - everyone and everything else is shown about 0.1 s in the past, smoothly blended between snapshots;
//  - snow changes are written straight into the local snow field, so the renderer re-meshes them;
//  - turrets, flags and everyone's streak rewards are copied over as the server has them;
//  - hits, splats, throws and the rest come through as the same GameEvents the offline game uses.
import * as P from './Protocol';
import { World, Penguin, PenguinInput, GameEvent, RosterEntry, emptyInput, asSkin, type Skin, Snowball, BigBall, Flake, Turret } from '../sim/World';
import type { Mode } from '../world/Maps';
import type { Vehicle } from '../sim/Vehicles';
import type { ClassId } from '../sim/Classes';

const STEP = 1 / P.TICK_HZ;
const DELAY = 6; // ticks behind the server that other penguins are shown (100 ms): room for a late snapshot
const HISTORY = 180; // inputs kept for replay (3 s)

export interface NetHooks {
  /** A match started (or you just joined one): build the world from this. */
  onMatch(info: P.MatchInfo, density: Uint8Array, hard: Uint8Array): void;
  /** Someone joined or left: names, hats and who's a bot changed. */
  onRoster(roster: RosterEntry[]): void;
  /** Couldn't join, or lost the connection. */
  onClose(reason: string): void;
}

export interface JoinRequest { name: string; hat: string; skin?: Skin; size: number; mode: Mode; /** Breakthrough: the side you'd like (0 attack, 1 defend) */ team?: number; cls?: ClassId; }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpA = (a: number, b: number, t: number) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; };

/** Where the game server is: ?server=, then the build's VITE_SERVER, then the page's own address. */
export function serverUrl(): string {
  const q = new URLSearchParams(location.search).get('server');
  const env = (import.meta as any).env?.VITE_SERVER as string | undefined;
  const base = q || env || location.origin;
  const u = new URL(base, location.href);
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  if (!u.pathname.endsWith('/ws')) u.pathname = u.pathname.replace(/\/?$/, '/ws');
  return u.toString();
}

/** Is a game server answering? Returns its head count, or null when there's no server (e.g. the GitHub Pages copy). */
export async function serverStatus(): Promise<{ players: number; max: number } | null> {
  try {
    const u = new URL(serverUrl());
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = u.pathname.replace(/ws$/, 'status');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(u, { cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    if (j?.game !== 'polar-penguin-fight') return null;
    if (j.protocol !== P.PROTOCOL) return null;
    return { players: j.players | 0, max: j.max | 0 };
  } catch { return null; }
}

export class NetClient {
  private ws: WebSocket;
  private chain: Promise<void> = Promise.resolve();
  private world: World | null = null;
  private seq = 0;
  private history: { seq: number; input: PenguinInput }[] = [];
  private outbox: P.InputRow[] = [];
  private outFirst = 1;
  private snaps: P.Snapshot[] = [];
  private latest: P.Snapshot | null = null;
  private reconciled = -1;
  private events: { tick: number; e: GameEvent }[] = [];
  private offset = NaN; // server tick minus local tick
  private renderTick = 0;
  private pingT = 0;
  private closed = false;
  /** where your penguin is drawn relative to where it is (eases away small corrections) */
  readonly drawOffset = { x: 0, y: 0, z: 0 };
  rtt = 0;
  predicting = false;
  you = -1;

  constructor(url: string, join: JoinRequest, private hooks: NetHooks) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => this.ws.send(JSON.stringify({ t: 'join', v: P.PROTOCOL, ...join }));
    this.ws.onmessage = ev => { const d = ev.data; this.chain = this.chain.then(() => this.receive(d)).catch(e => console.error('net:', e)); };
    this.ws.onclose = ev => {
      if (this.closed) return;
      this.closed = true;
      const why = ev.code === 4001 ? 'You were removed from the match.' : ev.code === 4003 ? 'You are banned from this server.'
        : ev.reason || 'Lost the connection to the game server.';
      this.hooks.onClose(why);
    };
  }

  /** Come back as this class next time you respawn. */
  setClass(cls: ClassId) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'cls', cls })); }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.close(1000, 'left'); } catch { /* already closed */ }
  }

  private async receive(data: unknown) {
    if (this.closed) return;
    if (typeof data === 'string') {
      const m = JSON.parse(data);
      if (m.t === 'roster') this.applyRoster(m.roster);
      else if (m.t === 'pong') this.rtt = performance.now() - m.c;
      else if (m.t === 'joinErr') { this.closed = true; this.ws.close(); this.hooks.onClose(m.err); }
      return;
    }
    const buf = new Uint8Array(data as ArrayBuffer);
    if (buf[0] === P.MSG_MATCH) {
      const { info, field } = P.decodeMatch(buf);
      const all = new Uint8Array(await new Response(new Blob([field as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      const n = all.length / 2;
      this.world = null;
      this.snaps.length = 0; this.events.length = 0; this.latest = null; this.reconciled = -1;
      this.history.length = 0; this.offset = NaN; this.renderTick = 0;
      this.you = info.you;
      this.hooks.onMatch(info, all.subarray(0, n), all.subarray(n));
    } else if (buf[0] === P.MSG_SNAP) {
      const s = P.decodeSnapshot(buf);
      if (!this.world) return;
      // snow goes straight into the field (the renderer re-meshes what changed)
      const f = this.world.field;
      P.applySnow(f, s.snow, id => {
        const j = id % f.ny, rest = (id - j) / f.ny, i = rest % f.nx, k = (rest - i) / f.nx;
        f.onDirty?.(i, j, k, i, j, k);
      });
      for (const e of s.events) this.events.push({ tick: s.tick, e });
      this.snaps.push(s);
      // a hidden tab stops drawing frames: don't pile up what it will never show
      if (this.snaps.length > 90) this.snaps.splice(0, this.snaps.length - 90);
      if (this.events.length > 1500) this.events.splice(0, this.events.length - 1500);
      if (!this.latest || s.tick > this.latest.tick) this.latest = s;
      const sample = s.tick - performance.now() / 1000 * P.TICK_HZ;
      // the clock offset follows the fastest-arriving snapshots, and drifts down slowly if the connection gets slower
      if (!(sample <= this.offset)) this.offset = sample;
    }
  }

  private applyRoster(roster: RosterEntry[]) {
    const w = this.world;
    if (!w) return;
    for (const r of roster) {
      const p = w.penguin(r.id);
      if (p) { p.name = r.name; p.hat = r.hat; p.bot = r.bot; p.cls = r.cls ?? p.cls; p.skin = asSkin(r.skin); }
    }
    this.hooks.onRoster(roster);
  }

  /** The game built the world for the match it was just told about. */
  attach(w: World) {
    this.world = w;
    this.predicting = false;
    this.drawOffset.x = this.drawOffset.y = this.drawOffset.z = 0;
  }

  /** One 60 Hz tick of your own penguin: send the input and move ahead of the server. */
  step(w: World, me: Penguin) {
    if (w !== this.world) return;
    const input = P.copyInput(me.input, emptyInput());
    const seq = ++this.seq;
    if (!this.outbox.length) this.outFirst = seq;
    this.outbox.push(P.packInput(input));
    this.history.push({ seq, input });
    if (this.history.length > HISTORY) this.history.shift();
    if (this.predicting) w.predictPenguin(me, STEP);
    else { me.input.jump = false; me.input.reward = 0; } // sent once; a press while you're down isn't saved for later
  }

  /** Once a frame: send inputs, line up with the server, and show everyone else where they were 0.1 s ago. */
  present(w: World, me: Penguin, dt: number) {
    if (w !== this.world || this.closed) return;
    const now = performance.now();
    if (this.outbox.length && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ t: 'in', s: this.outFirst, i: this.outbox }));
      this.outbox.length = 0;
    }
    if (now - this.pingT > 2000 && this.ws.readyState === 1) { this.pingT = now; this.ws.send(JSON.stringify({ t: 'ping', c: now })); }
    if (!this.latest) return;

    this.reconcile(w, me);

    // render clock: a little behind the newest snapshot
    const local = now / 1000 * P.TICK_HZ;
    this.offset -= dt * 0.5; // let it settle later if the connection got slower (the next snapshot pushes it back up)
    let target = local + this.offset - DELAY;
    if (this.latest.tick - target > 30) { this.offset = this.latest.tick - local; target = local + this.offset - DELAY; }
    this.renderTick = Math.max(this.renderTick, target);
    if (this.renderTick > this.latest.tick + 30) this.renderTick = target; // the server restarted its clock
    const rt = this.renderTick;

    // drop snapshots we're past, keeping the one just before the render time
    while (this.snaps.length > 2 && this.snaps[1].tick <= rt) this.snaps.shift();
    const a = this.snaps[0], b = this.snaps.find(s => s.tick > rt) ?? a;
    const t = b === a ? 0 : Math.max(0, Math.min(1, (rt - a.tick) / (b.tick - a.tick)));
    this.applyInterpolated(w, me, a, b, t);

    // events happen when their snapshot's moment is shown
    let n = 0;
    while (n < this.events.length && this.events[n].tick <= rt) n++;
    for (const { e } of this.events.splice(0, n)) {
      if (this.predicting && 'pid' in e && e.pid === me.id && (e.type === 'jump' || e.type === 'slideStart' || e.type === 'launch' || e.type === 'rush')) continue; // already played
      w.events.push(e);
    }

    const k = Math.exp(-dt * 10);
    this.drawOffset.x *= k; this.drawOffset.y *= k; this.drawOffset.z *= k;
  }

  /** Take the server's word for your penguin, then replay the inputs it hasn't seen yet. */
  private reconcile(w: World, me: Penguin) {
    const s = this.latest!;
    if (s.tick === this.reconciled) return;
    this.reconciled = s.tick;
    w.phase = s.phase; // movement depends on the phase (build-phase line, no moving at the end)
    w.sector = Math.min(s.sector, Math.max(0, w.map.sectors.length - 1)); w.holdT = s.holdT; // ... and on Breakthrough's hold line
    w.guns.patches = s.patches; // ... and on the ice patches under your feet
    const st = s.penguins.find(p => p.id === me.id);
    if (!st) return;
    while (this.history.length && this.history[0].seq <= s.ack) this.history.shift();
    // down, or on a vehicle (the server drives it): shown like everyone else until you're back on your feet
    if (!st.alive || s.phase === 'end' || s.vehicles.some(v => v.seats.includes(me.id))) {
      if (this.predicting) { this.predicting = false; this.drawOffset.x = this.drawOffset.y = this.drawOffset.z = 0; }
      return;
    }
    me.riding = -1; me.covered = false;
    const wasPredicting = this.predicting;
    const bx = me.x, by = me.y, bz = me.z;
    const live = P.copyInput(me.input, emptyInput());
    P.applyPenguinState(me, st);
    me.lookYaw = live.yaw; me.lookPitch = live.pitch;
    const evs = w.events.length;
    for (const h of this.history) { P.copyInput(h.input, me.input); w.predictPenguin(me, STEP); }
    w.events.length = evs; // replays don't make sounds twice
    P.copyInput(live, me.input);
    me.input.jump = false;
    this.predicting = true;
    if (wasPredicting) {
      const ox = this.drawOffset.x + bx - me.x, oy = this.drawOffset.y + by - me.y, oz = this.drawOffset.z + bz - me.z;
      if (Math.hypot(ox, oy, oz) < 2) { this.drawOffset.x = ox; this.drawOffset.y = oy; this.drawOffset.z = oz; }
      else { this.drawOffset.x = this.drawOffset.y = this.drawOffset.z = 0; }
    }
    me.px = me.x; me.py = me.y; me.pz = me.z;
  }

  private applyInterpolated(w: World, me: Penguin, a: P.Snapshot, b: P.Snapshot, t: number) {
    w.phase = a.phase; w.phaseT = a.phaseT;
    w.scores[0] = a.scores[0]; w.scores[1] = a.scores[1];
    w.piles[0] = a.piles[0]; w.piles[1] = a.piles[1];
    w.winner = a.winner;
    w.lastStandT = a.lastStandT;
    // what your own penguin's movement depends on comes from the newest snapshot, so the prediction agrees with the server
    const now = this.latest ?? a;
    w.phase = now.phase; w.sector = Math.min(now.sector, Math.max(0, w.map.sectors.length - 1)); w.holdT = now.holdT;

    const bp = new Map(b.penguins.map(s => [s.id, s]));
    for (const sa of a.penguins) {
      const p = w.penguin(sa.id);
      if (!p) continue;
      const sb = bp.get(sa.id) ?? sa;
      if (p === me && this.predicting) {
        const mine = this.latest!.penguins.find(s => s.id === me.id);
        if (mine) P.applyPenguinStats(me, mine);
        continue;
      }
      P.applyPenguinState(p, sa);
      const jump = Math.hypot(sb.x - sa.x, sb.z - sa.z) > 6; // respawned: don't slide across the map
      const u = jump ? 1 : t;
      p.x = lerp(sa.x, sb.x, u); p.y = lerp(sa.y, sb.y, u); p.z = lerp(sa.z, sb.z, u);
      p.vx = lerp(sa.vx, sb.vx, u); p.vy = lerp(sa.vy, sb.vy, u); p.vz = lerp(sa.vz, sb.vz, u);
      p.yaw = lerpA(sa.yaw, sb.yaw, u); p.lookYaw = lerpA(sa.lookYaw, sb.lookYaw, u); p.lookPitch = lerp(sa.lookPitch, sb.lookPitch, u);
      p.charge = lerp(sa.charge, sb.charge, u);
      p.px = p.x; p.py = p.y; p.pz = p.z;
      p.input.moveX = 0;
    }

    const bb = new Map(b.balls.map(s => [s.id, s]));
    const balls: Snowball[] = [];
    for (const s of a.balls) {
      const e = bb.get(s.id) ?? s;
      const x = lerp(s.x, e.x, t), y = lerp(s.y, e.y, t), z = lerp(s.z, e.z, t);
      balls.push({ id: s.id, owner: -1, team: s.team, x, y, z, px: x, py: y, pz: z, vx: s.vx, vy: s.vy, vz: s.vz, age: 0, alive: true, kind: s.kind, big: s.big, cat: s.cat });
    }
    w.snowballs = balls;

    const bigB = new Map(b.bigBalls.map(s => [s.id, s]));
    const bigs: BigBall[] = [];
    for (const s of a.bigBalls) {
      const e = bigB.get(s.id) ?? s;
      const x = lerp(s.x, e.x, t), y = lerp(s.y, e.y, t), z = lerp(s.z, e.z, t);
      bigs.push({ id: s.id, x, y, z, px: x, py: y, pz: z, vx: lerp(s.vx, e.vx, t), vy: lerp(s.vy, e.vy, t), vz: lerp(s.vz, e.vz, t),
        r: lerp(s.r, e.r, t), alive: true, grounded: s.grounded, lastPusher: -1, pushT: 0, restT: 0 });
    }
    w.bigBalls = bigs;

    const fl: Flake[] = [];
    for (const s of a.flakes) fl.push({ id: s.id, spot: s.spot, x: s.x, y: s.y, z: s.z, active: s.active, t: 0 });
    w.flakes = fl;

    // turrets stand still; only their aim turns
    const tb = new Map(b.turrets.map(s => [s.id, s]));
    const turrets: Turret[] = [];
    for (const s of a.turrets) {
      const e = tb.get(s.id) ?? s;
      turrets.push({ id: s.id, owner: s.owner, team: s.team, x: s.x, y: s.y, z: s.z, yaw: lerpA(s.yaw, e.yaw, t),
        health: s.health, ammo: s.ammo, cd: 0, target: -1, scanT: 0, fireT: s.fireT, age: 0, alive: true });
    }
    w.turrets = turrets;
    for (const s of a.points) { const pt = w.points[s.id]; if (pt) P.applyPoint(pt, s); }

    // vehicles, and who is sitting on them
    const vb = new Map(b.vehicles.map(s => [s.id, s]));
    const old = new Map(w.vehicles.map(v => [v.id, v]));
    const vehicles: Vehicle[] = [];
    for (const p of w.penguins) if (!(p === me && this.predicting)) { p.riding = -1; p.covered = false; }
    for (const s of a.vehicles) {
      const e = vb.get(s.id) ?? s;
      const jump = Math.hypot(e.x - s.x, e.z - s.z) > 8; // sent back to camp: don't slide across the map
      const u = jump ? 1 : t;
      const x = lerp(s.x, e.x, u), y = lerp(s.y, e.y, u), z = lerp(s.z, e.z, u), yaw = lerpA(s.yaw, e.yaw, u);
      const v: Vehicle = old.get(s.id) ?? {
        id: s.id, kind: s.kind, team: s.team, slot: s.slot, x, y, z, px: x, py: y, pz: z, yaw, pyaw: yaw, pitch: 0, roll: 0,
        vx: 0, vy: 0, vz: 0, speed: 0, steer: 0, grounded: true, health: s.health, seats: [], alive: true, idleT: 0, lastDriver: -1,
        hitT: 9, load: 0, climb: 0, snowAcc: 0, snowT: 0, stuckT: 0, plowDown: false, plowCd: 0,
      };
      v.x = v.px = x; v.y = v.py = y; v.z = v.pz = z; v.yaw = v.pyaw = yaw;
      v.pitch = lerp(s.pitch, e.pitch, u); v.roll = lerp(s.roll, e.roll, u);
      v.vx = lerp(s.vx, e.vx, u); v.vy = lerp(s.vy, e.vy, u); v.vz = lerp(s.vz, e.vz, u);
      v.speed = lerp(s.speed, e.speed, u); v.steer = lerp(s.steer, e.steer, u);
      v.grounded = s.grounded; v.plowDown = s.plowDown; v.health = s.health; v.hitT = s.hitT; v.load = s.load; v.team = s.team; v.slot = s.slot;
      v.seats = s.seats.slice();
      if (s.tank) {
        // the snow tank's turret, gun and turntable swing smoothly between snapshots
        const et = e.tank ?? s.tank;
        v.tank = { ...s.tank, aimYaw: lerpA(s.tank.aimYaw, et.aimYaw, u), aimPitch: lerp(s.tank.aimPitch, et.aimPitch, u), catYaw: lerpA(s.tank.catYaw, et.catYaw, u) };
      }
      s.seats.forEach((id, seat) => {
        const p = id >= 0 ? w.penguin(id) : undefined;
        if (p && !(p === me && this.predicting)) { p.riding = v.id; p.seat = seat; p.covered = v.kind === 'snowplow'; }
      });
      vehicles.push(v);
    }
    w.vehicles = vehicles;
    w.garage.plowT = a.plowT;

    const ba = a.board, bz = b.board;
    w.board.active = ba.active; w.board.holder = ba.holder;
    w.board.x = lerp(ba.x, bz.x, t); w.board.y = lerp(ba.y, bz.y, t); w.board.z = lerp(ba.z, bz.z, t); w.board.yaw = lerpA(ba.yaw, bz.yaw, t);

    // guns waiting to be picked up; the ice patches come from the newest snapshot because your own penguin can slip on them
    w.guns.crates = a.crates;
    w.guns.patches = now.patches;
  }
}
