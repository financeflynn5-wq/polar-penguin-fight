// Screenshot the model viewer headlessly:  node tools/viewer/shots.mjs <out dir> [sets…]
// CLS=bear (or yeti) takes the 'turn' and 'poses' sets of that class instead of the penguin.
// Needs `npm run dev` running (default http://localhost:5173) and Playwright.
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const out = process.argv[2] || 'shots';
const which = process.argv.slice(3).join(',') || 'all';
const base = process.env.VIEWER_URL || 'http://localhost:5173/tools/viewer/?script=1';
fs.mkdirSync(out, { recursive: true });

const CLS = process.env.CLS || 'penguin';
const TALL = { penguin: 1, bear: 1.25, yeti: 1.6 }[CLS] || 1; // how much further back the camera sits for a bigger class

const SETS = {
  // one penguin, four angles
  turn: async (page, shot) => {
    await page.evaluate(c => { const v = window.viewer; v.clear(); v.add({ team: 0, hat: 'none', yaw: 0, cls: c }); }, CLS);
    for (const [name, cam] of Object.entries({ front: [0.9, 1.0, -3.6, 0, 0.6, 0], back: [-1.1, 1.3, 3.4, 0, 0.6, 0], side: [3.7, 0.9, 0.2, 0, 0.6, 0], face: [0.35, 1.0, -1.7, 0, 0.86, 0] })) {
      await page.evaluate(c => { window.viewer.camera(...c, 30); window.viewer.run(40); }, cam.map(v => v * TALL));
      await shot('turn_' + name);
    }
  },
  // every action pose, one tile each, from the side and from the front quarter (montage them with tools/viewer/sheet.py)
  poses: async (page, shot) => {
    const poses = [
      ['idle', {}], ['walk', { anim: 'walk' }], ['run', { anim: 'run' }], ['slide', { state: { action: 'slide', vz: -9, sliding: true } }],
      ['plow', { state: { action: 'plow' } }], ['pack', { state: { action: 'pack' } }], ['dig', { state: { action: 'dig' } }], ['build', { state: { action: 'build' } }],
      ['charge', { state: { action: 'charge', charge: 1, carried: 1 } }], ['throw', { state: { action: 'throw', throwAnim: 0.13 } }], ['air', { state: { grounded: false, y: 0.5, py: 0.5 } }], ['hurt', { state: { health: 1 } }],
    ];
    if (CLS !== 'penguin') poses[3] = CLS === 'bear' ? ['rush', { state: { action: 'rush', vz: -12, rushT: 0.6 } }] : ['carry', { state: { carried: 3 } }];
    await page.setViewportSize({ width: 440, height: 440 });
    await page.waitForTimeout(400); // let the canvas catch up with the new size
    for (const [view, cam] of Object.entries({ side: [4.4, 1.0, -0.6, 0, 0.55, 0], front: [1.9, 1.3, -4.0, 0, 0.55, 0], back: [-1.6, 1.7, 3.9, 0, 0.55, 0] })) {
      for (const [name, o] of poses) {
        await page.evaluate(([o, cam, frames]) => { const v = window.viewer; v.clear(); v.add({ team: 0, hat: 'none', yaw: 0, ...o }); v.camera(...cam, 30); v.run(frames); }, [{ cls: CLS, ...o }, cam.map(v => v * TALL), name === 'hurt' ? 4 : 47]);
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
  // the three classes side by side, both teams, front and back, then each in a hat
  classes: async (page, shot) => {
    await page.evaluate(() => {
      const v = window.viewer; v.clear();
      ['penguin', 'bear', 'yeti'].forEach((c, i) => { v.add({ team: 0, cls: c, x: -3.3 + i * 1.25 + (i === 2 ? 0.2 : 0), yaw: -0.2 }); v.add({ team: 1, cls: c, x: 0.7 + i * 1.25 + (i === 2 ? 0.2 : 0), yaw: 0.2 }); });
      v.camera(0.05, 1.5, -11.2, 0.05, 0.85, 0, 30); v.run(40);
    });
    await shot('classes_front');
    await page.evaluate(() => { const v = window.viewer; v.camera(0.05, 3.0, 11.2, 0.05, 0.75, 0, 30); v.run(2); });
    await shot('classes_back');
    await page.evaluate(() => {
      const v = window.viewer; v.clear();
      const hats = ['beanie', 'viking', 'crown', 'tophat', 'party', 'chef'];
      ['penguin', 'bear', 'yeti', 'penguin', 'bear', 'yeti'].forEach((c, i) => v.add({ team: i < 3 ? 0 : 1, cls: c, hat: hats[i], x: -3.6 + i * 1.4, yaw: 0.25, name: ['Pebble', 'Flynn', 'Chat', 'Waddles', 'Mod', 'Frosty'][i] }));
      v.camera(0.4, 1.7, -11.6, -0.1, 1.05, 0, 30); v.run(40);
    });
    await shot('classes_hats');
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
  // the two guns (the blade has its own set below): each alone from four sides, both beside a penguin for scale, and small, as seen from 12 m away
  guns: async (page, shot) => {
    const views = { side: [1.25, 1.12, -0.19, 0, 1.06, -0.19], front: [0.72, 1.36, -1.25, 0, 1.06, -0.2], back: [-0.62, 1.5, 0.82, 0, 1.06, -0.2], left: [-1.25, 1.12, -0.19, 0, 1.06, -0.19], top: [0.25, 2.2, 0.05, 0, 1.06, -0.2] };
    for (const g of ['cocoa', 'water']) {
      await page.evaluate(g => { const v = window.viewer; v.clear(); v.gun(g, { y: 1 }); }, g);
      for (const [name, cam] of Object.entries(views)) {
        await page.evaluate(c => { window.viewer.camera(...c, 30); window.viewer.run(3); }, cam);
        await shot(`gun_${g}_${name}`);
      }
    }
    await page.evaluate(() => {
      const v = window.viewer; v.clear();
      v.gun('cocoa', { x: 0.40, y: 1.25, z: 0, yaw: Math.PI / 2 - 0.5 }); v.gun('water', { x: -0.04, y: 0.90, z: -0.05, yaw: Math.PI / 2 - 0.5 });
      v.camera(0, 1.3, -1.6, 0, 1.17, 0, 30); v.run(3);
    });
    await shot('guns_both');
    await page.evaluate(() => {
      const v = window.viewer; v.clear();
      v.add({ team: 0, hat: 'beanie', x: 0, yaw: 0.25 });
      v.gun('cocoa', { x: -0.85, y: 0.62, z: -0.1, yaw: Math.PI / 2 - 0.35 }); v.gun('water', { x: 0.85, y: 0.62, z: -0.1, yaw: -Math.PI / 2 + 0.35 });
      v.camera(0.2, 1.05, -3.9, 0, 0.6, 0, 30); v.run(40);
    });
    await shot('guns_scale');
    await page.evaluate(() => { const v = window.viewer; v.camera(-0.5, 1.7, 3.6, 0, 0.6, 0, 30); v.run(2); });
    await shot('guns_scale_back');
    await page.evaluate(() => {
      const v = window.viewer; v.clear();
      v.gun('cocoa', { x: -0.5, y: 0.9, yaw: Math.PI / 2 - 0.5 }); v.gun('water', { x: 0.5, y: 0.9, yaw: Math.PI / 2 - 0.5 });
      v.gun('cocoa', { x: -0.5, y: 0.35, yaw: 0.25 }); v.gun('water', { x: 0.5, y: 0.35, yaw: 0.25 });
      v.camera(0, 2.6, 12, 0, 0.7, 0, 55); v.run(3);
    });
    await shot('guns_far');
    // in the mittens and slung on the back, the way the game shows them
    await page.evaluate(() => {
      const v = window.viewer; v.clear();
      const held = { gun: 1, gunOut: true };
      v.hold(v.add({ team: 0, hat: 'beanie', x: -0.75, yaw: 0.35, state: held }), 'cocoa');
      v.hold(v.add({ team: 1, hat: 'none', x: 0.75, yaw: 0.35, state: held }), 'water');
      v.camera(1.6, 1.15, -3.9, 0.1, 0.6, 0, 30); v.run(40);
    });
    await shot('guns_held');
    await page.evaluate(() => { const v = window.viewer; v.camera(1.3, 2.0, 4.6, 0.2, 0.7, -0.6, 32); v.run(2); });
    await shot('guns_held_behind');
    await page.evaluate(() => {
      const v = window.viewer; v.clear();
      v.hold(v.add({ team: 0, hat: 'none', x: -0.75, yaw: -0.5 }), 'cocoa', 'back');
      v.hold(v.add({ team: 1, hat: 'none', x: 0.75, yaw: 0.5 }), 'water', 'back');
      v.camera(0, 1.7, 4.4, 0, 0.6, 0, 30); v.run(40);
    });
    await shot('guns_slung');
    await page.evaluate(() => {
      const v = window.viewer; v.clear();
      const held = { gun: 1, gunOut: true };
      v.hold(v.add({ team: 0, hat: 'none', x: -1.2, yaw: 2.3, state: held }), 'cocoa');
      v.hold(v.add({ team: 1, hat: 'none', x: 1.2, yaw: 2.3, state: held }), 'water');
      v.hold(v.add({ team: 1, hat: 'none', x: -3.4, yaw: 0.6, state: held }), 'cocoa');
      v.hold(v.add({ team: 0, hat: 'none', x: 3.4, yaw: 0.6, state: held }), 'water');
      v.camera(0, 2.6, 12, 0, 0.7, 0, 55); v.run(40);
    });
    await shot('guns_held_far');
  },
  // the Candy Cane Blade: alone from every side, beside a penguin for scale, carried, and small, as seen from 12 m away
  blade: async (page, shot) => {
    const views = { side: [1.5, 0.98, -0.34, 0, 0.96, -0.34], left: [-1.5, 0.98, -0.34, 0, 0.96, -0.34], top: [0.02, 2.5, -0.33, 0, 0.96, -0.34], under: [0.02, -0.55, -0.33, 0, 0.96, -0.34],
      front: [0.85, 1.32, -1.75, 0, 0.96, -0.36, 21], back: [-0.7, 1.4, 0.95, 0, 0.96, -0.32, 23], hilt: [0.62, 1.1, 0.28, 0, 0.95, -0.03], point: [0.5, 1.12, -0.95, 0, 0.98, -0.66] };
    await page.evaluate(() => { const v = window.viewer; v.clear(); v.gun('blade', { y: 1 }); });
    for (const [name, cam] of Object.entries(views)) {
      await page.evaluate(c => { window.viewer.camera(...c.slice(0, 6), c[6] ?? 30); window.viewer.run(3); }, cam);
      await shot(`blade_${name}`);
    }
    await page.evaluate(() => {
      const v = window.viewer; v.clear();
      v.add({ team: 0, hat: 'beanie', x: 0.35, yaw: 0.25 });
      v.gun('blade', { x: -0.55, y: 0.2, z: -0.1, pitch: Math.PI / 2 - 0.12, yaw: Math.PI / 2 });
      v.gun('cocoa', { x: -1.15, y: 0.5, z: -0.1, yaw: Math.PI / 2 - 0.35 });
      v.camera(0.0, 1.05, -4.1, -0.25, 0.6, 0, 30); v.run(40);
    });
    await shot('blade_scale');
    const held = { gun: 3, gunOut: true };
    await page.evaluate(held => {
      const v = window.viewer; v.clear();
      v.hold(v.add({ team: 0, hat: 'beanie', x: -0.75, yaw: 0.35, state: held }), 'blade');
      v.hold(v.add({ team: 1, hat: 'none', x: 0.75, yaw: 0.35, state: held }), 'blade');
      v.camera(1.6, 1.15, -3.9, 0.1, 0.7, 0, 30); v.run(40);
    }, held);
    await shot('blade_held');
    await page.evaluate(() => { const v = window.viewer; v.camera(1.3, 2.0, 4.6, 0.2, 0.8, -0.6, 32); v.run(2); });
    await shot('blade_held_behind');
    await page.evaluate(() => { const v = window.viewer; v.camera(0.2, 1.05, -2.0, 0.05, 0.85, 0, 30); v.run(2); });
    await shot('blade_held_close');
    await page.evaluate(held => {
      const v = window.viewer; v.clear();
      v.hold(v.add({ team: 0, hat: 'none', x: -1.2, yaw: 2.3, state: held }), 'blade');
      v.hold(v.add({ team: 1, hat: 'none', x: 1.2, yaw: 2.3, state: held }), 'blade');
      v.hold(v.add({ team: 1, hat: 'none', x: -3.4, yaw: 0.6, state: held }), 'blade');
      v.hold(v.add({ team: 0, hat: 'none', x: 3.4, yaw: 0.6, state: held }), 'blade');
      v.gun('blade', { x: 0, y: 0.9, yaw: Math.PI / 2 }); v.gun('blade', { x: 0, y: 0.25, yaw: 0.6 });
      v.camera(0, 2.6, 12, 0, 0.7, 0, 55); v.run(40);
    }, held);
    await shot('blade_far');
  },
};

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const [VW, VH] = (process.env.SIZE || '1280x800').split('x').map(Number); // SIZE=1920x1200 for bigger pictures
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('PAGE ERROR', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('console:', m.text()); });
await page.goto(base);
await page.waitForFunction(() => window.viewer && window.viewer.ready, null, { timeout: 120000 });
const shot = async name => { await page.screenshot({ path: `${out}/${name}.png` }); console.log('wrote', name, JSON.stringify(await page.evaluate(() => window.viewer.info()))); };
for (const [name, fn] of Object.entries(SETS)) if (which === 'all' || which.split(',').includes(name)) await fn(page, shot);
await browser.close();
