// The landing page's 3D table (ADR-001): one spotlight over a felt table in
// a dark room, cards dealt from a deck and flipped with weight, chips that
// slide, a camera that moves, and the decision beats (range cloud, grade
// stamp light, slow-motion verdict). React owns the hand; this module only
// shows it. Loaded lazily: three.js never reaches the entry chunk.
//
// The look: physically based materials lit by the spotlight and a studio
// environment (lacquered cards, brushed felt with sheen, stitched leather,
// varnished wood, clay chips), soft shadows, a visible shaft of light, and
// a lens pass (bloom, vignette, grain). Quality steps down with frame time.
import * as THREE from 'three'
import { chipStacks, DENOMINATIONS } from '../../lib/chips'
import type { Denomination } from '../../lib/chips'
import type { Card, Game } from '../../lib/poker'
import type { RangeEntry } from '../../challenge/score'
import { backdrop, lightBeam, studioEnvironment } from './atmosphere'
import {
  cardGeometry,
  chipGeometry,
  cushionProfile,
  sweepGeometry,
} from './geometry'
import { Lens } from './post'
import {
  cardBack,
  cardFace,
  chipEdge,
  chipFace,
  comboTexture,
  dotTexture,
  feltNormal,
  feltTexture,
  leatherNormal,
  leatherTexture,
  linenNormal,
  seeded,
  woodTexture,
} from './textures'
import {
  easeInOutCubic,
  easeOutBack,
  easeOutCubic,
  lerp,
  linear,
  Tweens,
} from './tween'

const RANKS = '23456789TJQKA'
const code = (c: Card) => `${RANKS[c.rank - 2]}${c.suit}`

const CARD_W = 0.62
const CARD_H = 0.88
const CARD_T = 0.01
const CHIP_R = 0.16
const CHIP_H = 0.032
const TABLE_X = 4.2
const TABLE_Z = 2.4
/** The wooden racetrack between the felt and the rail, and the rail itself. */
const TRACK_W = 0.22
const RAIL_W = 0.5
const RAIL_H = 0.25

/** Where things sit on the felt (y is up; the hero sits at +z). */
const SPOT = {
  deck: new THREE.Vector3(2.75, 0, -1.05),
  hero: [new THREE.Vector3(-0.36, 0, 1.45), new THREE.Vector3(0.36, 0, 1.45)],
  atlas: [new THREE.Vector3(-0.36, 0, -1.5), new THREE.Vector3(0.36, 0, -1.5)],
  board: [-1.6, -0.8, 0, 0.8, 1.6].map((x) => new THREE.Vector3(x, 0, 0.05)),
  heroBet: new THREE.Vector3(-0.9, 0, 0.95),
  atlasBet: new THREE.Vector3(0.9, 0, -0.95),
  pot: new THREE.Vector3(0, 0, -0.62),
  heroStack: new THREE.Vector3(-1.55, 0, 1.6),
  atlasStack: new THREE.Vector3(1.55, 0, -1.65),
}

/** Camera rigs: position and look-at target. */
const RIG = {
  overhead: {
    pos: new THREE.Vector3(0, 10.5, 0.4),
    at: new THREE.Vector3(0, 0, 0),
  },
  seat: {
    pos: new THREE.Vector3(0, 4.3, 6.1),
    at: new THREE.Vector3(0, -0.15, 0.25),
  },
  pot: {
    pos: new THREE.Vector3(0.2, 2.1, 2.55),
    at: new THREE.Vector3(0, 0.25, -0.2),
  },
  range: {
    pos: new THREE.Vector3(0, 3.6, 5.6),
    at: new THREE.Vector3(0, 1.1, -0.6),
  },
  wide: {
    pos: new THREE.Vector3(0, 7.2, 7.4),
    at: new THREE.Vector3(0, -0.4, -0.6),
  },
}
type RigName = keyof typeof RIG

const LAMP = new THREE.Vector3(0, 7.5, 1.2)
const SPOT_ON = 46

export type Tier = 0 | 1 | 2
export type StageOptions = {
  /** Called once if WebGL is lost or cannot start: show the 2D table. */
  onFail: () => void
  reducedMotion?: boolean
}
export type AnchorName = 'atlas' | 'hero' | 'pot' | 'equityBar' | 'priceBar'

type CardMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>
/** One chip to draw: its denomination, where it sits, a seed for its wobble. */
type Placed = { d: Denomination; x: number; y: number; z: number; seed: number }
type ChipGroup = 'heroBet' | 'atlasBet' | 'pot' | 'heroStack' | 'atlasStack'

/**
 * The tier to start at: `?stagequality=0|1|2` pins it (for screenshots and
 * QA); a software GPU starts at 0; a phone at 1; anything else at 2.
 */
