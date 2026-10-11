// Artwork for the landing stage, drawn to canvases at runtime so the page
// ships no image assets: card faces with real pip layouts and court panels,
// a guilloché back, the printed felt, leather with stitching, varnished
// wood, chip faces and edges, and soft dots for dust and bokeh. Surface
// relief (the cards' linen finish, felt fibre, leather grain) is drawn as a
// height field and turned into a normal map, so the light rakes across it.
// Everything is deterministic: a seeded generator, never Math.random.
import * as THREE from 'three'
import type { Denomination } from '../../lib/chips'

const RANKS = '23456789TJQKA'
export const RED = '#c3242f'
export const INK = '#141a17'
const GOLD = '#b8923f'
const FONT = "'Manrope', 'DM Sans', system-ui, sans-serif"

/** A card face's design size; textures scale it to their width. */
const FW = 640
const FH = 908

export const rankLabel = (rank: string) => (rank === 'T' ? '10' : rank)
export const isRank = (r: string) => RANKS.includes(r)

function canvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!] as const
}

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
}

function finish(
  c: HTMLCanvasElement,
  anisotropy: number,
  { color = true, repeat = false } = {},
) {
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace
  texture.anisotropy = anisotropy
  if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  return texture
}

/** A small seeded generator (mulberry32), so artwork is the same each load. */
export function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ------------------------------------------------------------------ suits

/** Suit outlines in a 100 × 100 box, drawn as paths (never font glyphs). */
const SUIT_PATH: Record<string, string[]> = {
  h: [
    'M50 93 C46 86 31 73 18 60 C6 48 0 39 0 27 C0 12 11 2 25 2 C36 2 45 9 50 19 C55 9 64 2 75 2 C89 2 100 12 100 27 C100 39 94 48 82 60 C69 73 54 86 50 93 Z',
  ],
  d: [
    'M50 0 C58 16 72 34 88 50 C72 66 58 84 50 100 C42 84 28 66 12 50 C28 34 42 16 50 0 Z',
  ],
  s: [
    'M50 2 C56 14 70 26 84 38 C96 48 100 56 100 65 C100 79 89 89 76 89 C66 89 58 84 54 76 C55 86 59 93 67 98 L33 98 C41 93 45 86 46 76 C42 84 34 89 24 89 C11 89 0 79 0 65 C0 56 4 48 16 38 C30 26 44 14 50 2 Z',
  ],
  c: [
    'M50 2 A22 22 0 1 1 49.9 2 Z',
    'M26 38 A22 22 0 1 1 25.9 38 Z',
    'M74 38 A22 22 0 1 1 73.9 38 Z',
    'M50 36 L34 62 L66 62 Z',
    'M46 62 C46 80 41 90 31 98 L69 98 C59 90 54 80 54 62 Z',
  ],
}
const suitPaths = new Map<string, Path2D[]>()
function pathsFor(suit: string) {
  let p = suitPaths.get(suit)
  if (!p) {
    p = SUIT_PATH[suit].map((d) => new Path2D(d))
    suitPaths.set(suit, p)
  }
  return p
}

export const suitColor = (suit: string) =>
  suit === 'h' || suit === 'd' ? RED : INK

/** One suit symbol centred on (x, y), `size` tall, upside down if `flip`. */
export function drawSuit(
  g: CanvasRenderingContext2D,
  suit: string,
  x: number,
  y: number,
  size: number,
  flip = false,
  fill: string | CanvasGradient = suitColor(suit),
) {
  g.save()
  g.translate(x, y)
  if (flip) g.rotate(Math.PI)
  g.scale(size / 100, size / 100)
  g.translate(-50, -50)
  g.fillStyle = fill
  for (const p of pathsFor(suit)) g.fill(p)
  g.restore()
}

// ------------------------------------------------------------------ cards

