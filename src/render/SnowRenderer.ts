import * as THREE from 'three';
import { SnowField } from '../world/SnowField';
import { CHUNK, meshChunk } from './SnowMesher';

/** Snow material: soft white with blue shadows, a little surface grain and view-dependent sparkles. */
export function makeSnowMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.86,
    metalness: 0.0,
    color: 0xffffff,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    (mat.userData as any).shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSnowWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvSnowWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vSnowWorld;
uniform float uTime;
float snowHash(vec3 p){ p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float snowNoise(vec3 p){ vec3 i = floor(p); vec3 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(snowHash(i), snowHash(i+vec3(1,0,0)), f.x), mix(snowHash(i+vec3(0,1,0)), snowHash(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(snowHash(i+vec3(0,0,1)), snowHash(i+vec3(1,0,1)), f.x), mix(snowHash(i+vec3(0,1,1)), snowHash(i+vec3(1,1,1)), f.x), f.y), f.z); }
`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // soft lumpy grain on the snow surface
  vec3 q = vSnowWorld * 2.2;
  float e = 0.08;
  float n0 = snowNoise(q);
  vec3 g = vec3(snowNoise(q + vec3(e,0,0)) - n0, snowNoise(q + vec3(0,e,0)) - n0, snowNoise(q + vec3(0,0,e)) - n0) / e;
  vec3 gv = (viewMatrix * vec4(g, 0.0)).xyz;
  normal = normalize(normal - gv * 0.05);
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  // sparkles: tiny glints that twinkle as the camera moves
  vec3 sp = vSnowWorld * 22.0;
  vec3 cellP = floor(sp);
  float h = snowHash(cellP);
  vec3 vdir = normalize(cameraPosition - vSnowWorld);
  float tw = snowHash(cellP + floor(vdir * 9.0) * 13.0);
  float dot0 = 1.0 - smoothstep(0.08, 0.2, length(fract(sp) - 0.5));
  float glint = step(0.975, h) * step(0.5, tw) * dot0;
  float camD = length(cameraPosition - vSnowWorld);
  float distFade = smoothstep(1.5, 4.0, camD) * (1.0 - smoothstep(14.0, 45.0, camD));
  totalEmissiveRadiance += vec3(0.9, 0.95, 1.0) * glint * distFade * 1.6;
}`);
  };
  return mat;
}

export class SnowRenderer {
  readonly group = new THREE.Group();
  private meshes = new Map<number, THREE.Mesh>();
  private dirty = new Set<number>();
  readonly cxN: number; readonly cyN: number; readonly czN: number;
  readonly material: THREE.MeshStandardMaterial;

  constructor(private field: SnowField, private pondY: number) {
    this.cxN = Math.ceil(field.nx / CHUNK);
    this.cyN = Math.ceil(field.ny / CHUNK);
    this.czN = Math.ceil(field.nz / CHUNK);
    this.material = makeSnowMaterial();
    field.onDirty = (i0, j0, k0, i1, j1, k1) => this.markDirty(i0, j0, k0, i1, j1, k1);
  }

  key(cx: number, cy: number, cz: number) { return (cz * this.cxN + cx) * this.cyN + cy; }

  markDirty(i0: number, j0: number, k0: number, i1: number, j1: number, k1: number) {
    const pad = 2;
    const cx0 = Math.max(0, Math.floor((i0 - pad) / CHUNK)), cx1 = Math.min(this.cxN - 1, Math.floor((i1 + pad) / CHUNK));
    const cy0 = Math.max(0, Math.floor((j0 - pad) / CHUNK)), cy1 = Math.min(this.cyN - 1, Math.floor((j1 + pad) / CHUNK));
    const cz0 = Math.max(0, Math.floor((k0 - pad) / CHUNK)), cz1 = Math.min(this.czN - 1, Math.floor((k1 + pad) / CHUNK));
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      this.dirty.add(this.key(cx, cy, cz));
    }
  }

  buildAll() {
    for (let cz = 0; cz < this.czN; cz++) for (let cx = 0; cx < this.cxN; cx++) for (let cy = 0; cy < this.cyN; cy++) {
      this.rebuild(cx, cy, cz);
    }
    this.dirty.clear();
  }

  private rebuild(cx: number, cy: number, cz: number) {
    const key = this.key(cx, cy, cz);
    const data = meshChunk(this.field, cx, cy, cz, this.pondY);
    let mesh = this.meshes.get(key);
    if (!data) {
      if (mesh) { mesh.geometry.dispose(); this.group.remove(mesh); this.meshes.delete(key); }
      return;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geo.computeBoundingSphere();
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geo;
    } else {
      mesh = new THREE.Mesh(geo, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.meshes.set(key, mesh);
      this.group.add(mesh);
    }
  }

  /** Re-mesh changed chunks, nearest first, within a time budget. */
  update(camPos: THREE.Vector3, budgetMs = 5, time = 0) {
    const sh = (this.material.userData as any).shader;
    if (sh) sh.uniforms.uTime.value = time;
    if (this.dirty.size === 0) return;
    const list = [...this.dirty];
    const cs = CHUNK * this.field.cell;
    const dist = (key: number) => {
      const cy = key % this.cyN; const rest = (key - cy) / this.cyN;
      const cx = rest % this.cxN; const cz = (rest - cx) / this.cxN;
      const x = this.field.x0 + (cx + 0.5) * cs, y = (cy + 0.5) * cs, z = this.field.z0 + (cz + 0.5) * cs;
      return (x - camPos.x) ** 2 + (y - camPos.y) ** 2 + (z - camPos.z) ** 2;
    };
    if (list.length > 1) list.sort((a, b) => dist(a) - dist(b));
    const t0 = performance.now();
    for (const key of list) {
      const cy = key % this.cyN; const rest = (key - cy) / this.cyN;
      const cx = rest % this.cxN; const cz = (rest - cx) / this.cxN;
      this.rebuild(cx, cy, cz);
      this.dirty.delete(key);
      if (performance.now() - t0 > budgetMs) break;
    }
  }
}
