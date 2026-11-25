import { setPropAnisotropy } from '../render/PropMaterials';
import * as THREE from 'three';
import { MapDef } from '../world/MapDef';
import { buildMap, MapId, mapForMode } from '../world/Maps';
import { ISO } from '../world/SnowField';
import { SnowRenderer } from '../render/SnowRenderer';
import { Environment } from '../render/Environment';
import { Particles, PKind } from '../render/Particles';
import { PenguinModel, setPenguinQuality } from '../render/PenguinModel';
import { Props } from '../render/Props';
import { PlaygroundView } from '../render/PlaygroundView';
import { Decals } from '../render/Decals';
import { World, Penguin, GameEvent, solveThrow, lookVelocity, MatchOptions } from '../sim/World';
import { BotBrain } from '../sim/Bot';
import { CFG, MITTEN_NAMES, REWARD_NAMES } from '../sim/config';
import { LandmarksView } from '../render/Landmarks';
import { TurretsView } from '../render/Turrets';
import { FlagsView } from '../render/Flags';
import { VehiclesView } from '../render/Vehicles';
import { vehicleOf, VEHICLE_NAMES, Vehicle } from '../sim/Vehicles';
import { TEAM_NAMES } from '../render/Environment';
import { Input } from './Input';
import { Audio } from './Audio';
import { Hud } from '../ui/Hud';
import { PostFX } from '../render/PostFX';
import { NetClient } from '../net/NetClient';
import type { MatchInfo } from '../net/Protocol';

const STEP = 1 / 60;