/** Pip centres for 2–10 in the face's design space, per standard layouts. */
const L = 196
const C = 320
const R = 444
const TOP = 214
const BOT = 694
const MID = (TOP + BOT) / 2
const Q1 = TOP + (BOT - TOP) / 3
const Q2 = TOP + (2 * (BOT - TOP)) / 3
const PIPS: Record<string, [number, number][]> = {
  '2': [
    [C, TOP],
    [C, BOT],
  ],
  '3': [
    [C, TOP],
    [C, MID],
    [C, BOT],
  ],
  '4': [
    [L, TOP],
    [R, TOP],
    [L, BOT],
    [R, BOT],
  ],
  '5': [
    [L, TOP],
    [R, TOP],
    [C, MID],
    [L, BOT],
    [R, BOT],
  ],
  '6': [
    [L, TOP],
    [R, TOP],
    [L, MID],
    [R, MID],
    [L, BOT],
    [R, BOT],
  ],
  '7': [
    [L, TOP],
    [R, TOP],
    [C, (TOP + MID) / 2],
    [L, MID],
    [R, MID],
    [L, BOT],
    [R, BOT],
  ],
  '8': [
    [L, TOP],
    [R, TOP],
    [C, (TOP + MID) / 2],
    [L, MID],
    [R, MID],
    [C, (MID + BOT) / 2],
    [L, BOT],
    [R, BOT],
  ],
  '9': [
    [L, TOP],
    [R, TOP],
    [L, Q1],
    [R, Q1],
    [C, MID],
    [L, Q2],
    [R, Q2],
    [L, BOT],
    [R, BOT],
  ],
  T: [
    [L, TOP],
    [R, TOP],
    [C, (TOP + Q1) / 2],
    [L, Q1],
    [R, Q1],
    [L, Q2],
    [R, Q2],
    [C, (Q2 + BOT) / 2],
    [L, BOT],
    [R, BOT],
  ],
}

const COURT_NAME: Record<string, string> = { J: 'J', Q: 'Q', K: 'K' }

/** A faint paper grain, tiled, shared by every face. */
let paperTile: HTMLCanvasElement | null = null
function paper() {
  if (paperTile) return paperTile
  const [c, g] = canvas(128, 128)
  const image = g.createImageData(128, 128)
  const rnd = seeded(7)
  for (let i = 0; i < image.data.length; i += 4) {
    const v = 128 + (rnd() - 0.5) * 60
    image.data[i] = image.data[i + 1] = image.data[i + 2] = v
    image.data[i + 3] = 255
  }
  g.putImageData(image, 0, 0)
  paperTile = c
  return c
}

/** A crown, tiara or plume over a court card's medallion. */
function emblem(g: CanvasRenderingContext2D, rank: string, y: number) {
  g.save()
  g.translate(C, y)
  g.fillStyle = GOLD
  g.strokeStyle = '#6e5420'
  g.lineWidth = 2
  g.beginPath()
  if (rank === 'K') {
    g.moveTo(-58, 22)
    g.lineTo(-64, -18)
    g.lineTo(-32, 4)
    g.lineTo(0, -30)
    g.lineTo(32, 4)
    g.lineTo(64, -18)
    g.lineTo(58, 22)
    g.closePath()
  } else if (rank === 'Q') {
    g.moveTo(-56, 20)
    g.quadraticCurveTo(0, -46, 56, 20)
    g.quadraticCurveTo(0, 2, -56, 20)
  } else {
    g.moveTo(-50, 20)
    g.lineTo(0, -26)
    g.lineTo(50, 20)
    g.lineTo(30, 20)
    g.lineTo(0, -4)
    g.lineTo(-30, 20)
    g.closePath()
  }
  g.fill()
  g.stroke()
  for (const x of rank === 'K' ? [-64, 0, 64] : rank === 'Q' ? [0] : []) {
    g.beginPath()
    g.arc(x, rank === 'K' ? (x ? -22 : -34) : -24, 7, 0, Math.PI * 2)
    g.fill()
  }
  g.restore()
}

/**
 * A court card's art: a gilded panel with a sunburst, a medallion bearing
 * the rank in the suit's colour, an emblem above it, and the suit at both
 * ends of the panel.
 */
