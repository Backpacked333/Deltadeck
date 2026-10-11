// What surrounds the table: a studio environment for reflections (one
// warm softbox overhead, two dim strips at the sides, so glossy things
// catch a lamp rather than a grey room), a visible shaft of light from the
// spotlight, and out-of-focus lights far behind, like a room beyond.
import * as THREE from 'three'
import { bokehTexture, seeded } from './textures'

/**
 * A prefiltered environment map lit like a dark card room. Its glow is HDR
 * (colours above 1), so highlights on lacquer and chips read as a lamp.
 */
export function studioEnvironment(renderer: THREE.WebGLRenderer) {
  const room = new THREE.Scene()
  room.background = new THREE.Color('#020303')
  const panels: THREE.Mesh[] = []
  const panel = (
    w: number,
    h: number,
    color: string,
    power: number,
    at: [number, number, number],
    look: [number, number, number],
  ) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(color).multiplyScalar(power),
        side: THREE.DoubleSide,
      }),
    )
    mesh.position.set(...at)
    mesh.lookAt(...look)
    room.add(mesh)
    panels.push(mesh)
  }
  panel(5, 2.4, '#fff0d8', 5, [0, 7, 0.6], [0, 0, 0])
  panel(0.8, 5, '#d9dde2', 0.55, [-7, 3, -3], [0, 0, 0])
  panel(0.8, 5, '#ffd3a1', 0.45, [7, 2.5, 2], [0, 0, 0])
  panel(14, 6, '#24382f', 0.35, [0, -3, 0], [0, 0, 0])
  const pmrem = new THREE.PMREMGenerator(renderer)
  const target = pmrem.fromScene(room, 0.03)
  pmrem.dispose()
  for (const p of panels) {
    p.geometry.dispose()
    ;(p.material as THREE.Material).dispose()
  }
  return target
}

const beamVertex = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`
const beamFragment = /* glsl */ `
  uniform vec3 color;
  uniform float intensity;
  uniform float time;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  void main() {
    vec3 view = normalize(cameraPosition - vPosW);
    // Brightest through the middle of the cone, nothing at its silhouette.
    float facing = pow(abs(dot(normalize(vNormalW), view)), 2.2);
    // Fades in below the lamp and out well above the cards.
    float along = smoothstep(1.0, 0.86, vUv.y) * smoothstep(0.3, 0.78, vUv.y);
    // Seen from the side it is a shaft; looking down it, only a faint haze.
    float side = pow(1.0 - abs(view.y), 1.5);
    // Slow shafts in the air.
    float shafts = 0.7 + 0.3 * noise(vec2(vUv.x * 18.0, vUv.y * 2.0 - time * 0.05));
    float a = intensity * facing * along * shafts * side;
    gl_FragColor = vec4(color * a, 1.0);
  }
`

/** The spotlight's shaft: a cone of lit air, additive, drawn after the scene. */
export function lightBeam(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
) {
  const length = from.distanceTo(to)
  const geometry = new THREE.ConeGeometry(radius, length, 64, 1, true)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color('#fff1d6') },
      intensity: { value: 0 },
      time: { value: 0 },
    },
    vertexShader: beamVertex,
    fragmentShader: beamFragment,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  })
  const beam = new THREE.Mesh(geometry, material)
  // A cone's tip is at +y: point it from the lamp down to the table.
  beam.position.copy(from).add(to).multiplyScalar(0.5)
  beam.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    from.clone().sub(to).normalize(),
  )
  beam.renderOrder = 10
  return { beam, material }
}

/** Soft, distant lights behind the table, out of focus and never fogged. */
export function backdrop(count: number) {
  const group = new THREE.Group()
  const map = bokehTexture()
  const rnd = seeded(97)
  const tints = ['#ffcf8a', '#ffb066', '#ffe2b0', '#9fd8c0', '#ffc27a']
  for (let i = 0; i < count; i++) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map,
        color: tints[i % tints.length],
        transparent: true,
        opacity: 0.05 + rnd() * 0.1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    )
    const size = 0.12 + rnd() * 0.3
    sprite.scale.set(size, size, 1)
    // Other tables' lamps, low beyond the far rail where the seated camera
    // looks: above the floor, before the fog.
    sprite.position.set(
      (rnd() - 0.5) * 24,
      -1.45 + rnd() * 1.1,
      -6.5 - rnd() * 6,
    )
    group.add(sprite)
  }
  return { group, map }
}
