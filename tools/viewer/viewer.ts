// Dev-only model viewer (npm run dev, then open /tools/viewer/). Lights the Blender assets like the game does so
// they can be checked and screenshotted in any pose: see tools/viewer/shots.mjs.
import * as THREE from 'three';
import { Assets, loadAssets } from '../../src/render/Assets';
import { PenguinModel, setPenguinQuality } from '../../src/render/PenguinModel';
import { Penguin } from '../../src/sim/World';
import { PostFX } from '../../src/render/PostFX';
import { makeVehicleModel, VehicleKind } from '../../src/render/VehicleModel';
import { GUN_HOLD, GUN_BACK, GUN_BACK_Q } from '../../src/render/GunsView';

/** How a penguin carries the Candy Cane Blade: grip beside the right hip, blade up and a little forward ('YXZ' angles). */
const BLADE_CARRY = { at: new THREE.Vector3(0.5, 0.6, -0.12), rx: 1.05, ry: 0.12, rz: -0.18 };
/** The middle of a mitten, seen from its hand joint (the flipper's rest direction, 0.077 m on from the joint). */
const MITTEN = new THREE.Vector3(0.0447, -0.0627, 0);
const _v = new THREE.Vector3();

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.05, 200);
const sunDir = new THREE.Vector3(0.34, 0.4, -0.85).normalize();