function court(g: CanvasRenderingContext2D, rank: string, suit: string) {
  const color = suitColor(suit)
  const x = 122
  const y = 150
  const w = FW - 2 * x
  const h = FH - 2 * y
  g.save()
  roundRect(g, x, y, w, h, 18)
  const panel = g.createLinearGradient(0, y, 0, y + h)
  panel.addColorStop(0, '#f6efdc')
  panel.addColorStop(0.5, '#fbf6e8')
  panel.addColorStop(1, '#f6efdc')
  g.fillStyle = panel
  g.fill()
  g.clip()
  // Sunburst rays from the medallion.
  g.translate(C, FH / 2)
  for (let i = 0; i < 48; i++) {
    g.rotate((Math.PI * 2) / 48)
    g.fillStyle = i % 2 ? 'rgba(184,146,63,0.10)' : 'rgba(184,146,63,0.04)'
    g.beginPath()
    g.moveTo(0, 0)
    g.lineTo(-30, -520)
    g.lineTo(30, -520)
    g.closePath()
    g.fill()
  }
  g.restore()
  // Gold double frame.
  g.strokeStyle = GOLD
  g.lineWidth = 5
  roundRect(g, x, y, w, h, 18)
  g.stroke()
  g.lineWidth = 1.6
  roundRect(g, x + 11, y + 11, w - 22, h - 22, 10)
  g.stroke()
  // The medallion.
  const cy = FH / 2
  const disc = g.createRadialGradient(C - 40, cy - 50, 20, C, cy, 150)
  disc.addColorStop(0, suit === 'h' || suit === 'd' ? '#e0444c' : '#3a4440')
  disc.addColorStop(1, color)
  g.fillStyle = disc
  g.beginPath()
  g.arc(C, cy, 138, 0, Math.PI * 2)
  g.fill()
  g.lineWidth = 6
  g.strokeStyle = GOLD
  g.stroke()
  g.lineWidth = 1.5
  g.beginPath()
  g.arc(C, cy, 150, 0, Math.PI * 2)
  g.stroke()
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2
    g.beginPath()
    g.arc(C + Math.cos(a) * 160, cy + Math.sin(a) * 160, 3, 0, Math.PI * 2)
    g.fillStyle = GOLD
    g.fill()
  }
  g.fillStyle = '#fbf3df'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `800 196px ${FONT}`
  g.fillText(COURT_NAME[rank], C, cy + 10)
  emblem(g, rank, cy - 208)
  g.save()
  g.translate(C, cy)
  g.rotate(Math.PI)
  g.translate(-C, -cy)
  emblem(g, rank, cy - 208)
  g.restore()
  drawSuit(g, suit, C, y + 64, 64)
  drawSuit(g, suit, C, y + h - 64, 64, true)
}

/** An ace: one large pip inside a fine gilded ring. */
function ace(g: CanvasRenderingContext2D, suit: string) {
  const cy = FH / 2
  g.strokeStyle = 'rgba(184,146,63,0.75)'
  g.lineWidth = 3
  g.beginPath()
  g.arc(C, cy, 214, 0, Math.PI * 2)
  g.stroke()
  g.lineWidth = 1.2
  g.setLineDash([2, 7])
  g.beginPath()
  g.arc(C, cy, 200, 0, Math.PI * 2)
  g.stroke()
  g.setLineDash([])
  const big = suit === 's' ? 300 : 260
  drawSuit(g, suit, C, cy, big)
  // A soft highlight on the pip, as if varnished.
  g.save()
  g.globalCompositeOperation = 'source-atop'
  const shine = g.createLinearGradient(C - 150, cy - 150, C + 150, cy + 150)
  shine.addColorStop(0, 'rgba(255,255,255,0.18)')
  shine.addColorStop(0.5, 'rgba(255,255,255,0)')
  g.fillStyle = shine
  g.fillRect(C - 160, cy - 160, 320, 320)
  g.restore()
}

/** One card face, e.g. 'Ah', drawn into (x, y, w, h) of `g`. */
export function drawFace(
  g: CanvasRenderingContext2D,
  code: string,
  x = 0,
  y = 0,
  w = FW,
  h = FH,
) {
  const rank = code[0]
  const suit = code[1]
  const label = rankLabel(rank)
  const color = suitColor(suit)
  g.save()
  g.translate(x, y)
  g.scale(w / FW, h / FH)
  // The whole rect is paper (the geometry rounds the corners), so filtered
  // edges never pick up a dark fringe.
  g.fillStyle = '#f3eee2'
  g.fillRect(0, 0, FW, FH)
  const tone = g.createLinearGradient(0, 0, FW, FH)
  tone.addColorStop(0, 'rgba(255,255,255,0.6)')
  tone.addColorStop(1, 'rgba(214,200,170,0.22)')
  g.fillStyle = tone
  g.fillRect(0, 0, FW, FH)
  g.save()
  g.globalAlpha = 0.05
  g.fillStyle = g.createPattern(paper(), 'repeat')!
  g.fillRect(0, 0, FW, FH)
  g.restore()

  // Indices, top left and (turned) bottom right.
  const index = () => {
    g.fillStyle = color
    g.textAlign = 'center'
    g.textBaseline = 'alphabetic'
    g.font = `800 ${label.length > 1 ? 92 : 108}px ${FONT}`
    if ('letterSpacing' in g)
      (
        g as CanvasRenderingContext2D & { letterSpacing: string }
      ).letterSpacing = label.length > 1 ? '-8px' : '0px'
    g.fillText(label, 68, 122)
    drawSuit(g, suit, 68, 176, 58)
  }
  index()
  g.save()
  g.translate(FW, FH)
  g.rotate(Math.PI)
  index()
  g.restore()

  if (rank === 'A') ace(g, suit)
  else if (COURT_NAME[rank]) court(g, rank, suit)
  else
    for (const [px, py] of PIPS[rank])
      drawSuit(g, suit, px, py, 116, py > MID + 1)
  g.restore()
}

