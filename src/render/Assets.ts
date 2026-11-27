import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ClassId } from '../sim/Classes';

// The characters and every hat are their own files, built in Blender by the scripts in tools/blender.
const modelUrls = import.meta.glob('../assets/models/*.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const hatUrls = import.meta.glob('../assets/models/hats/*.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
// facts about each character's skeleton that the animation code needs (written by the Blender scripts next to the models)
const rigFiles = import.meta.glob('../assets/models/*.json', { import: 'default', eager: true }) as Record<string, Partial<RigFacts>>;

/** What the game needs to know about a character model to pose and dress it. Metres; y up; the character faces -z. */
export interface RigFacts {
  /** how far the arms are held out from straight down in the rest pose, radians */
  armRest: number;
  /** each eye is turned outward by this much; its lid sweeps round that axis, and is held open at lidOpen */
  eyeYaw: number;
  lidOpen: number;
  /** top of the head */
  height: number;
  hatScale: number;
  /** points on the surface where snow sticks when you're hit: front of the chest, a cheek, low on the belly */
  chestFront: [number, number, number];
  cheek: [number, number, number];
  belly: [number, number, number];
  /** where carried snowballs get tucked: an ellipse round the back of the body at this height */
  belt: { y: number; rx: number; rz: number };
}

const FILES: Record<ClassId, string> = { penguin: 'penguin', bear: 'polarbear', yeti: 'yeti' };
const PENGUIN_RIG: RigFacts = {
  armRest: 0.62, eyeYaw: 0.30, lidOpen: 2.72, height: 1.15, hatScale: 1,
  chestFront: [0.17, 0.44, -0.335], cheek: [-0.15, 0.96, -0.215], belly: [-0.2, 0.3, -0.31],
  belt: { y: 0.2, rx: 0.41, rz: 0.4 },
};

// The guns (hot chocolate blaster, freeze soaker) and the candy cane blade are built by tools/blender/guns.py.
const gunUrls = import.meta.glob('../assets/models/guns/*.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/** The Blender-built models, loaded once before the game starts. */
export const Assets = {
  /** kept for older code: the penguin */
  penguin: null as THREE.Group | null,
  models: { penguin: null, bear: null, yeti: null } as Record<ClassId, THREE.Group | null>,
  rigs: { penguin: PENGUIN_RIG, bear: PENGUIN_RIG, yeti: PENGUIN_RIG } as Record<ClassId, RigFacts>,
  hats: new Map<string, THREE.Group>(),
  /** by gun name: 'cocoa', 'water', 'blade' */
  guns: new Map<string, THREE.Group>(),
};

let loading: Promise<void> | null = null;

/** Load every character and every hat. onProgress gets 0..1. */
export function loadAssets(onProgress?: (f: number) => void): Promise<void> {
  if (loading) return loading;
  const loader = new GLTFLoader();
  const jobs: [string, (scene: THREE.Group) => void][] = [];
  for (const cls of Object.keys(FILES) as ClassId[]) {
    const url = modelUrls[`../assets/models/${FILES[cls]}.glb`];
    if (url) jobs.push([url, s => { Assets.models[cls] = s; if (cls === 'penguin') Assets.penguin = s; }]);
    const rig = rigFiles[`../assets/models/${FILES[cls]}.json`];
    if (rig) Assets.rigs[cls] = { ...PENGUIN_RIG, ...rig };
  }
  for (const [path, url] of Object.entries(hatUrls)) jobs.push([url, s => { Assets.hats.set(path.split('/').pop()!.replace('.glb', ''), s); }]);
  for (const [path, url] of Object.entries(gunUrls)) jobs.push([url, s => { Assets.guns.set(path.split('/').pop()!.replace('.glb', ''), s); }]);
  let done = 0;
  loading = Promise.all(jobs.map(async ([url, keep]) => {
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
    keep(gltf.scene);
    onProgress?.(++done / jobs.length);
  })).then(() => undefined);
  return loading;
}
