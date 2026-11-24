import * as THREE from 'three';
import { SnowField, ISO } from '../world/SnowField';

// Thousands of little snow grains that fly, tumble, land on the snow and settle. This is what sells the pushing.
const CAP = 24000;

export const enum PKind { Grain = 0, Puff = 1, Spark = 2 }

export class Particles {
  readonly points: THREE.Points;
  private pos = new Float32Array(CAP * 3);
  private vel = new Float32Array(CAP * 3);
  private life = new Float32Array(CAP);
  private maxLife = new Float32Array(CAP);
  private size = new Float32Array(CAP);
  private baseSize = new Float32Array(CAP);
  private alpha = new Float32Array(CAP);
  private color = new Float32Array(CAP * 3);
  private kind = new Uint8Array(CAP);
  private settled = new Uint8Array(CAP);
  private alive = new Uint8Array(CAP);
  private next = 0;
  private count = 0;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private frame = 0;

  constructor(private field: SnowField) {
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('palpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('pcolor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uScale: { value: 600 },
        fogColor: { value: new THREE.Color(0xcfe1f4) }, fogNear: { value: 110 }, fogFar: { value: 460 },
      },
      vertexShader: `
        attribute float psize; attribute float palpha; attribute vec3 pcolor;
        uniform float uScale;
        varying float vAlpha; varying vec3 vColor; varying float vFog;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.0, psize * uScale / -mv.z);
          vAlpha = palpha; vColor = pcolor; vFog = -mv.z;
        }`,
      fragmentShader: `
        uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
        varying float vAlpha; varying vec3 vColor; varying float vFog;
        void main(){
          vec2 c = gl_PointCoord - 0.5;
          float d = dot(c, c);
          if (d > 0.25) discard;
          // little lit sphere: bright top-left, blue-grey underside
          float shade = 0.78 + 0.32 * (-c.y * 1.3 - c.x * 0.5);
          vec3 col = vColor * shade;
          col = mix(col, vec3(0.62, 0.72, 0.88) * vColor, smoothstep(0.05, 0.25, d) * 0.35);
          float f = smoothstep(fogNear, fogFar, vFog);
          col = mix(col, fogColor, f);
          float a = vAlpha * (1.0 - smoothstep(0.16, 0.25, d));
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  spawn(kind: PKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, r = 1, g = 1, b = 1) {
    const i = this.next;
    this.next = (this.next + 1) % CAP;
    if (!this.alive[i]) this.count++;
    this.alive[i] = 1;
    this.kind[i] = kind;
    this.settled[i] = 0;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.baseSize[i] = size; this.size[i] = size;
    this.alpha[i] = kind === PKind.Puff ? 0.55 : 1;
    this.color[i * 3] = r; this.color[i * 3 + 1] = g; this.color[i * 3 + 2] = b;
  }

  /** A burst of grains + puffs (snowball impact, splat, crush). */
  burst(x: number, y: number, z: number, n: number, speed: number, up = 1, nx = 0, ny = 1, nz = 0) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, s = Math.sqrt(1 - u * u);
      let dx = Math.cos(a) * s, dy = Math.abs(u) * up, dz = Math.sin(a) * s;
      const dn = dx * nx + dy * ny + dz * nz;
      if (dn < 0) { dx -= 2 * dn * nx; dy -= 2 * dn * ny; dz -= 2 * dn * nz; }
      const sp = speed * (0.3 + Math.random() * 0.9);
      this.spawn(PKind.Grain, x, y, z, dx * sp, dy * sp + 1.5, dz * sp, 0.035 + Math.random() * 0.06, 1.6 + Math.random());
    }
    for (let k = 0; k < Math.ceil(n / 5); k++) {
      this.spawn(PKind.Puff, x + (Math.random() - 0.5) * 0.3, y + Math.random() * 0.2, z + (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * speed * 0.4 + nx, Math.random() * 1.2 + ny * 0.6, (Math.random() - 0.5) * speed * 0.4 + nz, 0.25 + Math.random() * 0.35, 0.5 + Math.random() * 0.5);
    }
  }

  /** Snow thrown from one point to land on another (dig over the shoulder, build onto a wall). */
  arc(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, n: number, flight = 0.4, spread = 0.25) {
    for (let k = 0; k < n; k++) {
      const t = flight * (0.8 + Math.random() * 0.4);
      const sx = fx + (Math.random() - 0.5) * spread, sy = fy + Math.random() * 0.1, sz = fz + (Math.random() - 0.5) * spread;
      const ex = tx + (Math.random() - 0.5) * spread * 1.6, ey = ty + (Math.random() - 0.5) * spread, ez = tz + (Math.random() - 0.5) * spread * 1.6;
      const vx = (ex - sx) / t, vz = (ez - sz) / t;
      const vy = (ey - sy) / t + 0.5 * 9.8 * t;
      this.spawn(PKind.Grain, sx, sy, sz, vx, vy, vz, 0.035 + Math.random() * 0.055, t + 0.6 + Math.random() * 0.5);
    }
  }

  sparkle(x: number, y: number, z: number, n: number, r: number, g: number, b: number) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, s = Math.sqrt(1 - u * u);
      const sp = 2 + Math.random() * 4;
      this.spawn(PKind.Spark, x, y, z, Math.cos(a) * s * sp, u * sp + 2, Math.sin(a) * s * sp, 0.06 + Math.random() * 0.08, 0.6 + Math.random() * 0.6, r, g, b);
    }
  }

  update(dt: number, viewportH: number, fov: number) {
    this.mat.uniforms.uScale.value = viewportH / (2 * Math.tan((fov * Math.PI / 180) / 2));
    this.frame++;
    const f = this.field;
    const checkCollide = true;
    for (let i = 0; i < CAP; i++) {
      if (!this.alive[i]) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.alive[i] = 0; this.count--; this.alpha[i] = 0; this.size[i] = 0; continue; }
      const k = this.kind[i];
      const i3 = i * 3;
      if (k === PKind.Grain) {
        if (this.settled[i]) {
          // shrink away once landed
          const t = this.life[i];
          this.size[i] = this.baseSize[i] * Math.min(1, t * 2.5);
          continue;
        }
        this.vel[i3 + 1] -= 9.8 * dt;
        const drag = 1 - 0.6 * dt;
        this.vel[i3] *= drag; this.vel[i3 + 2] *= drag;
        const nx = this.pos[i3] + this.vel[i3] * dt, ny = this.pos[i3 + 1] + this.vel[i3 + 1] * dt, nz = this.pos[i3 + 2] + this.vel[i3 + 2] * dt;
        if (checkCollide && this.vel[i3 + 1] < 0.5 && f.sample(nx, ny, nz) > ISO) {
          // landed: stick to the surface and settle
          this.settled[i] = 1;
          this.life[i] = Math.min(this.life[i], 0.25 + Math.random() * 0.6);
          continue;
        }
        this.pos[i3] = nx; this.pos[i3 + 1] = ny; this.pos[i3 + 2] = nz;
      } else if (k === PKind.Puff) {
        const drag = 1 - 2.5 * dt;
        this.vel[i3] *= drag; this.vel[i3 + 1] = this.vel[i3 + 1] * drag - 0.6 * dt; this.vel[i3 + 2] *= drag;
        this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
        const t = this.life[i] / this.maxLife[i];
        this.size[i] = this.baseSize[i] * (1.8 - t * 0.8);
        this.alpha[i] = 0.5 * t;
      } else {
        const drag = 1 - 1.5 * dt;
        this.vel[i3] *= drag; this.vel[i3 + 1] = this.vel[i3 + 1] * drag - 3 * dt; this.vel[i3 + 2] *= drag;
        this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
        const t = this.life[i] / this.maxLife[i];
        this.alpha[i] = t;
        this.size[i] = this.baseSize[i] * (0.6 + 0.4 * Math.sin(this.life[i] * 30));
      }
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.psize as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.palpha as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.pcolor as THREE.BufferAttribute).needsUpdate = true;
  }

  get active() { return this.count; }
}
