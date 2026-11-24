// Server/protocol test: run a Room in-process with fake sockets, decode everything the "browsers" get,
// and check that each browser's copy of the snow ends up identical to the server's.
// Run: npm run test:net
import { inflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { Room, Client } from '../server/Room';
import * as P from '../src/net/Protocol';
import { emptyInput } from '../src/sim/World';
import { CFG } from '../src/sim/config';

interface FakeBrowser {
  c: Client; got: (Uint8Array | string)[]; density: Uint8Array | null; hard: Uint8Array | null;
  snaps: number; bytes: number; lastTick: number; lastAck: number; you: number; matches: number; rosters: number; seq: number;
}

function browser(name: string): FakeBrowser {
  const got: (Uint8Array | string)[] = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (b: Uint8Array | string) => got.push(typeof b === 'string' ? b : new Uint8Array(b)), close: () => {} };
  const c: Client = { ws: ws as any, name, hat: 'tophat', team: -1, penguinId: -1, queue: [], last: emptyInput(), lastSeq: -1, ack: 0, held: null, resync: false };
  return { c, got, density: null, hard: null, snaps: 0, bytes: 0, lastTick: -1, lastAck: -1, you: -1, matches: 0, rosters: 0, seq: 0 };
}

function drain(b: FakeBrowser) {
  for (const m of b.got) {
    if (typeof m === 'string') { const j = JSON.parse(m); if (j.t === 'roster') b.rosters++; continue; }
    b.bytes += m.length;
    if (m[0] === P.MSG_MATCH) {
      const { info, field } = P.decodeMatch(m);
      const all = new Uint8Array(inflateRawSync(field));
      const n = all.length / 2;
      b.density = all.slice(0, n); b.hard = all.slice(n);
      b.you = info.you; b.matches++; b.lastTick = info.tick;
      assert.ok(info.roster.some(r => r.id === info.you && !r.bot), 'you are a person in your roster');
    } else if (m[0] === P.MSG_SNAP) {
      assert.ok(b.density, 'a snapshot never arrives before its snow field');
      const s = P.decodeSnapshot(m);
      assert.ok(s.tick > b.lastTick, `snapshots arrive in order (${s.tick} after ${b.lastTick})`);
      assert.ok(s.ack >= b.lastAck || b.lastAck < 0, 'acks only go up');
      b.lastTick = s.tick; b.lastAck = s.ack; b.snaps++;
      P.applySnow({ density: b.density!, hard: b.hard! }, s.snow);
    }
  }
  b.got.length = 0;
}

const room = new Room(5, 'test', () => {});
const A = browser('Flynn'), Bb = browser('Chat'), C = browser('Mod');
assert.ok(room.join(A.c)); assert.ok(room.join(Bb.c));
const teams = [A.c.team, Bb.c.team].sort();
assert.deepEqual(teams, [0, 1], 'two people land on opposite teams');

// let the async deflate finish, then play
await new Promise(r => setTimeout(r, 200));
const players = [A, Bb];
let t0 = performance.now();
const STEP = (ticks: number, act: (b: FakeBrowser, t: number) => void) => {
  for (let t = 0; t < ticks; t++) {
    if (t % 2 === 0) for (const b of players) {
      const rows: P.InputRow[] = [];
      for (let k = 0; k < 2; k++) { const i = emptyInput(); act(b, t + k); i.moveZ = 1; i.yaw = Math.sin((t + k) / 90) * 2; i.plow = (t % 600) < 300; i.build = (t % 600) >= 300 && (t % 600) < 420; i.pack = (t % 600) >= 420; i.aim = { x: 0, y: 2, z: 0 }; i.jump = (t + k) % 240 === 0; rows.push(P.packInput(i)); }
      room.onInput(b.c, b.seq + 1, rows); b.seq += 2;
    }
    room.step();
  }
};
STEP(60 * 20, () => {});
await new Promise(r => setTimeout(r, 50));
// a third person joins mid-build: their field is a copy of the snow as it is right now
assert.ok(room.join(C.c)); players.push(C);
await new Promise(r => setTimeout(r, 200));
STEP(60 * 70, () => {});
const ms = performance.now() - t0;
for (const b of players) drain(b);
const f = room.world.field;
for (const b of players) {
  assert.ok(b.density && b.density.length === f.density.length);
  let diff = 0;
  for (let i = 0; i < f.density.length; i++) if (b.density![i] !== f.density[i] || b.hard![i] !== f.hard[i]) diff++;
  assert.equal(diff, 0, `${b.c.name}'s snow matches the server's exactly`);
  assert.ok(b.lastAck > b.seq - 10, `${b.c.name}'s inputs are being used (ack ${b.lastAck}, sent ${b.seq})`);
}
const secs = (60 * 90) / 60;
console.log(`ok: 3 players, ${room.world.phase} phase, scores ${room.world.scores.join('-')}; ${(ms / (60 * 90)).toFixed(3)} ms per tick incl. encoding`);
console.log(`   download per player: ${players.map(b => `${b.c.name} ${(b.bytes / 1024).toFixed(0)} KB (${b.snaps} snaps)`).join(', ')}; ~${Math.round(A.bytes / secs / 1024)} KB/s before websocket compression`);

// someone leaves: a bot takes their penguin, everyone else hears about it
const leftId = Bb.c.penguinId;
room.leave(Bb.c);
assert.equal(room.world.penguin(leftId)!.bot, true, 'a bot takes over a leaver\'s penguin');
drain(A);
assert.ok(A.rosters >= 2, 'roster updates go out on join and leave');

// end the match: everyone still here gets a fresh field and is seated again
room.world.scores[0] = CFG.scoreToWin;
const before = A.matches;
STEP(60 * 16, () => {});
drain(A); drain(C);
assert.equal(A.matches, before + 1, 'a new match starts after the results screen');
assert.equal(room.world.phase, 'build');
assert.ok(room.world.penguins.filter(p => !p.bot).length === 2, 'both people are seated in the new match');
let diff = 0;
for (let i = 0; i < f.density.length; i++) if (A.density![i] !== room.world.field.density[i]) diff++;
assert.equal(diff, 0, 'the new match field matches');
console.log('ok: leave → bot takes over; match end → new match with everyone seated');
