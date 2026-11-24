import * as THREE from 'three';
import { World } from '../sim/World';
import { MapDef } from '../world/MapDef';
import { TEAM_COLORS } from './Environment';

const snowballMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });

/** a soft vertical light pillar that fades out at the top, so pickups can be spotted across the map */
export function beamMaterial(color: number) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position,1.0); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: `uniform vec3 uColor; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ float edge = pow(abs(dot(vN, vV)), 2.0); float fade = (1.0 - vUv.y) * smoothstep(0.0, 0.05, vUv.y); gl_FragColor = vec4(uColor * edge * fade * 0.2, 1.0); }`,
  });
}

export function makeSurfboard() {
  const g = new THREE.Group();
  const geo = new THREE.CapsuleGeometry(0.27, 1.15, 6, 16);
  geo.rotateX(Math.PI / 2);
  geo.scale(1, 0.16, 1);
  const board = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xfff1c9, roughness: 0.35 }));
  g.add(board);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 1.5), new THREE.MeshStandardMaterial({ color: 0x18b5c9, roughness: 0.4 }));
  stripe.position.y = 0.045;
  g.add(stripe);
  for (const sx of [-0.17, 0.17]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.021, 1.2), new THREE.MeshStandardMaterial({ color: 0xff7a3d, roughness: 0.4 }));
    side.position.set(sx, 0.042, 0);
    g.add(side);
  }
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.2), new THREE.MeshStandardMaterial({ color: 0x18b5c9 }));
  fin.position.set(0, -0.08, 0.6);
  g.add(fin);
  g.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}

function lumpySnowGeometry(r: number, detail = 3, amp = 0.06) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = Math.sin(v.x * 7.1) * Math.sin(v.y * 6.3) * Math.sin(v.z * 5.7) + Math.sin(v.x * 13 + v.z * 11) * 0.4;
    v.multiplyScalar(1 + n * amp);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function textSprite(text: string, color = '#ffffff', w = 1.2) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  s.scale.set(w, w / 2, 1);
  s.renderOrder = 10;
  const draw = (t: string) => {
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, 128, 64);
    ctx.font = '700 40px Fredoka, Nunito, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(10,20,40,0.85)';
    ctx.strokeText(t, 64, 34);
    ctx.fillStyle = color; ctx.fillText(t, 64, 34);
    tex.needsUpdate = true;
  };
  draw(text);
  return { sprite: s, draw };
}

export class Props {
  readonly group = new THREE.Group();
  private snowballs: THREE.InstancedMesh;
  private bigGeo = lumpySnowGeometry(1, 4, 0.035);
  private bigMat = new THREE.MeshStandardMaterial({ color: 0xf7faff, roughness: 0.85 });
  private bigMeshes = new Map<number, THREE.Mesh>();
  private piles: THREE.InstancedMesh[] = [];
  private pileLabels: { sprite: THREE.Sprite; draw: (t: string) => void; last: number }[] = [];
  private flakeMeshes = new Map<number, THREE.Group>();
  private flakeProto: THREE.Group;
  private barrier: THREE.Mesh;
  private freeBoard: THREE.Group;
  private barrierMat: THREE.ShaderMaterial;
  readonly aimMarker: THREE.Mesh;
  readonly trajectory: THREE.Line;
  private trajPos = new Float32Array(64 * 3);
  private m4 = new THREE.Matrix4();

