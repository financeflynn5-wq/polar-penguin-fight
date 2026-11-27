// Snow tank checks, headless: (1) a scripted shoot-out on an empty field, (2) bot matches in every mode, counting what
// the tanks got up to.   npm run tank -- [matches per mode] [team size]
import { buildMap, mapForMode, Mode } from '../../src/world/Maps';
import { World, Penguin } from '../../src/sim/World';
import { BotBrain } from '../../src/sim/Bot';
import { tryEnter } from '../../src/sim/Vehicles';
import { CFG } from '../../src/sim/config';
import { encodeSnapshot, decodeSnapshot } from '../../src/net/Protocol';

const N = Math.max(1, +(process.argv[2] ?? 1));
const SIZE = +(process.argv[3] ?? 5);
const DT = 1 / 60;

function fail(msg: string): never { console.error('FAIL', msg); process.exit(1); }

/** A scripted check: two penguins take a tank, aim at an enemy standing in the open, and fire both weapons. */
function scripted() {
  const w = new World(buildMap(mapForMode('tdm')), { teamSize: 5, playerName: '', playerHat: '', allBots: true, mode: 'tdm' });
  // skip the build phase
  for (let i = 0; i < 60 && w.phase === 'build'; i++) w.step(DT);
  w.phase = 'fight' as typeof w.phase; w.phaseT = 300;
  const tank = w.vehicles.find(v => v.kind === 'snowtank' && v.team === 0);
  if (!tank) fail('no snow tank at team 0 camp: ' + w.vehicles.map(v => `${v.kind}/${v.team}`).join(', '));
  const [a, b] = w.penguins.filter(p => p.team === 0);
  const enemy = w.penguins.find(p => p.team === 1)!;
  for (const p of [a, b]) { p.x = tank.x + 1.5; p.z = tank.z + 1.5; p.y = tank.y; p.invuln = 0; tryEnter(w, p); }
  if (a.riding !== tank.id || a.seat !== 0 || b.riding !== tank.id || b.seat !== 1) fail(`boarding: a ${a.riding}/${a.seat} b ${b.riding}/${b.seat}`);
  // the enemy stands 18 m in front of the tank
  const fx = -Math.sin(tank.yaw), fz = -Math.cos(tank.yaw);
  const place = (p: Penguin, d: number, side: number) => {
    p.x = tank.x + fx * d + fz * side; p.z = tank.z + fz * d - fx * side;
    p.y = w.field.surfaceBelow(p.x, 40, p.z, 0, 50) ?? tank.y; p.vx = p.vy = p.vz = 0; p.invuln = 0; p.health = 3;
  };
  place(enemy, 18, 0);
  const events: Record<string, number> = {};
  let gunShots = 0, catShots = 0, booms = 0, hits = 0;
  for (let t = 0; t < 60 * 8; t++) {
    // keep the enemy standing still where they are
    enemy.input.moveX = enemy.input.moveZ = 0; enemy.input.fire = false;
    a.input.aim = { x: enemy.x, y: enemy.y + 0.6, z: enemy.z }; a.input.fire = t < 60 * 3;
    b.input.aim = { x: enemy.x, y: enemy.y, z: enemy.z }; b.input.fire = t > 60 * 3;
    a.input.moveX = a.input.moveZ = 0;
    w.step(DT);
    if (t === 60 * 3 + 40) {
      // the online snapshot carries the tank's aim and the catapult ball
      const s = decodeSnapshot(encodeSnapshot(w, t, new Uint8Array(0), []));
      const st = s.vehicles.find(v => v.id === tank.id);
      const g = tank.tank!;
      if (!st?.tank) fail('snapshot has no tank gear');
      if (Math.abs(st.tank.aimYaw - g.aimYaw) > 1e-3 || Math.abs(st.tank.catYaw - g.catYaw) > 1e-3 || Math.abs(st.tank.catT - g.catT) > 0.03 || st.tank.hot !== g.hot) fail(`snapshot tank gear ${JSON.stringify(st.tank)} vs ${JSON.stringify(g)}`);
      if (w.snowballs.some(b => b.cat) && !s.balls.some(b => b.cat)) fail('snapshot lost the catapult ball');
      if (s.vehicles.length !== w.vehicles.length) fail('snapshot vehicle count');
      console.log('  snapshot ok:', s.vehicles.map(v => v.kind).join(', '), '| balls', s.balls.map(b => b.cat ? 'cat' : b.kind).join(','));
    }
    for (const e of w.events) {
      events[e.type] = (events[e.type] ?? 0) + 1;
      if (e.type === 'tankFire') { if (e.gun === 0) gunShots++; else catShots++; }
      if (e.type === 'boom') booms++;
      if (e.type === 'hit' && e.pid === enemy.id) hits++;
      if (e.type === 'splat' && e.pid === enemy.id) { place(enemy, 25, 4); }
    }
    w.events.length = 0;
    if (!enemy.alive) { enemy.alive = true; enemy.health = 3; place(enemy, 25, 4); }
  }
  console.log(`scripted: gun shots ${gunShots}, catapult shots ${catShots}, catapult booms ${booms}, hits on the enemy ${hits}, splats ${enemy.downs}`);
  console.log('  turret aim', tank.tank!.aimYaw.toFixed(2), tank.tank!.aimPitch.toFixed(2), 'catapult', tank.tank!.catYaw.toFixed(2), 'heat', tank.tank!.heat.toFixed(2), 'hot', tank.tank!.hot);
  if (gunShots < CFG.tankGunShots) fail('the gun barely fired');
  if (gunShots > CFG.tankGunShots + 3 * CFG.tankGunRate) fail('the gun never overheated');
  if (catShots < 1 || booms < 1) fail('the catapult never fired / landed');
  if (hits < 3) fail('nothing hit the enemy');
}

