// The landing page's 3D table (ADR-001): one spotlight over a felt table in
// a dark void, cards dealt from a deck and flipped with weight, chips that
// slide, a camera that moves, and the decision beats (range cloud, grade
// stamp light, slow-motion verdict). React owns the hand; this module only
// shows it. Loaded lazily: three.js never reaches the entry chunk.
import * as THREE from 'three'
import { chipStacks } from '../../lib/chips'
import type { Card, Game } from '../../lib/poker'
import type { RangeEntry } from '../../challenge/score'
import {
  cardBack,
  cardFace,
  comboTexture,
  dotTexture,
  feltTexture,
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
const CARD_T = 0.012
const CHIP_R = 0.15
const CHIP_H = 0.034
const TABLE_X = 4.2
const TABLE_Z = 2.4

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

export type Tier = 0 | 1 | 2
export type StageOptions = {
  /** Called once if WebGL is lost or cannot start: show the 2D table. */
  onFail: () => void
  reducedMotion?: boolean
}
export type AnchorName = 'atlas' | 'hero' | 'pot' | 'equityBar' | 'priceBar'

type CardMesh = THREE.Mesh<THREE.BoxGeometry, THREE.Material[]>

export class Stage {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 80)
  private tweens = new Tweens()
  private spot: THREE.SpotLight
  private rim: THREE.DirectionalLight
  private dust: THREE.Points
  private dustBase: Float32Array
  private textures = new Map<string, THREE.Texture>()
  private back: THREE.Texture
  private cards = new Map<string, CardMesh>()
  private chips = {
    heroBet: new THREE.Group(),
    atlasBet: new THREE.Group(),
    pot: new THREE.Group(),
  }
  private chipValues = { heroBet: 0, atlasBet: 0, pot: 0 }
  private bars: { equity: THREE.Mesh; price: THREE.Mesh } | null = null
  private cloud: THREE.Group | null = null
  private look = RIG.seat.at.clone()
  private frame = 0
  private raf = 0
  private frameTimes: number[] = []
  private lastFrame = 0
  private tier: Tier
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
    const mobile = Math.min(window.innerWidth, window.innerHeight) < 600
    this.tier = mobile ? 1 : 2
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    canvas.addEventListener('webglcontextlost', this.lost)

    this.scene.background = new THREE.Color('#050807')
    this.scene.fog = new THREE.Fog('#050807', 9, 20)
    const anisotropy = Math.min(
      8,
      this.renderer.capabilities.getMaxAnisotropy(),
    )
    this.back = cardBack(anisotropy)
    this.textures.set('back', this.back)

    // Lights: one warm spotlight, a cool rim from behind, a whisper of fill.
    this.spot = new THREE.SpotLight('#fff3dc', 0, 20, 0.7, 0.6, 1.1)
    this.spot.position.set(0, 7.5, 1.2)
    this.spot.target.position.set(0, 0, 0)
    this.spot.shadow.mapSize.set(1024, 1024)
    this.spot.shadow.bias = -0.0004
    this.scene.add(this.spot, this.spot.target)
    this.rim = new THREE.DirectionalLight('#7fb6f0', 0.35)
    this.rim.position.set(-3, 3, -6)
    this.scene.add(
      this.rim,
      new THREE.HemisphereLight('#a9c6b6', '#050807', 0.12),
    )

    this.buildTable(anisotropy)
    for (const group of Object.values(this.chips)) this.scene.add(group)
    this.chips.heroBet.position.copy(SPOT.heroBet)
    this.chips.atlasBet.position.copy(SPOT.atlasBet)
    this.chips.pot.position.copy(SPOT.pot)

    // Dust drifting through the beam.
    const count = this.tier === 2 ? 420 : 160
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
        size: 0.045,
        map: dotTexture(),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        color: '#fff1d6',
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

  private buildTable(anisotropy: number) {
    const felt = new THREE.Mesh(
      new THREE.CircleGeometry(1, 96),
      new THREE.MeshStandardMaterial({
        map: feltTexture(anisotropy),
        roughness: 0.95,
        metalness: 0,
      }),
    )
    felt.rotation.x = -Math.PI / 2
    felt.scale.set(TABLE_X, TABLE_Z, 1)
    felt.receiveShadow = true
    this.scene.add(felt)

    // The leather rail: an elliptical ring, extruded and bevelled.
    const outer = new THREE.Shape()
    outer.absellipse(0, 0, TABLE_X + 0.42, TABLE_Z + 0.42, 0, Math.PI * 2)
    const hole = new THREE.Path()
    hole.absellipse(0, 0, TABLE_X - 0.02, TABLE_Z - 0.02, 0, Math.PI * 2, true)
    outer.holes.push(hole)
    const rail = new THREE.Mesh(
      new THREE.ExtrudeGeometry(outer, {
        depth: 0.16,
        bevelEnabled: true,
        bevelSize: 0.1,
        bevelThickness: 0.1,
        bevelSegments: 6,
        curveSegments: 96,
      }),
      new THREE.MeshStandardMaterial({
        color: '#2a1d16',
        roughness: 0.55,
        metalness: 0.05,
      }),
    )
    rail.rotation.x = -Math.PI / 2
    rail.position.y = -0.05
    rail.castShadow = true
    rail.receiveShadow = true
    this.scene.add(rail)

    // A dark plinth under the table, catching the spill of the spotlight.
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(16, 64),
      new THREE.MeshStandardMaterial({ color: '#0a0f0d', roughness: 1 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -1.6
    floor.receiveShadow = true
    this.scene.add(floor)

    // The deck, a short stack of backs.
    for (let i = 0; i < 6; i++) {
      const card = this.makeCard(null)
      card.position.copy(SPOT.deck).setY(CARD_T / 2 + i * CARD_T)
      card.rotation.set(0, 0.35, Math.PI)
      this.scene.add(card)
    }
  }

  private texture(key: string) {
    let t = this.textures.get(key)
    if (!t) {
      t = cardFace(
        key,
        Math.min(8, this.renderer.capabilities.getMaxAnisotropy()),
      )
      this.textures.set(key, t)
    }
    return t
  }

  /** A card lying face up (rotation.z = 0) or down (π); `null` is a back. */
  private makeCard(face: string | null): CardMesh {
    const edge = new THREE.MeshStandardMaterial({
      color: '#f2efe4',
      roughness: 0.6,
    })
    const front = new THREE.MeshStandardMaterial({
      map: face ? this.texture(face) : this.back,
      roughness: 0.42,
      metalness: 0,
    })
    const back = new THREE.MeshStandardMaterial({
      map: this.back,
      roughness: 0.5,
    })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(CARD_W, CARD_T, CARD_H), [
      edge,
      edge,
      front,
      back,
      edge,
      edge,
    ])
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
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
      for (const card of this.cards.values()) this.scene.remove(card)
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
    // Chips: what each player has in front of them, and the middle.
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
        if (faceUp) card.rotation.z = lerp(Math.PI, 0, easeInOutCubic(p))
      },
      {
        delay,
        ease: easeOutCubic,
        done: () => card.position.setY(CARD_T / 2),
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

  private chipGeometry = new THREE.CylinderGeometry(CHIP_R, CHIP_R, CHIP_H, 28)
  private chipMaterials = new Map<string, THREE.Material[]>()

  private chipMaterial(color: string, stripe: string) {
    let m = this.chipMaterials.get(color)
    if (!m) {
      const side = new THREE.MeshStandardMaterial({
        color: stripe,
        roughness: 0.5,
      })
      const face = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.38,
        metalness: 0.05,
      })
      m = [side, face, face]
      this.chipMaterials.set(color, m)
    }
    return m
  }

  /** Redraws one chip group for `amount`, sliding new chips in from `from`. */
  private setChips(
    which: keyof Stage['chips'],
    amount: number,
    from: THREE.Vector3,
  ) {
    if (this.chipValues[which] === amount) return
    const grew = amount > this.chipValues[which]
    this.chipValues[which] = amount
    const group = this.chips[which]
    group.clear()
    const { stacks } = chipStacks(amount, { maxPerStack: 10, maxStacks: 4 })
    stacks.forEach((stack, s) => {
      for (let i = 0; i < stack.count; i++) {
        const chip = new THREE.Mesh(
          this.chipGeometry,
          this.chipMaterial(
            stack.denomination.color,
            stack.denomination.stripe,
          ),
        )
        chip.position.set(
          (s - (stacks.length - 1) / 2) * CHIP_R * 2.15,
          CHIP_H / 2 + i * CHIP_H,
          (s % 2) * 0.05,
        )
        chip.rotation.y = i * 0.7
        chip.castShadow = true
        chip.receiveShadow = true
        group.add(chip)
      }
    })
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
          group.clear()
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
      this.spot.intensity = lerp(0, 46, p)
      dust.opacity = lerp(0, 0.55, p)
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
        }),
      )
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTex,
          color: tint,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      glow.scale.set(0.6, 0.46, 1)
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
        if (m.map && m.map !== this.back) m.map.dispose()
        m.dispose()
      }
    })
    this.cloud = null
  }

  /** A short beat: the light warms green or cools red, then settles. */
  stamp(good: boolean, onDone: () => void) {
    const now = this.now()
    const base = new THREE.Color('#fff3dc')
    const tint = new THREE.Color(good ? '#b8f5cf' : '#ffb3a8')
    this.tweens.add(
      now,
      900,
      (p) => {
        const k = Math.sin(p * Math.PI)
        this.spot.color.copy(base).lerp(tint, k)
        this.spot.intensity = 46 + k * 18
      },
      { beat: true, ease: linear, done: onDone },
    )
  }

  /**
   * Last decision: time slows, the camera pushes in on the pot, the hero's
   * equity and the price rise out of the felt as two bars, and the light
   * turns with the grade.
   */
  verdict(equity: number, price: number, good: boolean, onDone: () => void) {
    const now = this.now()
    this.clearBars()
    const make = (color: string, x: number) => {
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 1, 0.22),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 1.6,
          transparent: true,
          opacity: 0.92,
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
    this.renderer.render(this.scene, this.camera)
    this.measure(time)
    this.emitAnchors()
  }

  /** Steps quality down while the first frames come in slow. */
  private measure(time: number) {
    if (this.lastFrame) this.frameTimes.push(time - this.lastFrame)
    this.lastFrame = time
    if (this.frameTimes.length < 90) return
    const sorted = [...this.frameTimes].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    this.frameTimes = []
    if (median > 22 && this.tier > 0) {
      this.tier = (this.tier - 1) as Tier
      this.applyTier()
      this.resize()
    }
  }

  get quality(): Tier {
    return this.tier
  }

  private applyTier() {
    const shadows = this.tier === 2
    this.renderer.shadowMap.enabled = shadows
    this.spot.castShadow = shadows
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.renderer.setPixelRatio(
      this.tier === 2 ? dpr : this.tier === 1 ? Math.min(dpr, 1.5) : 1,
    )
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh)
        for (const m of [o.material].flat())
          (m as THREE.Material).needsUpdate = true
    })
    this.dust.visible = this.tier > 0
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
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
      atlas: project(SPOT.atlasStack.clone().setY(0.45)),
      hero: project(SPOT.heroStack.clone().setY(0.2)),
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
    })
    for (const t of this.textures.values()) t.dispose()
    this.renderer.dispose()
  }
}
