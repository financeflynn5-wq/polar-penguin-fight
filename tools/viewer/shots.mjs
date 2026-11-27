// Screenshot the model viewer headlessly:  node tools/viewer/shots.mjs <out dir> [sets…]
// Needs `npm run dev` running (default http://localhost:5173) and Playwright.
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const out = process.argv[2] || 'shots';
const which = process.argv.slice(3).join(',') || 'all';
const base = process.env.VIEWER_URL || 'http://localhost:5173/tools/viewer/?script=1';
fs.mkdirSync(out, { recursive: true });

const SETS = {
  // one penguin, four angles
  turn: async (page, shot) => {
    await page.evaluate(() => { const v = window.viewer; v.clear(); v.add({ team: 0, hat: 'none', yaw: 0 }); });
    for (const [name, cam] of Object.entries({ front: [0.9, 1.0, -3.6, 0, 0.6, 0], back: [-1.1, 1.3, 3.4, 0, 0.6, 0], side: [3.7, 0.9, 0.2, 0, 0.6, 0], face: [0.35, 1.0, -1.7, 0, 0.86, 0] })) {
      await page.evaluate(c => { window.viewer.camera(...c, 30); window.viewer.run(40); }, cam);
      await shot('turn_' + name);
    }
  },
  // every action pose, one tile each, from the side and from the front quarter (montage them with tools/viewer/sheet.py)
  poses: async (page, shot) => {
    const poses = [
      ['idle', {}], ['walk', { anim: 'walk' }], ['run', { anim: 'run' }], ['slide', { state: { action: 'slide', vz: -9, sliding: true } }],
      ['plow', { state: { action: 'plow' } }], ['pack', { state: { action: 'pack' } }], ['dig', { state: { action: 'dig' } }], ['build', { state: { action: 'build' } }],
      ['charge', { state: { action: 'charge', charge: 1 } }], ['throw', { state: { action: 'throw', throwAnim: 0.13 } }], ['air', { state: { grounded: false, y: 0.5, py: 0.5 } }], ['hurt', { state: { health: 1 } }],
    ];
    await page.setViewportSize({ width: 440, height: 440 });
    await page.waitForTimeout(400); // let the canvas catch up with the new size
    for (const [view, cam] of Object.entries({ side: [4.4, 1.0, -0.6, 0, 0.55, 0], front: [1.9, 1.3, -4.0, 0, 0.55, 0], back: [-1.6, 1.7, 3.9, 0, 0.55, 0] })) {
      for (const [name, o] of poses) {
        await page.evaluate(([o, cam, frames]) => { const v = window.viewer; v.clear(); v.add({ team: 0, hat: 'none', yaw: 0, ...o }); v.camera(...cam, 30); v.run(frames); }, [o, cam, name === 'hurt' ? 4 : 47]);
        await shot(`pose_${view}_${name}`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  },
  teams: async (page, shot) => {
    await page.evaluate(() => {
      const v = window.viewer; v.clear();
      v.add({ team: 0, hat: 'none', x: -0.6, yaw: -0.3, name: 'Flynn' }); v.add({ team: 1, hat: 'none', x: 0.6, yaw: 0.3, name: 'Pebble' });
      v.camera(0, 1.1, -4.2, 0, 0.62, 0, 30); v.run(40);
    });
    await shot('teams_front');
    await page.evaluate(() => { const v = window.viewer; v.camera(0, 1.5, 4.4, 0, 0.6, 0, 30); v.run(2); });
    await shot('teams_back');
  },
  hats: async (page, shot) => {
    const hats = ['beanie', 'tophat', 'propeller', 'viking', 'crown', 'fish', 'party', 'chef', 'cone'];
    for (const view of ['front', 'back']) {
      await page.evaluate(([hats, view]) => {
        const v = window.viewer; v.clear();
        hats.forEach((h, i) => v.add({ team: i % 2, hat: h, x: (i % 3 - 1) * 1.25, z: 0, yaw: view === 'front' ? 0.25 : 0.15, state: { y: (2 - Math.floor(i / 3)) * 1.45, py: (2 - Math.floor(i / 3)) * 1.45 } }));
        v.camera(view === 'front' ? 0.6 : -0.8, 2.2, view === 'front' ? -9.5 : 9.5, 0, 2.05, 0, 28); v.run(30);
      }, [hats, view]);
      await shot('hats_' + view);
    }
  },
  hatclose: async (page, shot) => {
    const hats = ['beanie', 'tophat', 'propeller', 'viking', 'crown', 'fish', 'party', 'chef', 'cone'];
    for (const h of hats) {
      await page.evaluate(h => { const v = window.viewer; v.clear(); v.add({ team: 0, hat: h, yaw: 0.45 }); v.camera(0.3, 1.4, -2.7, 0, 1.04, 0, 28); v.run(30); }, h);
      await shot('hat_' + h);
      await page.evaluate(() => { const v = window.viewer; v.camera(-0.9, 1.75, 2.6, 0, 1.04, 0, 28); v.run(2); });
      await shot('hatback_' + h);
    }
  },
  // both vehicles in both team colours, with riders; then the moving parts moved
  vehicles: async (page, shot) => {
    const cams = { front: [6.2, 2.3, 4.6, 0.2, 0.75, 0], side: [0.2, 1.5, 8.5, 0.2, 0.8, 0], rear: [-6.4, 2.6, -4.4, 0, 0.8, 0], top: [2.5, 8.5, 2.5, 0, 0.5, 0], low: [5.5, 0.7, -5.2, 0.3, 0.7, 0] };
    await page.evaluate(async () => { const v = window.viewer; await v.vehicle({ kind: 'snowplow', team: 0 }); v.run(2); });
    await page.waitForTimeout(2500); // the tiling textures arrive after the models
    for (const [kind, k] of [['snowmobile', 0.62], ['snowplow', 1.0]]) {
      for (const team of [0, 1]) {
        await page.evaluate(async ([kind, team]) => { const v = window.viewer; v.clear(); await v.vehicle({ kind, team, riders: true }); }, [kind, team]);
        for (const [name, c] of Object.entries(cams)) {
          if (team === 1 && name !== 'front') continue;
          await page.evaluate(([c, k]) => { window.viewer.camera(c[0] * k, c[1] * k, c[2] * k, c[3], c[4] * (k < 1 ? 0.75 : 1.4), c[5], 30); window.viewer.run(30); }, [c, k]);
          await shot(`${kind}_${team ? 'orange' : 'blue'}_${name}`);
        }
      }
      // moving parts: steering hard over / blade up, belts run on a third of a lug
      await page.evaluate(async ([kind]) => {
        const v = window.viewer; v.clear(); await v.vehicle({ kind, team: 0 });
        if (kind === 'snowmobile') { v.part(0, 'steer', [0, 0.5, 0]); v.part(0, 'skiL', [0, 0.4, 0]); v.part(0, 'skiR', [0, 0.4, 0]); }
        else v.part(0, 'blade', [0, 0, 0.3]);
        v.drive(0, 0.04);
      }, [kind]);
      await page.evaluate(([k]) => { window.viewer.camera(6.2 * k, 2.0 * k, 4.6 * k, 0.2, 0.75 * (k < 1 ? 0.75 : 1.4), 0, 30); window.viewer.run(3); }, [k]);
      await shot(`${kind}_moved`);
      await page.evaluate(([k]) => { window.viewer.camera(1.0 * k, 0.9 * k, 5.6 * k, 0.2, 0.4 * (k < 1 ? 0.75 : 1.4), 0, 30); window.viewer.run(3); }, [k]);
      await shot(`${kind}_moved_side`);
      console.log(kind, JSON.stringify(await page.evaluate(() => window.viewer.nodes(0))));
    }
    // how they sit together, at the distance the game's camera keeps
    await page.evaluate(async () => {
      const v = window.viewer; v.clear();
      await v.vehicle({ kind: 'snowplow', team: 1, x: -1.5, z: -2.5, yaw: -0.5, riders: true });
      await v.vehicle({ kind: 'snowmobile', team: 0, x: 2.2, z: 2.0, yaw: -0.9, riders: true });
      v.add({ team: 0, hat: 'viking', x: 3.6, z: 0.2, yaw: 2.4 });
      v.camera(9.5, 3.4, 9.5, 0, 1.0, -0.5, 32); v.run(30);
    });
    await shot('vehicles_together');
  },
};

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('PAGE ERROR', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('console:', m.text()); });
await page.goto(base);
await page.waitForFunction(() => window.viewer && window.viewer.ready, null, { timeout: 120000 });
const shot = async name => { await page.screenshot({ path: `${out}/${name}.png` }); console.log('wrote', name, JSON.stringify(await page.evaluate(() => window.viewer.info()))); };
for (const [name, fn] of Object.entries(SETS)) if (which === 'all' || which.split(',').includes(name)) await fn(page, shot);
await browser.close();