export interface GameHooks {
  onGameOver: (w: World) => void;
  onPauseChange: (paused: boolean) => void;
  /** online: a new match started (the server moves everyone on after the results screen) */
  onMatchStart?: () => void;
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
  private playground!: PlaygroundView;
  private decals!: Decals;
  private landmarks!: LandmarksView;
  private turretsView!: TurretsView;
  private flagsView!: FlagsView;
  private vehiclesView!: VehiclesView;
  /** the heading of the vehicle you're driving, last frame (the camera turns with it) */
  private rideYaw: number | null = null;
  private camClear = 20;
  private taughtDrive = false;
  mapId: MapId = 'bay';
  private rewardQueued = 0;
  private taughtTurret = false;
  private trails = new Map<number, { dist: number; side: number; x: number; z: number }>();
  private models = new Map<number, PenguinModel>();
  private modelKeys = new Map<number, string>();
  /** online play: the connection to the game server (null offline) */
  net: NetClient | null = null;
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
  private camDist = 4.8;
  private post: PostFX | null = null;
  quality: 'high' | 'low' = 'high';
  private stroke = new Map<number, number>();
  private stroking = false;
  private aimTarget: Penguin | null = null;
  private taughtRoll = false;
  private focusTmp = new THREE.Vector3();
  private seatTurn = new THREE.Quaternion();
  private aimSnow: { x: number; y: number; z: number } | null = null;
  private aimAny: { x: number; y: number; z: number } | null = null;
  paused = false;
  hooks: GameHooks | null = null;
  fps = 0;
  private fpsAcc = 0; private fpsN = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    setPropAnisotropy(this.renderer.capabilities.getMaxAnisotropy());
    try { if (localStorage.getItem('ppf.quality') === 'low') this.quality = 'low'; } catch { /* private mode */ }
    setPenguinQuality(this.quality === 'low');
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.post = new PostFX(this.renderer, this.scene, this.camera);
    container.appendChild(this.renderer.domElement);
    this.input = new Input(this.renderer.domElement);
    this.input.onLockChange = locked => {
      if (this.mode !== 'play') return;
      this.setPaused(!locked && this.world?.phase !== 'end');
    };
    this.input.onLockError = () => {
      if (this.mode === 'play' && !this.input.locked && this.world?.phase !== 'end') this.setPaused(true);
    };
    this.input.onKey = code => {
      if (code === 'Tab') this.hud?.setBoard(true);
      if (code === 'Digit1' || code === 'Digit2' || code === 'Digit3') this.rewardQueued = +code.slice(5);
    };
    window.addEventListener('keyup', e => { if (e.code === 'Tab') this.hud?.setBoard(false); });
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.loadMap();
    this.enterMenu();
    requestAnimationFrame(t => this.frame(t));
  }

  private pixelRatio() { return Math.min(window.devicePixelRatio, this.quality === 'high' ? 1.75 : 1); }

  setQuality(q: 'high' | 'low') {
    this.quality = q;
    try { localStorage.setItem('ppf.quality', q); } catch { /* private mode */ }
    setPenguinQuality(q === 'low');
    this.renderer.shadowMap.enabled = true;
    this.resize();
  }

  private resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(w, h);
    this.post?.setSize(w, h, this.pixelRatio());
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loadMap(id: MapId = this.mapId, snow?: { density: Uint8Array; hard: Uint8Array }) {
    this.mapId = id;
    // clear old
    while (this.scene.children.length) this.scene.remove(this.scene.children[0]);
    this.models.forEach(m => m.dispose(this.scene));
    this.models.clear();
    this.modelKeys.clear();
    this.env?.dispose();
    this.map = buildMap(id);
    if (snow && snow.density.length === this.map.field.density.length) {
      // online: the server's snow, exactly as it is in the match right now
      this.map.field.density.set(snow.density);
      this.map.field.hard.set(snow.hard);
    }
    this.env = new Environment(this.scene, this.map, this.renderer);
    this.snow = new SnowRenderer(this.map.field);
    this.snow.buildAll();
    this.scene.add(this.snow.group);
    this.particles = new Particles(this.map.field);
    this.scene.add(this.particles.points);
    this.props = new Props(this.map);
    this.scene.add(this.props.group);
    this.playground = new PlaygroundView(this.map.playground);
    this.scene.add(this.playground.group);
    this.decals = new Decals(this.map.field);
    this.scene.add(this.decals.group);
    this.landmarks = new LandmarksView(this.map);
    this.scene.add(this.landmarks.group);
    this.turretsView = new TurretsView();
    this.scene.add(this.turretsView.group);
    this.flagsView = new FlagsView(this.map);
    this.scene.add(this.flagsView.group);
    this.vehiclesView = new VehiclesView();
    this.scene.add(this.vehiclesView.group);
    this.trails.clear();
  }

  // ───────────────────────── menu ─────────────────────────
  enterMenu() {
    this.mode = 'menu';
    this.paused = false;
    this.input.enabled = false;
    this.input.unlock();
    this.hud?.destroy(); this.hud = null;
    if (this.net) { this.net.close(); this.net = null; }
    if (this.world || this.mapId !== 'bay') { this.world = null; this.loadMap('bay'); }
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
    const mapId = mapForMode(opts.mode ?? 'tdm');
    if (this.world || mapId !== this.mapId) this.loadMap(mapId);
    this.world = new World(this.map, opts);
    this.bots.clear();
    let rndSeed = 1;
    const rnd = () => { rndSeed = (rndSeed * 16807) % 2147483647; return rndSeed / 2147483647; };
    const slots = [0, 0];
    slots[this.world.player.team] = 1; // the player takes the first job slot on their team
    this.world.penguins.forEach((p, i) => {
      const m = new PenguinModel(p.team, p.hat, p.bot ? p.name : p.name, true);
      this.scene.add(m.root);
      this.models.set(p.id, m);
      if (p.bot) this.bots.set(p.id, new BotBrain(i, rnd, slots[p.team]++));
    });
    this.hud = new Hud(this.world);
    this.mode = 'play';
    this.input.enabled = true;
    this.input.yaw = this.world.player.yaw;
    this.input.pitch = -0.12;
    this.acc = 0;
    this.countdownLast = -1;
    this.audio.unlock();
    this.audio.whistle();
    if (this.world.mode === 'breakthrough') this.hud.banner('BREAKTHROUGH', this.breakthroughBrief(this.world.player.team), 5);
    else if (this.world.mode === 'conquest') this.hud.banner('CONQUEST', `${this.world.buildLen} seconds to fortify flag A: build walls, pack snowballs, hold T for a turret`, 4.5);
    else this.hud.banner('BUILD PHASE', `${this.world.buildLen} seconds to build your fort and pack snowballs!`, 3.5);
    this.rewardQueued = 0;
    this.input.lock();
  }

  /** Online: the server started a match (or we just joined one). Build its world from the server's roster and snow. */
  beginOnlineMatch(net: NetClient, info: MatchInfo, density: Uint8Array, hard: Uint8Array) {
    const first = this.mode !== 'play' || this.net !== net;
    this.net = net;
    if (this.menuPenguin) { this.menuPenguin.dispose(this.scene); this.menuPenguin = null; }
    this.hud?.destroy(); this.hud = null;
    this.loadMap(mapForMode(info.mode), { density, hard });
    this.world = new World(this.map, { teamSize: info.size, playerName: '', playerHat: '', mode: info.mode, roster: info.roster, meId: info.you });
    this.bots.clear();
    this.trails.clear();
    this.refreshModels();
    net.attach(this.world);
    const me = this.world.player;
    this.hud = new Hud(this.world);
    this.rewardQueued = 0;
    this.mode = 'play';
    this.input.enabled = true;
    this.input.yaw = this.map.bases[me.team].facing;
    this.input.pitch = -0.12;
    this.acc = 0;
    this.countdownLast = -1;
    this.audio.unlock();
    this.audio.whistle();
    this.world.phase = info.phase;
    const team = TEAM_NAMES[me.team];
    const sub = info.phase === 'build' ? (info.mode === 'breakthrough' ? this.breakthroughBrief(me.team) : info.mode === 'conquest' ? 'Fortify your flag: build walls, pack snowballs, hold T for a turret' : 'Build your fort and pack snowballs: the fight starts soon!')
      : info.phase === 'fight' ? 'The fight is on! Grab snowballs from your stockpile with E' : 'This match is wrapping up: the next one starts in a moment';
    this.hud.banner(first ? `YOU'RE ON ${team.toUpperCase()}` : 'NEW MATCH', sub, 3.5);
    this.hooks?.onMatchStart?.();
    if (first) this.input.lock();
    else if (!this.input.locked) this.setPaused(true);
  }

  private breakthroughBrief(team: number) {
    const s = this.world!.buildLen;
    return team === 0 ? `You attack! ${s} seconds to pack snowballs, then take rings A and B on the Flats`
      : `You defend! ${s} seconds to dig in at rings A and B: build walls, hold T for a turret`;
  }

  /** Make sure every penguin has a model that matches its hat and name (online, people join and leave mid-match). */
  refreshModels() {
    const w = this.world;
    if (!w) return;
    for (const p of w.penguins) {
      const key = `${p.team}|${p.hat}|${p.name}`;
      if (this.modelKeys.get(p.id) === key) continue;
      this.models.get(p.id)?.dispose(this.scene);
      const m = new PenguinModel(p.team, p.hat, p.name, true);
      this.scene.add(m.root);
      this.models.set(p.id, m);
      this.modelKeys.set(p.id, key);
    }
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

    {
      const me = this.mode === 'play' ? this.world?.player : null;
      this.env.setFocus(this.camera.position, me ? this.focusTmp.set(me.x, me.y + 0.7, me.z) : null);
    }
    this.env.update(this.time, this.camera, window.innerHeight);
    this.playground.update(this.time);
    this.flagsView.update(this.mode === 'play' ? this.world : null, this.time, dt);
    if (this.mode !== 'play') this.vehiclesView.update(null, 1, dt, this.time, this.particles, this.decals);
    this.decals.update(this.time);
    this.snow.update(this.camera.position, this.mode === 'menu' ? 8 : 4, this.time);
    this.particles.update(dt, window.innerHeight * this.pixelRatio(), this.camera.fov);
    const me = this.world?.player;
    if (this.post && this.quality === 'high') this.post.render(dt, me && me.sliding ? Math.hypot(me.vx, me.vz) : me && me.riding >= 0 ? Math.hypot(me.vx, me.vz) * 0.7 : 0);
    else this.renderer.render(this.scene, this.camera);
  }

  private menuFrame(dt: number) {
    const p = this.menuFake!;
    const m = this.menuPenguin!;
    p.lookPitch = Math.sin(this.time * 0.7) * 0.15;
    p.yaw = -Math.PI / 2 - 0.35 + Math.sin(this.time * 0.4) * 0.25;
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
    pi.roll = playing && inp.down('KeyG');
    pi.turret = playing && inp.down('KeyT');
    if (this.rewardQueued && playing) pi.reward = this.rewardQueued;
    this.rewardQueued = 0;

    // driving: the view swings round with the vehicle, so "ahead" stays ahead (the mouse still looks around)
    const myRide = me.alive && me.seat === 0 ? vehicleOf(w, me) : null;
    if (myRide && this.rideYaw !== null) {
      let d = myRide.yaw - this.rideYaw;
      while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) < 0.5) { inp.yaw += d; pi.yaw = inp.yaw; }
    }
    this.rideYaw = myRide ? myRide.yaw : null;

    // camera first (so aiming uses this frame's view)
    this.updateCamera(dt, me);
    this.computeAim(me);
    pi.aim = (pi.dig || pi.build || pi.turret) ? this.aimSnow : this.throwAim(me);

    // fixed-step simulation
    if (this.net) {
      // online: the server runs the match; we step only our own penguin ahead of it and show everyone else
      this.acc += dt;
      let steps = 0;
      while (this.acc >= STEP && steps < 5) { this.net.step(w, me); this.acc -= STEP; steps++; }
      if (steps === 5) this.acc = 0;
      this.net.present(w, me, dt);
    } else if (!this.paused) {
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
    const alpha = this.paused && !this.net ? 1 : this.acc / STEP;

    this.handleEvents(w, me);

    // visuals
    for (const p of w.penguins) {
      const m = this.models.get(p.id);
      if (!m) continue;
      m.camDist = this.camera.position.distanceTo(m.root.position);
      m.update(p, alpha, dt, this.time, p === me);
      if (p === me && this.net) { const o = this.net.drawOffset; m.root.position.x += o.x; m.root.position.y += o.y; m.root.position.z += o.z; }
    }
    // vehicles, and the penguins sitting on them
    this.vehiclesView.update(w, alpha, dt, this.time, this.particles, this.decals);
    this.vehiclesView.group.updateMatrixWorld(true);
    for (const p of w.penguins) {
      if (p.riding < 0 || !p.alive) continue;
      const m = this.models.get(p.id), seat = this.vehiclesView.seat(p.riding, p.seat), body = this.vehiclesView.body(p.riding);
      const v = vehicleOf(w, p);
      if (!m || !seat || !body || !v) continue;
      seat.getWorldPosition(m.root.position);
      body.getWorldQuaternion(m.root.quaternion);
      // the models face +x, penguins face -z; a passenger also turns to where they're looking
      m.root.quaternion.multiply(this.seatTurn.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, -Math.PI / 2 + (p.seat === 0 ? 0 : p.yaw - v.yaw)));
    }
    this.updateTrails(w);
    // a wisp of snow behind every flying snowball so you can follow it
    for (const b of w.snowballs) this.particles.spawn(PKind.Puff, b.px + (b.x - b.px) * alpha, b.py + (b.y - b.py) * alpha, b.pz + (b.z - b.pz) * alpha, 0, 0.1, 0, 0.1, 0.3);
    this.props.update(w, alpha, dt, this.time);
    this.turretsView.update(w, dt, this.time, this.camera.position);
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
    {
      // engines: yours is loud, others fade with distance
      let level = 0, pitch = 0, heavy = 0;
      for (const v of w.vehicles) {
        if (!v.seats.some(s => s >= 0)) continue;
        const mine = v.id === me.riding;
        const d = Math.hypot(v.x - this.camera.position.x, v.z - this.camera.position.z);
        const l = (mine ? 1 : 0.8) / (1 + d * d * 0.004);
        if (l > level) { level = l; pitch = Math.abs(v.speed) / (v.kind === 'snowplow' ? 6.6 : 17) + (v.grounded ? 0 : 0.35); heavy = v.kind === 'snowplow' ? 1 : 0; }
      }
      this.audio.setEngine(level, pitch, heavy);
    }
    if (me.alive && me.riding < 0 && me.grounded && !me.sliding && Math.hypot(me.vx, me.vz) > 1.5) {
      this.stepT -= dt * Math.hypot(me.vx, me.vz) / 4.5;
      if (this.stepT <= 0) { this.stepT = 0.3; this.audio.step(me.x, me.y, me.z); }
    }

    // build-phase countdown
    if (w.phase === 'build') {
      const s = Math.ceil(w.phaseT);
      if (s <= 5 && s !== this.countdownLast && s > 0) { this.countdownLast = s; this.hud!.banner(String(s), w.mode === 'breakthrough' ? (me.team === 0 ? 'Get ready to charge!' : 'Here they come!') : w.mode === 'conquest' ? 'Get ready to take the flags!' : 'Get ready to throw!', 0.9); this.audio.countdown(false); }
    }

    // HUD
    let hint: string | null = null;
    const riding = me.riding >= 0;
    if ((pi.dig || pi.build) && !riding && !this.aimInReach(me)) hint = 'Aim closer to dig or build';
    if (pi.turret && !pi.build && !pi.dig && !riding) {
      hint = me.turretBlock === 2 ? 'A turret can\'t stand there'
        : me.turretBlock === 3 ? 'Too close to another turret'
        : me.turretBlock === 4 ? `Your team already has ${CFG.maxTeamTurrets} turrets`
        : me.turretAt ? `Building a turret: ${Math.floor(Math.min(1, me.turretSnow / CFG.turretCost) * 100)}% (keep holding T)` : hint;
    }
    if (pi.build && me.buildBlock === 1) hint = 'Too tall to reach from here: get closer or climb up';
    if (pi.build && me.slumping) hint = 'Too thin to go higher: the snow is sliding down to widen the base';
    if (me.noSnowT > 0 && !riding && (pi.pack || pi.build || pi.dig || pi.roll || pi.turret)) hint = me.carried >= CFG.maxCarry && pi.pack ? 'Your mittens are full (5): stash or throw!' : 'No loose snow here';
    if (w.phase === 'build' && pi.fire && me.carried > 0) hint = 'No throwing until the fight starts!';
    this.hud!.update(w, me, dt, hint);
  }

  /** Footprints while walking, a groove while belly sliding, twin tracks behind the surfboard, ruts behind big balls. */
  private updateTrails(w: World) {
    for (const p of w.penguins) {
      let t = this.trails.get(p.id);
      if (!t) { t = { dist: 0, side: 1, x: p.x, z: p.z }; this.trails.set(p.id, t); }
      const d = Math.hypot(p.x - t.x, p.z - t.z);
      t.x = p.x; t.z = p.z;
      if (!p.alive || p.riding >= 0 || !p.grounded || p.onProp || p.onIce || d > 2) { t.dist = 0; continue; }
      t.dist += d;
      const sp = Math.hypot(p.vx, p.vz);
      const moveYaw = sp > 0.1 ? Math.atan2(-p.vx, -p.vz) : p.yaw;
      if (p.surfing) {
        if (t.dist > 0.25) { t.dist = 0; this.decals.boardTrack(this.time, p.x, p.y, p.z, moveYaw); }
      } else if (p.sliding) {
        if (t.dist > 0.22) { t.dist = 0; this.decals.groove(this.time, p.x, p.y, p.z, moveYaw); }
      } else if (t.dist > 0.34) {
        t.dist = 0;
        t.side = -t.side;
        const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
        this.decals.footprint(this.time, p.x + rx * 0.13 * t.side, p.y, p.z + rz * 0.13 * t.side, p.yaw);
      }
    }
    for (const b of w.bigBalls) {
      const key = -b.id;
      let t = this.trails.get(key);
      if (!t) { t = { dist: 0, side: 1, x: b.x, z: b.z }; this.trails.set(key, t); }
      const d = Math.hypot(b.x - t.x, b.z - t.z);
      t.x = b.x; t.z = b.z;
      if (!b.grounded || d > 2) continue;
      t.dist += d;
      if (t.dist > 0.35) { t.dist = 0; this.decals.groove(this.time, b.x, b.y - b.r, b.z, Math.atan2(-b.vx, -b.vz), b.r * 1.3, 0.9); }
    }
  }

  private aimInReach(me: Penguin) {
    const a = this.aimSnow;
    if (!a) return false;
    return Math.hypot(a.x - me.x, a.y - (me.y + 0.8), a.z - me.z) <= CFG.reach + (me.input.build ? 1.2 : me.input.turret ? 0.8 : 0.3);
  }

  /** How far a ray gets before it runs into a tree (its trunk, or the cone of its branches), up to max. */
  private treeClear(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number) {
    let best = max;
    for (const t of this.map.trees) {
      const ex = t.x - ox, ez = t.z - oz;
      if (ex * ex + ez * ez > (max + t.cw) * (max + t.cw)) continue;
      const along = ex * dx + ez * dz;
      if (along < -t.cw || along > best + t.cw) continue;
      for (let d = Math.max(0.5, along - t.cw - 0.5); d < Math.min(best, along + t.cw + 0.5); d += 0.25) {
        const yy = oy + dy * d - t.y;
        if (yy < -0.5 || yy > t.h) continue;
        const r = yy < t.cb ? 0.6 : t.cw * (1 - 0.72 * (yy - t.cb) / Math.max(0.1, t.h - t.cb)) + 0.35;
        if (Math.hypot(ox + dx * d - t.x, oz + dz * d - t.z) < r) { best = Math.max(0, d - 0.4); break; }
      }
    }
    return best;
  }

  private updateCamera(dt: number, me: Penguin) {
    const inp = this.input;
    const alpha = this.acc / STEP;
    const o = this.net?.drawOffset;
    const px = me.px + (me.x - me.px) * alpha + (o?.x ?? 0), py = me.py + (me.y - me.py) * alpha + (o?.y ?? 0), pz = me.pz + (me.z - me.pz) * alpha + (o?.z ?? 0);
    const yaw = inp.yaw, pitch = inp.pitch;
    const fx = -Math.sin(yaw) * Math.cos(pitch), fy = Math.sin(pitch), fz = -Math.cos(yaw) * Math.cos(pitch);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const ride = me.alive ? vehicleOf(this.world!, me) : null;
    let want = me.sliding ? 5.6 : me.charging ? 3.9 : me.input.build || me.input.turret ? 5.6 : 4.8;
    if (ride) want = ride.kind === 'snowplow' ? 10.5 : me.charging ? 5.2 : 6.6 + Math.min(1.6, Math.abs(ride.speed) * 0.1);
    if (!me.alive) want = 6.5;
    this.camDist += (want - this.camDist) * Math.min(1, dt * 6);
    const pivY = py + (ride ? (ride.kind === 'snowplow' ? 2.5 : 1.55) : me.sliding ? 1.0 : 1.5);
    const sh = ride ? (ride.kind === 'snowplow' ? 0 : 0.3) : 0.62;
    const pivX = px + rx * sh, pivZ = pz + rz * sh;
    // pull in if snow is in the way
    let dist = this.camDist;
    const f = this.map.field;
    const hit = f.raycast(pivX, pivY, pivZ, -fx, -fy, -fz, dist, 0.15);
    if (hit) dist = Math.max(0.6, hit.t - 0.3);
    if (ride) {
      // a vehicle's camera sits a long way back: keep it out of the trees too (in quickly, back out gently)
      const clear = Math.max(ride.kind === 'snowplow' ? 3.2 : 2.4, this.treeClear(pivX, pivY, pivZ, -fx, -fy, -fz, dist));
      this.camClear += (clear - this.camClear) * Math.min(1, dt * (clear < this.camClear ? 14 : 2.5));
      dist = Math.min(dist, this.camClear);
    } else this.camClear = 20;
    let cx = pivX - fx * dist, cy = pivY - fy * dist, cz = pivZ - fz * dist;
    const g = f.surfaceBelow(cx, cy + 1, cz, 0, 4);
    if (g !== null && cy < g + 0.35) cy = g + 0.35;
    this.camera.position.set(cx, cy, cz);
    this.camera.rotation.set(pitch, yaw, 0, 'YXZ');
    const fovWant = ride ? (me.charging ? 66 : 72 + Math.min(12, Math.abs(ride.speed) * 0.7)) : me.sliding ? 78 + Math.min(10, Math.hypot(me.vx, me.vz) * 0.5) : me.charging ? 64 : 70;
    this.camera.fov += (fovWant - this.camera.fov) * Math.min(1, dt * 5);
    this.camera.updateProjectionMatrix();
  }

  /**
   * While you hold build, the aim ray ignores the snow you've added during this stroke: it keeps hitting the ground
   * as it was when you started. That's what lets a pile grow straight up under the crosshair instead of creeping
   * toward you, and lets you draw a wall by sweeping the crosshair along the ground.
   */
  private strokeRaycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxD: number) {
    const f = this.map.field;
    for (let t = 0; t <= maxD; t += 0.12) {
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      if (!f.inBoundsXZ(x, z)) { if (y < 0) return null; continue; }
      const h = this.stroke.get(f.colIndex(x, z));
      if (h !== undefined ? y < h : f.sample(x, y, z) > ISO) return { t, x, y: h !== undefined ? Math.min(h, y + 0.12) : y, z };
    }
    return null;
  }

  private rememberStroke(x: number, y: number, z: number) {
    const f = this.map.field;
    const i0 = Math.round(f.fx(x)), k0 = Math.round(f.fz(z));
    for (let dk = -4; dk <= 4; dk++) for (let di = -4; di <= 4; di++) {
      const i = i0 + di, k = k0 + dk;
      if (i < 0 || k < 0 || i >= f.nx || k >= f.nz) continue;
      const col = k * f.nx + i;
      if (this.stroke.has(col)) continue;
      const g = f.surfaceBelow(f.wx(i), y + 1.5, f.wz(k), 0, 5);
      this.stroke.set(col, g ?? -1e9);
    }
  }

  private computeAim(me: Penguin) {
    const w = this.world!;
    const cam = this.camera.position;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const start = Math.max(0.5, this.camDist * 0.85);
    const ox = cam.x + dir.x * start, oy = cam.y + dir.y * start, oz = cam.z + dir.z * start;
    const maxD = 120;
    const building = me.input.build && me.alive;
    if (building && !this.stroking) { this.stroke.clear(); this.stroking = true; }
    if (!building) this.stroking = false;
    const snowHit = building ? this.strokeRaycast(ox, oy, oz, dir.x, dir.y, dir.z, 18) : this.map.field.raycast(ox, oy, oz, dir.x, dir.y, dir.z, maxD, 0.2);
    if (building && snowHit) this.rememberStroke(snowHit.x, snowHit.y, snowHit.z);
    let bestT = snowHit ? snowHit.t : maxD;
    this.aimSnow = snowHit ? { x: snowHit.x, y: snowHit.y, z: snowHit.z } : null;
    let any = this.aimSnow;
    this.aimTarget = null;
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
      const cy = p.y + (p.sliding ? 0.3 : 0.65);
      // enemies are a little "sticky" under the crosshair, more so far away where a penguin is only a few pixels
      const enemy = p.team !== me.team;
      const d = Math.hypot(p.x - ox, cy - oy, p.z - oz);
      const t = raySphere(p.x, cy, p.z, enemy ? 0.52 + Math.min(0.22, d * 0.006) : 0.5);
      // snow in front of them still blocks the shot; the throw goes where the crosshair is, pulled only a little toward them
      if (t > 0 && t < bestT + (enemy ? 0.3 : 0)) {
        bestT = Math.min(bestT, t);
        const tc = (p.x - ox) * dir.x + (cy - oy) * dir.y + (p.z - oz) * dir.z;
        const pull = enemy ? 0.25 : 0;
        any = {
          x: ox + dir.x * tc + (p.x - ox - dir.x * tc) * pull,
          y: oy + dir.y * tc + (cy - oy - dir.y * tc) * pull,
          z: oz + dir.z * tc + (p.z - oz - dir.z * tc) * pull,
        };
        this.aimTarget = enemy ? p : null;
      }
    }
    for (const b of w.bigBalls) {
      const t = raySphere(b.x, b.y, b.z, b.r);
      if (t > 0 && t < bestT) { bestT = t; any = { x: ox + dir.x * t, y: oy + dir.y * t, z: oz + dir.z * t }; this.aimTarget = null; }
    }
    if (!any) any = { x: ox + dir.x * maxD, y: oy + dir.y * maxD, z: oz + dir.z * maxD };
    this.aimAny = any;
  }

  private throwSpeed(me: Penguin) {
    return (CFG.throwSpeedMin + (CFG.throwSpeedMax - CFG.throwSpeedMin) * me.charge) * (1 + me.mitten * CFG.throwPerLevel);
  }

  /** Where a throw should go: the crosshair point, led a little when there's a moving enemy under it. */
  private throwAim(me: Penguin) {
    const a = this.aimAny, t = this.aimTarget;
    if (!a || !t || CFG.aimAssist <= 0) return a;
    const flight = Math.hypot(t.x - me.x, t.z - me.z) / (this.throwSpeed(me) * 0.96);
    const k = flight * CFG.aimAssist;
    return { x: a.x + t.vx * k, y: a.y, z: a.z + t.vz * k };
  }

  private updateAimVisuals(me: Penguin) {
    const pi = me.input;
    const f = this.map.field;
    const marker = this.props.aimMarker, ghost = this.props.buildGhost;
    const turreting = pi.turret && !pi.build && !pi.dig;
    const showMarker = me.alive && me.riding < 0 && (pi.dig || pi.build || turreting) && (me.turretAt || (this.aimSnow && this.aimInReach(me)));
    marker.visible = !!showMarker && !turreting;
    ghost.visible = !!showMarker && (pi.build || turreting);
    if (showMarker && turreting) {
      // a ring on the snow where the snowman will stand (it locks in once you start scooping)
      const a = me.turretAt ?? this.aimSnow!;
      ghost.position.set(a.x, a.y + 0.08, a.z);
      (ghost.material as THREE.MeshBasicMaterial).color.set(me.turretBlock ? 0xff5a5a : 0x9dffb0);
    } else if (showMarker && this.aimSnow) {
      const a = this.aimSnow;
      const mat = marker.material as THREE.MeshBasicMaterial;
      if (pi.build) {
        // the lump sits on top of whatever snow is at the aim point
        const top = f.sample(a.x, a.y - 0.2, a.z) > ISO ? f.topAbove(a.x, a.y - 0.2, a.z, 7) : a.y;
        marker.position.set(a.x, top + 0.25, a.z);
        marker.scale.setScalar(CFG.buildRadius * (1 + Math.sin(this.time * 10) * 0.04));
        const col = me.buildBlock ? 0xff5a5a : me.slumping ? 0xffd34d : 0x8fe6ff;
        mat.color.set(col);
        ghost.position.set(a.x, a.y + 0.05, a.z);
        (ghost.material as THREE.MeshBasicMaterial).color.set(col);
      } else {
        marker.position.set(a.x, a.y, a.z);
        marker.scale.setScalar(0.62 * (1 + Math.sin(this.time * 10) * 0.05));
        mat.color.set(0xffb36b);
      }
    }
    // throw arc: faint whenever you're holding snowballs, bold while you wind up
    const w = this.world!;
    const busy = pi.dig || pi.build || pi.plow || pi.pack || pi.turret;
    if (me.alive && w.phase === 'fight' && me.carried > 0 && (me.charging || !busy) && !(me.riding >= 0 && me.seat === 0)) {
      const speed = this.throwSpeed(me);
      const h = w.handPos(me);
      const v = solveThrow(h, this.throwAim(me), speed, CFG.snowballGravity) ?? lookVelocity(me.lookYaw, me.lookPitch + 0.07, speed);
      const pts: number[][] = [];
      let x = h.x, y = h.y, z = h.z, vx = v.x + me.vx * 0.3, vy = v.y, vz = v.z + me.vz * 0.3;
      let normal: { x: number; y: number; z: number } | null = null;
      let willHit = false;
      const sdt = 0.04;
      const hitR = CFG.hitRadius + CFG.snowballRadius;
      outer: for (let i = 0; i < 71; i++) {
        pts.push([x, y, z]);
        vy -= CFG.snowballGravity * sdt;
        const nx = x + vx * sdt, ny = y + vy * sdt, nz = z + vz * sdt;
        // check along the step so fast throws don't skip through things
        for (let s = 1; s <= 4; s++) {
          const u = s / 4, qx = x + (nx - x) * u, qy = y + (ny - y) * u, qz = z + (nz - z) * u;
          for (const p of w.penguins) {
            if (!p.alive || p.team === me.team) continue;
            const cy = p.sliding ? p.y + 0.3 : Math.max(p.y + 0.3, Math.min(p.y + 1.05, qy));
            if (Math.hypot(qx - p.x, qy - cy, qz - p.z) < hitR) { pts.push([qx, qy, qz]); normal = { x: -vx, y: -vy, z: -vz }; willHit = true; break outer; }
          }
          if (f.sample(qx, qy, qz) > ISO || qy < 0) {
            pts.push([qx, qy, qz]);
            normal = f.normalAt(qx, qy, qz, { x: 0, y: 1, z: 0 });
            break outer;
          }
        }
        x = nx; y = ny; z = nz;
      }
      this.props.arc.set(pts, normal, me.charging ? 1 : 0.5, willHit || !!this.aimTarget, this.time, this.camera.position);
    } else this.props.arc.hide();
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
        const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
        this.decals.dent(this.time, p.x + fx * 0.6, p.y, p.z + fz * 0.6, 0.32);
        break;
      }
      case 'board': {
        if (e.what === 'spawn') { H.banner('SURFBOARD!', `A surfboard popped up ${e.where}. Grab it to surf!`, 3); A.flake(e.x, e.y, e.z); P.sparkle(e.x, e.y, e.z, 50, 1.3, 1.0, 0.5); }
        else if (e.what === 'grab') {
          const p = w.penguin(e.pid)!;
          P.sparkle(e.x, e.y + 0.5, e.z, 40, 1.3, 1.0, 0.5); A.flake(e.x, e.y, e.z);
          if (e.pid === me.id) H.banner('SURF\'S UP!', 'You are faster on the board. Splat and you drop it!', 2.6);
          else H.toast(`${p.name} grabbed the surfboard!`, 2);
        } else if (e.what === 'drop') { H.toast('The surfboard dropped! Go grab it!', 2); }
        break;
      }
      case 'launch': {
        const p = w.penguin(e.pid)!;
        A.slide(p.x, p.y, p.z); A.jump(p.x, p.y, p.z);
        P.burst(p.x, p.y, p.z, 14, 2.5, 1);
        if (e.pid === me.id) H.toast('WHEEE!', 1);
        break;
      }
      case 'noSnow': if (e.pid === me.id) A.noSnow(); break;
      case 'collapse': {
        // unsupported snow came down: a curtain of powder and a thump
        const n = Math.min(90, 10 + Math.ceil(e.mass / 60));
        for (let k = 0; k < n; k++) P.burst(e.x + (Math.random() - 0.5) * 3.5, e.y - Math.random() * e.drop, e.z + (Math.random() - 0.5) * 3.5, 1, 2.2, 0.5);
        A.crush(e.x, e.y, e.z, Math.min(1, e.mass / 6000));
        break;
      }
      case 'ballMade': {
        P.burst(e.x, e.y, e.z, 26, 3, 1.2);
        A.pat(e.x, e.y, e.z);
        if (e.pid === me.id && !this.taughtRoll) { this.taughtRoll = true; H.banner('GIANT SNOWBALL!', 'Push it through fresh snow to grow it, then send it downhill', 3); }
        break;
      }
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
        if (e.by === me.id && e.pid !== me.id) H.banner('SPLAT!', e.cause === 'turret' ? `Your turret got ${victim.name}` : e.cause === 'vehicle' ? `You ran over ${victim.name}` : `You got ${victim.name}`, 1.3);
        break;
      }
      case 'turretBuilt': {
        P.burst(e.x, e.y + 0.9, e.z, 46, 3.5, 1.4);
        P.sparkle(e.x, e.y + 1.4, e.z, 24, 0.9, 0.97, 1.0);
        A.packDone(e.x, e.y, e.z); A.crush(e.x, e.y, e.z, 0.35);
        if (e.pid === me.id) {
          if (!this.taughtTurret) { this.taughtTurret = true; H.banner('TURRET UP!', 'It throws at any enemy it can see. Hold E beside it to hand it your snowballs', 3.4); }
          else H.toast('Turret up!', 1.6);
        }
        break;
      }
      case 'turretFire': A.whoosh(e.x, e.y, e.z, 0.15); P.burst(e.x, e.y, e.z, 5, 1.8, 0.4); break;
      case 'turretHit': {
        P.burst(e.x, e.y, e.z, 22, 3.5, 1.1); A.splatSnow(e.x, e.y, e.z);
        if (e.by === me.id) { H.hitMarker(e.health <= 0); A.hitMarker(); }
        break;
      }
      case 'turretDown': {
        P.burst(e.x, e.y + 0.9, e.z, 110, 6, 1.5); A.crush(e.x, e.y, e.z, 0.8);
        if (e.by === me.id) H.toast('Turret knocked down!', 1.6);
        else if (e.owner === me.id && e.by >= 0) H.toast('Your turret got knocked down!', 2);
        break;
      }
      case 'turretLoad': if (e.pid === me.id) { A.stash(); H.toast(`Loaded ${e.n * CFG.turretAmmoPerBall} shots into the turret`, 1.6); } break;
      case 'streak': {
        if (e.pid !== me.id) {
          const p = w.penguin(e.pid);
          if (p && e.reward >= 0 && e.streak >= CFG.streakAt[1]) H.toast(`${p.name} is on a ${e.streak} splat streak!`, 2);
          break;
        }
        if (e.reward >= 0) { A.flake(me.x, me.y, me.z); H.banner(`${e.streak} SPLAT STREAK!`, `${REWARD_NAMES[e.reward]} ready: press ${e.reward + 1}`, 2.8); }
        break;
      }
      case 'reward': {
        const p = w.penguin(e.pid);
        if (e.reward === 2) {
          this.turretsView.barrage(e.x, e.y, e.z, p ? p.team : 0, CFG.avalancheDelay + CFG.avalancheTime + 0.6);
          A.whistle();
          if (e.pid === me.id) H.banner('AVALANCHE!', 'Snowballs incoming', 1.8);
          else if (p && p.team !== me.team && Math.hypot(e.x - me.x, e.z - me.z) < CFG.avalancheRadius + 6) H.banner('AVALANCHE!', 'Get out of the ring!', 1.8);
        } else if (e.reward === 0) {
          P.sparkle(e.x, e.y + 1, e.z, 50, 1.0, 0.8, 0.4); A.flake(e.x, e.y, e.z);
          if (e.pid === me.id) H.banner('SNOWBALL FRENZY!', `Unlimited snowballs for ${CFG.frenzyTime} seconds: hold the mouse down`, 2.2);
        }
        break;
      }
      case 'rewardFail': if (e.pid === me.id) { A.noSnow(); H.toast('No room for a turret there: aim at open snow near you', 2); } break;
      case 'capture': {
        const pt = w.points[e.point];
        P.sparkle(pt.x, pt.y + 5, pt.z, 80, e.team === 0 ? 0.3 : 1.0, e.team === 0 ? 0.6 : 0.5, e.team === 0 ? 1.0 : 0.2);
        A.flake(pt.x, pt.y, pt.z);
        if (w.mode === 'breakthrough') {
          const more = w.activePoints().some(i => w.points[i].owner !== 0);
          if (e.team === 0) H.banner(me.team === 0 ? `${pt.name} IS OURS!` : `WE LOST ${pt.name}!`, me.team === 0 ? (more ? 'Hold it, and take the other one' : 'That\'s the whole section!') : (more ? 'Take it back before they get the other one' : 'Fall back!'), 2.4);
          else H.banner(me.team === 1 ? `${pt.name} IS OURS AGAIN!` : `THEY TOOK ${pt.name} BACK!`, me.team === 1 ? 'Keep them out of it' : 'Get back in that ring', 2.2);
        } else if (e.team === me.team) H.banner(`FLAG ${pt.name} IS OURS!`, 'Hold it to keep scoring', 2.2);
        else H.banner(`${TEAM_NAMES[e.team].toUpperCase()} TOOK ${pt.name}!`, 'Take it back', 2.2);
        break;
      }
      case 'sector': {
        // Breakthrough: a whole section fell (the last one ends the match, and the end screen says so)
        const next = w.map.sectors[e.sector + 1];
        if (!next) break;
        const name = w.map.sectors[e.sector].name.toUpperCase();
        if (me.team === 0) H.banner(`${name} IS OURS!`, `+${e.tickets} tickets. Regroup at the new camp: ${next.name} opens in ${CFG.btRegroup} seconds`, 4.5);
        else H.banner(`WE LOST ${name}!`, `Fall back to ${next.name} and dig in: they come in ${CFG.btRegroup} seconds`, 4.5);
        A.whistle();
        break;
      }
      case 'sectorOpen': {
        const sec = w.map.sectors[e.sector];
        const rings = sec.points.length > 1 ? 'rings A and B' : 'ring A';
        if (me.team === 0) H.banner('GO GO GO!', `Take ${rings} in ${sec.name}`, 2.6);
        else H.banner('HERE THEY COME!', `Hold ${rings} in ${sec.name}`, 2.6);
        A.whistle();
        break;
      }
      case 'lastStand': {
        if (me.team === 0) H.banner('LAST STAND!', `No tickets left, so nobody comes back. Take the section in ${CFG.btLastStand} seconds or it's over`, 4.5);
        else H.banner('THEY\'RE OUT OF TICKETS!', 'Splat the ones still standing and it\'s over', 4);
        A.countdown(false);
        break;
      }
      case 'neutral': {
        const pt = w.points[e.point];
        const what = w.mode === 'breakthrough' ? 'ring' : 'flag';
        H.toast(e.team === me.team ? `We're losing ${what} ${pt.name}!` : `${what === 'ring' ? 'Ring' : 'Flag'} ${pt.name} is up for grabs!`, 2.2);
        if (e.team === me.team) A.noSnow();
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
        if (e.phase === 'fight') {
          if (w.mode === 'breakthrough') {
            if (me.team === 0) H.banner('BREAK THROUGH!', 'Stand in rings A and B to take them. Every splat costs your team a ticket', 3.2);
            else H.banner('HOLD THE LINE!', 'Keep them out of rings A and B until their tickets run out', 3.2);
          } else if (w.mode === 'conquest') H.banner('TAKE THE FLAGS!', `Stand in a flag's ring to take it. First to ${w.scoreToWin} points wins!`, 3);
          else H.banner('FIGHT!', 'Splat the other team. First to ' + w.scoreToWin + ' wins!', 2.2);
          A.whistle();
        }
        break;
      case 'vehicle': {
        const name = VEHICLE_NAMES[e.kind], plow = e.kind === 'snowplow';
        const p = w.penguin(e.pid);
        if (e.what === 'spawn') {
          P.burst(e.x, e.y + 0.5, e.z, plow ? 60 : 24, 3.5, 1.2);
          if (plow && w.phase === 'fight') {
            if (me.team === e.team) H.banner('SNOWPLOW READY!', 'It\'s at your camp: hop in with E. It drives straight through snow walls', 4);
            else H.banner('SNOWPLOW INCOMING!', 'Snowballs and giant snowballs wreck it. Stay out from in front of the blade!', 4);
            A.whistle();
          }
        } else if (e.what === 'home') P.burst(e.x, e.y + 0.5, e.z, 30, 3, 1.2);
        else if (e.what === 'enter') {
          A.engineStart(e.x, e.y, e.z, plow);
          if (e.pid === me.id) {
            const driving = me.seat === 0;
            if (!this.taughtDrive || plow) H.banner(plow ? 'SNOWPLOW!' : driving ? 'SNOWMOBILE!' : 'ON THE BACK!', plow ? 'W/S drive, A/D steer. Walls, turrets and penguins in front of the blade go flying. E hops out' : driving ? 'W/S drive, A/D steer, E hops off. A friend on the back seat can throw' : 'You can still pack and throw from the back seat. E hops off', 3.2);
            this.taughtDrive = true;
          } else if (plow && p && w.phase === 'fight') H.toast(p.team === me.team ? `${p.name} is driving the snowplow: follow it in!` : `${p.name} is driving the snowplow!`, 2.4);
        } else if (e.what === 'exit') { if (e.pid === me.id) A.click(); }
        else if (e.what === 'denied' && e.pid === me.id) { A.noSnow(); H.toast(plow ? 'Only the attackers can drive the snowplow' : `The other team is on that ${name}`, 2); }
        break;
      }
      case 'vehicleHit': {
        P.burst(e.x, e.y, e.z, 18, 3.2, 1); A.clank(e.x, e.y, e.z);
        if (e.by === me.id) { H.hitMarker(e.health <= 0); A.hitMarker(); }
        break;
      }
      case 'vehicleDown': {
        const plow = e.kind === 'snowplow';
        P.burst(e.x, e.y + 0.8, e.z, plow ? 220 : 110, plow ? 9 : 7, 1.6);
        for (let k = 0; k < (plow ? 26 : 12); k++) P.spawn(PKind.Puff, e.x + (Math.random() - 0.5) * 3, e.y + 0.5 + Math.random() * 2, e.z + (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, 2 + Math.random() * 3, (Math.random() - 0.5) * 3, 0.9 + Math.random(), 1.6, 0.35, 0.35, 0.38);
        P.sparkle(e.x, e.y + 1.2, e.z, plow ? 50 : 24, 1.0, 0.7, 0.3);
        A.crush(e.x, e.y, e.z, 0.9); A.clank(e.x, e.y, e.z); A.splat(e.x, e.y, e.z);
        if (plow) H.banner(me.team === e.team ? 'THE SNOWPLOW IS WRECKED!' : 'SNOWPLOW WRECKED!', me.team === e.team ? `The next one turns up in ${CFG.plowEvery} seconds` : 'Nice throwing. They get another one soon', 3);
        else if (e.by === me.id) H.toast('Snowmobile wrecked!', 1.8);
        break;
      }
      case 'vehicleBump': P.burst(e.x, e.y, e.z, 10 + Math.floor(e.hard * 30), 3 + e.hard * 3, 1); A.crush(e.x, e.y, e.z, 0.25 + e.hard * 0.5); A.clank(e.x, e.y, e.z, 0.5); break;
      case 'vehicleAir': { const mine = w.vehicles.find(v => v.id === e.vid); if (mine && mine.id === me.riding) H.toast('AIR!', 1); break; }
      case 'vehicleLand': P.burst(e.x, e.y, e.z, 20 + Math.floor(e.hard * 50), 3 + e.hard * 4, 0.8); A.crush(e.x, e.y, e.z, 0.3 + e.hard * 0.5); break;
      case 'plowSnow': {
        const v = w.vehicles.find(q => q.id === e.vid) as Vehicle | undefined;
        if (v) this.vehiclesView.plowSpray(v, e.mass, P);
        if (e.mass > 500) A.crush(e.x, e.y, e.z, Math.min(0.7, e.mass / 5000));
        else if (Math.random() < 0.3) A.crunch(e.x, e.y, e.z, 0.2);
        break;
      }
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