/** One card face texture, e.g. 'Ah'. Portrait, `width` wide (5:7). */
export function cardFace(code: string, anisotropy = 4, width = FW) {
  const [c, g] = canvas(width, Math.round((width * FH) / FW))
  drawFace(g, code, 0, 0, c.width, c.height)
  return finish(c, anisotropy)
}

/**
 * The back: a deep green panel inside a white border, covered in a fine lace
 * of gilded rosettes over a diamond lattice, with an oval frame and a
 * medallion bearing the spade. Symmetric under a half turn, as a real back is.
 */
export function cardBack(anisotropy = 4, width = FW) {
  const [c, g] = canvas(width, Math.round((width * FH) / FW))
  g.scale(c.width / FW, c.height / FH)
  g.fillStyle = '#f4efe3'
  g.fillRect(0, 0, FW, FH)
  const px = 32
  const cx = FW / 2
  const cy = FH / 2
  roundRect(g, px, px, FW - 2 * px, FH - 2 * px, 24)
  const inner = g.createRadialGradient(cx, cy, 40, cx, cy, FH * 0.62)
  inner.addColorStop(0, '#1f6149')
  inner.addColorStop(1, '#0e3427')
  g.fillStyle = inner
  g.fill()
  g.save()
  g.clip()
  // A diamond lattice of hairlines.
  g.strokeStyle = 'rgba(214,232,180,0.10)'
  g.lineWidth = 1.2
  for (let i = -FH; i < FW + FH; i += 22) {
    g.beginPath()
    g.moveTo(i, 0)
    g.lineTo(i + FH, FH)
    g.moveTo(i + FH, 0)
    g.lineTo(i, FH)
    g.stroke()
  }
  // Rosettes at every other crossing: six petals and a seed.
  g.strokeStyle = 'rgba(232,214,156,0.30)'
  g.fillStyle = 'rgba(232,214,156,0.45)'
  g.lineWidth = 1.3
  const step = 44
  for (let y = px - step; y < FH + step; y += step / 2)
    for (let x = px - step; x < FW + step; x += step) {
      const ox = (Math.round((y - px) / (step / 2)) % 2) * (step / 2)
      const rx = x + ox
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2
        g.beginPath()
        g.arc(rx + Math.cos(a) * 7, y + Math.sin(a) * 7, 7, 0, Math.PI * 2)
        g.stroke()
      }
      g.beginPath()
      g.arc(rx, y, 2, 0, Math.PI * 2)
      g.fill()
    }
  // The oval frame: a dark field for the medallion, ringed in gold.
  g.fillStyle = 'rgba(10,40,30,0.45)'
  g.beginPath()
  g.ellipse(cx, cy, 150, 220, 0, 0, Math.PI * 2)
  g.fill()
  g.strokeStyle = 'rgba(226,206,140,0.85)'
  g.lineWidth = 3
  g.stroke()
  g.lineWidth = 1.2
  g.beginPath()
  g.ellipse(cx, cy, 140, 210, 0, 0, Math.PI * 2)
  g.stroke()
  // A ring of guilloché around the medallion.
  g.strokeStyle = 'rgba(226,214,160,0.22)'
  g.lineWidth = 1
  for (let k = 0; k < 9; k++) {
    const phase = (k / 9) * Math.PI * 2
    g.beginPath()
    for (let i = 0; i <= 480; i++) {
      const t = (i / 480) * Math.PI * 2
      const r = 1 + 0.09 * Math.sin(20 * t + phase)
      const x = cx + 104 * r * Math.cos(t)
      const y = cy + 150 * r * Math.sin(t)
      if (i) g.lineTo(x, y)
      else g.moveTo(x, y)
    }
    g.stroke()
  }
  g.restore()
  // Gold frame lines just inside the panel.
  g.strokeStyle = 'rgba(226,200,128,0.85)'
  g.lineWidth = 2.5
  roundRect(g, px + 14, px + 14, FW - 2 * px - 28, FH - 2 * px - 28, 14)
  g.stroke()
  g.lineWidth = 1
  roundRect(g, px + 22, px + 22, FW - 2 * px - 44, FH - 2 * px - 44, 10)
  g.stroke()
  // The medallion.
  g.fillStyle = '#0b2c21'
  g.beginPath()
  g.arc(cx, cy, 64, 0, Math.PI * 2)
  g.fill()
  g.strokeStyle = 'rgba(232,212,146,0.95)'
  g.lineWidth = 3
  g.stroke()
  const gold = g.createLinearGradient(cx - 40, cy - 40, cx + 40, cy + 40)
  gold.addColorStop(0, '#f6e7b0')
  gold.addColorStop(1, '#b48a3c')
  drawSuit(g, 's', cx, cy, 70, false, gold)
  // Small spades at the frame's corners, turned for the half-turn symmetry.
  for (const [x, y, flip] of [
    [px + 52, px + 52, false],
    [FW - px - 52, px + 52, false],
    [px + 52, FH - px - 52, true],
    [FW - px - 52, FH - px - 52, true],
  ] as const)
    drawSuit(g, 's', x, y, 30, flip, 'rgba(232,212,146,0.8)')
  return finish(c, anisotropy)
}