function matches() {
  for (const mode of ['tdm', 'conquest', 'breakthrough'] as Mode[]) for (let n = 0; n < N; n++) {
    const w = new World(buildMap(mapForMode(mode)), { teamSize: SIZE, playerName: '', playerHat: '', allBots: true, mode });
    let seed = 7 + n * 101;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const slots = [0, 0];
    const bots = w.penguins.map((p, i) => new BotBrain(i, rnd, slots[p.team]++));
    const c = { drive: 0, gunner: 0, gun: 0, cat: 0, gunSplats: 0, catSplats: 0, wrecked: 0, rideSecs: 0, crewSecs: 0 };
    let ticks = 0;
    const t0 = Date.now();
    while (w.phase !== 'end' && ticks < 60 * 60 * 6) {
      for (let i = 0; i < bots.length; i++) bots[i].think(w, w.penguins[i], DT);
      w.step(DT);
      for (const e of w.events) {
        if (e.type === 'vehicle' && e.what === 'enter' && e.kind === 'snowtank') { const p = w.penguin(e.pid); if (p?.seat === 0) c.drive++; else c.gunner++; }
        if (e.type === 'tankFire') { if (e.gun === 0) c.gun++; else c.cat++; }
        if (e.type === 'splat' && e.cause === 'tankgun') c.gunSplats++;
        if (e.type === 'splat' && e.cause === 'catapult') c.catSplats++;
        if (e.type === 'vehicleDown' && e.kind === 'snowtank') c.wrecked++;
      }
      for (const v of w.vehicles) if (v.kind === 'snowtank') { if (v.seats[0] >= 0) c.rideSecs += DT; if (v.seats[1] >= 0) c.crewSecs += DT; }
      w.events.length = 0;
      ticks++;
      for (const v of w.vehicles) for (const k of ['x', 'y', 'z', 'yaw'] as const) if (!Number.isFinite(v[k])) fail(`vehicle ${v.kind} ${k} is ${v[k]}`);
    }
    console.log(`${mode} ${SIZE}v${SIZE}: ${(ticks / 60 / 60).toFixed(1)} min (${((Date.now() - t0) / 1000).toFixed(0)} s real), score ${w.scores.join('-')}; tank drives ${c.drive}, gunners ${c.gunner}, driven ${c.rideSecs.toFixed(0)} s, with gunner ${c.crewSecs.toFixed(0)} s; gun shots ${c.gun}, catapult shots ${c.cat}; splats gun ${c.gunSplats}, catapult ${c.catSplats}; tanks wrecked ${c.wrecked}`);
  }
}

scripted();
matches();
