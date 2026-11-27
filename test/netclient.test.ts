// End-to-end online test without a browser: starts the real game server, connects headless clients that use the
// real NetClient (prediction, reconciliation, interpolation) over a connection with added lag and jitter, and
// measures how well your own penguin's prediction holds up and how smoothly others are shown.
// Run: npm run test:online
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { buildMap, mapForMode, Mode } from '../src/world/Maps';
import { World, Penguin, type Skin } from '../src/sim/World';
import { NetClient } from '../src/net/NetClient';

const PORT = 8000 + Math.floor(Math.random() * 900);
const LAG = Number(process.env.LAG ?? 60); // ms each way
const JITTER = Number(process.env.JITTER ?? 25); // ms extra, random
const SECONDS = Number(process.env.SECONDS ?? 20);
const MODE = (process.env.MODE ?? 'tdm') as Mode;

const server = spawn(process.execPath, ['server-dist/main.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise<void>(res => server.stdout!.on('data', d => { if (String(d).includes('server on')) res(); }));

interface Bot { name: string; net: NetClient; world: World | null; me: Penguin | null; corrections: number[]; starved: number; frames: number; matches: number; events: number; }

function connect(name: string, size: number, skin?: Skin): Bot {
  const b: Bot = { name, net: null as any, world: null, me: null, corrections: [], starved: 0, frames: 0, matches: 0, events: 0 };
  b.net = new NetClient(`ws://localhost:${PORT}/ws`, { name, hat: 'viking', skin, size, mode: MODE }, {
    onMatch: (info, density, hard) => {
      assert.equal(info.mode, MODE);
      const map = buildMap(mapForMode(info.mode));
      map.field.density.set(density); map.field.hard.set(hard);
      b.world = new World(map, { teamSize: info.size, playerName: '', playerHat: '', roster: info.roster, meId: info.you, mode: info.mode });
      b.me = b.world.player;
      b.net.attach(b.world);
      b.matches++;
    },
    onRoster: () => {},
    onClose: r => console.log(`${name} closed: ${r}`),
  });
  // add lag and jitter both ways
  const ws = (b.net as any).ws as WebSocket;
  const send = ws.send.bind(ws);
  let lastOut = 0, lastIn = 0;
  (ws as any).send = (d: any) => { const at = Math.max(lastOut, performance.now() + LAG + Math.random() * JITTER); lastOut = at; setTimeout(() => { if (ws.readyState === 1) send(d); }, at - performance.now()); };
  const wrap = () => {
    const on = ws.onmessage!;
    ws.onmessage = ev => { const at = Math.max(lastIn, performance.now() + LAG + Math.random() * JITTER); lastIn = at; setTimeout(() => on.call(ws, ev), at - performance.now()); };
  };
  const tryWrap = setInterval(() => { if (ws.onmessage) { wrap(); clearInterval(tryWrap); } }, 1);
  return b;
}

const A = connect('Alpha', 5, 'classic'), B = connect('Bravo', 5);
const bots = [A, B];
const t0 = performance.now();
let last = performance.now(), acc = 0, tick = 0;
const STEP = 1 / 60;
let prevOffset = new Map<Bot, number>();
await new Promise<void>(done => {
  const iv = setInterval(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    acc += dt;
    while (acc >= STEP) {
      acc -= STEP; tick++;
      for (const b of bots) {
        if (!b.world || !b.me) continue;
        const i = b.me.input;
        // wander: walk, turn, hop now and then, belly slide sometimes, plow a bit
        i.moveZ = 1; i.moveX = Math.sin(tick / 50) > 0.7 ? 1 : 0;
        i.yaw = (b.me.team === 0 ? -Math.PI / 2 : Math.PI / 2) + Math.sin(tick / 160) * 1.2;
        i.jump = tick % 150 === 0; i.slide = tick % 400 > 340; i.plow = tick % 600 > 450;
        b.net.step(b.world, b.me);
      }
    }
    for (const b of bots) {
      if (!b.world || !b.me) continue;
      const before = Math.hypot(b.net.drawOffset.x, b.net.drawOffset.y, b.net.drawOffset.z);
      b.net.present(b.world, b.me, dt);
      const after = Math.hypot(b.net.drawOffset.x, b.net.drawOffset.y, b.net.drawOffset.z);
      if (after > before + 1e-4) b.corrections.push(after - before);
      const net = b.net as any;
      if (net.snaps.length && net.renderTick > net.latest.tick) b.starved++;
      b.frames++;
      b.events += b.world.events.length; b.world.events.length = 0;
    }
    if (now - t0 > SECONDS * 1000) { clearInterval(iv); done(); }
  }, 16);
});

for (const b of bots) {
  const c = b.corrections.sort((x, y) => x - y);
  const pct = (q: number) => (c.length ? c[Math.min(c.length - 1, Math.floor(c.length * q))] : 0).toFixed(3);
  console.log(`${b.name}: rtt ${Math.round(b.net.rtt)} ms, ${b.frames} frames, ${(100 * b.starved / b.frames).toFixed(1)}% frames past the newest snapshot, ` +
    `${c.length} corrections (median ${pct(0.5)} m, 95% ${pct(0.95)} m, max ${pct(1)} m), ${b.events} events`);
  assert.equal(b.matches, 1);
  assert.ok(b.net.predicting, `${b.name} is predicting its own penguin`);
}
// each sees the other one roughly where the other thinks it is (they're shown ~0.1 s + lag in the past)
const aInB = B.world!.penguin(A.me!.id)!;
const d = Math.hypot(aInB.x - A.me!.x, aInB.z - A.me!.z);
console.log(`Bravo sees Alpha ${d.toFixed(2)} m from where Alpha is (Alpha is moving ~5 m/s)`);
assert.ok(d < 3, 'others are shown close to where they are');
// skins are looks only, but everyone sees the one you picked
assert.equal(A.me!.skin, 'classic', 'Alpha wears the classic penguin');
assert.equal(aInB.skin, 'classic', 'Bravo sees Alpha in the classic penguin');
assert.equal(A.world!.penguin(B.me!.id)!.skin, 'new', 'Alpha sees Bravo in the new penguin');
for (const b of bots) b.net.close();
server.kill();
console.log('ok');