/** Two small cards side by side, for one hand in Atlas's range cloud. */
export function comboTexture(cards: string) {
  const [c, g] = canvas(368, 260)
  g.clearRect(0, 0, 368, 260)
  for (const [i, code] of [cards.slice(0, 2), cards.slice(2)].entries()) {
    const x = 6 + i * 182
    g.save()
    roundRect(g, x, 6, 176, 248, 16)
    g.clip()
    g.fillStyle = '#fbf8f1'
    g.fillRect(x, 6, 176, 248)
    const suit = code[1]
    g.fillStyle = suitColor(suit)
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.font = `800 92px ${FONT}`
    g.fillText(rankLabel(code[0]), x + 88, 92)
    drawSuit(g, suit, x + 88, 186, 74)
    g.restore()
  }
  return finish(c, 1)
}

// ------------------------------------------------------------- relief

/**
 * A tangent-space normal map from a tiling height field (0..1), sampled
 * with wrap-around so the tile has no seam.
 */
function normalMap(
  height: Float32Array,
  w: number,
  h: number,
  strength: number,
  anisotropy: number,
) {
  const [c, g] = canvas(w, h)
  const image = g.createImageData(w, h)
  const at = (x: number, y: number) => height[((y + h) % h) * w + ((x + w) % w)]
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength
      const inv = 1 / Math.hypot(dx, dy, 1)
      const i = (y * w + x) * 4
      image.data[i] = (-dx * inv * 0.5 + 0.5) * 255
      image.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255
      image.data[i + 2] = (inv * 0.5 + 0.5) * 255
      image.data[i + 3] = 255
    }
  g.putImageData(image, 0, 0)
  return finish(c, anisotropy, { color: false, repeat: true })
}

/** Tiling value noise: `period` cells across, smoothly interpolated. */
function valueNoise(period: number, seed: number) {
  const rnd = seeded(seed)
  const grid = Array.from({ length: period * period }, rnd)
  const cell = (x: number, y: number) =>
    grid[
      (((y % period) + period) % period) * period +
        (((x % period) + period) % period)
    ]
  return (u: number, v: number) => {
    const x = u * period
    const y = v * period
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const a = cell(x0, y0) + (cell(x0 + 1, y0) - cell(x0, y0)) * sx
    const b = cell(x0, y0 + 1) + (cell(x0 + 1, y0 + 1) - cell(x0, y0 + 1)) * sx
    return a + (b - a) * sy
  }
}

/** The cards' linen (air-cushion) finish: a fine regular dimple. */
export function linenNormal(anisotropy = 4) {
  const n = 128
  const height = new Float32Array(n * n)
  const rnd = seeded(11)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const weave =
        Math.sin((x / 4) * Math.PI) * Math.sin((y / 4) * Math.PI) * 0.5 + 0.5
      height[y * n + x] = weave * 0.8 + rnd() * 0.2
    }
  return normalMap(height, n, n, 0.9, anisotropy)
}

