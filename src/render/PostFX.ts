import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uSpeed: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uSpeed; varying vec2 vUv;
    void main(){
      vec2 q = vUv - 0.5;
      float r2 = dot(q, q);
      // a whisper of colour fringing toward the corners, stronger when you're flying downhill
      float ca = (0.0012 + uSpeed * 0.004) * r2 * 4.0;
      vec3 c = vec3(texture2D(tDiffuse, vUv + q * ca).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - q * ca).b);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, 1.14); // richer colour
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.2); // gentle contrast curve
      c += vec3(-0.014, 0.0, 0.022) * (1.0 - l) + vec3(0.016, 0.006, -0.012) * l; // cool shadows, warm highlights
      c *= mix(1.0, 0.74, smoothstep(0.12, 0.62, r2 * 1.5)); // vignette
      gl_FragColor = vec4(c, 1.0);
    }`,
};

/** HDR render with MSAA, bloom on the bright bits (sun, sparkles, ice glints, pickups), filmic tone map and a colour grade. */
export class PostFX {
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.2, 0.6, 2.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
  }

  setSize(w: number, h: number, pixelRatio: number) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
  }

  render(dt: number, speed: number) {
    const u = this.grade.uniforms.uSpeed;
    u.value += (Math.min(1, Math.max(0, (speed - 9) / 10)) - u.value) * Math.min(1, dt * 4);
    this.composer.render(dt);
  }
}
