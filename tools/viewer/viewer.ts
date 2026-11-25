// Dev-only model viewer (npm run dev, then open /tools/viewer/). Lights the Blender assets like the game does so
// they can be checked and screenshotted in any pose: see tools/viewer/shots.mjs.
import * as THREE from 'three';
import { loadAssets } from '../../src/render/Assets';
import { PenguinModel, setPenguinQuality } from '../../src/render/PenguinModel';
import { Penguin } from '../../src/sim/World';
import { PostFX } from '../../src/render/PostFX';

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

interface Actor { model: PenguinModel; p: Penguin; tick?: (p: Penguin, t: number, dt: number) => void }
const actors: Actor[] = [];
let time = 0;
let usePost = true;

const api = {
  ready: false,
  clear() { for (const a of actors) a.model.dispose(scene); actors.length = 0; },
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
      for (const a of actors) { a.tick?.(a.p, time, dt); a.model.camDist = camera.position.distanceTo(a.model.root.position); a.model.update(a.p, 1, dt, time, false); }
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
  api.camera(0, 1.6, -9, 0, 0.6, 0, 35);
  let last = performance.now();
  const loop = (now: number) => { const dt = Math.min(0.05, (now - last) / 1000); last = now; api.run(1, dt); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); post.setSize(innerWidth, innerHeight, 1); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