/** Felt fibre: many short strokes in every direction, softened. */
export function feltNormal(anisotropy = 4) {
  const n = 256
  const [, g] = canvas(n, n)
  g.fillStyle = '#808080'
  g.fillRect(0, 0, n, n)
  const rnd = seeded(23)
  g.lineCap = 'round'
  for (let i = 0; i < 5200; i++) {
    const x = rnd() * n
    const y = rnd() * n
    const a = rnd() * Math.PI * 2
    const len = 3 + rnd() * 9
    g.strokeStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)'
    g.lineWidth = 0.6 + rnd() * 0.8
    for (const ox of [-n, 0, n])
      for (const oy of [-n, 0, n]) {
        if (Math.abs(x + ox - n / 2) > n || Math.abs(y + oy - n / 2) > n)
          continue
        g.beginPath()
        g.moveTo(x + ox, y + oy)
        g.lineTo(x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len)
        g.stroke()
      }
  }
  const data = g.getImageData(0, 0, n, n).data
  const height = new Float32Array(n * n)
  for (let i = 0; i < n * n; i++) height[i] = data[i * 4] / 255
  return normalMap(height, n, n, 3.2, anisotropy)
}

/** Leather: a pebble grain (cellular noise) with fine creases. */
export function leatherNormal(anisotropy = 4) {
  const n = 256
  const cells = 16
  const size = n / cells
  const rnd = seeded(31)
  const points = Array.from({ length: cells * cells }, () => [
    rnd() * size,
    rnd() * size,
  ])
  const crease = valueNoise(8, 37)
  const height = new Float32Array(n * n)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const cx = Math.floor(x / size)
      const cy = Math.floor(y / size)
      let best = Infinity
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const gx = cx + i
          const gy = cy + j
          const p =
            points[((gy + cells) % cells) * cells + ((gx + cells) % cells)]
          const d = Math.hypot(gx * size + p[0] - x, gy * size + p[1] - y)
          if (d < best) best = d
        }
      const pebble = 1 - Math.min(1, best / (size * 0.75))
      height[y * n + x] = Math.sqrt(pebble) * 0.8 + crease(x / n, y / n) * 0.2
    }
  return normalMap(height, n, n, 1.6, anisotropy)
}

// --------------------------------------------------------------- table

/**
 * The felt as printed: an even cloth green with a gentle mottle, the
 * betting line, and the wordmark between two spades. Its aspect matches the
 * table's, so the print is not stretched.
 */
export function feltTexture(anisotropy = 4, width = 2048) {
  const w = width
  const h = Math.round(width / 1.75)
  const [c, g] = canvas(w, h)
  const cloth = g.createRadialGradient(
    w / 2,
    h / 2,
    h * 0.1,
    w / 2,
    h / 2,
    w * 0.56,
  )
  cloth.addColorStop(0, '#227056')
  cloth.addColorStop(0.7, '#1b5b46')
  cloth.addColorStop(1, '#13402f')
  g.fillStyle = cloth
  g.fillRect(0, 0, w, h)
  // A slow mottle, as real cloth is never one flat colour: drawn small and
  // laid over the cloth smoothly enlarged.
  const mw = 384
  const mh = Math.round(mw / 1.75)
  const [m, mg] = canvas(mw, mh)
  const mottle = valueNoise(12, 5)
  const fine = valueNoise(64, 9)
  const spots = mg.createImageData(mw, mh)
  for (let y = 0; y < mh; y++)
    for (let x = 0; x < mw; x++) {
      const i = (y * mw + x) * 4
      const v =
        128 +
        (mottle(x / mw, y / mh) - 0.5) * 70 +
        (fine(x / mw, y / mh) - 0.5) * 26
      spots.data[i] = spots.data[i + 1] = spots.data[i + 2] = v
      spots.data[i + 3] = 255
    }
  mg.putImageData(spots, 0, 0)
  g.save()
  g.globalCompositeOperation = 'overlay'
  g.globalAlpha = 0.35
  g.imageSmoothingQuality = 'high'
  g.drawImage(m, 0, 0, w, h)
  g.restore()
  const k = w / 1024
  // The betting line: a double line in pale ink, slightly worn.
  g.strokeStyle = 'rgba(236,226,188,0.34)'
  g.lineWidth = 3 * k
  g.beginPath()
  g.ellipse(w / 2, h / 2, w * 0.322, h * 0.5 * 0.5, 0, 0, Math.PI * 2)
  g.stroke()
  g.strokeStyle = 'rgba(236,226,188,0.16)'
  g.lineWidth = 1.2 * k
  g.beginPath()
  g.ellipse(
    w / 2,
    h / 2,
    w * 0.322 + 9 * k,
    h * 0.25 + 9 * k,
    0,
    0,
    Math.PI * 2,
  )
  g.stroke()
  // The wordmark, screen-printed: low contrast, letter-spaced.
  g.fillStyle = 'rgba(236,244,230,0.13)'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `800 ${30 * k}px ${FONT}`
  if ('letterSpacing' in g)
    (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      `${12 * k}px`
  const ty = h * 0.35
  g.fillText('DELTADECK', w / 2 + 6 * k, ty)
  const ink = 'rgba(236,244,230,0.13)'
  drawSuit(g, 's', w / 2 - 190 * k, ty, 24 * k, false, ink)
  drawSuit(g, 's', w / 2 + 196 * k, ty, 24 * k, false, ink)
  return finish(c, anisotropy)
}

/**
 * Varnished wood for the racetrack, one tile along its length: dark
 * mahogany with a long, wavering grain.
 */
export function woodTexture(anisotropy = 4) {
  const w = 1024
  const h = 128
  const [c, g] = canvas(w, h)
  const image = g.createImageData(w, h)
  const warp = valueNoise(6, 41)
  const fibre = valueNoise(96, 43)
  const pore = valueNoise(256, 47)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x / w
      const v = y / h
      // Long rings along the board, gently wavering, with fine fibres and
      // pores between them.
      const ring = Math.sin((v * 14 + warp(u, v * 0.25) * 1.4) * Math.PI * 2)
      const grain = ring * 0.5 + 0.5
      const t =
        Math.pow(grain, 3) * 0.55 +
        fibre(u * 0.25, v * 4) * 0.3 +
        pore(u, v) * 0.15
      const i = (y * w + x) * 4
      image.data[i] = 118 - t * 62
      image.data[i + 1] = 56 - t * 30
      image.data[i + 2] = 30 - t * 16
      image.data[i + 3] = 255
    }
  g.putImageData(image, 0, 0)
  return finish(c, anisotropy, { repeat: true })
}

