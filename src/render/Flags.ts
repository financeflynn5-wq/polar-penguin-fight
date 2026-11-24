import * as THREE from 'three';
import { World } from '../sim/World';
import { MapDef } from '../world/MapDef';
import { TEAM_COLORS, TEAM_CSS } from './Environment';
import { beamMaterial } from './Props';

const NEUTRAL = new THREE.Color(0xe9eff8);
const teamCol = TEAM_COLORS.map(c => new THREE.Color(c));

interface FlagModel {
  flag: THREE.Mesh; base: Float32Array; zone: THREE.Mesh; beam: THREE.Mesh; ring: THREE.Mesh;
  label: THREE.Sprite; draw: (owner: number, cap: number, contested: boolean) => void; lastKey: string;
  color: THREE.Color;
}

/** Conquest flags: a tall pole whose flag climbs as a team takes it, a glowing ring you stand in, and a letter you can see from anywhere. */
export class FlagsView {
  readonly group = new THREE.Group();
  private models: FlagModel[] = [];

  constructor(map: MapDef) {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.8 });
    const knobMat = new THREE.MeshStandardMaterial({ color: 0xffd34d, roughness: 0.3, metalness: 0.6 });
    for (const p of map.points) {
      const g = new THREE.Group();
      g.position.set(p.x, p.y, p.z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 9.5, 8), poleMat);
      pole.position.y = 4.25; pole.castShadow = true;
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), knobMat);
      knob.position.y = 9.05;
      g.add(pole, knob);
      const flagGeo = new THREE.PlaneGeometry(3.2, 2.0, 16, 6);
      flagGeo.translate(1.6, 0, 0);
      const flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: NEUTRAL.clone(), side: THREE.DoubleSide, roughness: 0.75, emissive: NEUTRAL.clone(), emissiveIntensity: 0.18 }));
      flag.castShadow = true;
      g.add(flag);
      // the capture zone: a low wall of light round the ring, plus a line on the snow
      const zoneMat = beamMaterial(0xffffff);
      const zone = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r, 2.6, 56, 1, true), zoneMat);
      zone.position.y = 1.0;
      zone.renderOrder = 5;
      g.add(zone);
      const ring = new THREE.Mesh(new THREE.RingGeometry(p.r - 0.14, p.r + 0.04, 64), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthTest: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.3; ring.renderOrder = 4;
      g.add(ring);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 34, 14, 1, true), beamMaterial(0xffffff));
      beam.position.y = 17 + 9;
      g.add(beam);

      // the letter, always readable: owner colour in the middle, capture progress round the edge
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false }));
      label.scale.set(0.075, 0.075, 1);
      label.position.y = 11.2;
      label.renderOrder = 11;
      g.add(label);
      const draw = (owner: number, cap: number, contested: boolean) => {
        const ctx = c.getContext('2d')!;
        ctx.clearRect(0, 0, 128, 128);
        ctx.beginPath(); ctx.arc(64, 64, 50, 0, Math.PI * 2);
        ctx.fillStyle = owner < 0 ? 'rgba(16,36,63,0.92)' : TEAM_CSS[owner]; ctx.fill();
        ctx.lineWidth = 9; ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.stroke();
        const side = cap < 0 ? 0 : 1, amt = Math.abs(cap);
        if (amt > 0.01 && amt < 0.995) {
          ctx.beginPath(); ctx.arc(64, 64, 50, -Math.PI / 2, -Math.PI / 2 + amt * Math.PI * 2);
          ctx.strokeStyle = contested ? '#ffe14d' : owner === side ? '#ffffff' : TEAM_CSS[side]; ctx.lineWidth = 11; ctx.stroke();
        }
        ctx.font = '700 62px Fredoka, Nunito, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff'; ctx.fillText(p.name, 64, 68);
        tex.needsUpdate = true;
      };
      draw(p.owner, p.owner < 0 ? 0 : p.owner === 0 ? -1 : 1, false);
      this.models.push({ flag, base: flagGeo.attributes.position.array.slice() as Float32Array, zone, beam, ring, label, draw, lastKey: '', color: NEUTRAL.clone() });
      this.group.add(g);
    }
  }

  update(w: World | null, time: number, dt: number) {
    this.models.forEach((m, i) => {
      const pt = w?.points[i];
      const owner = pt ? pt.owner : -1, cap = pt ? pt.cap : 0;
      const contested = !!pt && pt.n0 > 0 && pt.n1 > 0;
      // the flag climbs the pole as the flag is taken, and shows the colour of whichever side it's leaning to
      const lean = cap < 0 ? 0 : 1, amt = Math.abs(cap);
      const want = owner >= 0 ? teamCol[owner] : amt > 0.02 ? NEUTRAL.clone().lerp(teamCol[lean], amt * 0.7) : NEUTRAL;
      m.color.lerp(want, Math.min(1, dt * 6));
      const fm = m.flag.material as THREE.MeshStandardMaterial;
      fm.color.copy(m.color); fm.emissive.copy(m.color);
      m.flag.position.y = 3.2 + amt * 4.7;
      const pos = m.flag.geometry.attributes.position as THREE.BufferAttribute;
      for (let v = 0; v < pos.count; v++) { const x = m.base[v * 3]; pos.setZ(v, Math.sin(time * 4.5 + x * 2.2 + i) * 0.16 * x); }
      pos.needsUpdate = true;
      const glow = contested && Math.sin(time * 10) > 0 ? NEUTRAL : m.color;
      (m.zone.material as THREE.ShaderMaterial).uniforms.uColor.value.copy(glow).multiplyScalar(2.2);
      (m.beam.material as THREE.ShaderMaterial).uniforms.uColor.value.copy(m.color).multiplyScalar(1.6);
      (m.ring.material as THREE.MeshBasicMaterial).color.copy(glow);
      const key = `${owner}|${Math.round(cap * 40)}|${contested}`;
      if (key !== m.lastKey) { m.lastKey = key; m.draw(owner, cap, contested); }
    });
  }
}
