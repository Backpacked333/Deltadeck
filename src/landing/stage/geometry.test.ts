// The stage's own shapes: which way their faces point decides whether the
// GPU draws them at all (back faces are culled), so a wrong winding shows
// a table inside out. Checked here without a GPU.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  cardGeometry,
  chipGeometry,
  cushionProfile,
  sweepGeometry,
} from './geometry'

/** The geometric normal of each triangle in `group` (or all), by winding. */
function faceNormals(geometry: THREE.BufferGeometry, group?: number) {
  const index = geometry.getIndex()!
  const pos = geometry.getAttribute('position')
  const { start, count } =
    group === undefined
      ? { start: 0, count: index.count }
      : geometry.groups[group]
  const out: { normal: THREE.Vector3; centre: THREE.Vector3 }[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  for (let i = start; i < start + count; i += 3) {
    a.fromBufferAttribute(pos, index.getX(i))
    b.fromBufferAttribute(pos, index.getX(i + 1))
    c.fromBufferAttribute(pos, index.getX(i + 2))
    const centre = a.clone().add(b).add(c).divideScalar(3)
    const normal = b.clone().sub(a).cross(c.clone().sub(a))
    if (normal.lengthSq() > 1e-14)
      out.push({ normal: normal.normalize(), centre })
  }
  return out
}

describe('cardGeometry', () => {
  const card = cardGeometry(0.62, 0.88, 0.01, 0.036)

  it('has a face up, a back down and an edge facing out', () => {
    expect(card.groups.map((g) => g.materialIndex)).toEqual([0, 1, 2])
    for (const { normal } of faceNormals(card, 0))
      expect(normal.y).toBeCloseTo(1)
    for (const { normal } of faceNormals(card, 1))
      expect(normal.y).toBeCloseTo(-1)
    for (const { normal, centre } of faceNormals(card, 2)) {
      expect(Math.abs(normal.y)).toBeLessThan(1e-6)
      expect(normal.x * centre.x + normal.z * centre.z).toBeGreaterThan(0)
    }
  })

  it('maps the face like a box top: the texture reads upright from the hero', () => {
    const pos = card.getAttribute('position')
    const uv = card.getAttribute('uv')
    const { start, count } = card.groups[0]
    const index = card.getIndex()!
    for (let i = start; i < start + count; i++) {
      const v = index.getX(i)
      expect(uv.getX(v)).toBeCloseTo((pos.getX(v) + 0.31) / 0.62)
      // The top of the texture (v = 1) is the far edge (−z).
      expect(uv.getY(v)).toBeCloseTo((0.44 - pos.getZ(v)) / 0.88)
    }
  })

  it('rounds its corners inside the card', () => {
    card.computeBoundingBox()
    const box = card.boundingBox!
    expect(box.max.x).toBeCloseTo(0.31)
    expect(box.max.z).toBeCloseTo(0.44)
    const pos = card.getAttribute('position')
    for (let i = 0; i < pos.count; i++)
      // No vertex sits in the square corner the rounding cuts off.
      expect(
        Math.hypot(
          Math.max(0, Math.abs(pos.getX(i)) - (0.31 - 0.036)),
          Math.max(0, Math.abs(pos.getZ(i)) - (0.44 - 0.036)),
        ),
      ).toBeLessThanOrEqual(0.036 + 1e-6)
  })
})

describe('sweepGeometry', () => {
  it('faces outward and up, so the rail is not drawn inside out', () => {
    const rail = sweepGeometry(4.2, 2.4, cushionProfile(0.5, 0.25), {
      segments: 64,
    })
    let up = 0
    let down = 0
    for (const { normal, centre } of faceNormals(rail)) {
      if (centre.y <= 0.2) continue
      if (normal.y > 0) up++
      else down++
    }
    // The cushion's crown is all upward-facing.
    expect(up).toBeGreaterThan(0)
    expect(down).toBe(0)
    // Vertex normals agree with the winding.
    const normals = rail.getAttribute('normal')
    const pos = rail.getAttribute('position')
    for (let i = 0; i < pos.count; i++)
      if (pos.getY(i) > 0.24) expect(normals.getY(i)).toBeGreaterThan(0.5)
  })

  it('repeats u around the ellipse and spans v across the profile', () => {
    const track = sweepGeometry(
      1,
      1,
      [
        [0, 0],
        [0.1, 0.02],
      ],
      { segments: 8, repeat: 4 },
    )
    const uv = track.getAttribute('uv')
    let maxU = 0
    for (let i = 0; i < uv.count; i++) maxU = Math.max(maxU, uv.getX(i))
    expect(maxU).toBeCloseTo(4)
    expect(uv.getY(0)).toBe(0)
    expect(uv.getY(1)).toBe(1)
  })
})

describe('cushionProfile', () => {
  it('rises from the inside edge to its crown and tucks under the outside', () => {
    const profile = cushionProfile(0.5, 0.25)
    expect(profile[0]).toEqual([0, 0.02])
    expect(Math.max(...profile.map(([, y]) => y))).toBeCloseTo(0.25)
    expect(profile.at(-1)![1]).toBeLessThan(0)
  })
})

describe('chipGeometry', () => {
  const chip = chipGeometry(0.16, 0.032, 0.008)

  it('draws the side with one material and both faces with the other', () => {
    expect(chip.groups.map((g) => g.materialIndex)).toEqual([0, 1, 1])
  })

  it('maps each face so the print is centred on the chip', () => {
    const pos = chip.getAttribute('position')
    const uv = chip.getAttribute('uv')
    const index = chip.getIndex()!
    const { start, count } = chip.groups[1]
    for (let i = start; i < start + count; i++) {
      const v = index.getX(i)
      expect(uv.getX(v)).toBeCloseTo(0.5 + pos.getX(v) / 0.32)
      expect(uv.getY(v)).toBeCloseTo(0.5 - pos.getZ(v) / 0.32)
    }
  })

  it('faces its top up and its rim out', () => {
    for (const { normal } of faceNormals(chip, 1))
      expect(normal.y).toBeCloseTo(1)
    for (const { normal, centre } of faceNormals(chip, 0))
      expect(normal.x * centre.x + normal.z * centre.z).toBeGreaterThan(0)
  })
})