/**
 * The rail's leather, one tile along its length (v runs across the
 * cushion): deep oxblood with two rows of saddle stitching.
 */
export function leatherTexture(anisotropy = 4, stitchRows = [0.16, 0.8]) {
  const w = 512
  const h = 256
  const [c, g] = canvas(w, h)
  g.fillStyle = '#3d2117'
  g.fillRect(0, 0, w, h)
  const tone = valueNoise(8, 53)
  const image = g.getImageData(0, 0, w, h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const m = (tone(x / w, y / h) - 0.5) * 18
      image.data[i] += m
      image.data[i + 1] += m * 0.6
      image.data[i + 2] += m * 0.5
    }
  g.putImageData(image, 0, 0)
  for (const row of stitchRows) {
    const y = (1 - row) * h
    // A pressed channel, then the thread.
    g.fillStyle = 'rgba(0,0,0,0.35)'
    g.fillRect(0, y - 5, w, 10)
    for (let x = 4; x < w; x += 22) {
      g.fillStyle = '#0e0705'
      g.fillRect(x - 2, y - 3, 3, 6)
      g.fillStyle = '#bb955c'
      g.save()
      g.translate(x + 8, y)
      g.rotate(-0.18)
      roundRect(g, -7, -2.6, 14, 5.2, 2.6)
      g.fill()
      g.fillStyle = 'rgba(255,240,210,0.45)'
      g.fillRect(-5, -2.2, 10, 1.4)
      g.restore()
    }
  }
  return finish(c, anisotropy, { repeat: true })
}

// --------------------------------------------------------------- chips

/** How many edge spots a chip carries, on its face and around its side. */
export const CHIP_SPOTS = 6
const SPOT_SPAN = 0.42

const shade = (hex: string, amount: number) => {
  const c = new THREE.Color(hex)
  return `#${(amount > 0 ? c.lerp(new THREE.Color('#ffffff'), amount) : c.lerp(new THREE.Color('#000000'), -amount)).getHexString()}`
}

/**
 * A chip's face: edge spots matching the side's, a dashed ring, and a
 * cream inlay with the value and the house name around it. The spots sit
 * at the angles where the side's stripes are (see geometry.ts).
 */