  constructor(private map: MapDef) {
    this.snowballs = new THREE.InstancedMesh(lumpySnowGeometry(0.13, 1, 0.08), snowballMat, 256);
    this.snowballs.castShadow = true;
    this.snowballs.count = 0;
    this.snowballs.frustumCulled = false;
    this.group.add(this.snowballs);

    // stockpiles: pyramids of snowballs + a count label
    const pileGeo = lumpySnowGeometry(0.17, 1, 0.08);
    for (const b of map.bases) {
      const im = new THREE.InstancedMesh(pileGeo, snowballMat, 60);
      im.castShadow = true; im.receiveShadow = true;
      im.count = 0;
      im.position.set(b.stockpile.x, b.stockpile.y, b.stockpile.z);
      this.group.add(im);
      this.piles.push(im);
      const label = textSprite('0', b.team === 0 ? '#9fd0ff' : '#ffc29a', 1.0);
      label.sprite.position.set(b.stockpile.x, b.stockpile.y + 2.2, b.stockpile.z);
      label.sprite.visible = false;
      (label.sprite.material as THREE.SpriteMaterial).depthTest = true;
      this.group.add(label.sprite);
      this.pileLabels.push({ ...label, last: -1 });
    }

    // snowflake pickup: a glowing six-armed crystal
    this.flakeProto = new THREE.Group();
    const crystal = new THREE.MeshStandardMaterial({ color: 0xbff4ff, emissive: 0x47d4ff, emissiveIntensity: 1.6, roughness: 0.2, metalness: 0.3 });
    for (let a = 0; a < 6; a++) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.62, 0.05), crystal);
      arm.rotation.z = (a / 6) * Math.PI;
      this.flakeProto.add(arm);
      for (const s of [-1, 1]) for (const off of [0.16, 0.24]) {
        const twig = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.04), crystal);
        const ang = (a / 6) * Math.PI;
        const ax = -Math.sin(ang) * off * s, ay = Math.cos(ang) * off * s;
        twig.position.set(ax, ay, 0);
        twig.rotation.z = ang + s * 0.7 + (s < 0 ? Math.PI : 0);
        this.flakeProto.add(twig);
      }
    }
    const glowTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const ctx = c.getContext('2d')!;
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(200,245,255,0.9)'); g.addColorStop(0.3, 'rgba(120,220,255,0.35)'); g.addColorStop(1, 'rgba(120,220,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.scale.set(1.8, 1.8, 1);
    this.flakeProto.add(glow);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 12, 14, 1, true), beamMaterial(0x8fe6ff));
    beam.position.y = 6;
    beam.name = 'beam';
    this.flakeProto.add(beam);

    // the surfboard lying around, waiting for a rider
    this.freeBoard = new THREE.Group();
    const fb = makeSurfboard();
    fb.rotation.x = -0.25;
    this.freeBoard.add(fb);
    const goldBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 14, 14, 1, true), beamMaterial(0xffc94d));
    goldBeam.position.y = 7;
    this.freeBoard.add(goldBeam);
    this.freeBoard.visible = false;
    this.group.add(this.freeBoard);

    // build-phase ice line down the middle
    this.barrierMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec2 vUv; uniform float uTime;
        void main(){
          float band = 0.5 + 0.5 * sin(vUv.y * 40.0 - uTime * 3.0);
          float edge = smoothstep(0.0, 0.08, vUv.y) * (1.0 - smoothstep(0.6, 1.0, vUv.y));
          float hex = step(0.92, fract(vUv.x * 60.0 + sin(vUv.y * 20.0) * 0.2)) * 0.5;
          vec3 c = vec3(0.55, 0.85, 1.0);
          gl_FragColor = vec4(c, (0.12 + band * 0.12 + hex * 0.25) * edge);
        }`,
    });
    this.barrier = new THREE.Mesh(new THREE.PlaneGeometry(64, 8, 1, 1), this.barrierMat);
    this.barrier.rotation.y = Math.PI / 2;
    this.barrier.position.set(map.midLineX, 6, 0);
    this.barrier.renderOrder = 6;
    this.group.add(this.barrier);

    // dig / build target
    this.aimMarker = new THREE.Mesh(new THREE.SphereGeometry(0.62, 20, 14), new THREE.MeshBasicMaterial({ color: 0x8fe6ff, transparent: true, opacity: 0.22, depthWrite: false }));
    this.aimMarker.visible = false;
    this.aimMarker.renderOrder = 7;
    this.group.add(this.aimMarker);

    // throw arc preview
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trajPos, 3));
    this.trajectory = new THREE.Line(tg, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.35, gapSize: 0.25, transparent: true, opacity: 0.75, depthTest: false }));
    this.trajectory.frustumCulled = false;
    this.trajectory.visible = false;
    this.trajectory.renderOrder = 8;
    this.group.add(this.trajectory);
  }

  setTrajectory(points: number[][]) {
    const n = Math.min(64, points.length);
    for (let i = 0; i < 64; i++) {
      const p = points[Math.min(i, n - 1)];
      this.trajPos[i * 3] = p[0]; this.trajPos[i * 3 + 1] = p[1]; this.trajPos[i * 3 + 2] = p[2];
    }
    const g = this.trajectory.geometry;
    g.setDrawRange(0, n);
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.trajectory.computeLineDistances();
  }

  update(w: World, alpha: number, dt: number, time: number) {
    // flying snowballs
    let n = 0;
    for (const b of w.snowballs) {
      if (n >= 256) break;
      const x = b.px + (b.x - b.px) * alpha, y = b.py + (b.y - b.py) * alpha, z = b.pz + (b.z - b.pz) * alpha;
      this.m4.makeTranslation(x, y, z);
      this.snowballs.setMatrixAt(n++, this.m4);
    }
    this.snowballs.count = n;
    this.snowballs.instanceMatrix.needsUpdate = true;

    // big balls (rolling spin from velocity)
    const seen = new Set<number>();
    for (const b of w.bigBalls) {
      seen.add(b.id);
      let m = this.bigMeshes.get(b.id);
      if (!m) {
        m = new THREE.Mesh(this.bigGeo, this.bigMat);
        m.castShadow = true; m.receiveShadow = true;
        this.group.add(m);
        this.bigMeshes.set(b.id, m);
      }
      m.position.set(b.px + (b.x - b.px) * alpha, b.py + (b.y - b.py) * alpha, b.pz + (b.z - b.pz) * alpha);
      m.scale.setScalar(b.r);
      const sp = Math.hypot(b.vx, b.vz);
      if (sp > 0.01) {
        const axis = new THREE.Vector3(b.vz / sp, 0, -b.vx / sp);
        const q = new THREE.Quaternion().setFromAxisAngle(axis, sp * dt / b.r);
        m.quaternion.premultiply(q);
      }
    }
    for (const [id, m] of this.bigMeshes) if (!seen.has(id)) { this.group.remove(m); this.bigMeshes.delete(id); }

    // stockpiles
    for (let t = 0; t < 2; t++) {
      const count = w.piles[t];
      const show = Math.min(60, count);
      const im = this.piles[t];
      if (im.count !== show) {
        let i = 0;
        // stack in rings: big bottom layer, smaller on top
        for (let layer = 0; i < show; layer++) {
          const ring = Math.max(1, 12 - layer * 3);
          const rr = Math.max(0, 0.75 - layer * 0.2);
          for (let k = 0; k < ring && i < show; k++, i++) {
            const a = (k / ring) * Math.PI * 2 + layer * 0.5;
            this.m4.makeTranslation(Math.cos(a) * rr, 0.15 + layer * 0.27, Math.sin(a) * rr);
            im.setMatrixAt(i, this.m4);
          }
          if (layer > 8) break;
        }
        im.count = show;
        im.instanceMatrix.needsUpdate = true;
      }
      const lab = this.pileLabels[t];
      lab.sprite.visible = true;
      if (lab.last !== count) { lab.draw(String(count)); lab.last = count; }
      lab.sprite.position.y = this.map.bases[t].stockpile.y + 1.4 + Math.min(1.5, show * 0.03) + Math.sin(time * 2) * 0.05;
    }

    // snowflakes
    const fseen = new Set<number>();
    for (const f of w.flakes) {
      if (!f.active) continue;
      fseen.add(f.id);
      let g = this.flakeMeshes.get(f.id);
      if (!g) { g = this.flakeProto.clone(); this.group.add(g); this.flakeMeshes.set(f.id, g); }
      g.position.set(f.x, f.y + Math.sin(time * 2 + f.id) * 0.15, f.z);
      g.rotation.y = time * 1.5;
      const beam = g.getObjectByName('beam');
      if (beam) beam.rotation.y = -time * 1.5;
    }
    for (const [id, g] of this.flakeMeshes) if (!fseen.has(id)) { this.group.remove(g); this.flakeMeshes.delete(id); }

    // surfboard on the ground
    const bd = w.board;
    this.freeBoard.visible = bd.active && bd.holder < 0;
    if (this.freeBoard.visible) {
      this.freeBoard.position.set(bd.x, bd.y + 0.25 + Math.sin(time * 2.5) * 0.12, bd.z);
      this.freeBoard.rotation.y = time * 1.2;
    }

    // build-phase barrier
    this.barrier.visible = w.phase === 'build';
    this.barrierMat.uniforms.uTime.value = time;
  }
}

export { TEAM_COLORS };