function startingTier(renderer: THREE.WebGLRenderer): {
  tier: Tier
  pinned: boolean
} {
  const asked = new URLSearchParams(location.search).get('stagequality')
  if (asked && /^[012]$/.test(asked))
    return { tier: Number(asked) as Tier, pinned: true }
  const gl = renderer.getContext()
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
  if (/swiftshader|llvmpipe|softpipe|software/i.test(name))
    return { tier: 0, pinned: false }
  const phone = Math.min(window.innerWidth, window.innerHeight) < 600
  return { tier: phone ? 1 : 2, pinned: false }
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 80)
  private tweens = new Tweens()
  private spot: THREE.SpotLight
  private rim: THREE.DirectionalLight
  private beam: THREE.ShaderMaterial
  private dust: THREE.Points
  private dustBase: Float32Array
  private backdrop: THREE.Group
  private environment: THREE.WebGLRenderTarget
  private lens: Lens | null = null
  private textures = new Map<string, THREE.Texture>()
  private faceWidth: number
  private cardShape = cardGeometry(CARD_W, CARD_H, CARD_T, 0.036)
  private cardBack: THREE.MeshPhysicalMaterial
  private cardEdge: THREE.MeshStandardMaterial
  private linen: THREE.Texture
  private cards = new Map<string, CardMesh>()
  private chips: Record<ChipGroup, THREE.Group> = {
    heroBet: new THREE.Group(),
    atlasBet: new THREE.Group(),
    pot: new THREE.Group(),
    heroStack: new THREE.Group(),
    atlasStack: new THREE.Group(),
  }
  private chipValues: Record<ChipGroup, number> = {
    heroBet: 0,
    atlasBet: 0,
    pot: 0,
    heroStack: 0,
    atlasStack: 0,
  }
  private bars: { equity: THREE.Mesh; price: THREE.Mesh } | null = null
  private cloud: THREE.Group | null = null
  private look = RIG.seat.at.clone()
  private frame = 0
  private raf = 0
  private frameTimes: number[] = []
  private lastFrame = 0
  private measured = false
  private tier: Tier
  private pinned: boolean
  private disposed = false
  /** Where the table sits across a wide screen: + right of centre, − left. */
  private shift = 0.17
  private wideScreen = false
  private hand = -1
  private shown = { board: 0, atlasUp: false }
  private idleWaiters: (() => void)[] = []
  private anchorListener:
    | ((anchors: Record<AnchorName, { x: number; y: number }>) => void)
    | null = null

  /** Screen positions for HTML labels, sent every other frame. */
  onAnchors(
    listener:
      | ((anchors: Record<AnchorName, { x: number; y: number }>) => void)
      | null,
  ) {
    this.anchorListener = listener
  }

  constructor(
    readonly canvas: HTMLCanvasElement,
    private options: StageOptions,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    const start = startingTier(this.renderer)
    this.tier = start.tier
    this.pinned = start.pinned
    this.faceWidth = this.tier === 2 ? 640 : 384
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.95
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    canvas.addEventListener('webglcontextlost', this.lost)

    const anisotropy = Math.min(
      this.tier === 2 ? 16 : 8,
      this.renderer.capabilities.getMaxAnisotropy(),
    )
    this.scene.background = this.roomTone()
    this.scene.fog = new THREE.Fog('#040706', 11, 26)
    this.environment = studioEnvironment(this.renderer)
    this.scene.environment = this.environment.texture
    this.scene.environmentIntensity = 0.45

    // Lights: one warm spotlight, a cool rim from behind, a whisper of fill;
    // the environment adds the lamp's reflections.
    this.spot = new THREE.SpotLight('#fff1d8', 0, 20, 0.66, 0.62, 1.1)
    this.spot.position.copy(LAMP)
    this.spot.target.position.set(0, 0, 0)
    const shadow = this.tier === 2 ? 2048 : 1024
    this.spot.shadow.mapSize.set(shadow, shadow)
    this.spot.shadow.bias = -0.00025
    this.spot.shadow.normalBias = 0.012
    this.spot.shadow.camera.near = 3
    this.spot.shadow.camera.far = 13
    this.scene.add(this.spot, this.spot.target)
    this.rim = new THREE.DirectionalLight('#b9cadb', 0.32)
    this.rim.position.set(-3, 3.5, -6)
    // A soft fill from over the viewer's shoulder, so the rail's leather and
    // the racetrack's varnish read at the edge of the pool of light.
    const fill = new THREE.SpotLight('#ffe2bf', 14, 24, 0.85, 1, 1.2)
    fill.position.set(0, 6.5, 10)
    fill.target.position.set(0, -0.2, 2.4)
    this.scene.add(
      this.rim,
      fill,
      fill.target,
      new THREE.HemisphereLight('#a9c6b6', '#050807', 0.08),
    )
    const shaft = lightBeam(LAMP, new THREE.Vector3(0, 0, 0), 3.1)
    this.beam = shaft.material
    this.scene.add(shaft.beam)
    const far = backdrop(this.tier === 2 ? 34 : 18)
    this.backdrop = far.group
    this.textures.set('bokeh', far.map)
    this.scene.add(this.backdrop)

    this.linen = linenNormal(anisotropy)
    this.linen.repeat.set(5, 7)
    this.textures.set('linen', this.linen)
    const back = cardBack(anisotropy, this.faceWidth)
    this.textures.set('back', back)
    this.cardBack = new THREE.MeshPhysicalMaterial({
      map: back,
      roughness: 0.36,
      clearcoat: 0.55,
      clearcoatRoughness: 0.25,
      normalMap: this.linen,
      normalScale: new THREE.Vector2(0.18, 0.18),
    })
    this.cardEdge = new THREE.MeshStandardMaterial({
      color: '#e7e1d2',
      roughness: 0.7,
    })

    this.buildTable(anisotropy)
    for (const group of Object.values(this.chips)) this.scene.add(group)
    this.chips.heroBet.position.copy(SPOT.heroBet)
    this.chips.atlasBet.position.copy(SPOT.atlasBet)
    this.chips.pot.position.copy(SPOT.pot)
    this.chips.heroStack.position.copy(SPOT.heroStack)
    this.chips.atlasStack.position.copy(SPOT.atlasStack)

    // Dust drifting through the beam.
    const count = this.tier === 2 ? 520 : 180
    this.dustBase = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const a = (i * 2.399963) % (Math.PI * 2)
      const r = 2.6 * Math.sqrt(((i * 7919) % count) / count)
      this.dustBase[i * 3] = Math.cos(a) * r
      this.dustBase[i * 3 + 1] = 0.3 + ((i * 104729) % 1000) / 180
      this.dustBase[i * 3 + 2] = Math.sin(a) * r * 0.7
    }
    const dustGeo = new THREE.BufferGeometry()
    dustGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.dustBase.slice(), 3),
    )
    this.dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({
        size: 0.028,
        map: dotTexture(),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        color: '#ffe9c7',
      }),
    )
    this.scene.add(this.dust)

    this.applyTier()
    this.resize()
    this.camera.position.copy(RIG.overhead.pos)
    this.camera.lookAt(RIG.overhead.at)
    this.look.copy(RIG.overhead.at)
    this.raf = requestAnimationFrame(this.loop)
  }

  // ---------------------------------------------------------------- scene

  /** The room behind everything: near black, faintly green at the middle. */
  private roomTone() {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 256
    const g = c.getContext('2d')!
    const tone = g.createRadialGradient(128, 110, 10, 128, 128, 190)
    tone.addColorStop(0, '#0b1612')
    tone.addColorStop(0.6, '#060c0a')
    tone.addColorStop(1, '#020403')
    g.fillStyle = tone
    g.fillRect(0, 0, 256, 256)
    const texture = new THREE.CanvasTexture(c)
    texture.colorSpace = THREE.SRGBColorSpace
    this.textures.set('room', texture)
    return texture
  }

  private buildTable(anisotropy: number) {
    const add = (mesh: THREE.Mesh, cast = true) => {
      mesh.castShadow = cast
      mesh.receiveShadow = true
      this.scene.add(mesh)
      return mesh
    }
    // The felt: printed cloth with fibre relief and a velvet sheen.
    const print = feltTexture(anisotropy, this.tier === 2 ? 2048 : 1024)
    const fibre = feltNormal(anisotropy)
    fibre.repeat.set(30, 17)
    this.textures.set('felt', print)
    this.textures.set('fibre', fibre)
    const felt = new THREE.Mesh(
      new THREE.CircleGeometry(1, 128),
      new THREE.MeshPhysicalMaterial({
        map: print,
        roughness: 0.94,
        normalMap: fibre,
        normalScale: new THREE.Vector2(0.55, 0.55),
        sheen: 0.7,
        sheenColor: new THREE.Color('#2f7458'),
        sheenRoughness: 0.6,
      }),
    )
    felt.rotation.x = -Math.PI / 2
    felt.scale.set(TABLE_X + 0.03, TABLE_Z + 0.03, 1)
    // It casts too, so nothing on the table shadows what is under it.
    add(felt)

    // The racetrack: a band of varnished mahogany around the felt.
    const wood = woodTexture(anisotropy)
    this.textures.set('wood', wood)
    add(
      new THREE.Mesh(
        sweepGeometry(
          TABLE_X,
          TABLE_Z,
          [
            [0, -0.01],
            [0, 0.012],
            [0.012, 0.02],
            [TRACK_W * 0.5, 0.026],
            [TRACK_W - 0.012, 0.02],
            [TRACK_W, 0.01],
          ],
          { repeat: 16 },
        ),
        new THREE.MeshPhysicalMaterial({
          map: wood,
          roughness: 0.4,
          clearcoat: 1,
          clearcoatRoughness: 0.14,
        }),
      ),
    )

    // The rail: a padded leather cushion with two rows of stitching.
    const hide = leatherTexture(anisotropy, [0.24, 0.62])
    const grain = leatherNormal(anisotropy)
    hide.repeat.set(1, 1)
    grain.repeat.set(4, 3)
    this.textures.set('leather', hide)
    this.textures.set('grain', grain)
    const railBase = TABLE_X + TRACK_W - 0.03
    const zBase = TABLE_Z + TRACK_W - 0.03
    add(
      new THREE.Mesh(
        sweepGeometry(railBase, zBase, cushionProfile(RAIL_W, RAIL_H), {
          repeat: 30,
          segments: 320,
        }),
        new THREE.MeshPhysicalMaterial({
          map: hide,
          roughness: 0.5,
          normalMap: grain,
          normalScale: new THREE.Vector2(0.7, 0.7),
          sheen: 0.6,
          sheenColor: new THREE.Color('#9a6446'),
          sheenRoughness: 0.5,
          clearcoat: 0.22,
          clearcoatRoughness: 0.4,
        }),
      ),
    )

    // The apron under the rail, black lacquer, and a pedestal to the floor.
    const lacquer = new THREE.MeshPhysicalMaterial({
      color: '#0c0908',
      roughness: 0.4,
      clearcoat: 0.7,
      clearcoatRoughness: 0.2,
    })
    add(
      new THREE.Mesh(
        sweepGeometry(
          railBase,
          zBase,
          [
            [RAIL_W * 0.95, -0.14],
            [RAIL_W * 0.9, -0.34],
            [RAIL_W * 0.6, -0.5],
            [0, -0.53],
          ],
          { segments: 160 },
        ),
        lacquer,
      ),
    )
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 1.1, 1, 48, 1, true),
      lacquer,
    )
    pedestal.position.y = -1.12
    add(pedestal)

    // The floor: dark carpet, catching the spill of the spotlight.
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(18, 64),
      new THREE.MeshStandardMaterial({ color: '#0a0f0d', roughness: 1 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -1.6
    add(floor, false)

    // The deck: a squared-up stack of backs, each a hair out of line, drawn
    // as one instanced mesh.
    const rnd = seeded(3)
    const deck = new THREE.InstancedMesh(
      this.cardShape,
      [this.cardBack, this.cardBack, this.cardEdge],
      16,
    )
    const card = new THREE.Object3D()
    for (let i = 0; i < 16; i++) {
      card.position
        .copy(SPOT.deck)
        .add(new THREE.Vector3((rnd() - 0.5) * 0.008, 0, (rnd() - 0.5) * 0.008))
        .setY(CARD_T / 2 + i * CARD_T)
      card.rotation.set(0, 0.35 + (rnd() - 0.5) * 0.02, Math.PI)
      card.updateMatrix()
      deck.setMatrixAt(i, card.matrix)
    }
    add(deck)
  }

  private texture(key: string) {
    let t = this.textures.get(key)
    if (!t) {
      t = cardFace(
        key,
        Math.min(16, this.renderer.capabilities.getMaxAnisotropy()),
        this.faceWidth,
      )
      this.textures.set(key, t)
    }
    return t
  }

  /** A card lying face up (rotation.z = 0) or down (π); `null` is a back. */
  private makeCard(face: string | null): CardMesh {
    const front = face
      ? new THREE.MeshPhysicalMaterial({
          map: this.texture(face),
          roughness: 0.34,
          clearcoat: 0.55,
          clearcoatRoughness: 0.24,
          normalMap: this.linen,
          normalScale: new THREE.Vector2(0.14, 0.14),
        })
      : this.cardBack
    const mesh = new THREE.Mesh(this.cardShape, [
      front,
      this.cardBack,
      this.cardEdge,
    ])
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }

  private removeCard(card: CardMesh) {
    this.scene.remove(card)
    const front = card.material[0]
    if (front !== this.cardBack) front.dispose()
  }

  // ---------------------------------------------------------------- hand

  /**
   * Shows `game`: new cards are dealt from the deck, bets and the pot are
   * redrawn as chips, Atlas's cards turn over at a showdown. A new hand id
   * clears the felt and deals from scratch.
   */
  show(game: Game) {
    const now = this.now()
    if (game.id !== this.hand) {
      this.hand = game.id
      for (const card of this.cards.values()) this.removeCard(card)
      this.cards.clear()
      this.shown = { board: 0, atlasUp: false }
      let delay = 0
      for (let i = 0; i < 2; i++) {
        this.deal(
          `h${i}`,
          code(game.cards[0][i]),
          SPOT.hero[i],
          true,
          delay,
          (i ? 1 : -1) * 0.06,
        )
        delay += 140
        this.deal(
          `a${i}`,
          code(game.cards[1][i]),
          SPOT.atlas[i],
          false,
          delay,
          (i ? -1 : 1) * 0.05,
        )
        delay += 140
      }
      for (let i = 0; i < game.board.length; i++) {
        this.deal(
          `b${i}`,
          code(game.board[i]),
          SPOT.board[i],
          true,
          delay + 120,
        )
        delay += 150
      }
      this.shown.board = game.board.length
    } else {
      let delay = 0
      for (let i = this.shown.board; i < game.board.length; i++) {
        // An all-in runout lands one street at a time.
        this.deal(`b${i}`, code(game.board[i]), SPOT.board[i], true, delay)
        delay +=
          game.result && game.board.length - this.shown.board > 1 ? 700 : 160
      }
      this.shown.board = game.board.length
    }
    if (game.result?.showdown && !this.shown.atlasUp) {
      this.shown.atlasUp = true
      for (let i = 0; i < 2; i++) {
        const card = this.cards.get(`a${i}`)
        if (card) this.flip(card, now, 900 + i * 120)
      }
    }
    // Chips: each player's stack, what they have in front of them, the middle.
    this.setStack('heroStack', game.stacks[0])
    this.setStack('atlasStack', game.stacks[1])
    const potMiddle = game.pot - game.bets[0] - game.bets[1]
    this.setChips('heroBet', game.result ? 0 : game.bets[0], SPOT.heroStack)
    this.setChips('atlasBet', game.result ? 0 : game.bets[1], SPOT.atlasStack)
    if (game.result) {
      const winner = game.result.winner
      const to =
        winner === 0
          ? SPOT.heroStack
          : winner === 1
            ? SPOT.atlasStack
            : SPOT.pot
      this.pushPot(to, game.result.showdown ? 1300 : 300)
    } else this.setChips('pot', potMiddle, SPOT.pot)
  }

  private deal(
    key: string,
    face: string,
    to: THREE.Vector3,
    faceUp: boolean,
    delay: number,
    yaw = 0,
  ) {
    const card = this.makeCard(face)
    card.position.copy(SPOT.deck).setY(0.12)
    card.rotation.set(0, 0.35, Math.PI)
    this.scene.add(card)
    this.cards.set(key, card)
    const from = card.position.clone()
    const fly = this.options.reducedMotion ? 0 : 520
    this.tweens.add(
      this.now(),
      fly,
      (p) => {
        card.position.lerpVectors(from, to, p)
        card.position.y = CARD_T / 2 + Math.sin(p * Math.PI) * 0.55
        card.rotation.y = lerp(0.35, yaw, p)
        // A slight bank in flight, as a card skimmed across a table has.
        card.rotation.x = Math.sin(p * Math.PI) * -0.18
        if (faceUp) card.rotation.z = lerp(Math.PI, 0, easeInOutCubic(p))
      },
      {
        delay,
        ease: easeOutCubic,
        done: () => {
          card.position.setY(CARD_T / 2)
          card.rotation.x = 0
        },
      },
    )
  }

  private flip(card: CardMesh, now: number, delay: number) {
    this.tweens.add(
      now,
      this.options.reducedMotion ? 0 : 520,
      (p) => {
        card.rotation.z = lerp(Math.PI, 0, p)
        card.position.y = CARD_T / 2 + Math.sin(p * Math.PI) * 0.4
      },
      { delay, ease: easeInOutCubic },
    )
  }

  private chipShape = chipGeometry(CHIP_R, CHIP_H, 0.008)
  private chipMaterials = new Map<number, THREE.Material[]>()

  /** A denomination's side and face materials, made once. */
  private chipMaterial(d: Denomination) {
    let m = this.chipMaterials.get(d.value)
    if (!m) {
      const anisotropy = Math.min(
        8,
        this.renderer.capabilities.getMaxAnisotropy(),
      )
      const edge = chipEdge(d, anisotropy)
      const face = chipFace(d, anisotropy)
      this.textures.set(`chip-edge-${d.value}`, edge)
      this.textures.set(`chip-face-${d.value}`, face)
      m = [
        new THREE.MeshPhysicalMaterial({
          map: edge,
          roughness: 0.55,
          clearcoat: 0.2,
          clearcoatRoughness: 0.5,
        }),
        new THREE.MeshPhysicalMaterial({
          map: face,
          roughness: 0.42,
          clearcoat: 0.45,
          clearcoatRoughness: 0.28,
        }),
      ]
      this.chipMaterials.set(d.value, m)
    }
    return m
  }

  /**
   * Replaces `group`'s chips with `placed`: one instanced mesh for each
   * denomination (a few draw calls, not one per chip), each chip a little
   * out of true.
   */
  private fillChips(group: THREE.Group, placed: Placed[]) {
    this.emptyChips(group)
    const byValue = new Map<number, Placed[]>()
    for (const chip of placed)
      byValue.set(chip.d.value, [...(byValue.get(chip.d.value) ?? []), chip])
    const matrix = new THREE.Matrix4()
    const turn = new THREE.Quaternion()
    const tilt = new THREE.Euler()
    const at = new THREE.Vector3()
    const one = new THREE.Vector3(1, 1, 1)
    for (const chips of byValue.values()) {
      const mesh = new THREE.InstancedMesh(
        this.chipShape,
        this.chipMaterial(chips[0].d),
        chips.length,
      )
      chips.forEach((chip, i) => {
        const rnd = seeded(chip.seed)
        at.set(
          chip.x + (rnd() - 0.5) * 0.012,
          chip.y,
          chip.z + (rnd() - 0.5) * 0.012,
        )
        tilt.set(
          (rnd() - 0.5) * 0.02,
          rnd() * Math.PI * 2,
          (rnd() - 0.5) * 0.02,
        )
        mesh.setMatrixAt(i, matrix.compose(at, turn.setFromEuler(tilt), one))
      })
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
    }
  }

  private emptyChips(group: THREE.Group) {
    for (const child of group.children)
      if (child instanceof THREE.InstancedMesh) child.dispose()
    group.clear()
  }

  /** Redraws one chip group for `amount`, sliding new chips in from `from`. */
  private setChips(
    which: 'heroBet' | 'atlasBet' | 'pot',
    amount: number,
    from: THREE.Vector3,
  ) {
    if (this.chipValues[which] === amount) return
    const grew = amount > this.chipValues[which]
    this.chipValues[which] = amount
    const group = this.chips[which]
    const { stacks } = chipStacks(amount, { maxPerStack: 10, maxStacks: 4 })
    this.fillChips(
      group,
      stacks.flatMap((stack, s) =>
        Array.from({ length: stack.count }, (_, i) => ({
          d: stack.denomination,
          x: (s - (stacks.length - 1) / 2) * CHIP_R * 2.15,
          y: CHIP_H / 2 + i * CHIP_H,
          z: (s % 2) * 0.05,
          seed: amount * 31 + s * 17 + i,
        })),
      ),
    )
    if (!grew || this.options.reducedMotion) return
    const home = group.position.clone()
    const start = from.clone().sub(home)
    group.position.add(start)
    this.tweens.add(
      this.now(),
      460,
      (p) => {
        group.position.lerpVectors(home.clone().add(start), home, p)
        group.position.y = Math.sin(p * Math.PI) * 0.25
      },
      { ease: easeOutCubic, done: () => group.position.copy(home) },
    )
  }

  /**
   * A player's stack behind the line: columns of each denomination in two
   * rows, the tallest at the back, as a player squares them.
   */
  private setStack(which: 'heroStack' | 'atlasStack', amount: number) {
    if (this.chipValues[which] === amount) return
    this.chipValues[which] = amount
    const columns: { d: Denomination; count: number }[] = []
    let rest = Math.max(0, Math.round(amount))
    for (const d of DENOMINATIONS) {
      let count = Math.floor(rest / d.value)
      rest -= count * d.value
      while (count > 0 && columns.length < 6) {
        columns.push({ d, count: Math.min(count, 14) })
        count -= 14
      }
    }
    const away = which === 'atlasStack' ? -1 : 1
    const across = Math.ceil(columns.length / 2)
    this.fillChips(
      this.chips[which],
      columns.flatMap(({ d, count }, c) =>
        Array.from({ length: count }, (_, i) => ({
          d,
          x: (Math.floor(c / 2) - (across - 1) / 2) * CHIP_R * 2.12,
          y: CHIP_H / 2 + i * CHIP_H,
          z: (c % 2 ? 0.5 : -0.5) * CHIP_R * 2.05 * away,
          seed: c * 101 + i * 7 + d.value,
        })),
      ),
    )
  }

  private pushPot(to: THREE.Vector3, delay: number) {
    const group = this.chips.pot
    const home = SPOT.pot.clone()
    if (!this.chipValues.pot) return
    this.tweens.add(
      this.now(),
      this.options.reducedMotion ? 0 : 700,
      (p) => {
        group.position.lerpVectors(home, to, p)
        group.position.y = Math.sin(p * Math.PI) * 0.3
      },
      {
        delay,
        ease: easeInOutCubic,
        done: () => {
          this.emptyChips(group)
          group.position.copy(home)
          this.chipValues.pot = 0
        },
      },
    )
  }

  // ---------------------------------------------------------------- camera

  private moveCamera(
    rig: RigName,
    duration: number,
    { beat = false, delay = 0, ease = easeInOutCubic } = {},
  ) {
    const fromPos = this.camera.position.clone()
    const fromAt = this.look.clone()
    const to = RIG[rig]
    this.tweens.add(
      this.now(),
      this.options.reducedMotion ? 0 : duration,
      (p) => {
        this.camera.position.lerpVectors(fromPos, to.pos, p)
        this.look.lerpVectors(fromAt, to.at, p)
      },
      { beat, delay, ease },
    )
  }

  /** The opening: lights up, the dust appears, the camera sits down. */
  intro() {
    const now = this.now()
    const dust = this.dust.material as THREE.PointsMaterial
    this.tweens.add(now, 1400, (p) => {
      this.spot.intensity = lerp(0, SPOT_ON, p)
      dust.opacity = lerp(0, 0.45, p)
    })
    this.moveCamera('seat', 2400, { delay: 250 })
  }

  // ---------------------------------------------------------------- beats

  /**
   * First decision: Atlas's likeliest hands rise above the table as a cloud,
   * red where they beat the hero, green where they do not, then dissolve.
   */
  rangeCloud(range: RangeEntry[], onDone: () => void) {
    const now = this.now()
    this.clearCloud()
    const group = new THREE.Group()
    this.cloud = group
    this.scene.add(group)
    const plane = new THREE.PlaneGeometry(0.36, 0.254)
    const glowTex = dotTexture()
    range.slice(0, 32).forEach(([cards, , equity], i) => {
      const ahead = equity < 0.5
      const tint = ahead ? '#f0697a' : '#79e0a8'
      const card = new THREE.Mesh(
        plane,
        new THREE.MeshBasicMaterial({
          map: comboTexture(cards),
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          toneMapped: false,
        }),
      )
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTex,
          color: new THREE.Color(tint).multiplyScalar(1.6),
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      glow.scale.set(0.62, 0.48, 1)
      glow.position.z = -0.02
      card.add(glow)
      // An arc of cards, rows bowed toward the camera.
      const cols = 9
      const row = Math.floor(i / cols)
      const col = i % cols
      const x = (col - (cols - 1) / 2) * 0.52
      const target = new THREE.Vector3(
        x,
        0.75 + row * 0.38,
        -0.95 - Math.abs(x) * 0.18 + row * 0.05,
      )
      const from = SPOT.atlas[i % 2].clone().setY(0.05)
      card.position.copy(from)
      card.lookAt(RIG.range.pos)
      group.add(card)
      const mat = card.material as THREE.MeshBasicMaterial
      const glowMat = glow.material as THREE.SpriteMaterial
      this.tweens.add(
        now,
        700,
        (p) => {
          card.position.lerpVectors(from, target, p)
          mat.opacity = Math.min(1, p * 1.6)
          glowMat.opacity = p * 0.7
        },
        { delay: 120 + i * 18, ease: easeOutBack, beat: true },
      )
      this.tweens.add(
        now,
        420,
        (p) => {
          mat.opacity = 1 - p
          glowMat.opacity = 0.7 * (1 - p)
          card.position.y = target.y + p * 0.4
        },
        { delay: 1650 + i * 6, ease: linear, beat: true },
      )
    })
    this.moveCamera('range', 700, { beat: true })
    this.moveCamera('seat', 700, { beat: true, delay: 1900 })
    this.tweens.add(now, 0, () => {}, {
      delay: 2650,
      beat: true,
      done: () => {
        this.clearCloud()
        onDone()
      },
    })
  }

  private clearCloud() {
    if (!this.cloud) return
    this.scene.remove(this.cloud)
    this.cloud.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
        const m = o.material as THREE.MeshBasicMaterial
        if (m.map) m.map.dispose()
        m.dispose()
      }
    })
    this.cloud = null
  }

  /** A short beat: the light warms green or cools red, then settles. */
  stamp(good: boolean, onDone: () => void) {
    const now = this.now()
    const base = new THREE.Color('#fff1d8')
    const tint = new THREE.Color(good ? '#b8f5cf' : '#ffb3a8')
    this.tweens.add(
      now,
      900,
      (p) => {
        const k = Math.sin(p * Math.PI)
        this.spot.color.copy(base).lerp(tint, k)
        this.spot.intensity = SPOT_ON + k * 18
      },
      { beat: true, ease: linear, done: onDone },
    )
  }

  /**
   * Last decision: time slows, the camera pushes in on the pot, the hero's
   * equity and the price rise out of the felt as two glowing columns, and
   * the light turns with the grade.
   */
  verdict(equity: number, price: number, good: boolean, onDone: () => void) {
    const now = this.now()
    this.clearBars()
    const make = (color: string, x: number) => {
      const bar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.1, 1, 40),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 2.2,
          roughness: 0.2,
          transparent: true,
          opacity: 0.9,
        }),
      )
      bar.position.set(x, 0, 0.78)
      bar.scale.y = 0.001
      this.scene.add(bar)
      return bar
    }
    const bars = {
      equity: make('#79e0a8', -0.42),
      price: make('#e8b866', 0.42),
    }
    this.bars = bars
    const height = (v: number) => Math.max(0.04, v * 0.9)
    this.moveCamera('pot', 650, { beat: true, ease: easeOutCubic })
    for (const [bar, value, delay] of [
      [bars.equity, equity, 250],
      [bars.price, price, 380],
    ] as const)
      this.tweens.add(
        now,
        700,
        (p) => {
          bar.scale.y = Math.max(0.001, height(value) * p)
          bar.position.y = (height(value) * p) / 2
        },
        { delay, ease: easeOutBack, beat: true },
      )
    this.stamp(good, () => {})
    this.tweens.add(
      now,
      500,
      (p) => {
        for (const bar of [bars.equity, bars.price]) {
          const m = bar.material as THREE.MeshStandardMaterial
          m.opacity = 0.92 * (1 - p)
        }
      },
      { delay: 1500, beat: true, ease: linear },
    )
    this.moveCamera('seat', 650, { beat: true, delay: 1500 })
    this.tweens.add(now, 0, () => {}, {
      delay: 2150,
      beat: true,
      done: () => {
        this.clearBars()
        onDone()
      },
    })
  }

  private clearBars() {
    if (!this.bars) return
    for (const bar of [this.bars.equity, this.bars.price]) {
      this.scene.remove(bar)
      bar.geometry.dispose()
      ;(bar.material as THREE.Material).dispose()
    }
    this.bars = null
  }

  /** The hand is over: the camera rises and the table slides left of the score. */
  wide() {
    this.moveCamera('wide', 1600)
    this.slide(-0.2, 1600)
  }

  /** Back to the seat for a new hand. */
  seat() {
    this.moveCamera('seat', 900)
    this.slide(0.17, 900)
  }

  private slide(to: number, duration: number) {
    const from = this.shift
    this.tweens.add(
      this.now(),
      this.options.reducedMotion ? 0 : duration,
      (p) => {
        this.shift = lerp(from, to, p)
        this.frameShot()
      },
      { ease: easeInOutCubic },
    )
  }

  /** Ends any running beat at once (a click or a key). */
  skip() {
    this.tweens.finish()
  }

  get busy() {
    return this.tweens.beatBusy
  }

  /** Resolves when no tween (deal, chips, beat) is running. */
  whenIdle() {
    if (!this.tweens.busy) return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  // ---------------------------------------------------------------- loop

  /**
   * The stage's clock. `?stageslow=<n>` runs it n times slower, so tests
   * and screenshots can catch a beat mid-flight on a slow software GPU.
   */
  private scale = (() => {
    const slow = Number(new URLSearchParams(location.search).get('stageslow'))
    return slow > 1 ? 1 / Math.min(slow, 50) : 1
  })()
  private now() {
    return performance.now() * this.scale
  }

  private loop = (time: number) => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    time = performance.now() * this.scale
    this.tweens.tick(time)
    if (!this.tweens.busy && this.idleWaiters.length) {
      const waiting = this.idleWaiters
      this.idleWaiters = []
      for (const resolve of waiting) resolve()
    }
    // A slow breath of camera drift, and the dust turning in the beam.
    const t = time / 1000
    const drift = this.options.reducedMotion ? 0 : 1
    this.camera.lookAt(
      this.look.x + Math.sin(t * 0.21) * 0.04 * drift,
      this.look.y + Math.sin(t * 0.17) * 0.02 * drift,
      this.look.z,
    )
    const positions = this.dust.geometry.getAttribute(
      'position',
    ) as THREE.BufferAttribute
    const arr = positions.array as Float32Array
    for (let i = 0; i < arr.length; i += 3) {
      const phase = i * 0.37
      arr[i] = this.dustBase[i] + Math.sin(t * 0.13 + phase) * 0.25 * drift
      arr[i + 1] =
        this.dustBase[i + 1] + Math.sin(t * 0.09 + phase * 1.3) * 0.18 * drift
      arr[i + 2] =
        this.dustBase[i + 2] + Math.cos(t * 0.11 + phase) * 0.2 * drift
    }
    positions.needsUpdate = true
    // The shaft follows the lamp: its brightness and its colour.
    this.beam.uniforms.time.value = t * drift
    this.beam.uniforms.intensity.value = (this.spot.intensity / SPOT_ON) * 0.05
    ;(this.beam.uniforms.color.value as THREE.Color).copy(this.spot.color)
    if (this.lens) this.lens.render(t)
    else this.renderer.render(this.scene, this.camera)
    this.measure(time)
    this.emitAnchors()
  }

  /**
   * Steps quality down while frames come in slow: a first look after 30
   * frames (a very slow device goes straight to the lowest tier), then every
   * 90. A pinned tier (?stagequality) stays put.
   */
  private measure(time: number) {
    if (this.lastFrame) this.frameTimes.push(time - this.lastFrame)
    this.lastFrame = time
    if (this.pinned || this.frameTimes.length < (this.measured ? 90 : 30))
      return
    this.measured = true
    const sorted = [...this.frameTimes].sort((a, b) => a - b)
    // In wall-clock milliseconds, whatever ?stageslow does to the clock.
    const median = sorted[Math.floor(sorted.length / 2)] / this.scale
    this.frameTimes = []
    if (this.tier > 0 && median > 22) {
      this.tier = median > 45 ? 0 : ((this.tier - 1) as Tier)
      this.applyTier()
      this.resize()
    }
  }

  get quality(): Tier {
    return this.tier
  }

  private applyTier() {
    const shadows = this.tier > 0
    this.renderer.shadowMap.enabled = shadows
    this.spot.castShadow = shadows
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.renderer.setPixelRatio(
      this.tier === 2 ? dpr : this.tier === 1 ? Math.min(dpr, 1.5) : 1,
    )
    // The lens (bloom, grade) from tier 1; multisampled so edges stay clean.
    this.lens?.dispose()
    this.lens =
      this.tier > 0
        ? new Lens(this.renderer, this.scene, this.camera, {
            samples: this.tier === 2 ? 4 : 2,
            bloom: this.tier === 2 ? 0.55 : 0.4,
          })
        : null
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh)
        for (const m of [o.material].flat())
          (m as THREE.Material).needsUpdate = true
    })
    this.dust.visible = this.tier > 0
    this.backdrop.visible = this.tier > 0
    this.canvas.dataset.quality = String(this.tier)
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.lens?.setSize(w, h, this.renderer.getPixelRatio())
    this.camera.aspect = w / h
    // Narrow screens pull back so the whole table fits. Wide ones slide the
    // picture right, leaving the left for the headline.
    this.camera.fov = w / h < 1 ? 56 : 36
    this.wideScreen = w >= 980 && w / h > 1.25
    this.frameShot()
  }

  /** Slides the picture across a wide screen (the headline or card side). */
  private frameShot() {
    const { clientWidth: w, clientHeight: h } = this.canvas
    if (!w || !h) return
    if (this.wideScreen)
      this.camera.setViewOffset(w, h, -w * this.shift, h * 0.02, w, h)
    // Tall screens: lift the table into the middle of the frame.
    else if (w / h < 1) this.camera.setViewOffset(w, h, 0, h * 0.16, w, h)
    else this.camera.clearViewOffset()
    this.camera.updateProjectionMatrix()
  }

  private anchorPoint = new THREE.Vector3()
  private emitAnchors() {
    if (!this.anchorListener || this.frame++ % 2) return
    const { clientWidth: w, clientHeight: h } = this.canvas
    const project = (v: THREE.Vector3) => {
      this.anchorPoint.copy(v).project(this.camera)
      return {
        x: ((this.anchorPoint.x + 1) / 2) * w,
        y: ((1 - this.anchorPoint.y) / 2) * h,
      }
    }
    const top = (bar: THREE.Mesh | undefined, fallback: THREE.Vector3) =>
      bar
        ? project(bar.position.clone().setY(bar.scale.y + 0.12))
        : project(fallback)
    this.anchorListener({
      atlas: project(SPOT.atlasStack.clone().setY(0.6)),
      hero: project(SPOT.heroStack.clone().setY(0.5)),
      pot: project(new THREE.Vector3(SPOT.pot.x + 0.75, 0.05, SPOT.pot.z)),
      equityBar: top(this.bars?.equity, new THREE.Vector3(-0.36, 0, 0.78)),
      priceBar: top(this.bars?.price, new THREE.Vector3(0.36, 0, 0.78)),
    })
  }

  private lost = (event: Event) => {
    event.preventDefault()
    this.options.onFail()
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.canvas.removeEventListener('webglcontextlost', this.lost)
    this.clearCloud()
    this.clearBars()
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) {
        o.geometry.dispose()
        for (const m of [o.material].flat()) (m as THREE.Material).dispose()
      }
      if (o instanceof THREE.Sprite) o.material.dispose()
    })
    this.cardShape.dispose()
    this.chipShape.dispose()
    for (const m of this.chipMaterials.values()) for (const x of m) x.dispose()
    for (const t of this.textures.values()) t.dispose()
    this.lens?.dispose()
    this.environment.dispose()
    this.renderer.dispose()
  }
}
