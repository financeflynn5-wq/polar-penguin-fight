// The snowmobile and the snowplow (public/models/<kind>.glb, built by tools/blender/vehicles.py), and the snow tank
// (public/models/snowtank.glb, built by tools/blender/snowtank.py).
// Unlike the map props these keep a node hierarchy, because parts of them move. Every moving part is a named node
// sitting at its own pivot, unrotated at rest, so the game only ever sets a rotation on it:
//
//   body                    everything fixed
//   steer, skiL, skiR       snowmobile: handlebars and skis, rotation.y
//   blade                   snowplow: rotation.z (0 = down and working, positive lifts it)
//   track | trackL, trackR  the belts; userData.scroll holds the textures to slide (offset.y, 1 = 1 m of belt)
//   wheel…                  spin about z; userData.radius is the wheel's radius in metres
//   beacon                  the lens on the roof; userData.material is this vehicle's own copy to pulse
//   turret, gun, barrels    snow tank: the gun turret (rotation.y), the gun on it (rotation.z, + = up), its barrels (spin about x)
//   catapult, arm, ammo     snow tank: the turntable (rotation.y), the throwing arm (rotation.z, 0 = cocked, - = thrown),
//                           the snowball sitting in the bucket
//   muzzle, bucket          snow tank: empties at the end of the barrels and in the bucket
//   seat0, seat1, gripL, gripR, exhaust   empties: where riders sit, where mittens hold on, where smoke comes out
//
// The front of a vehicle is +x. Materials come from PropMaterials by name, like the props.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { propMaterial } from './PropMaterials';

import type { VehicleKind } from '../sim/Vehicles';

/** Too small, too bright or too clear for a shadow of their own to show. */
const NO_SHADOW = new Set(['glass', 'glow', 'beacon', 'lamp_red', 'chrome', 'snow', 'rope']);

const sources = new Map<VehicleKind, Promise<THREE.Group>>();

function load(kind: VehicleKind) {
  let p = sources.get(kind);
  if (!p) {
    p = new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/${kind}.glb`).then(gltf => {
      const root = gltf.scene;
      root.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const name = (m.material as THREE.Material).name;
        m.userData.mat = name;
        m.material = propMaterial(name);
        m.castShadow = !NO_SHADOW.has(name);
        m.receiveShadow = name !== 'glass';
        if (name === 'glass') m.renderOrder = 2; // after the driver behind it
      });
      return root;
    });
    sources.set(kind, p);
  }
  return p;
}

/** A material of this vehicle's own. clone() leaves the see-through hook behind, so it is carried over by hand. */
function own<T extends THREE.Material>(m: T): T {
  const c = m.clone() as T;
  c.onBeforeCompile = m.onBeforeCompile;
  c.customProgramCacheKey = m.customProgramCacheKey;
  return c;
}

/** A texture is only worth copying once its picture has arrived (a copy made earlier would never be uploaded). */
function arrived(t: THREE.Texture | null) {
  return new Promise<void>(done => {
    const t0 = performance.now();
    const look = () => { if (!t || t.image || performance.now() - t0 > 8000) done(); else setTimeout(look, 30); };
    look();
  });
}

/**
 * Loads public/models/<kind>.glb once and resolves to a fresh clone: a THREE.Group whose named descendants (body,
 * blade, steer, skiL, skiR, track, trackL, trackR, wheel*, beacon, seat0, seat1, gripL, gripR, exhaust) are the
 * pivots described in tools/blender/vehicles.py. Front is +x. Materials come from propMaterial(name); `paint` is
 * cloned per vehicle and multiplied by `tint`; each `tread` mesh gets its own material and texture clones so its
 * map/normalMap/roughnessMap offset can be scrolled independently (userData.scroll: THREE.Texture[] on the track
 * node). Also on the group: userData.wheels = the wheel nodes, userData.paint = this vehicle's paint material.
 */
export async function makeVehicleModel(kind: VehicleKind, tint: THREE.ColorRepresentation): Promise<THREE.Group> {
  const src = await load(kind);
  const tread = propMaterial('tread') as THREE.MeshStandardMaterial;
  await Promise.all([arrived(tread.map), arrived(tread.normalMap), arrived(tread.roughnessMap)]);
  const g = src.clone(true); // shares the geometry and, until they are replaced below, the materials
  g.name = kind;
  const paint = own(propMaterial('paint') as THREE.MeshStandardMaterial);
  paint.color.multiply(new THREE.Color(tint));
  const wheels: THREE.Object3D[] = [];
  g.traverse(o => {
    if (o.name.startsWith('wheel')) wheels.push(o);
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const name = m.userData.mat as string;
    if (name === 'paint') m.material = paint;
    else if (name === 'tread') {
      const mat = own(tread);
      const copy = (t: THREE.Texture | null) => { if (!t) return null; const c = t.clone(); c.needsUpdate = true; return c; };
      mat.map = copy(tread.map);
      mat.normalMap = copy(tread.normalMap);
      mat.roughnessMap = mat.aoMap = copy(tread.roughnessMap);
      m.material = mat;
      const node = m.parent ?? m;
      const list = (node.userData.scroll ??= []) as THREE.Texture[];
      for (const t of [mat.map, mat.normalMap, mat.roughnessMap]) if (t) list.push(t);
    } else if (name === 'beacon') {
      const mat = own(m.material as THREE.MeshStandardMaterial);
      m.material = mat;
      (m.parent ?? m).userData.material = mat;
    }
  });
  g.userData.wheels = wheels;
  g.userData.paint = paint;
  return g;
}

/** Slide a track's tread by `metres` of belt travel in total (positive = the vehicle driving forward). */
export function scrollTrack(track: THREE.Object3D, metres: number) {
  const list = track.userData.scroll as THREE.Texture[] | undefined;
  if (list) for (const t of list) t.offset.y = metres % 1;
}

/** Free what one vehicle owns (its paint, its tread materials and their texture copies). The geometry is shared. */
export function disposeVehicleModel(g: THREE.Group) {
  (g.userData.paint as THREE.Material | undefined)?.dispose();
  g.traverse(o => {
    const list = o.userData.scroll as THREE.Texture[] | undefined;
    if (list) for (const t of list) t.dispose();
    const m = o as THREE.Mesh;
    if (m.isMesh && (m.userData.mat === 'tread' || m.userData.mat === 'beacon')) (m.material as THREE.Material).dispose();
  });
}
