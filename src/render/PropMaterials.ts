// The materials for the Blender-made props (public/models/*.glb). The models only carry geometry, UVs, a material
// NAME per mesh and vertex colours (a tint multiplied by baked ambient occlusion); the surfaces themselves are built
// here from the shared tiling texture sets in public/textures (made by tools/blender/textures.py). Keep the names
// in step with MATERIALS in tools/blender/kit.py.
import * as THREE from 'three';
import { seeThrough } from './Environment';

const BASE = import.meta.env.BASE_URL;
const loader = new THREE.TextureLoader();
const textures = new Map<string, THREE.Texture>();
let anisotropy = 8;

/** Call once with the renderer so textures stay sharp at a glancing angle. */
export function setPropAnisotropy(max: number) { anisotropy = Math.min(8, max); for (const t of textures.values()) { t.anisotropy = anisotropy; t.needsUpdate = true; } }

function tex(name: string, srgb: boolean) {
  let t = textures.get(name);
  if (!t) {
    t = loader.load(`${BASE}textures/${name}.webp`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.flipY = false; // glTF's UV origin is the top left, like the models' UVs
    t.anisotropy = anisotropy;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    textures.set(name, t);
  }
  return t;
}

interface Spec {
  tex?: string; color?: number; rough?: number; metal?: number; normal?: number;
  coat?: number; coatRough?: number; emissive?: number; glow?: number; env?: number; sheen?: number; plain?: boolean;
  /** below 1 the material is see-through (window glass): drawn blended, without writing depth */
  opacity?: number;
}

const SPECS: Record<string, Spec> = {
  gingerbread: { tex: 'gingerbread', normal: 1.1 },
  icing: { tex: 'icing', normal: 0.8 },
  candy: { tex: 'candy', coat: 1, coatRough: 0.08, rough: 0.9, env: 1.25 },
  mint: { tex: 'mint', coat: 1, coatRough: 0.08, env: 1.25 },
  gumdrop: { tex: 'sugar', coat: 0.35, coatRough: 0.3, normal: 1.2 },
  wood: { tex: 'wood' },
  log: { tex: 'log' },
  logend: { tex: 'logend' },
  snow: { tex: 'snow', normal: 0.7, color: 0xf6faff },
  ice: { tex: 'ice', coat: 1, coatRough: 0.05, emissive: 0x1f6fb0, glow: 0.16, env: 1.7, normal: 0.7 },
  canvas: { tex: 'canvas' },
  stone: { tex: 'stone' },
  metal: { color: 0x565a63, rough: 0.38, metal: 1 },
  rope: { color: 0x9a774a, rough: 0.9 },
  ribbon: { color: 0xffffff, rough: 0.45, sheen: 0.6 },
  glow: { color: 0xffc27a, rough: 0.4, emissive: 0xffb45e, glow: 2.4, plain: true },
  // vehicles (public/models/snowmobile.glb, snowplow.glb; see VehicleModel.ts)
  paint: { color: 0xffffff, rough: 0.34, coat: 1, coatRough: 0.08, env: 1.15 }, // baked light grey; VehicleModel multiplies in the team colour
  trim: { color: 0xffffff, rough: 0.5 },                                        // its colours (charcoal, ivory, hazard yellow) are vertex tints
  rubber: { color: 0x26272b, rough: 0.85 },
  tread: { tex: 'tread', normal: 1.6 },
  glass: { color: 0x7fb4d6, rough: 0.06, env: 1.6, opacity: 0.34, plain: true },
  chrome: { color: 0xe6ebf2, rough: 0.14, metal: 1, env: 1.3 },
  seat: { color: 0xffffff, rough: 0.55, sheen: 0.35 },
  beacon: { color: 0xffa21f, rough: 0.3, emissive: 0xff8a00, glow: 2.2, plain: true },
  lamp_red: { color: 0xff2a1f, rough: 0.3, emissive: 0xff1a10, glow: 1.6, plain: true },
};

const made = new Map<string, THREE.Material>();

/** The game material for a mesh in a prop model, by the name it was given in Blender. */
export function propMaterial(name: string): THREE.Material {
  const have = made.get(name);
  if (have) return have;
  const s = SPECS[name] ?? { color: 0xff00ff };
  const physical = s.coat !== undefined || s.sheen !== undefined;
  const m = physical ? new THREE.MeshPhysicalMaterial() : new THREE.MeshStandardMaterial();
  m.name = name;
  m.vertexColors = !s.plain;
  m.color.set(s.color ?? 0xffffff);
  m.roughness = s.rough ?? (s.tex ? 1 : 0.6);
  m.metalness = s.metal ?? 0;
  if (s.tex) {
    m.map = tex(`${s.tex}_color`, true);
    m.normalMap = tex(`${s.tex}_normal`, false);
    m.normalScale.setScalar(s.normal ?? 1);
    const orm = tex(`${s.tex}_orm`, false);
    m.aoMap = orm; m.roughnessMap = orm;
    m.aoMapIntensity = 0.6;
  }
  if (s.emissive !== undefined) { m.emissive.set(s.emissive); m.emissiveIntensity = s.glow ?? 1; }
  if (s.env !== undefined) m.envMapIntensity = s.env;
  if (s.opacity !== undefined && s.opacity < 1) { m.transparent = true; m.opacity = s.opacity; m.depthWrite = false; }
  if (m instanceof THREE.MeshPhysicalMaterial) {
    if (s.coat !== undefined) { m.clearcoat = s.coat; m.clearcoatRoughness = s.coatRough ?? 0.1; }
    if (s.sheen !== undefined) { m.sheen = s.sheen; m.sheenRoughness = 0.5; m.sheenColor.set(0xffffff); }
  }
  seeThrough(m);
  made.set(name, m);
  return m;
}
