import * as THREE from 'three';
import { buildMap, MapDef } from '../world/MapDef';
import { ISO } from '../world/SnowField';
import { SnowRenderer } from '../render/SnowRenderer';
import { Environment } from '../render/Environment';
import { Particles, PKind } from '../render/Particles';
import { PenguinModel } from '../render/PenguinModel';
import { Props } from '../render/Props';
import { World, Penguin, GameEvent, solveThrow, lookVelocity, MatchOptions } from '../sim/World';
import { BotBrain } from '../sim/Bot';
import { CFG, MITTEN_NAMES } from '../sim/config';
import { Input } from './Input';
import { Audio } from './Audio';
import { Hud } from '../ui/Hud';

const STEP = 1 / 60;

export interface GameHooks {
  onGameOver: (w: World) => void;
  onPauseChange: (paused: boolean) => void;
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.08, 900);
  readonly input: Input;
  readonly audio = new Audio();
  map!: MapDef;
  world: World | null = null;
  private env!: Environment;
  private snow!: SnowRenderer;
  private particles!: Particles;
  private props!: Props;
  private models = new Map<number, PenguinModel>();
  private bots = new Map<number, BotBrain>();
  private hud: Hud | null = null;
  private acc = 0;
  private last = performance.now();
  private time = 0;
  private mode: 'menu' | 'play' = 'menu';
  private menuPenguin: PenguinModel | null = null;
  private menuFake: Penguin | null = null;
  private plowSound = 0;
  private stepT = 0;
  private countdownLast = -1;
  private camDist = 4.4;
  private aimSnow: { x: number; y: number; z: number } | null = null;
  private aimAny: { x: number; y: number; z: number } | null = null;
  paused = false;
  hooks: GameHooks | null = null;
  fps = 0;
  private fpsAcc = 0; private fpsN = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    container.appendChild(this.renderer.domElement);
    this.input = new Input(this.renderer.domElement);
    this.input.onLockChange = locked => {
      if (this.mode !== 'play') return;
      this.setPaused(!locked && this.world?.phase !== 'end');
    };
    this.input.onKey = code => {
      if (code === 'Tab') this.hud?.setBoard(true);
    };
    window.addEventListener('keyup', e => { if (e.code === 'Tab') this.hud?.setBoard(false); });
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.loadMap();
    this.enterMenu();
    requestAnimationFrame(t => this.frame(t));
  }

  private resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loadMap() {
    // clear old
    while (this.scene.children.length) this.scene.remove(this.scene.children[0]);
    this.models.forEach(m => m.dispose(this.scene));
    this.models.clear();
    this.map = buildMap();
    this.env = new Environment(this.scene, this.map);
    this.snow = new SnowRenderer(this.map.field, this.map.pond.y);
    this.snow.buildAll();
    this.scene.add(this.snow.group);
    this.particles = new Particles(this.map.field);
    this.scene.add(this.particles.points);
    this.props = new Props(this.map);
    this.scene.add(this.props.group);
  }

  // ───────────────────────── menu ─────────────────────────
  enterMenu() {
    this.mode = 'menu';
    this.paused = false;
    this.input.enabled = false;
    this.input.unlock();
    this.hud?.destroy(); this.hud = null;
    if (this.world) { this.world = null; this.loadMap(); }
    const b = this.map.bases[0];
    const p = new Penguin(0, '', 0, 'beanie', false);
    p.x = b.center.x + 4; p.z = b.center.z + 3;
    p.y = this.map.field.surfaceBelow(p.x, 20, p.z, 0, 20) ?? b.center.y;
    p.px = p.x; p.py = p.y; p.pz = p.z;
    p.yaw = -Math.PI / 2 + 0.5;
    p.grounded = true;
    this.menuFake = p;
    this.menuPenguin = new PenguinModel(0, 'beanie', null, false);
    this.scene.add(this.menuPenguin.root);
  }

  setMenuHat(hat: string) { this.menuPenguin?.setHat(hat); }

  // ───────────────────────── match ─────────────────────────
  startMatch(opts: MatchOptions) {
    if (this.menuPenguin) { this.menuPenguin.dispose(this.scene); this.menuPenguin = null; }
    if (this.world) this.loadMap();
    this.world = new World(this.map, opts);
    this.bots.clear();
    let rndSeed = 1;
    const rnd = () => { rndSeed = (rndSeed * 16807) % 2147483647; return rndSeed / 2147483647; };
    this.world.penguins.forEach((p, i) => {
      const m = new PenguinModel(p.team, p.hat, p.bot ? p.name : p.name, true);
      this.scene.add(m.root);
      this.models.set(p.id, m);
      if (p.bot) this.bots.set(p.id, new BotBrain(i, rnd));
    });
    this.hud = new Hud();
    this.mode = 'play';
    this.input.enabled = true;
    this.input.yaw = this.world.player.yaw;
    this.input.pitch = -0.12;
    this.acc = 0;
    this.countdownLast = -1;
    this.audio.unlock();
    this.audio.whistle();
    this.hud.banner('BUILD PHASE', `${CFG.buildPhase} seconds to build your fort and pack snowballs!`, 3.5);
    this.input.lock();
  }

  setPaused(p: boolean) {
    if (this.paused === p) return;
    this.paused = p;
    this.hooks?.onPauseChange(p);
  }

  resume() { this.input.lock(); }

  // ───────────────────────── frame ─────────────────────────
  private frame(t: number) {
    requestAnimationFrame(tt => this.frame(tt));
    let dt = (t - this.last) / 1000;
    this.last = t;
    if (dt > 0.1) dt = 0.1;
    this.time += dt;
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5) { this.fps = this.fpsN / this.fpsAcc; this.fpsAcc = 0; this.fpsN = 0; }

    if (this.mode === 'menu') this.menuFrame(dt);
    else if (this.world) this.playFrame(dt);

    this.env.update(this.time, this.camera, window.innerHeight);
    this.snow.update(this.camera.position, this.mode === 'menu' ? 8 : 4, this.time);
    this.particles.update(dt, window.innerHeight * Math.min(window.devicePixelRatio, 1.75), this.camera.fov);
    this.renderer.render(this.scene, this.camera);
  }

  private menuFrame(dt: number) {
    const p = this.menuFake!;
    const m = this.menuPenguin!;
    p.lookPitch = Math.sin(this.time * 0.7) * 0.15;
    p.yaw = -Math.PI / 2 + 0.55 + Math.sin(this.time * 0.4) * 0.25;
    m.update(p, 1, dt, this.time, false);
    const a = this.time * 0.05;
    const cx = p.x + 3.4, cz = p.z - 0.6;
    this.camera.position.set(cx + Math.sin(a) * 0.3, p.y + 1.25, cz + Math.cos(a) * 0.3);
    this.camera.lookAt(p.x + 0.9, p.y + 0.85, p.z + 1.6);
    // an occasional plume of snow so the menu feels alive
    if (Math.random() < dt * 3) this.particles.burst(p.x + 1.5 + Math.random() * 3, p.y, p.z - 3 + Math.random() * 7, 8, 2.5, 1.2);
  }

  private playFrame(dt: number) {
    const w = this.world!;
    const me = w.player;
    const inp = this.input;

    // player input → sim
    const pi = me.input;
    const playing = !this.paused && w.phase !== 'end';
    pi.moveZ = playing ? (inp.down('KeyW') || inp.down('ArrowUp') ? 1 : 0) - (inp.down('KeyS') || inp.down('ArrowDown') ? 1 : 0) : 0;
    pi.moveX = playing ? (inp.down('KeyD') || inp.down('ArrowRight') ? 1 : 0) - (inp.down('KeyA') || inp.down('ArrowLeft') ? 1 : 0) : 0;
    pi.yaw = inp.yaw; pi.pitch = inp.pitch;
    if (inp.jumpQueued && playing) { pi.jump = true; }
    inp.jumpQueued = false;
    pi.slide = playing && (inp.down('ShiftLeft') || inp.down('ShiftRight'));
    pi.fire = playing && inp.mouse[0];
    pi.plow = playing && inp.mouse[2];
    pi.pack = playing && inp.down('KeyF');
    pi.dig = playing && inp.down('KeyQ');
    pi.build = playing && (inp.down('KeyR') || inp.down('KeyC'));
    pi.use = playing && inp.down('KeyE');

    // camera first (so aiming uses this frame's view)
    this.updateCamera(dt, me);
    this.computeAim(me);
    pi.aim = (pi.dig || pi.build) ? this.aimSnow : this.aimAny;

    // fixed-step simulation
    if (!this.paused) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= STEP && steps < 5) {
        for (const [id, brain] of this.bots) {
          const p = w.penguin(id)!;
          brain.think(w, p, STEP);
        }
        w.step(STEP);
        this.acc -= STEP;
        steps++;
      }
      if (steps === 5) this.acc = 0;
    }
    const alpha = this.paused ? 1 : this.acc / STEP;

    this.handleEvents(w, me);

    // visuals
    for (const p of w.penguins) this.models.get(p.id)?.update(p, alpha, dt, this.time, p === me);
    this.props.update(w, alpha, dt, this.time);
    this.updateAimVisuals(me);

    // audio beds
    this.audio.listener = { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z, yaw: inp.yaw };
    this.plowSound *= Math.pow(0.02, dt);
    this.audio.setPlow(this.plowSound);
    let rumble = 0;
    for (const b of w.bigBalls) {
      const d = Math.hypot(b.x - me.x, b.z - me.z);
      rumble = Math.max(rumble, Math.min(1, Math.hypot(b.vx, b.vz) / 8) / (1 + d * 0.08));
    }
    this.audio.setRumble(rumble * 0.8);
    this.audio.setWind(0.04);
    if (me.alive && me.grounded && !me.sliding && Math.hypot(me.vx, me.vz) > 1.5) {
      this.stepT -= dt * Math.hypot(me.vx, me.vz) / 4.5;
      if (this.stepT <= 0) { this.stepT = 0.3; this.audio.step(me.x, me.y, me.z); }
    }

    // build-phase countdown
    if (w.phase === 'build') {
      const s = Math.ceil(w.phaseT);
      if (s <= 5 && s !== this.countdownLast && s > 0) { this.countdownLast = s; this.hud!.banner(String(s), 'Get ready to throw!', 0.9); this.audio.countdown(false); }
    }

    // HUD
    let hint: string | null = null;
    if ((pi.dig || pi.build) && !this.aimInReach(me)) hint = 'Aim closer to dig or build';
    if (me.noSnowT > 0 && (pi.pack || pi.build || pi.dig)) hint = me.carried >= CFG.maxCarry && pi.pack ? 'Your mittens are full (5): stash or throw!' : 'No loose snow here';
    if (w.phase === 'build' && pi.fire && me.carried > 0) hint = 'No throwing until the fight starts!';
    this.hud!.update(w, me, dt, hint);
  }

  private aimInReach(me: Penguin) {
    const a = this.aimSnow;
    if (!a) return false;
    return Math.hypot(a.x - me.x, a.y - (me.y + 0.8), a.z - me.z) <= CFG.reach + 0.3;
  }

  private updateCamera(dt: number, me: Penguin) {
    const inp = this.input;
    const alpha = this.acc / STEP;
    const px = me.px + (me.x - me.px) * alpha, py = me.py + (me.y - me.py) * alpha, pz = me.pz + (me.z - me.pz) * alpha;
    const yaw = inp.yaw, pitch = inp.pitch;
    const fx = -Math.sin(yaw) * Math.cos(pitch), fy = Math.sin(pitch), fz = -Math.cos(yaw) * Math.cos(pitch);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    let want = me.sliding ? 5.2 : me.charging ? 3.5 : 4.4;
    if (!me.alive) want = 6.5;
    this.camDist += (want - this.camDist) * Math.min(1, dt * 6);
    const pivY = py + (me.sliding ? 1.0 : 1.5);
    const sh = 0.62;
    const pivX = px + rx * sh, pivZ = pz + rz * sh;
    // pull in if snow is in the way
    let dist = this.camDist;
    const f = this.map.field;
    const hit = f.raycast(pivX, pivY, pivZ, -fx, -fy, -fz, dist, 0.15);
    if (hit) dist = Math.max(0.6, hit.t - 0.3);
    let cx = pivX - fx * dist, cy = pivY - fy * dist, cz = pivZ - fz * dist;
    const g = f.surfaceBelow(cx, cy + 1, cz, 0, 4);
    if (g !== null && cy < g + 0.35) cy = g + 0.35;
    this.camera.position.set(cx, cy, cz);
    this.camera.rotation.set(pitch, yaw, 0, 'YXZ');
    const fovWant = me.sliding ? 80 : me.charging ? 64 : 70;
    this.camera.fov += (fovWant - this.camera.fov) * Math.min(1, dt * 5);
    this.camera.updateProjectionMatrix();
  }

  private computeAim(me: Penguin) {
    const w = this.world!;
    const cam = this.camera.position;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const start = Math.max(0.5, this.camDist * 0.85);
    const ox = cam.x + dir.x * start, oy = cam.y + dir.y * start, oz = cam.z + dir.z * start;
    const maxD = 90;
    const snowHit = this.map.field.raycast(ox, oy, oz, dir.x, dir.y, dir.z, maxD, 0.2);
    let bestT = snowHit ? snowHit.t : maxD;
    this.aimSnow = snowHit ? { x: snowHit.x, y: snowHit.y, z: snowHit.z } : null;
    let any = this.aimSnow;
    const raySphere = (cx: number, cy: number, cz: number, r: number) => {
      const lx = cx - ox, ly = cy - oy, lz = cz - oz;
      const tca = lx * dir.x + ly * dir.y + lz * dir.z;
      if (tca < 0) return -1;
      const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
      if (d2 > r * r) return -1;
      return tca - Math.sqrt(r * r - d2);
    };
    for (const p of w.penguins) {
      if (p === me || !p.alive) continue;
      const t = raySphere(p.x, p.y + (p.sliding ? 0.3 : 0.65), p.z, 0.55);
      if (t > 0 && t < bestT) { bestT = t; any = { x: p.x, y: p.y + (p.sliding ? 0.3 : 0.65), z: p.z }; }
    }
    for (const b of w.bigBalls) {
      const t = raySphere(b.x, b.y, b.z, b.r);
      if (t > 0 && t < bestT) { bestT = t; any = { x: ox + dir.x * t, y: oy + dir.y * t, z: oz + dir.z * t }; }
    }
    if (!any) any = { x: ox + dir.x * maxD, y: oy + dir.y * maxD, z: oz + dir.z * maxD };
    this.aimAny = any;
  }

  private updateAimVisuals(me: Penguin) {
    const pi = me.input;
    const marker = this.props.aimMarker;
    const showMarker = me.alive && (pi.dig || pi.build) && this.aimSnow && this.aimInReach(me);
    marker.visible = !!showMarker;
    if (showMarker && this.aimSnow) {
      marker.position.set(this.aimSnow.x, this.aimSnow.y, this.aimSnow.z);
      (marker.material as THREE.MeshBasicMaterial).color.set(pi.dig ? 0xffb36b : 0x8fe6ff);
      marker.scale.setScalar(1 + Math.sin(this.time * 10) * 0.05);
    }
    // throw arc
    const traj = this.props.trajectory;
    if (me.alive && me.charging && this.world!.phase === 'fight') {
      const speed = (CFG.throwSpeedMin + (CFG.throwSpeedMax - CFG.throwSpeedMin) * me.charge) * (1 + me.mitten * CFG.throwPerLevel);
      const h = this.world!.handPos(me);
      const v = solveThrow(h, this.aimAny, speed, CFG.snowballGravity) ?? lookVelocity(me.lookYaw, me.lookPitch + 0.07, speed);
      const pts: number[][] = [];
      let x = h.x, y = h.y, z = h.z, vx = v.x + me.vx * 0.3, vy = v.y, vz = v.z + me.vz * 0.3;
      const f = this.map.field;
      for (let i = 0; i < 64; i++) {
        pts.push([x, y, z]);
        const sdt = 0.035;
        vy -= CFG.snowballGravity * sdt;
        x += vx * sdt; y += vy * sdt; z += vz * sdt;
        if (f.sample(x, y, z) > ISO || y < 0) { pts.push([x, y, z]); break; }
      }
      this.props.setTrajectory(pts);
      traj.visible = true;
    } else traj.visible = false;
  }

  // ───────────────────────── events → effects ─────────────────────────
  private handleEvents(w: World, me: Penguin) {
    const P = this.particles, A = this.audio, H = this.hud!;
    for (const e of w.events) this.handleEvent(e, w, me, P, A, H);
    w.events.length = 0;
  }

  private handleEvent(e: GameEvent, w: World, me: Penguin, P: Particles, A: Audio, H: Hud) {
    switch (e.type) {
      case 'plow': {
        const n = Math.min(26, Math.ceil(e.mass / 45));
        const rx = -e.fz, rz = e.fx;
        const p = w.penguin(e.pid)!;
        for (let k = 0; k < n; k++) {
          const u = (Math.random() - 0.5) * 1.3;
          const x = p.x + e.fx * (0.55 + Math.random() * 0.4) + rx * u, z = p.z + e.fz * (0.55 + Math.random() * 0.4) + rz * u;
          const y = Math.max(p.y + 0.05, e.y) + Math.random() * 0.5;
          const sp = 1.5 + Math.random() * 2.5;
          P.spawn(PKind.Grain, x, y, z, e.fx * sp + rx * u * 1.2 + (Math.random() - 0.5), 1 + Math.random() * 2.6, e.fz * sp + rz * u * 1.2 + (Math.random() - 0.5), 0.03 + Math.random() * 0.06, 1.2 + Math.random());
        }
        if (Math.random() < 0.35) P.spawn(PKind.Puff, p.x + e.fx * 0.9, p.y + 0.3, p.z + e.fz * 0.9, e.fx, 0.6, e.fz, 0.3 + Math.random() * 0.3, 0.6);
        if (e.pid === me.id) this.plowSound = Math.min(1, this.plowSound + e.mass / 1500);
        else if (Math.random() < 0.1) A.crunch(e.x, e.y, e.z, 0.15);
        break;
      }
      case 'dig': {
        P.arc(e.x, e.y, e.z, e.tx, e.ty, e.tz, Math.min(10, Math.ceil(e.mass / 50)), 0.45, 0.35);
        if (Math.random() < 0.3) P.burst(e.x, e.y, e.z, 4, 1.5, 0.6);
        if (Math.random() < (e.pid === me.id ? 0.4 : 0.08)) A.crunch(e.x, e.y, e.z, 0.3);
        break;
      }
      case 'build': {
        P.arc(e.x, e.y + 0.1, e.z, e.tx, e.ty, e.tz, Math.min(12, Math.ceil(e.mass / 40)), 0.32, 0.3);
        if (Math.random() < (e.pid === me.id ? 0.3 : 0.06)) A.pat(e.tx, e.ty, e.tz);
        break;
      }
      case 'packTick': {
        P.spawn(PKind.Grain, e.x + (Math.random() - 0.5) * 0.3, e.y + 0.2, e.z + (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 1.5, 1.5 + Math.random() * 1.5, (Math.random() - 0.5) * 1.5, 0.04, 1);
        if (e.pid === me.id && Math.random() < 0.5) A.pat(e.x, e.y, e.z);
        break;
      }
      case 'packDone': {
        const p = w.penguin(e.pid)!;
        if (e.pid === me.id) A.packDone(p.x, p.y, p.z);
        break;
      }
      case 'noSnow': if (e.pid === me.id) A.noSnow(); break;
      case 'throw': A.whoosh(e.x, e.y, e.z, e.power); break;
      case 'snowHit': P.burst(e.x, e.y, e.z, 16, 3, 1, e.nx, e.ny, e.nz); A.splatSnow(e.x, e.y, e.z); break;
      case 'hit': {
        P.burst(e.x, e.y, e.z, 30, 4.5, 1.2);
        A.hit(e.x, e.y, e.z);
        if (e.by === me.id) { H.hitMarker(e.health <= 0); A.hitMarker(); }
        if (e.pid === me.id) H.splatScreen();
        break;
      }
      case 'splat': {
        P.burst(e.x, e.y + 0.6, e.z, 70, 6, 1.5);
        A.splat(e.x, e.y, e.z);
        const victim = w.penguin(e.pid)!;
        const killer = w.penguin(e.by);
        H.feed(killer, victim, e.cause);
        if (e.by === me.id && e.pid !== me.id) H.banner('SPLAT!', `You got ${victim.name}`, 1.3);
        break;
      }
      case 'grab':
        if (e.pid === me.id) { A.grab(); H.toast(e.stolen ? `Stole ${e.n} snowball${e.n > 1 ? 's' : ''}!` : `+${e.n} snowball${e.n > 1 ? 's' : ''}`); }
        break;
      case 'stash': if (e.pid === me.id) { A.stash(); H.toast(`Stashed ${e.n} in the stockpile`); } break;
      case 'flake': {
        P.sparkle(e.x, e.y, e.z, 60, 0.6, 0.95, 1.2);
        A.flake(e.x, e.y, e.z);
        if (e.pid === me.id) H.banner('MITTEN UPGRADE!', `${MITTEN_NAMES[e.level]}: faster packing, building and harder throws`, 2.6);
        break;
      }
      case 'crush': P.burst(e.x, e.y, e.z, Math.min(90, Math.ceil(e.mass / 25)), 5, 1.5); A.crush(e.x, e.y, e.z, e.mass / 4000); break;
      case 'bigBurst': P.burst(e.x, e.y, e.z, 120, 7, 1.5); A.crush(e.x, e.y, e.z, 0.9); break;
      case 'jump': if (e.pid === me.id) A.jump(me.x, me.y, me.z); break;
      case 'slideStart': { const p = w.penguin(e.pid)!; A.slide(p.x, p.y, p.z); P.burst(p.x, p.y, p.z, 12, 2, 0.8); break; }
      case 'phase':
        if (e.phase === 'fight') { H.banner('FIGHT!', 'Splat the other team. First to ' + CFG.scoreToWin + ' wins!', 2.2); A.whistle(); }
        break;
      case 'gameOver': {
        const win = e.winner === me.team;
        A.fanfare(win);
        this.input.unlock();
        this.hooks?.onGameOver(w);
        break;
      }
      case 'respawn': break;
    }
  }
}
