import * as THREE from 'three';
import { MapDef, mulberry32, groundHeight } from '../world/MapDef';
import { makeSnowMaterial } from './SnowRenderer';

export const TEAM_COLORS = [0x2f8cff, 0xff6a2b];
export const TEAM_NAMES = ['Team Blizzard', 'Team Sunrise'];
export const TEAM_CSS = ['#3d95ff', '#ff7a3d'];

export const FOG_COLOR = 0xcfe1f4;
export const FOG_NEAR = 110;
export const FOG_FAR = 460;

const SKY_VERT = `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`;
const SKY_FRAG = `varying vec3 vDir; uniform vec3 uSun; uniform float uTime;
  float h2(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(h2(i), h2(i+vec2(1,0)), f.x), mix(h2(i+vec2(0,1)), h2(i+vec2(1,1)), f.x), f.y); }
  float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * n2(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
  void main(){
    vec3 d = normalize(vDir);
    float h = clamp(d.y, -0.2, 1.0);
    float s = max(dot(d, uSun), 0.0);
    vec3 zen = vec3(0.13, 0.36, 0.78);
    vec3 hor = vec3(0.74, 0.86, 0.97);
    vec3 warm = vec3(1.0, 0.84, 0.70);
    vec3 c = mix(hor, zen, pow(max(h, 0.0), 0.5));
    // warm glow low in the sky on the sun's side, cool on the far side
    c = mix(c, warm, smoothstep(0.3, -0.03, h) * (0.25 + 0.75 * pow(s, 2.5)));
    c = mix(vec3(0.81, 0.88, 0.96), c, smoothstep(-0.06, 0.03, h));
    if (d.y > 0.015) {
      // two layers of drifting cloud, lit warm on the sun side
      vec2 uv = d.xz / (d.y + 0.14);
      float n = fbm(uv * 1.15 + vec2(uTime * 0.006, uTime * 0.002));
      float n2b = fbm(uv * 2.7 - vec2(uTime * 0.004, 0.0) + 31.0);
      float cl = smoothstep(0.5, 0.76, n * 0.75 + n2b * 0.25) * smoothstep(0.015, 0.16, d.y);
      vec3 lit = mix(vec3(0.78, 0.83, 0.94), vec3(1.0, 0.98, 0.95), smoothstep(0.5, 0.85, n));
      lit += vec3(1.0, 0.72, 0.45) * pow(s, 5.0) * 0.55;
      c = mix(c, lit, cl * 0.9);
    }
    // the sun: a hot disc with a wide soft halo
    // colours above were picked by eye in display space: convert to linear light so they survive tone mapping
    c = pow(max(c, vec3(0.0)), vec3(2.2)) * 1.25;
    c += vec3(1.0, 0.86, 0.64) * (smoothstep(0.9993, 0.9997, s) * 14.0 + pow(s, 350.0) * 2.4 + pow(s, 24.0) * 0.3 + pow(s, 4.0) * 0.06);
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/** Shared by every material that should melt away when it gets between the camera and your penguin. */
const SEE = { uSeeA: { value: new THREE.Vector3() }, uSeeB: { value: new THREE.Vector3() } };
function seeThrough<T extends THREE.Material>(mat: T): T {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSeeA = SEE.uSeeA; sh.uniforms.uSeeB = SEE.uSeeB;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSeeW;')
      .replace('#include <project_vertex>', `#include <project_vertex>