export function chipFace(d: Denomination, anisotropy = 4) {
  const n = 512
  const [c, g] = canvas(n, n)
  const r = n / 2
  g.fillStyle = d.color
  g.fillRect(0, 0, n, n)
  const body = g.createRadialGradient(r * 0.7, r * 0.7, r * 0.1, r, r, r)
  body.addColorStop(0, shade(d.color, 0.12))
  body.addColorStop(1, shade(d.color, -0.08))
  g.fillStyle = body
  g.beginPath()
  g.arc(r, r, r, 0, Math.PI * 2)
  g.fill()
  g.translate(r, r)
  for (let k = 0; k < CHIP_SPOTS; k++) {
    const centre = Math.PI / 2 - ((k + 0.5) / CHIP_SPOTS) * Math.PI * 2
    const span = (SPOT_SPAN / CHIP_SPOTS) * Math.PI * 2
    g.fillStyle = d.stripe
    g.beginPath()
    g.arc(0, 0, r * 1.02, centre - span / 2, centre + span / 2)
    g.arc(0, 0, r * 0.78, centre + span / 2, centre - span / 2, true)
    g.closePath()
    g.fill()
    // Three fine bars of the body colour across each spot.
    g.strokeStyle = d.color
    g.lineWidth = 3
    for (const f of [-0.25, 0, 0.25]) {
      const a = centre + f * span
      g.beginPath()
      g.moveTo(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8)
      g.lineTo(Math.cos(a) * r, Math.sin(a) * r)
      g.stroke()
    }
  }
  g.setLineDash([10, 9])
  g.strokeStyle = shade(d.stripe, -0.05)
  g.globalAlpha = 0.7
  g.lineWidth = 4
  g.beginPath()
  g.arc(0, 0, r * 0.72, 0, Math.PI * 2)
  g.stroke()
  g.setLineDash([])
  g.globalAlpha = 1
  // The inlay.
  const light = d.value === 1
  const inlay = g.createRadialGradient(-r * 0.2, -r * 0.2, 4, 0, 0, r * 0.62)
  inlay.addColorStop(0, light ? '#eaf1fb' : '#fbf7ec')
  inlay.addColorStop(1, light ? '#cad9ee' : '#e8dfc8')
  g.fillStyle = inlay
  g.beginPath()
  g.arc(0, 0, r * 0.6, 0, Math.PI * 2)
  g.fill()
  g.strokeStyle = GOLD
  g.lineWidth = 3
  g.stroke()
  g.lineWidth = 1.2
  g.beginPath()
  g.arc(0, 0, r * 0.53, 0, Math.PI * 2)
  g.stroke()
  const ink = light ? d.stripe : d.color
  g.fillStyle = ink
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `800 ${d.value >= 100 ? 92 : 112}px ${FONT}`
  g.fillText(String(d.value), 0, 6)
  g.font = `700 22px ${FONT}`
  const word = 'DELTADECK · PLAY MONEY · '
  const step = (Math.PI * 2) / word.length
  for (let i = 0; i < word.length; i++) {
    g.save()
    g.rotate(i * step - Math.PI / 2)
    g.translate(0, -r * 0.44)
    g.fillText(word[i], 0, 0)
    g.restore()
  }
  return finish(c, anisotropy)
}

/** A chip's side, once around (u) and across its edge (v). */
export function chipEdge(d: Denomination, anisotropy = 4) {
  const w = 512
  const h = 32
  const [c, g] = canvas(w, h)
  g.fillStyle = d.color
  g.fillRect(0, 0, w, h)
  for (let k = 0; k < CHIP_SPOTS; k++) {
    const centre = ((k + 0.5) / CHIP_SPOTS) * w
    const span = (SPOT_SPAN / CHIP_SPOTS) * w
    g.fillStyle = d.stripe
    g.fillRect(centre - span / 2, 0, span, h)
    g.fillStyle = d.color
    for (const f of [-0.25, 0, 0.25])
      g.fillRect(centre + f * span - 1.5, 0, 3, h)
  }
  return finish(c, anisotropy)
}

// --------------------------------------------------------------- light

/** A soft round dot, for dust and glows. */
export function dotTexture() {
  const [c, g] = canvas(64, 64)
  const dot = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  dot.addColorStop(0, 'rgba(255,255,255,1)')
  dot.addColorStop(0.35, 'rgba(255,255,255,0.45)')
  dot.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = dot
  g.fillRect(0, 0, 64, 64)
  return finish(c, 1)
}

/** An out-of-focus highlight: a disc with a brighter rim, as a lens draws it. */
export function bokehTexture() {
  const [c, g] = canvas(128, 128)
  const disc = g.createRadialGradient(64, 64, 0, 64, 64, 62)
  disc.addColorStop(0, 'rgba(255,255,255,0.55)')
  disc.addColorStop(0.82, 'rgba(255,255,255,0.7)')
  disc.addColorStop(0.92, 'rgba(255,255,255,0.95)')
  disc.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = disc
  g.fillRect(0, 0, 128, 128)
  return finish(c, 1)
}
