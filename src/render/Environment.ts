import * as THREE from 'three';
import { MapDef, mulberry32 } from '../world/MapDef';

export const TEAM_COLORS = [0x2f8cff, 0xff6a2b];
export const TEAM_NAMES = ['Team Blizzard', 'Team Sunrise'];
export const TEAM_CSS = ['#3d95ff', '#ff7a3d'];

/** Sky dome, sun, lights, fog, far mountains, trees, the frozen pond, igloos and flags. */
export class Environment {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private flakes: THREE.Points;
  private flakeMat: THREE.ShaderMaterial;
  private flags: THREE.Mesh[] = [];
  readonly sunDir = new THREE.Vector3(0.3, 0.42, -0.86).normalize();

  constructor(scene: THREE.Scene, private map: MapDef) {
    const horizon = new THREE.Color(0xcfe3f5);
    scene.fog = new THREE.Fog(horizon, 70, 230);
    scene.background = horizon;

    // sky dome
    const skyGeo = new THREE.SphereGeometry(400, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uSun: { value: this.sunDir } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
      fragmentShader: `varying vec3 vDir; uniform vec3 uSun;
        void main(){
          float h = clamp(vDir.y, -0.2, 1.0);
          vec3 zen = vec3(0.24, 0.47, 0.82);
          vec3 hor = vec3(0.81, 0.89, 0.96);
          vec3 low = vec3(0.98, 0.86, 0.80);
          vec3 c = mix(hor, zen, pow(max(h,0.0), 0.55));
          c = mix(low, c, smoothstep(-0.02, 0.12, h));
          float s = max(dot(vDir, uSun), 0.0);
          c += vec3(1.0, 0.9, 0.7) * (pow(s, 600.0) * 4.0 + pow(s, 12.0) * 0.25);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.group.add(sky);

    // lights
    this.hemi = new THREE.HemisphereLight(0xa9c9ff, 0xe8eefc, 0.95);
    this.group.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffeedd, 2.9);
    this.sun.position.copy(this.sunDir).multiplyScalar(80);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -62; sc.right = 62; sc.top = 52; sc.bottom = -52; sc.near = 10; sc.far = 200;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sun.target.position.set(0, 0, 0);
    this.group.add(this.sun, this.sun.target);

    this.addMountains();
    this.addTrees();
    this.addPond();
    this.addBases();

    // falling snow around the camera (animated on the GPU)
    const N = 5000;
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
          gl_PointSize = (0.05 + rnd * 0.06) * uScale / -mv.z;
          vA = smoothstep(60.0, 8.0, -mv.z) * 0.9;
        }`,
      fragmentShader: `varying float vA; void main(){ vec2 c = gl_PointCoord - 0.5; float d = dot(c,c); if (d > 0.25) discard; gl_FragColor = vec4(1.0,1.0,1.0, vA * (1.0 - d*4.0)); }`,
    });
    this.flakes = new THREE.Points(g, this.flakeMat);
    this.flakes.frustumCulled = false;
    this.group.add(this.flakes);