#ifdef USE_INSTANCING
  vSeeW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vSeeW = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSeeW;\nuniform vec3 uSeeA;\nuniform vec3 uSeeB;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
{
  vec3 ab = uSeeB - uSeeA; float l2 = dot(ab, ab);
  if (l2 > 0.01) {
    float t = dot(vSeeW - uSeeA, ab) / l2;
    float d = length(vSeeW - (uSeeA + ab * clamp(t, 0.0, 1.0)));
    float keep = smoothstep(0.8, 2.0, d);
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (t < 1.0 && keep < n * 0.9 + 0.1) discard;
  }
}`);
  };
  return mat;
}

/** Sky dome, sun, lights, fog, the land around the arena, far mountains, trees, rocks, the frozen pond, igloos and flags. */
export class Environment {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private flakes: THREE.Points;
  private flakeMat: THREE.ShaderMaterial;
  private skyMat: THREE.ShaderMaterial;
  private flags: THREE.Mesh[] = [];
  private envTarget: THREE.WebGLRenderTarget | null = null;
  readonly sunDir = new THREE.Vector3(0.34, 0.4, -0.85).normalize();

  constructor(private scene: THREE.Scene, private map: MapDef, renderer: THREE.WebGLRenderer) {
    const horizon = new THREE.Color(FOG_COLOR);
    scene.fog = new THREE.Fog(horizon, FOG_NEAR, FOG_FAR);
    scene.background = horizon;

    // sky dome
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uSun: { value: this.sunDir }, uTime: { value: 0 } },
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(600, 48, 24), this.skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.group.add(sky);

    // image-based light from the sky itself, so ice, metal and snow pick up real sky colour
    {
      const pm = new THREE.PMREMGenerator(renderer);
      const s = new THREE.Scene();
      s.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.ShaderMaterial({
        side: THREE.BackSide, uniforms: { uSun: { value: this.sunDir }, uTime: { value: 0 } },
        vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: SKY_FRAG.replace('smoothstep(0.9993, 0.9997, s) * 14.0', '0.0').replace('#include <tonemapping_fragment>', '').replace('#include <colorspace_fragment>', ''),
      })));
      // snowy ground bounce
      const floor = new THREE.Mesh(new THREE.CircleGeometry(50, 24), new THREE.MeshBasicMaterial({ color: 0xc9d9ee }));
      floor.rotation.x = -Math.PI / 2; floor.position.y = -1.5;
      s.add(floor);
      this.envTarget = pm.fromScene(s, 0.035, 0.1, 200);
      scene.environment = this.envTarget.texture;
      scene.environmentIntensity = 0.62;
      pm.dispose();
    }

    // lights: a low warm sun and cool sky fill
    this.hemi = new THREE.HemisphereLight(0x9fc2ff, 0xdfe8f8, 0.48);
    this.group.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffe6cc, 3.25);
    this.sun.position.copy(this.sunDir).multiplyScalar(140);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -86; sc.right = 86; sc.top = 78; sc.bottom = -78; sc.near = 20; sc.far = 320;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.06;
    this.sun.shadow.radius = 2.2;
    this.sun.target.position.set(0, 4, 0);
    this.group.add(this.sun, this.sun.target);

    this.addOuterLand();
    this.addMountains();
    this.addTrees();
    this.addRocks();
    this.addPond();
    this.addBases();

    // falling snow around the camera (animated on the GPU)
    const N = 7000;
    const p = new Float32Array(N * 3);
    const rnd = new Float32Array(N);
    for (let n = 0; n < N; n++) { p[n * 3] = Math.random() * 60 - 30; p[n * 3 + 1] = Math.random() * 30; p[n * 3 + 2] = Math.random() * 60 - 30; rnd[n] = Math.random(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('rnd', new THREE.BufferAttribute(rnd, 1));
    this.flakeMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uScale: { value: 400 } },
      vertexShader: `attribute float rnd; uniform float uTime; uniform vec3 uCam; uniform float uScale; varying float vA;
        void main(){
          vec3 p = position;
          p.y = mod(p.y - uTime * (0.6 + rnd * 0.6), 30.0);
          p.x += sin(uTime * 0.7 + rnd * 40.0) * 0.6 + uTime * 0.25;
          p.z += cos(uTime * 0.5 + rnd * 23.0) * 0.5;
          // wrap around the camera
          p.x = uCam.x + mod(p.x - uCam.x + 30.0, 60.0) - 30.0;
          p.z = uCam.z + mod(p.z - uCam.z + 30.0, 60.0) - 30.0;
          p.y = uCam.y - 10.0 + p.y;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (0.045 + rnd * 0.06) * uScale / -mv.z;
          vA = smoothstep(60.0, 8.0, -mv.z) * smoothstep(0.3, 1.5, -mv.z) * 0.85;
        }`,
      fragmentShader: `varying float vA; void main(){ vec2 c = gl_PointCoord - 0.5; float d = dot(c,c); if (d > 0.25) discard; gl_FragColor = vec4(1.0,1.0,1.0, vA * (1.0 - d*4.0)); }`,
    });
    this.flakes = new THREE.Points(g, this.flakeMat);
    this.flakes.frustumCulled = false;
    this.group.add(this.flakes);

    scene.add(this.group);
  }

  dispose() {
    this.envTarget?.dispose();
    this.scene.environment = null;
  }

  /** The snowy land that carries on past the edge of the arena, so the world doesn't end at the rim. */
  private addOuterLand() {
    const f = this.map.field;
    const step = 4, half = 300, n = (half * 2) / step + 1;
    const pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3);
    const x1 = f.x0 + (f.nx - 1) * f.cell, z1 = f.z0 + (f.nz - 1) * f.cell;
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
      const x = -half + i * step, z = -half + k * step;
      let y = outerHeight(x, z);
      // inside the arena the real snow field takes over: tuck this sheet underneath it
      if (x > f.x0 + 0.1 && x < x1 - 0.1 && z > f.z0 + 0.1 && z < z1 - 0.1) y -= 5;
      const o = (k * n + i) * 3;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      col[o] = 0.93; col[o + 1] = 0.96; col[o + 2] = 1.0;
    }
    const idx: number[] = [];
    for (let k = 0; k < n - 1; k++) for (let i = 0; i < n - 1; i++) {
      const a = k * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aIce', new THREE.BufferAttribute(new Float32Array(n * n), 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, makeSnowMaterial());
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private addMountains() {
    const rand = mulberry32(99);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true });
    const snow = new THREE.Color(0xf2f6fd), rock = new THREE.Color(0x73839c), c = new THREE.Color();
    for (let n = 0; n < 46; n++) {
      const ring = n % 2;
      const a = (n / 46) * Math.PI * 2 + rand() * 0.12;
      const r = (ring ? 300 : 235) + rand() * 55;
      const h = (ring ? 95 : 60) + rand() * 60;
      const w = 55 + rand() * 45;
      const geo = new THREE.ConeGeometry(w, h, 7 + Math.floor(rand() * 3), 5);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const cols = new Float32Array(pos.count * 3);
      const snowLine = 0.25 + rand() * 0.25;
      for (let v = 0; v < pos.count; v++) {
        const y = pos.getY(v);
        if (y < h / 2 - 0.1) {
          pos.setX(v, pos.getX(v) * (0.78 + rand() * 0.44)); pos.setZ(v, pos.getZ(v) * (0.78 + rand() * 0.44));
          pos.setY(v, y + (rand() - 0.5) * h * 0.11);
        }
        const t = (pos.getY(v) + h / 2) / h; // 0 at the foot, 1 at the peak
        c.copy(rock).lerp(snow, Math.min(1, Math.max(0, (t - snowLine) * 4 + rand() * 0.5)));
        if (t < 0.12) c.lerp(snow, 1); // snowed-in feet blend into the land
        cols[v * 3] = c.r; cols[v * 3 + 1] = c.g; cols[v * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, mat);
      m.position.set(Math.cos(a) * r, h / 2 + 6, Math.sin(a) * r * 0.9);
      m.rotation.y = rand() * Math.PI;
      this.group.add(m);
    }
  }

  private addTrees() {
    const layers = 4;
    const trunkGeo = new THREE.CylinderGeometry(0.13, 0.24, 1, 7);
    const coneGeo = new THREE.ConeGeometry(1, 1, 9, 1, true);
    // snow sits on the upper side of each bough: a shallower cone, slightly lumpy
    const capGeo = new THREE.ConeGeometry(1, 1, 9, 2);
    {
      const p = capGeo.attributes.position as THREE.BufferAttribute;
      for (let v = 0; v < p.count; v++) {
        const y = p.getY(v);
        if (y < 0.45) { const s = 1 + Math.sin(v * 12.9898) * 0.12; p.setX(v, p.getX(v) * s); p.setZ(v, p.getZ(v) * s); p.setY(v, y + Math.sin(v * 78.233) * 0.05); }
      }
      capGeo.computeVertexNormals();
    }
    const trunkMat = seeThrough(new THREE.MeshStandardMaterial({ color: 0x5b3e2c, roughness: 1 }));
    const leafMat = seeThrough(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, flatShading: true, side: THREE.DoubleSide }));
    const snowMat = seeThrough(new THREE.MeshStandardMaterial({ color: 0xf4f8ff, roughness: 0.8 }));

    // the arena's own trees (these have collision), plus woods carrying on up the slopes outside it
    const all = this.map.trees.map(t => ({ ...t }));
    const rand = mulberry32(4242);
    const f = this.map.field;
    const x1 = f.x0 + f.nx * f.cell, z1 = f.z0 + f.nz * f.cell;
    for (let n = 0; n < 5200 && all.length < this.map.trees.length + 950; n++) {
      const x = (rand() * 2 - 1) * 215, z = (rand() * 2 - 1) * 200;
      if (x > f.x0 - 0.5 && x < x1 + 0.5 && z > f.z0 - 0.5 && z < z1 + 0.5) continue;
      const d = Math.max(Math.abs(x) - 72, Math.abs(z) - 52);
      if (rand() > 1.05 - d / 150) continue; // thins out with distance
      const h = 4.5 + rand() * rand() * 7;
      all.push({ x, z, y: outerHeight(x, z) - 0.3, h, r: 0.3, cb: 1.0 + h * 0.16, cw: 0.9 + h * 0.2 });
    }

    const trunk = new THREE.InstancedMesh(trunkGeo, trunkMat, all.length);
    const leaves = new THREE.InstancedMesh(coneGeo, leafMat, all.length * layers);
    const caps = new THREE.InstancedMesh(capGeo, snowMat, all.length * layers);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0), tilt = new THREE.Quaternion(), c = new THREE.Color();
    const r2 = mulberry32(7);
    all.forEach((t, n) => {
      const trunkH = t.cb + (t.h - t.cb) * 0.3;
      p.set(t.x, t.y + trunkH / 2, t.z); s.set(0.8 + t.h * 0.08, trunkH, 0.8 + t.h * 0.08); q.identity();
      m.compose(p, q, s); trunk.setMatrixAt(n, m);
      const lean = (r2() - 0.5) * 0.08;
      tilt.setFromAxisAngle(new THREE.Vector3(1, 0, 0), lean);
      const tone = 0.82 + r2() * 0.3;
      for (let l = 0; l < layers; l++) {
        const fl = l / (layers - 1);
        const ch = t.h - t.cb; // height of the leafy part
        const w = t.cw * (1 - fl * 0.66) * (0.92 + r2() * 0.16);
        const hh = ch * (0.46 - fl * 0.08);
        const y = t.y + t.cb + fl * ch * 0.6;
        q.setFromAxisAngle(up, r2() * Math.PI * 2).premultiply(tilt);
        p.set(t.x, y + hh / 2, t.z); s.set(w, hh, w);
        m.compose(p, q, s); leaves.setMatrixAt(n * layers + l, m);
        // darker and bluer low down in the shade, brighter at the top
        c.setRGB(0.13 * tone * (0.8 + fl * 0.35), 0.31 * tone * (0.82 + fl * 0.3), 0.25 * tone * (0.9 + fl * 0.1));
        leaves.setColorAt(n * layers + l, c);
        p.set(t.x, y + hh * 0.585, t.z); s.set(w * 0.74, hh * 0.52, w * 0.74);
        m.compose(p, q, s); caps.setMatrixAt(n * layers + l, m);
      }
    });
    for (const im of [trunk, leaves, caps]) { im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; this.group.add(im); }
  }

  private addRocks() {
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x77869c, roughness: 0.9, flatShading: true });
    const snowMat = new THREE.MeshStandardMaterial({ color: 0xf6f9ff, roughness: 0.85 });
    for (const r of this.map.rocks) {
      const rand = mulberry32(r.seed);
      const geo = new THREE.IcosahedronGeometry(r.r, 1);
      const p = geo.attributes.position as THREE.BufferAttribute;
      // nudge shared corners by the same amount so the rock stays closed
      const seen = new Map<string, number>();
      for (let v = 0; v < p.count; v++) {
        const key = `${p.getX(v).toFixed(3)},${p.getY(v).toFixed(3)},${p.getZ(v).toFixed(3)}`;
        let k = seen.get(key);
        if (k === undefined) { k = 0.8 + rand() * 0.38; seen.set(key, k); }
        p.setXYZ(v, p.getX(v) * k, p.getY(v) * k * 0.82, p.getZ(v) * k);
      }
      geo.computeVertexNormals();
      const rock = new THREE.Mesh(geo, rockMat);
      rock.position.set(r.x, r.y + r.r * 0.22, r.z);
      rock.rotation.y = rand() * 6;
      rock.castShadow = true; rock.receiveShadow = true;
      this.group.add(rock);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(r.r * 0.78, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), snowMat);
      cap.scale.set(1, 0.42, 1);
      cap.position.set(r.x, r.y + r.r * 0.72, r.z);
      cap.castShadow = true; cap.receiveShadow = true;
      this.group.add(cap);
    }
  }

  private addPond() {
    const pd = this.map.pond;
    const ice = new THREE.Mesh(new THREE.CircleGeometry(pd.r - 0.2, 64), new THREE.MeshPhysicalMaterial({
      color: 0x8fcdee, roughness: 0.06, metalness: 0.0, transparent: true, opacity: 0.86, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.6,
    }));
    ice.rotation.x = -Math.PI / 2;
    ice.position.set(pd.x, pd.y + 0.03, pd.z);
    ice.receiveShadow = true;
    this.group.add(ice);
    // a few crack lines
    const crackMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
    const rand = mulberry32(5);
    for (let c = 0; c < 11; c++) {
      const pts: THREE.Vector3[] = [];
      let a = rand() * Math.PI * 2, r = rand() * 3.5;
      let x = pd.x + Math.cos(a) * r, z = pd.z + Math.sin(a) * r;
      for (let s = 0; s < 7; s++) {
        pts.push(new THREE.Vector3(x, pd.y + 0.045, z));
        a += (rand() - 0.5) * 1.2; x += Math.cos(a) * 0.9; z += Math.sin(a) * 0.9;
        if (Math.hypot(x - pd.x, z - pd.z) > pd.r - 0.6) break;
      }
      this.group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), crackMat));
    }
  }

  private addBases() {
    for (const b of this.map.bases) {
      const col = TEAM_COLORS[b.team];
      // igloo (decor + cover): dome of blocks
      const igloo = new THREE.Group();
      const blockMat = new THREE.MeshStandardMaterial({ color: 0xf1f6ff, roughness: 0.55 });
      const dome = new THREE.Mesh(new THREE.SphereGeometry(2.4, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), blockMat);
      dome.castShadow = true; dome.receiveShadow = true;
      igloo.add(dome);
      // block seams
      const seamMat = new THREE.LineBasicMaterial({ color: 0xa9c0da });
      for (let r = 1; r < 5; r++) {
        const phi = (r / 5) * Math.PI / 2;
        const rr = Math.cos(phi) * 2.41, yy = Math.sin(phi) * 2.41;
        const pts: THREE.Vector3[] = [];
        for (let s = 0; s <= 40; s++) { const a = (s / 40) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * rr, yy, Math.sin(a) * rr)); }
        igloo.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), seamMat));
      }
      const tunnel = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 1.6, 20, 1, false, 0, Math.PI), blockMat);
      tunnel.rotation.z = Math.PI / 2; tunnel.rotation.y = Math.PI / 2;
      tunnel.position.set(0, 0, 2.3);
      tunnel.castShadow = true;
      igloo.add(tunnel);
      const door = new THREE.Mesh(new THREE.CircleGeometry(0.75, 20, 0, Math.PI), new THREE.MeshBasicMaterial({ color: 0x1b2836 }));
      door.position.set(0, 0.02, 3.11);
      igloo.add(door);
      // a team-coloured stripe of blocks around the dome
      const band = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.36, 0.34, 32, 1, true), new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, emissive: col, emissiveIntensity: 0.15 }));
      band.position.y = 0.62;
      igloo.add(band);
      igloo.position.set(b.igloo.x, b.igloo.y - 0.15, b.igloo.z);
      igloo.rotation.y = b.team === 0 ? Math.PI / 2 : -Math.PI / 2;
      this.group.add(igloo);

      // flag
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 7, 8), new THREE.MeshStandardMaterial({ color: 0x8a6a4a }));
      pole.position.set(b.flag.x, b.flag.y + 3.5, b.flag.z);
      pole.castShadow = true;
      this.group.add(pole);
      const flagGeo = new THREE.PlaneGeometry(2.6, 1.6, 14, 5);
      flagGeo.translate(1.3, 0, 0);
      const flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: col, side: THREE.DoubleSide, roughness: 0.75, emissive: col, emissiveIntensity: 0.12 }));
      flag.position.set(b.flag.x, b.flag.y + 6.1, b.flag.z);
      flag.castShadow = true;
      flag.userData.base = flagGeo.attributes.position.array.slice();
      this.flags.push(flag);
      this.group.add(flag);

      // a team-coloured ring around the stockpile
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.7, 2.0, 48), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.6, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(b.stockpile.x, b.stockpile.y + 0.08, b.stockpile.z);
      ring.renderOrder = 2;
      ring.userData.stockRing = true;
      this.group.add(ring);
    }
  }

  /** Trees between the camera and this point fade out (pass null to turn that off). */
  setFocus(cam: THREE.Vector3, target: THREE.Vector3 | null) {
    SEE.uSeeA.value.copy(cam);
    SEE.uSeeB.value.copy(target ?? cam);
  }

  update(time: number, cam: THREE.Camera, viewportH: number) {
    this.skyMat.uniforms.uTime.value = time;
    this.flakeMat.uniforms.uTime.value = time;
    this.flakeMat.uniforms.uCam.value.copy(cam.position);
    this.flakeMat.uniforms.uScale.value = viewportH * 0.9;
    for (const f of this.flags) {
      const pos = f.geometry.attributes.position as THREE.BufferAttribute;
      const base = f.userData.base as Float32Array;
      for (let v = 0; v < pos.count; v++) {
        const x = base[v * 3];
        pos.setZ(v, Math.sin(time * 4 + x * 2.5) * 0.15 * x);
      }
      pos.needsUpdate = true;
    }
  }
}

/** Land height outside the arena: the rim carries on into rolling foothills that climb toward the mountains. */
export function outerHeight(x: number, z: number) {
  const d = Math.max(0, Math.max(Math.abs(x) - 72, Math.abs(z) - 52));
  const t = Math.min(1, d / 70);
  const roll = Math.sin(x * 0.021 + 1.3) * Math.cos(z * 0.024 + 0.4) * 7 + Math.sin(x * 0.05 + z * 0.043) * 2.2;
  return groundHeight(x, z) + t * t * (3 - 2 * t) * (roll + d * 0.07);
}
