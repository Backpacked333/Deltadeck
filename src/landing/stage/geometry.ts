// Shapes for the landing stage that three's primitives do not cover: a card
// with rounded corners and an edge, a profile swept around the table's
// ellipse (the racetrack, the padded rail, the apron), and a chip with a
// bevelled rim whose face print lines up with the stripes on its side.
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * A card lying face up in the x–z plane, `t` thick, centred on the origin,
 * its top edge toward −z. Groups: 0 the face (+y), 1 the back (−y), 2 the
 * edge. The face's UVs match a BoxGeometry's top, so textures read the same.
 */
export function cardGeometry(w: number, h: number, t: number, radius: number) {
  const outline: THREE.Vector2[] = []
  const corner = (cx: number, cz: number, start: number) => {
    for (let i = 0; i <= 6; i++) {
      const a = start + (i / 6) * (Math.PI / 2)
      outline.push(
        new THREE.Vector2(cx + Math.cos(a) * radius, cz + Math.sin(a) * radius),
      )
    }
  }
  const x = w / 2 - radius
  const z = h / 2 - radius
  corner(x, z, 0)
  corner(-x, z, Math.PI / 2)
  corner(-x, -z, Math.PI)
  corner(x, -z, (3 * Math.PI) / 2)
  const triangles = THREE.ShapeUtils.triangulateShape(outline, [])

  const position: number[] = []
  const normal: number[] = []
  const uv: number[] = []
  const index: number[] = []
  const cap = (y: number, up: 1 | -1) => {
    const base = position.length / 3
    for (const p of outline) {
      position.push(p.x, y, p.y)
      normal.push(0, up, 0)
      uv.push((p.x + w / 2) / w, up > 0 ? (h / 2 - p.y) / h : (h / 2 + p.y) / h)
    }
    for (const [a, b, c] of triangles) {
      // Wind each triangle so it faces `up`.
      const pa = outline[a]
      const pb = outline[b]
      const pc = outline[c]
      const cross =
        (pb.y - pa.y) * (pc.x - pa.x) - (pb.x - pa.x) * (pc.y - pa.y)
      if (cross * up > 0) index.push(base + a, base + b, base + c)
      else index.push(base + a, base + c, base + b)
    }
  }
  const geometry = new THREE.BufferGeometry()
  cap(t / 2, 1)
  const faceCount = index.length
  cap(-t / 2, -1)
  const backCount = index.length - faceCount
  // The edge: a strip around the outline, with outward normals.
  const base = position.length / 3
  const n = outline.length
  for (let i = 0; i < n; i++) {
    const prev = outline[(i + n - 1) % n]
    const next = outline[(i + 1) % n]
    const nx = next.y - prev.y
    const nz = -(next.x - prev.x)
    const len = Math.hypot(nx, nz) || 1
    for (const y of [t / 2, -t / 2]) {
      position.push(outline[i].x, y, outline[i].y)
      normal.push(nx / len, 0, nz / len)
      uv.push(i / n, y > 0 ? 1 : 0)
    }
  }
  const edgeStart = index.length
  for (let i = 0; i < n; i++) {
    const a = base + i * 2
    const b = base + ((i + 1) % n) * 2
    index.push(a, a + 1, b, b, a + 1, b + 1)
  }
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(position, 3),
  )
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geometry.setIndex(index)
  geometry.addGroup(0, faceCount, 0)
  geometry.addGroup(faceCount, backCount, 1)
  geometry.addGroup(edgeStart, index.length - edgeStart, 2)
  fixEdgeWinding(geometry, edgeStart)
  return geometry
}

/** Flips the edge strip's triangles if they face inward. */
function fixEdgeWinding(geometry: THREE.BufferGeometry, from: number) {
  const index = geometry.getIndex()!
  const pos = geometry.getAttribute('position')
  const nrm = geometry.getAttribute('normal')
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ia = index.getX(from)
  a.fromBufferAttribute(pos, ia)
  b.fromBufferAttribute(pos, index.getX(from + 1))
  c.fromBufferAttribute(pos, index.getX(from + 2))
  const face = b.sub(a).cross(c.sub(a))
  const outward = new THREE.Vector3().fromBufferAttribute(nrm, ia)
  if (face.dot(outward) >= 0) return
  for (let i = from; i < index.count; i += 3) {
    const t = index.getX(i + 1)
    index.setX(i + 1, index.getX(i + 2))
    index.setX(i + 2, t)
  }
}