// sky: the same sort of gradient the game's sky dome gives, used for the backdrop and the image-based light
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `varying vec3 vDir; void main(){ float h = clamp(vDir.y, -1.0, 1.0);
    vec3 c = mix(vec3(0.80,0.88,0.98), vec3(0.20,0.42,0.86), pow(max(h,0.0), 0.55));
    c = mix(c, vec3(0.79,0.85,0.93), smoothstep(0.0, -0.2, h));
    gl_FragColor = vec4(c, 1.0); }`,
});
{
  const pm = new THREE.PMREMGenerator(renderer);
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMat));
  scene.environment = pm.fromScene(s, 0.035, 0.1, 200).texture;
  scene.environmentIntensity = 0.62;
}
const sky = new THREE.Mesh(new THREE.SphereGeometry(150, 32, 16), skyMat);
scene.add(sky);
scene.add(new THREE.HemisphereLight(0x9fc2ff, 0xdfe8f8, 0.48));
const sun = new THREE.DirectionalLight(0xffe6cc, 3.25);
sun.position.copy(sunDir).multiplyScalar(30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera as THREE.OrthographicCamera;
sc.left = -8; sc.right = 8; sc.top = 8; sc.bottom = -8; sc.near = 1; sc.far = 80;
sun.shadow.bias = -0.0004;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0xf2f6ff, roughness: 0.9 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
scene.add(ground);

const post = new PostFX(renderer, scene, camera);
post.setSize(innerWidth, innerHeight, 1);

const TEAM_TINT = [0x2f7ee8, 0xff8a2e];
const vehicles: THREE.Group[] = [];

interface Actor { model: PenguinModel; p: Penguin; tick?: (p: Penguin, t: number, dt: number) => void; after?: () => void }
const actors: Actor[] = [];
const props: THREE.Object3D[] = [];
let time = 0;
let usePost = true;

const api = {
  ready: false,
  clear() { for (const a of actors) a.model.dispose(scene); actors.length = 0; for (const o of props) o.removeFromParent(); props.length = 0; for (const v of vehicles) scene.remove(v); vehicles.length = 0; },
  /** Add a vehicle (front toward `yaw`, radians from +x turning toward -z). riders: put a penguin on every seat. */
  async vehicle(opts: { kind: VehicleKind; team?: number; x?: number; z?: number; yaw?: number; riders?: boolean }) {
    const g = await makeVehicleModel(opts.kind, TEAM_TINT[opts.team ?? 0]);
    g.position.set(opts.x ?? 0, 0, opts.z ?? 0);
    g.rotation.y = opts.yaw ?? 0;
    scene.add(g);
    vehicles.push(g);
    g.updateMatrixWorld(true);
    if (opts.riders) for (const name of ['seat0', 'seat1']) {
      const seat = g.getObjectByName(name);
      if (!seat) continue;
      const at = seat.getWorldPosition(new THREE.Vector3());
      // a penguin faces -z at yaw 0; the vehicle's front is its +x
      api.add({ team: opts.team ?? 0, hat: name === 'seat1' ? 'beanie' : 'none', x: at.x, z: at.z, yaw: (opts.yaw ?? 0) - Math.PI / 2, state: { y: at.y, py: at.y } });
    }
    return vehicles.length - 1;
  },
  /** Turn a named part of a vehicle: rot = [x, y, z] radians. */
  part(i: number, name: string, rot: [number, number, number]) { vehicles[i].getObjectByName(name)?.rotation.set(rot[0], rot[1], rot[2]); },
  /** Run the belts `metres` along and roll the wheels to match. */
  drive(i: number, metres: number) {
    vehicles[i].traverse(o => {
      for (const t of (o.userData.scroll as THREE.Texture[] | undefined) ?? []) t.offset.y = metres % 1;
      if (o.name.startsWith('wheel')) o.rotation.z = -metres / (o.userData.radius ?? 0.2);
    });
  },
  /** Which way a belt's v runs along its bottom run (should rise toward the front, +x), its bounding box, and whether its textures are its own. */
  uvcheck(i: number) {
    const out: Record<string, unknown> = {};
    vehicles[i].traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.mat !== 'tread') return;
      const pos = m.geometry.attributes.position, uv = m.geometry.attributes.uv;
      let lo: number[] | null = null, hi: number[] | null = null, vmin = 1e9, vmax = -1e9, umin = 1e9, umax = -1e9;
      const base = m.getWorldPosition(new THREE.Vector3());
      for (let k = 0; k < pos.count; k++) {
        vmin = Math.min(vmin, uv.getY(k)); vmax = Math.max(vmax, uv.getY(k)); umin = Math.min(umin, uv.getX(k)); umax = Math.max(umax, uv.getX(k));
        if (pos.getY(k) + base.y > 0.03) continue; // the bottom run only
        const p = [pos.getX(k) + base.x, uv.getY(k)];
        if (!lo || p[0] < lo[0]) lo = p; if (!hi || p[0] > hi[0]) hi = p;
      }
      out[m.parent!.name] = { rear: lo, front: hi, u: [umin, umax], v: [vmin, vmax], scroll: (m.parent!.userData.scroll as unknown[] | undefined)?.length };
    });
    out.box = new THREE.Box3().setFromObject(vehicles[i]).min.toArray().concat(new THREE.Box3().setFromObject(vehicles[i]).max.toArray()).map(v => +v.toFixed(3));
    return out;
  },
  /** What the model is made of: every named node with its position, for checking pivots. */
  nodes(i: number) {
    const out: Record<string, number[]> = {};
    vehicles[i].traverse(o => { if (o.name && !(o as THREE.Mesh).isMesh) out[o.name] = [...o.getWorldPosition(new THREE.Vector3()).sub(vehicles[i].position).toArray().map(v => +v.toFixed(3)), o.userData.radius ?? 0]; });
    return out;
  },
  /** Add a gun ('cocoa' | 'water' | 'blade') on its own. It points along -Z when yaw is 0, like a penguin. Returns where its named nodes (muzzle and foregrip, or tip and mid) ended up. */
  gun(name: string, opts: { x?: number; y?: number; z?: number; yaw?: number; pitch?: number; roll?: number; scale?: number } = {}) {
    const src = Assets.guns.get(name);
    if (!src) throw new Error('no gun called ' + name);
    const g = src.clone();
    g.position.set(opts.x ?? 0, opts.y ?? 1, opts.z ?? 0);
    g.rotation.set(opts.pitch ?? 0, opts.yaw ?? 0, opts.roll ?? 0, 'YXZ');
    g.scale.setScalar(opts.scale ?? 1);
    scene.add(g); props.push(g);
    const out: Record<string, number[]> = {};
    g.updateMatrixWorld(true);
    g.traverse(o => { if (!(o as THREE.Mesh).isMesh) out[o.name] = o.getWorldPosition(new THREE.Vector3()).toArray(); });
    return out;
  },
  /** Put a gun on penguin i where the game does (GUN_HOLD and GUN_BACK in src/render/GunsView.ts; the game also poses the arm): in its mittens, or slung on its back. The blade is carried point up in the right mitten. */
  hold(i: number, name: string, where: 'hand' | 'back' = 'hand') {
    const g = Assets.guns.get(name)!.clone();
    if (name === 'blade' && where === 'hand') {
      // the blade follows the right mitten, wherever the pose puts it, so the grip always sits in the mitten
      g.position.copy(BLADE_CARRY.at); g.rotation.set(BLADE_CARRY.rx, BLADE_CARRY.ry, BLADE_CARRY.rz, 'YXZ');
      const a = actors[i], hand = a.model.root.getObjectByName('handR');
      if (hand) a.after = () => { a.model.root.updateMatrixWorld(true); g.position.copy(a.model.root.worldToLocal(hand.localToWorld(_v.copy(MITTEN)))); };
    } else if (where === 'hand') g.position.copy(GUN_HOLD);
    else { g.position.copy(GUN_BACK); g.quaternion.copy(GUN_BACK_Q); g.scale.setScalar(0.92); }
    actors[i].model.root.add(g); props.push(g);
  },
  /** Names of the guns that loaded. */
  guns() { return [...Assets.guns.keys()]; },
  /** Add a penguin. state: fields to set on its sim Penguin; anim: 'walk' | 'run' moves it as if walking. */
  add(opts: { team?: number; hat?: string; x?: number; z?: number; yaw?: number; name?: string | null; state?: Partial<Penguin>; anim?: string }) {
    const p = new Penguin(actors.length, opts.name ?? '', opts.team ?? 0, opts.hat ?? 'none', false);
    p.x = p.px = opts.x ?? 0; p.z = p.pz = opts.z ?? 0; p.y = p.py = 0;
    p.yaw = opts.yaw ?? 0; p.grounded = true;
    Object.assign(p, opts.state ?? {});
    const model = new PenguinModel(p.team, p.hat, opts.name ?? null, !!opts.name);
    scene.add(model.root);
    const a: Actor = { model, p };
    if (opts.anim === 'walk' || opts.anim === 'run') {
      const sp = opts.anim === 'run' ? 6 : 3;
      a.tick = (q) => { q.vx = -Math.sin(q.yaw) * sp; q.vz = -Math.cos(q.yaw) * sp; };
    }
    if (opts.anim === 'throw') a.tick = (q, t) => { const u = (t % 1.6); q.action = u < 0.9 ? 'charge' : u < 1.15 ? 'throw' : 'idle'; q.charge = Math.min(1, u / 0.8); q.throwAnim = u >= 0.9 && u < 1.15 ? 1.15 - u : 0; };
    actors.push(a);
    return actors.length - 1;
  },
  set(i: number, state: Partial<Penguin>) { Object.assign(actors[i].p, state); },
  camera(px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov = 30) {
    camera.position.set(px, py, pz); camera.lookAt(tx, ty, tz); camera.fov = fov; camera.updateProjectionMatrix();
  },
  quality(low: boolean) { setPenguinQuality(low); usePost = !low; },
  /** Advance n frames of dt and draw. */
  run(n = 1, dt = 1 / 60) {
    for (let i = 0; i < n; i++) {
      time += dt;
      for (const a of actors) { a.tick?.(a.p, time, dt); a.model.camDist = camera.position.distanceTo(a.model.root.position); a.model.update(a.p, 1, dt, time, false); a.after?.(); }
    }
    if (usePost) post.render(dt, 0); else renderer.render(scene, camera);
  },
  info() { return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles }; },
};
(window as unknown as { viewer: typeof api }).viewer = api;

await loadAssets();
api.ready = true;
if (!new URLSearchParams(location.search).has('script')) {
  // a default line-up when opened by hand
  const hats = ['none', 'beanie', 'tophat', 'propeller', 'viking', 'crown', 'fish', 'party', 'chef', 'cone'];
  hats.forEach((h, i) => api.add({ team: i % 2, hat: h, x: (i - 4.5) * 1.1, yaw: Math.PI, anim: i % 3 === 1 ? 'walk' : undefined }));
  void api.vehicle({ kind: 'snowmobile', team: 0, x: -3.6, z: 3.2, yaw: 2.2, riders: true });
  void api.vehicle({ kind: 'snowplow', team: 1, x: 3.2, z: 5.2, yaw: 1.2, riders: true });
  [...Assets.guns.keys()].forEach((n, i) => api.gun(n, { x: (i - 0.5) * 1.1, y: 0.75, z: -1.6, yaw: Math.PI / 2 }));
  api.camera(0, 1.6, -9, 0, 0.6, 0, 35);
  let last = performance.now();
  const loop = (now: number) => { const dt = Math.min(0.05, (now - last) / 1000); last = now; api.run(1, dt); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); post.setSize(innerWidth, innerHeight, 1); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
