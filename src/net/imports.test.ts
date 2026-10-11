// @vitest-environment node
// Live tables must never carry analysis: the online code may not import the
// trainer's model, range, grading or bot modules, nor the lab. Nor may it
// read the `?seed` and `?motion` debug switches (src/env.ts) or draw from
// the seedable random source: the server deals every live card.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const FORBIDDEN = [
  /lib\/atlas/,
  /lib\/range/,
  /lib\/grading/,
  /lib\/model/,
  /lib\/scripted/,
  /state\/trainer/,
  /state\/spots/,
  /components\/lab\//,
  /LabSheet/,
  /equity\.worker/,
  /lib\/random/,
  /(^|\/)env$/,
]

const dir = new URL('./', import.meta.url)

describe('src/net imports', () => {
  it('stay away from analysis modules', () => {
    const files = readdirSync(dir).filter(
      (f) =>
        /\.tsx?$/.test(f) &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.test.tsx'),
    )
    expect(files.length).toBeGreaterThan(3)
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), 'utf8')
      const imports = [
        ...source.matchAll(/from '([^']+)'|import\('([^']+)'\)/g),
      ].map((m) => m[1] ?? m[2])
      for (const path of imports)
        for (const rule of FORBIDDEN)
          expect(rule.test(path), `${file} imports ${path}`).toBe(false)
    }
  })

  // The six-seat ring and the table list are reached only through the
  // lazy online chunk: an import from anywhere else could pull them into
  // the entry bundle (ADR, "Table UI (P2-05)"; clarifications from PR-25).
  it('are the only ones to import the six-seat ring and the table list', () => {
    const src = new URL('../', import.meta.url)
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .map((f) => f.replaceAll('\\', '/'))
      .filter((f) => /\.tsx?$/.test(f) && !f.startsWith('net/'))
    expect(files.length).toBeGreaterThan(50)
    for (const file of files) {
      const source = readFileSync(new URL(file, src), 'utf8')
      expect(
        source.match(
          /(from |import\()'[^']*\/(SixRing|SeatPlate|TableList)'/,
        )?.[0],
        `${file} imports the ring or the list`,
      ).toBeUndefined()
    }
  })
})
