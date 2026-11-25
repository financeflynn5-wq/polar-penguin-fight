import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import penguinUrl from '../assets/models/penguin.glb?url';

// Every hat is its own small file, built in Blender by tools/blender/hats.py.
const hatUrls = import.meta.glob('../assets/models/hats/*.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/** The Blender-built models, loaded once before the game starts. */
export const Assets = {
  penguin: null as THREE.Group | null,
  hats: new Map<string, THREE.Group>(),
};

let loading: Promise<void> | null = null;

/** Load the penguin and every hat. onProgress gets 0..1. */
export function loadAssets(onProgress?: (f: number) => void): Promise<void> {
  if (loading) return loading;
  const loader = new GLTFLoader();
  const jobs: [string, string | null][] = [[penguinUrl, null]];
  for (const [path, url] of Object.entries(hatUrls)) jobs.push([url, path.split('/').pop()!.replace('.glb', '')]);
  let done = 0;
  loading = Promise.all(jobs.map(async ([url, hat]) => {
    const gltf = await loader.loadAsync(url);
    gltf.scene.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        const s = mat as THREE.MeshStandardMaterial;
        for (const t of [s.map, s.normalMap, s.roughnessMap, s.aoMap, s.emissiveMap]) if (t) t.anisotropy = 4;
      }
    });
    if (hat) Assets.hats.set(hat, gltf.scene); else Assets.penguin = gltf.scene;
    onProgress?.(++done / jobs.length);
  })).then(() => undefined);
  return loading;
}
