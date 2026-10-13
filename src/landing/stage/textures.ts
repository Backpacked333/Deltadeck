// Artwork for the landing stage, drawn to canvases at runtime so the page
// ships no image assets: card faces and the back, the felt, the leather
// rail, Atlas's range cards, and the soft dot used by the dust.
import * as THREE from 'three'

const RANKS = '23456789TJQKA'
const SUIT_GLYPH: Record<string, string> = {
  s: '♠',
  h: '♥',
  d: '♦',
  c: '♣',
}
const RED = '#c0392f'
const INK = '#1d2a24'
const FONT = "'Manrope', 'DM Sans', system-ui, sans-serif"

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

function finish(c: HTMLCanvasElement, anisotropy: number) {
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = anisotropy
  return texture
}

export const rankLabel = (rank: string) => (rank === 'T' ? '10' : rank)

/** One card face, e.g. 'Ah'. Portrait, 256 × 358. */
export function cardFace(code: string, anisotropy = 4) {
  const [c, g] = canvas(256, 358)
  const rank = rankLabel(code[0])
  const suit = code[1]
  const color = suit === 'h' || suit === 'd' ? RED : INK
  g.fillStyle = '#fffdf6'
  roundRect(g, 0, 0, 256, 358, 22)
  g.fill()
  // A faint paper grain, so the face catches the light.
  const grain = g.createLinearGradient(0, 0, 256, 358)
  grain.addColorStop(0, 'rgba(255,255,255,0)')
  grain.addColorStop(1, 'rgba(120,100,60,0.08)')
  g.fillStyle = grain
  g.fill()
  g.fillStyle = color
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `800 ${rank.length > 1 ? 58 : 66}px ${FONT}`
  g.fillText(rank, 46, 52)
  g.font = `400 46px ${FONT}`
  g.fillText(SUIT_GLYPH[suit], 46, 106)
  g.save()
  g.translate(210, 306)
  g.rotate(Math.PI)
  g.font = `800 ${rank.length > 1 ? 58 : 66}px ${FONT}`
  g.fillText(rank, 0, 0)
  g.font = `400 46px ${FONT}`
  g.fillText(SUIT_GLYPH[suit], 0, 54)
  g.restore()
  g.font = `400 150px ${FONT}`
  g.fillText(SUIT_GLYPH[suit], 128, 196)
  return finish(c, anisotropy)
}

/** The back: deep green with a fine lattice and the brand mark. */
export function cardBack(anisotropy = 4) {
  const [c, g] = canvas(256, 358)
  g.fillStyle = '#fffdf6'
  roundRect(g, 0, 0, 256, 358, 22)
  g.fill()
  const inner = g.createLinearGradient(0, 0, 256, 358)
  inner.addColorStop(0, '#2b6e57')
  inner.addColorStop(1, '#123c2f')
  g.fillStyle = inner
  roundRect(g, 14, 14, 228, 330, 14)
  g.fill()
  g.strokeStyle = 'rgba(196,230,168,0.18)'
  g.lineWidth = 2
  for (let i = -360; i < 600; i += 22) {
    g.beginPath()
    g.moveTo(i, 14)
    g.lineTo(i + 330, 344)
    g.moveTo(i + 330, 14)
    g.lineTo(i, 344)
    g.stroke()
  }
  g.fillStyle = 'rgba(196,230,168,0.9)'
  g.font = `400 64px ${FONT}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText('♠', 128, 179)
  return finish(c, anisotropy)
}

/** The felt: a lit radial gradient, fine grain and a printed brand ring. */
export function feltTexture(anisotropy = 4) {
  const [c, g] = canvas(1024, 600)
  const glow = g.createRadialGradient(512, 300, 40, 512, 300, 560)
  glow.addColorStop(0, '#2c7a5f')
  glow.addColorStop(0.55, '#1c4e3d')
  glow.addColorStop(1, '#0d2a20')
  g.fillStyle = glow
  g.fillRect(0, 0, 1024, 600)
  const image = g.getImageData(0, 0, 1024, 600)
  // Deterministic grain (no Math.random), a cheap hash per pixel.
  for (let i = 0; i < image.data.length; i += 4) {
    const n = ((((i * 2654435761) >>> 0) % 1000) / 1000 - 0.5) * 14
    image.data[i] += n
    image.data[i + 1] += n
    image.data[i + 2] += n
  }
  g.putImageData(image, 0, 0)
  g.strokeStyle = 'rgba(233,243,236,0.10)'
  g.lineWidth = 3
  g.beginPath()
  g.ellipse(512, 300, 330, 150, 0, 0, Math.PI * 2)
  g.stroke()
  g.fillStyle = 'rgba(233,243,236,0.13)'
  g.font = `800 30px ${FONT}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText('Q U A N T P O K E R', 512, 210)
  return finish(c, anisotropy)
}

/** Two small cards side by side, for one hand in Atlas's range cloud. */
export function comboTexture(cards: string) {
  const [c, g] = canvas(176, 124)
  for (const [i, code] of [cards.slice(0, 2), cards.slice(2)].entries()) {
    const x = 4 + i * 86
    const suit = code[1]
    g.fillStyle = '#fffdf6'
    roundRect(g, x, 4, 82, 116, 10)
    g.fill()
    g.fillStyle = suit === 'h' || suit === 'd' ? RED : INK
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.font = `800 40px ${FONT}`
    g.fillText(rankLabel(code[0]), x + 41, 44)
    g.font = `400 36px ${FONT}`
    g.fillText(SUIT_GLYPH[suit], x + 41, 88)
  }
  return finish(c, 1)
}

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

export const isRank = (r: string) => RANKS.includes(r)