    scene.add(this.group);
  }

  private addMountains() {
    const rand = mulberry32(99);
    const mat = new THREE.MeshStandardMaterial({ color: 0xe8f0fa, roughness: 0.95, flatShading: true, fog: true });
    const rock = new THREE.MeshStandardMaterial({ color: 0x8c9db3, roughness: 1, flatShading: true });
    for (let n = 0; n < 34; n++) {
      const a = (n / 34) * Math.PI * 2 + rand() * 0.1;
      const r = 120 + rand() * 60;
      const h = 25 + rand() * 45;
      const w = 30 + rand() * 30;
      const geo = new THREE.ConeGeometry(w, h, 6 + Math.floor(rand() * 3), 3);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      for (let v = 0; v < pos.count; v++) {
        const y = pos.getY(v);
        if (y < h / 2 - 0.1) { pos.setX(v, pos.getX(v) * (0.8 + rand() * 0.4)); pos.setZ(v, pos.getZ(v) * (0.8 + rand() * 0.4)); pos.setY(v, y + (rand() - 0.5) * h * 0.12); }
      }
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, rand() < 0.3 ? rock : mat);
      m.position.set(Math.cos(a) * r, h / 2 - 6, Math.sin(a) * r * 0.85);
      m.rotation.y = rand() * Math.PI;
      this.group.add(m);
      if (m.material === rock) {
        // snow cap
        const cap = new THREE.Mesh(new THREE.ConeGeometry(w * 0.42, h * 0.42, 6, 1), mat);
        cap.position.set(m.position.x, m.position.y + h * 0.29, m.position.z);
        cap.rotation.y = m.rotation.y;
        this.group.add(cap);
      }
    }
    // outer snowy ground ring so the arena doesn't float
    const ring = new THREE.Mesh(new THREE.CircleGeometry(400, 48), new THREE.MeshStandardMaterial({ color: 0xeef4fb, roughness: 1 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 9;
    ring.receiveShadow = false;
    this.group.add(ring);
  }

  private addTrees() {
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 1, 6);
    const coneGeo = new THREE.ConeGeometry(1, 1, 7);
    const capGeo = new THREE.ConeGeometry(1, 1, 7);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3d2b, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2c5b4a, roughness: 0.9, flatShading: true });
    const snowMat = new THREE.MeshStandardMaterial({ color: 0xf6f9ff, roughness: 0.85, flatShading: true });
    const trees = this.map.trees;
    const layers = 3;
    const trunk = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
    const leaves = new THREE.InstancedMesh(coneGeo, leafMat, trees.length * layers);
    const caps = new THREE.InstancedMesh(capGeo, snowMat, trees.length * layers);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const rand = mulberry32(7);
    trees.forEach((t, n) => {
      p.set(t.x, t.y + 0.5, t.z); s.set(1, 1.2, 1); q.identity();
      m.compose(p, q, s); trunk.setMatrixAt(n, m);
      const rot = rand() * Math.PI;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
      for (let l = 0; l < layers; l++) {
        const f = l / layers;
        const w = (1.55 - f * 0.9) * (t.h / 5);
        const hh = t.h * 0.42;
        p.set(t.x, t.y + 1.0 + f * t.h * 0.55 + hh / 2, t.z); s.set(w, hh, w);
        m.compose(p, q, s); leaves.setMatrixAt(n * layers + l, m);
        p.set(t.x, t.y + 1.0 + f * t.h * 0.55 + hh * 0.62, t.z); s.set(w * 0.66, hh * 0.5, w * 0.66);
        m.compose(p, q, s); caps.setMatrixAt(n * layers + l, m);
      }
    });
    for (const im of [trunk, leaves, caps]) { im.castShadow = true; im.receiveShadow = true; this.group.add(im); }
  }

  private addPond() {
    const pd = this.map.pond;
    const ice = new THREE.Mesh(new THREE.CircleGeometry(pd.r - 0.2, 48), new THREE.MeshStandardMaterial({
      color: 0xa9d8f2, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.82,
    }));
    ice.rotation.x = -Math.PI / 2;
    ice.position.set(pd.x, pd.y + 0.03, pd.z);
    ice.receiveShadow = true;
    this.group.add(ice);
    // a few crack lines
    const crackMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
    const rand = mulberry32(5);
    for (let c = 0; c < 7; c++) {
      const pts: THREE.Vector3[] = [];
      let a = rand() * Math.PI * 2, r = rand() * 2;
      let x = pd.x + Math.cos(a) * r, z = pd.z + Math.sin(a) * r;
      for (let s = 0; s < 6; s++) {
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
      const blockMat = new THREE.MeshStandardMaterial({ color: 0xf4f8ff, roughness: 0.6 });
      const dome = new THREE.Mesh(new THREE.SphereGeometry(2.4, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), blockMat);
      dome.castShadow = true; dome.receiveShadow = true;
      igloo.add(dome);
      // block seams
      const seamMat = new THREE.LineBasicMaterial({ color: 0xb8cce0 });
      for (let r = 1; r < 5; r++) {
        const phi = (r / 5) * Math.PI / 2;
        const rr = Math.cos(phi) * 2.41, yy = Math.sin(phi) * 2.41;
        const pts: THREE.Vector3[] = [];
        for (let s = 0; s <= 40; s++) { const a = (s / 40) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * rr, yy, Math.sin(a) * rr)); }
        igloo.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), seamMat));
      }
      const tunnel = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 1.6, 16, 1, false, 0, Math.PI), blockMat);
      tunnel.rotation.z = Math.PI / 2; tunnel.rotation.y = Math.PI / 2;
      tunnel.position.set(0, 0, 2.3);
      tunnel.castShadow = true;
      igloo.add(tunnel);
      const door = new THREE.Mesh(new THREE.CircleGeometry(0.75, 16, 0, Math.PI), new THREE.MeshBasicMaterial({ color: 0x1b2836 }));
      door.position.set(0, 0.02, 3.11);
      igloo.add(door);
      igloo.position.set(b.igloo.x, b.igloo.y - 0.15, b.igloo.z);
      igloo.rotation.y = b.team === 0 ? Math.PI / 2 : -Math.PI / 2;
      this.group.add(igloo);

      // flag
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 5, 6), new THREE.MeshStandardMaterial({ color: 0x8a6a4a }));
      pole.position.set(b.flag.x, b.flag.y + 2.5, b.flag.z);
      pole.castShadow = true;
      this.group.add(pole);
      const flagGeo = new THREE.PlaneGeometry(1.8, 1.1, 12, 4);
      flagGeo.translate(0.9, 0, 0);
      const flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: col, side: THREE.DoubleSide, roughness: 0.8 }));
      flag.position.set(b.flag.x, b.flag.y + 4.4, b.flag.z);
      flag.castShadow = true;
      flag.userData.base = flagGeo.attributes.position.array.slice();
      this.flags.push(flag);
      this.group.add(flag);

      // a team-coloured ring around the stockpile
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.7, 2.0, 40), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(b.stockpile.x, b.stockpile.y + 0.08, b.stockpile.z);
      ring.renderOrder = 2;
      ring.userData.stockRing = true;
      this.group.add(ring);
    }
  }

  update(time: number, cam: THREE.Camera, viewportH: number) {
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
