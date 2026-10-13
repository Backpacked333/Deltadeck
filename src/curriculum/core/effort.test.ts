import { describe, expect, it } from 'vitest'
import { EffortClock } from './effort'

describe('qualified effort, never trusted elapsed retention', () => {
  it('excludes hidden time, caps idle attention, and resumes without counting time away', () => {
    let at = 0
    const clock = new EffortClock(undefined, () => at)
    at = 120_000
    expect(clock.snapshot()).toMatchObject({
      activeMs: 60_000,
      visibleMs: 120_000,
    })
    clock.visibility(false)
    at = 180_000
    clock.visibility(true)
    at = 190_000
    clock.interact()
    at = 200_000
    const first = clock.snapshot()
    expect(first).toMatchObject({
      activeMs: 80_000,
      visibleMs: 140_000,
      sessions: 1,
    })
    at = 900_000
    const resumed = new EffortClock(first, () => at)
    at += 1000
    expect(resumed.snapshot()).toEqual({
      version: 1,
      provenance: 'client-monotonic',
      activeMs: 81_000,
      visibleMs: 141_000,
      sessions: 2,
    })
  })
})