/**
 * A profile swept around an ellipse with radii (a, b). Each profile point is
 * [offset, y]: the offset is added to both radii, a close stand-in for a
 * true offset curve at these proportions. u runs around (`repeat` times),
 * v across the profile, 0 at its first point.
 */
export function sweepGeometry(
  a: number,
  b: number,
  profile: [number, number][],
  { segments = 256, repeat = 1 } = {},
) {
  const position: number[] = []
  const uv: number[] = []
  const index: number[] = []
  const lengths = [0]
  for (let j = 1; j < profile.length; j++)
    lengths.push(
      lengths[j - 1] +
        Math.hypot(
          profile[j][0] - profile[j - 1][0],
          profile[j][1] - profile[j - 1][1],
        ),
    )
  const total = lengths[lengths.length - 1]
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2
    const cos = Math.cos(t)
    const sin = Math.sin(t)
    profile.forEach(([r, y], j) => {
      position.push((a + r) * cos, y, (b + r) * sin)
      uv.push((i / segments) * repeat, lengths[j] / total)
    })
  }
  const m = profile.length
  for (let i = 0; i < segments; i++)
    for (let j = 0; j < m - 1; j++) {
      // Wound so faces point away from the table's axis and up: around
      // (+θ) then along the profile (outward, upward).
      const p = i * m + j
      const q = (i + 1) * m + j
      index.push(p, q, p + 1, q, q + 1, p + 1)
    }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(position, 3),
  )
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geometry.setIndex(index)
  geometry.computeVertexNormals()
  // The seam's two columns share a place: give them the same normal.
  const nrm = geometry.getAttribute('normal')
  const v = new THREE.Vector3()
  for (let j = 0; j < m; j++) {
    const last = segments * m + j
    v.fromBufferAttribute(nrm, j)
      .add(new THREE.Vector3().fromBufferAttribute(nrm, last))
      .normalize()
    nrm.setXYZ(j, v.x, v.y, v.z)
    nrm.setXYZ(last, v.x, v.y, v.z)
  }
  return geometry
}

/** A padded cushion's cross-section: up from the inside, over, and under. */
export function cushionProfile(width: number, height: number, base = 0.02) {
  const points: [number, number][] = []
  const steps = 26
  const n = 2.6
  for (let i = 0; i <= steps; i++) {
    const phi = (i / steps) * Math.PI
    const c = Math.cos(phi)
    const s = Math.sin(phi)
    const r =
      width / 2 - (width / 2) * Math.sign(c) * Math.pow(Math.abs(c), 2 / n)
    const y = base + (height - base) * Math.pow(s, 2 / n)
    points.push([r, y])
  }
  // Tuck under the outer edge, out of sight.
  points.push([width * 0.99, -0.05], [width * 0.94, -0.16])
  return points
}

/**
 * A chip lying flat, `h` thick, radius `r`, with a rounded rim. Groups: 0 the
 * side (u once around, matching chipEdge), 1 the faces (planar UVs, matching
 * chipFace's spot angles).
 */
export function chipGeometry(
  r: number,
  h: number,
  bevel: number,
  segments = 48,
) {
  const profile: THREE.Vector2[] = []
  const arc = (cx: number, cy: number, from: number, to: number) => {
    for (let i = 0; i <= 4; i++) {
      const a = from + ((to - from) * i) / 4
      profile.push(
        new THREE.Vector2(cx + Math.cos(a) * bevel, cy + Math.sin(a) * bevel),
      )
    }
  }
  arc(r - bevel, -h / 2 + bevel, -Math.PI / 2, 0)
  arc(r - bevel, h / 2 - bevel, 0, Math.PI / 2)
  const side = new THREE.LatheGeometry(profile, segments)
  const face = (y: number) => {
    const disc = new THREE.CircleGeometry(r - bevel, segments)
    disc.rotateX(y > 0 ? -Math.PI / 2 : Math.PI / 2)
    disc.translate(0, y, 0)
    const pos = disc.getAttribute('position')
    const uv = disc.getAttribute('uv')
    for (let i = 0; i < pos.count; i++)
      uv.setXY(i, 0.5 + pos.getX(i) / (2 * r), 0.5 - pos.getZ(i) / (2 * r))
    return disc
  }
  const parts = [side, face(h / 2), face(-h / 2)]
  const merged = mergeGeometries(parts, true)!
  // Merge leaves three groups; both faces share the second material.
  merged.groups[2].materialIndex = 1
  for (const part of parts) part.dispose()
  return merged
}
