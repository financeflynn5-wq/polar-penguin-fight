// Soak test: whole online matches, sped up, in every mode. People are played by bot brains whose inputs go through
// the real network path (pack → server queue → unpack), so they use vehicles, guns, the blade, turrets and the tank;
// a couple of "chaos" players send junk, mash every button and switch class; people leave and come back.
// Fails on any exception from the server's step, any NaN/Infinity in the world or in a decoded snapshot.
// Run: npm run test:soak   (MODES=tdm,conquest SIZE=5 MATCHES=1)
import assert from 'node:assert/strict';
import { Room, Client } from '../server/Room';
import * as P from '../src/net/Protocol';
import { emptyInput, World, SKINS, HATS } from '../src/sim/World';
import { BotBrain } from '../src/sim/Bot';
import { CLASS_IDS, ClassId } from '../src/sim/Classes';
import type { Mode } from '../src/world/Maps';

const MODES = (process.env.MODES ?? 'tdm,conquest,breakthrough').split(',') as Mode[];
const SIZE = Number(process.env.SIZE ?? 5);
const MATCHES = Number(process.env.MATCHES ?? 1);
let seed = Number(process.env.SEED ?? 7);
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

interface Fake { c: Client; got: (Uint8Array | string)[]; brain: BotBrain | null; chaos: boolean; seq: number; open: boolean; snaps: number; }

function fake(name: string, cls: ClassId, chaos: boolean, team = -1): Fake {
  const got: (Uint8Array | string)[] = [];
  const f: Fake = { c: null as any, got, brain: null, chaos, seq: 0, open: true, snaps: 0 };
  const ws = { readyState: 1, bufferedAmount: 0, send: (b: Uint8Array | string) => got.push(typeof b === 'string' ? b : new Uint8Array(b)), close: () => { f.open = false; } };
  f.c = { ws: ws as any, name, hat: HATS[Math.floor(rnd() * HATS.length)], cls, skin: SKINS[Math.floor(rnd() * SKINS.length)], team, penguinId: -1, queue: [], last: emptyInput(), lastSeq: -1, ack: 0, held: null, resync: false };
  return f;
}

const bad = (v: number) => typeof v !== 'number' || !Number.isFinite(v);
function checkWorld(w: World, where: string) {
  for (const p of w.penguins) for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'health'] as const) if (bad((p as any)[k])) throw new Error(`${where}: penguin ${p.name} (${p.cls}) ${k} = ${(p as any)[k]}`);
  for (const v of w.vehicles) for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'speed', 'health'] as const) if (bad((v as any)[k])) throw new Error(`${where}: ${v.kind} ${k} = ${(v as any)[k]}`);
  for (const b of w.snowballs) for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz'] as const) if (bad((b as any)[k])) throw new Error(`${where}: snowball ${k} = ${(b as any)[k]}`);
  for (const b of w.bigBalls) for (const k of ['x', 'y', 'z', 'r'] as const) if (bad((b as any)[k])) throw new Error(`${where}: big ball ${k}`);
  for (const p of w.penguins) {
    if (p.riding >= 0) {
      const v = w.vehicles.find(v => v.id === p.riding);
      if (!v) throw new Error(`${where}: ${p.name} rides vehicle ${p.riding} that doesn't exist`);
      if (v.seats[p.seat] !== p.id) throw new Error(`${where}: ${p.name} thinks they're in seat ${p.seat} of ${v.kind} but seats are ${v.seats}`);
      if (!p.alive) throw new Error(`${where}: ${p.name} is splatted but still riding a ${v.kind}`);
    }
  }
  for (const v of w.vehicles) v.seats.forEach((id, s) => {
    if (id < 0) return;
    const p = w.penguin(id);
    if (!p || p.riding !== v.id || p.seat !== s) throw new Error(`${where}: ${v.kind} seat ${s} holds ${id} but that penguin rides ${p?.riding}/${p?.seat}`);
  });
}

function checkSnap(s: P.Snapshot, where: string) {
  const walk = (o: any, path: string) => {
    if (typeof o === 'number') { if (!Number.isFinite(o)) throw new Error(`${where}: snapshot ${path} = ${o}`); return; }
    if (o && typeof o === 'object' && !(o instanceof Uint8Array)) for (const k in o) walk(o[k], `${path}.${k}`);
  };
  walk({ ...s, snow: null }, 'snap');
}

const errors = new Map<string, number>();
const fail = (e: unknown) => { const msg = e instanceof Error ? (e.stack ?? e.message).split('\n').slice(0, 4).join(' | ') : String(e); errors.set(msg, (errors.get(msg) ?? 0) + 1); };

