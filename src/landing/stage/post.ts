// The stage's lens: the scene renders into a multisampled HDR buffer, the
// brightest highlights bloom, the output is tone-mapped once, and a last
// pass adds what a camera would: a vignette, a touch of chromatic fringe
// toward the corners, and fine moving grain.
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'

const FinishShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    vignette: { value: 0.32 },
    grain: { value: 0.028 },
    fringe: { value: 0.0011 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float vignette;
    uniform float grain;
    uniform float fringe;
    varying vec2 vUv;
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }
    void main() {
      vec2 d = vUv - 0.5;
      float r = dot(d, d);
      vec2 shift = d * fringe * r * 4.0;
      vec3 c = vec3(
        texture2D(tDiffuse, vUv + shift).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - shift).b
      );
      c *= 1.0 - vignette * smoothstep(0.06, 0.62, r);
      float n = hash(gl_FragCoord.xy + fract(time * 7.0) * 517.0) - 0.5;
      c += n * grain * (1.0 - c * 0.6);
      gl_FragColor = vec4(c, 1.0);
    }
  `,
}

export type LensOptions = { samples: number; bloom: number }

export class Lens {
  readonly composer: EffectComposer
  private bloom: UnrealBloomPass
  private finish: ShaderPass

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    { samples, bloom }: LensOptions,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples,
    })
    this.composer = new EffectComposer(renderer, target)
    this.composer.addPass(new RenderPass(scene, camera))
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      bloom,
      0.5,
      // Only real highlights bloom: lamp glints and the glowing columns,
      // never a card's lit paper.
      2.0,
    )
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
    this.finish = new ShaderPass(FinishShader)
    this.composer.addPass(this.finish)
  }

  setSize(width: number, height: number, pixelRatio: number) {
    this.composer.setPixelRatio(pixelRatio)
    this.composer.setSize(width, height)
  }

  render(time: number) {
    this.finish.uniforms.time.value = time
    this.composer.render()
  }

  dispose() {
    this.bloom.dispose()
    this.finish.dispose()
    this.composer.dispose()
  }
}
