import * as THREE from 'three';
import { SnowField } from '../world/SnowField';
import { CHUNK, meshChunk } from './SnowMesher';

/**
 * Snow material: soft white that scatters light (bright rims, blue in the shade), fine surface grain, drifts of
 * wind-blown texture, and sparkles that twinkle as the camera moves. Frozen water (aIce) turns glossy blue.
 */
export function makeSnowMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.0,
    color: 0xffffff,
    envMapIntensity: 0.9,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    (mat.userData as any).shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aIce;\nvarying vec3 vSnowWorld;\nvarying float vIce;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvSnowWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvIce = aIce;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vSnowWorld;
varying float vIce;
uniform float uTime;
float snowHash(vec3 p){ p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float snowNoise(vec3 p){ vec3 i = floor(p); vec3 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(snowHash(i), snowHash(i+vec3(1,0,0)), f.x), mix(snowHash(i+vec3(0,1,0)), snowHash(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(snowHash(i+vec3(0,0,1)), snowHash(i+vec3(1,0,1)), f.x), mix(snowHash(i+vec3(0,1,1)), snowHash(i+vec3(1,1,1)), f.x), f.y), f.z); }
float snowFbm(vec3 p){ return snowNoise(p) * 0.6 + snowNoise(p * 2.7 + 5.1) * 0.28 + snowNoise(p * 7.3 + 11.7) * 0.12; }
`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float iceAmt = smoothstep(0.35, 0.75, vIce);
float camDist = length(cameraPosition - vSnowWorld);
{
  // wind-packed drifts: very soft, large-scale brightness variation so big slopes aren't one flat tone
  float drift = snowFbm(vec3(vSnowWorld.x * 0.11, vSnowWorld.y * 0.3, vSnowWorld.z * 0.07));
  diffuseColor.rgb *= 0.94 + drift * 0.1;
  // ice: deep blue-green with frosty streaks
  float streak = snowNoise(vec3(vSnowWorld.x * 1.7, 0.0, vSnowWorld.z * 1.7)) * 0.6 + snowNoise(vec3(vSnowWorld.x * 6.0, 3.0, vSnowWorld.z * 6.0)) * 0.4;
  vec3 iceCol = mix(vec3(0.16, 0.44, 0.74), vec3(0.6, 0.86, 0.98), smoothstep(0.45, 0.8, streak));
  diffuseColor.rgb = mix(diffuseColor.rgb, iceCol, iceAmt);
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.07, iceAmt);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // lumpy grain on the snow surface: two scales, fading with distance so far slopes stay clean
  float e = 0.06;
  vec3 q = vSnowWorld * 2.4;
  float n0 = snowFbm(q);
  vec3 g = vec3(snowFbm(q + vec3(e,0,0)) - n0, snowFbm(q + vec3(0,e,0)) - n0, snowFbm(q + vec3(0,0,e)) - n0) / e;
  vec3 q2 = vSnowWorld * 13.0;
  float m0 = snowNoise(q2);
  vec3 g2 = vec3(snowNoise(q2 + vec3(e,0,0)) - m0, snowNoise(q2 + vec3(0,e,0)) - m0, snowNoise(q2 + vec3(0,0,e)) - m0) / e;
  float near = 1.0 - smoothstep(6.0, 30.0, camDist);
  vec3 gv = (viewMatrix * vec4(g * 0.075 + g2 * 0.022 * near, 0.0)).xyz;
  normal = normalize(normal - gv * (1.0 - iceAmt * 0.92));
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  vec3 vdir = normalize(cameraPosition - vSnowWorld);
  vec3 wn = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  // light scatters inside snow: edges turned away from you glow softly instead of going grey
  float rim = pow(1.0 - max(dot(wn, vdir), 0.0), 3.0);
  totalEmissiveRadiance += vec3(0.5, 0.68, 1.0) * rim * 0.16 * (1.0 - iceAmt);
  // sparkles: tiny glints that twinkle as the camera moves
  vec3 sp = vSnowWorld * 24.0;
  vec3 cellP = floor(sp);
  float h = snowHash(cellP);
  float tw = snowHash(cellP + floor(vdir * 11.0) * 13.0);
  float dot0 = 1.0 - smoothstep(0.06, 0.2, length(fract(sp) - 0.5));
  float glint = step(0.968, h) * step(0.45, tw) * dot0;
  float distFade = smoothstep(1.2, 3.5, camDist) * (1.0 - smoothstep(16.0, 50.0, camDist));
  totalEmissiveRadiance += vec3(1.0, 0.97, 0.9) * glint * distFade * 4.5 * (1.0 - iceAmt);
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

  constructor(private field: SnowField) {
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
    const data = meshChunk(this.field, cx, cy, cz);
    let mesh = this.meshes.get(key);
    if (!data) {
      if (mesh) { mesh.geometry.dispose(); this.group.remove(mesh); this.meshes.delete(key); }
      return;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geo.setAttribute('aIce', new THREE.BufferAttribute(data.ice, 1));
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