for (const mode of MODES) {
  const t0 = performance.now();
  const room = new Room(SIZE, mode, `soak-${mode}`, () => {});
  const people: Fake[] = [];
  const add = (f: Fake) => { if (room.join(f.c)) { people.push(f); f.brain = f.chaos ? null : new BotBrain(room.world.penguins.findIndex(p => p.id === f.c.penguinId), rnd, Math.floor(rnd() * 10)); } };
  CLASS_IDS.forEach((cls, i) => add(fake(`Brain${i}`, cls, false, mode === 'breakthrough' ? i % 2 : -1)));
  add(fake('Brain3', 'bear', false));
  add(fake('Chaos0', 'yeti', true));
  add(fake('Chaos1', 'penguin', true));
  await new Promise(r => setTimeout(r, 300));
  let matches = 0, ticks = 0, lastWorld = room.world, decoded = 0, rides = new Set<string>(), maxRiders = 0;
  const kinds = new Map<string, number>();
  while (matches < MATCHES && ticks < 60 * 60 * 12) {
    const w = room.world;
    if (w !== lastWorld) { matches++; lastWorld = w; for (const f of people) if (f.brain) f.brain = new BotBrain(w.penguins.findIndex(p => p.id === f.c.penguinId), rnd, Math.floor(rnd() * 10)); if (matches >= MATCHES) break; }
    for (const f of people) {
      const p = w.penguin(f.c.penguinId);
      if (!p) continue;
      let row: unknown;
      if (f.chaos) {
        const i = emptyInput();
        i.moveX = rnd() * 2 - 1; i.moveZ = rnd() < 0.7 ? 1 : rnd() * 2 - 1; i.yaw = (ticks / 200) * (f.c.name === 'Chaos0' ? 1 : -1); i.pitch = rnd() * 3 - 1.5;
        for (const k of ['jump', 'slide', 'fire', 'plow', 'pack', 'dig', 'build', 'use', 'roll', 'turret', 'gun'] as const) (i as any)[k] = rnd() < 0.15;
        i.reward = rnd() < 0.02 ? 1 + Math.floor(rnd() * 3) : 0;
        i.aim = rnd() < 0.8 ? { x: p.x + rnd() * 40 - 20, y: p.y + rnd() * 6 - 2, z: p.z + rnd() * 40 - 20 } : null;
        row = P.packInput(i);
        const r = rnd();
        if (r < 0.002) row = [NaN, Infinity, 'x', null, -5, 1e9, 1e9, 1e9];
        else if (r < 0.004) row = 'junk';
        else if (r < 0.006) row = [1, 1, 0, 0, 0xffff, 0, 0, 0];
      } else {
        P.copyInput(p.input, emptyInput());
        try { f.brain!.think(w, p, 1 / 60); } catch (e) { fail(e); }
        row = P.packInput(p.input);
      }
      room.onInput(f.c, f.seq + 1, [row]); f.seq++;
    }
    // now and then: someone switches class, someone leaves and someone new joins
    if (ticks % 1800 === 900) { const f = people[Math.floor(rnd() * people.length)]; room.setClass(f.c, CLASS_IDS[Math.floor(rnd() * 3)]); }
    if (ticks % 5400 === 2700 && people.length) {
      const f = people.splice(Math.floor(rnd() * people.length), 1)[0];
      room.leave(f.c);
      add(fake(`Late${ticks}`, CLASS_IDS[Math.floor(rnd() * 3)], rnd() < 0.3, mode === 'breakthrough' ? Math.floor(rnd() * 2) : -1));
    }
    try { room.step(); } catch (e) { fail(e); }
    ticks++;
    try { checkWorld(room.world, `${mode} t=${(ticks / 60).toFixed(1)}s ${room.world.phase}`); } catch (e) { fail(e); }
    for (const v of room.world.vehicles) { const n = v.seats.filter(s => s >= 0).length; if (n) { for (const id of v.seats) if (id >= 0) { const q = room.world.penguin(id)!; rides.add(`${q.cls} on ${v.kind} seat ${q.seat}${q.bot ? '' : ' (person)'}`); } } maxRiders = Math.max(maxRiders, n); }
    // what the browsers get
    for (const f of people) {
      for (const m of f.got) {
        if (typeof m === 'string') continue;
        if (m[0] === P.MSG_SNAP) {
          f.snaps++;
          if (f.snaps % 5 === 0) {
            try { const s = P.decodeSnapshot(m); checkSnap(s, `${mode} ${f.c.name}`); decoded++; for (const e of s.events) kinds.set(e.type, (kinds.get(e.type) ?? 0) + 1); } catch (e) { fail(e); }
          }
        } else if (m[0] === P.MSG_MATCH) { try { P.decodeMatch(m); } catch (e) { fail(e); } }
      }
      f.got.length = 0;
    }
    if (ticks % 600 === 0) await new Promise(r => setImmediate(r)); // let the field packing callbacks run
  }
  const w = room.world;
  console.log(`${mode} ${SIZE}v${SIZE}: ${(ticks / 60).toFixed(0)} s simulated in ${((performance.now() - t0) / 1000).toFixed(1)} s, ${matches} match(es) finished, phase ${w.phase}, scores ${w.scores.join('-')}, ${decoded} snapshots decoded`);
  console.log(`   rides seen: ${[...rides].sort().join('; ') || 'none'}`);
  console.log(`   events: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}`);
}

if (errors.size) {
  console.log(`\nFAIL: ${errors.size} distinct error(s):`);
  for (const [m, n] of errors) console.log(`  x${n}: ${m}`);
  process.exit(1);
}
console.log('ok: no errors, no NaNs');
