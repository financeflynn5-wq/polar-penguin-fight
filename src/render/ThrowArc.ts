import * as THREE from 'three';

const N = 72;

/**
 * The throw preview: a thick ribbon with marching dashes that always faces the camera, with a dark outline so it
 * reads against white snow, plus a landing ring where the snowball will hit. Turns hot pink when it will hit an enemy.
 */
export class ThrowArc {
  readonly group = new THREE.Group();
  private ribbon: THREE.Mesh;
  private ring: THREE.Mesh;
  private dot: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private pos = new Float32Array(N * 2 * 3);
  private tan = new Float32Array(N * 2 * 3);
  private dist = new Float32Array(N * 2);
  private colA = new THREE.Color(0xffd23a);
  private colHit = new THREE.Color(0xff3d7a);
  private strength = 0;

  constructor() {
    const geo = new THREE.BufferGeometry();
    const side = new Float32Array(N * 2);
    const idx: number[] = [];
    for (let i = 0; i < N; i++) {
      side[i * 2] = -1; side[i * 2 + 1] = 1;
      if (i < N - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aTan', new THREE.BufferAttribute(this.tan, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aDist', new THREE.BufferAttribute(this.dist, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color() }, uAlpha: { value: 1 }, uWidth: { value: 0.085 }, uLen: { value: 1 } },
      vertexShader: `attribute vec3 aTan; attribute float aDist; attribute float aSide;
        uniform float uWidth; varying float vD; varying float vS;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vec3 t = normalize((modelViewMatrix * vec4(aTan, 0.0)).xyz);
          vec3 n = normalize(cross(t, normalize(mv.xyz)));
          // never thinner than a few pixels, however far away it is
          float w = max(uWidth, -mv.z * 0.0078);
          mv.xyz += n * aSide * w;
          vD = aDist; vS = aSide;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform float uTime; uniform vec3 uColor; uniform float uAlpha; uniform float uLen; varying float vD; varying float vS;
        void main(){
          float dash = smoothstep(0.0, 0.08, fract(vD * 0.85 - uTime * 2.2) - 0.36);
          float edge = abs(vS);
          float core = 1.0 - smoothstep(0.5, 0.62, edge);
          float outline = 1.0 - smoothstep(0.88, 1.0, edge);
          vec3 col = mix(vec3(0.03, 0.07, 0.16), uColor * 1.6, core);
          float fadeIn = smoothstep(0.0, 1.2, vD);
          float fadeOut = 1.0 - smoothstep(uLen - 0.01, uLen, vD) * 0.0;
          gl_FragColor = vec4(col, outline * mix(0.25, 1.0, dash) * uAlpha * fadeIn * fadeOut);
        }`,
    });
    this.ribbon = new THREE.Mesh(geo, this.mat);
    this.ribbon.frustumCulled = false;
    this.ribbon.renderOrder = 20;
    this.group.add(this.ribbon);

    const ringMat = new THREE.ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: this.mat.uniforms.uTime, uColor: this.mat.uniforms.uColor, uAlpha: this.mat.uniforms.uAlpha },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uTime; uniform vec3 uColor; uniform float uAlpha; varying vec2 vUv;
        void main(){
          float r = length(vUv);
          float pulse = 0.72 + 0.06 * sin(uTime * 7.0);
          float ring = smoothstep(0.16, 0.1, abs(r - pulse));
          float inner = smoothstep(0.1, 0.06, abs(r - pulse));
          float fill = (1.0 - smoothstep(0.0, pulse, r)) * 0.28;
          vec3 col = mix(vec3(0.03, 0.07, 0.16), uColor * 1.6, max(inner, step(r, pulse - 0.12)));
          gl_FragColor = vec4(col, max(ring, fill) * uAlpha);
        }`,
    });
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), ringMat);
    this.ring.renderOrder = 21;
    this.group.add(this.ring);
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }));
    this.dot.renderOrder = 22;
    this.group.add(this.dot);
    this.group.visible = false;
  }

  /** points: the predicted path. normal: surface normal where it lands (or null if it flies off). */
  set(points: number[][], normal: { x: number; y: number; z: number } | null, strength: number, willHit: boolean, time: number, camPos: THREE.Vector3) {
    const n = Math.min(N, points.length);
    if (n < 2 || strength <= 0) { this.group.visible = false; return; }
    this.group.visible = true;
    let d = 0;
    for (let i = 0; i < N; i++) {
      const k = Math.min(i, n - 1);
      const p = points[k], q = points[Math.min(k + 1, n - 1)], o = points[Math.max(0, k - 1)];
      if (i > 0 && i < n) d += Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]);
      let tx = q[0] - o[0], ty = q[1] - o[1], tz = q[2] - o[2];
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      for (let s = 0; s < 2; s++) {
        const v = (i * 2 + s) * 3;
        this.pos[v] = p[0]; this.pos[v + 1] = p[1]; this.pos[v + 2] = p[2];
        this.tan[v] = tx; this.tan[v + 1] = ty; this.tan[v + 2] = tz;
        this.dist[i * 2 + s] = d;
      }
    }
    const g = this.ribbon.geometry;
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.aTan as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.aDist as THREE.BufferAttribute).needsUpdate = true;
    this.strength += (strength - this.strength) * 0.35;
    const u = this.mat.uniforms;
    u.uTime.value = time; u.uAlpha.value = this.strength; u.uLen.value = d;
    (u.uColor.value as THREE.Color).copy(willHit ? this.colHit : this.colA);
    u.uWidth.value = 0.08 + 0.05 * strength;

    const end = points[n - 1];
    this.ring.visible = this.dot.visible = !!normal;
    if (normal) {
      const camD = Math.hypot(end[0] - camPos.x, end[1] - camPos.y, end[2] - camPos.z);
      const size = Math.max(1.3, camD * 0.075);
      this.ring.position.set(end[0] + normal.x * 0.06, end[1] + normal.y * 0.06, end[2] + normal.z * 0.06);
      this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(normal.x, normal.y, normal.z).normalize());
      this.ring.scale.setScalar(size * (willHit ? 1.25 : 1));
      this.dot.position.set(end[0], end[1], end[2]);
      this.dot.scale.setScalar(Math.max(1, camD * 0.05));
      ((this.dot.material) as THREE.MeshBasicMaterial).opacity = this.strength;
    }
  }

  hide() { this.group.visible = false; this.strength = 0; }
}
