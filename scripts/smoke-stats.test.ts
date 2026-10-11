// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  ACK_P95_LIMIT_MS,
  percentile,
  SIX_ACK_P95_LIMIT_MS,
  verdict,
} from './smoke-stats.ts'
import type { SmokeResult } from './smoke-stats.ts'

const ok: SmokeResult = {
  hands: 500,
  target: 500,
  acks: Array.from({ length: 100 }, (_, i) => i + 1),
  failures: [],
  leaks: 0,
  commitments: 500,
}

describe('smoke stats', () => {
  it('takes nearest-rank percentiles', () => {
    const samples = Array.from({ length: 100 }, (_, i) => 100 - i)
    expect(percentile(samples, 50)).toBe(50)
    expect(percentile(samples, 95)).toBe(95)
    expect(percentile(samples, 99)).toBe(99)
    expect(percentile([7], 99)).toBe(7)
    expect(percentile([], 50)).toBeNaN()
  })

  it('passes a run that is fast and clean', () => {
    expect(verdict(ok)).toEqual([])
  })

  it(`fails at a p95 over ${ACK_P95_LIMIT_MS} ms, but not at exactly ${ACK_P95_LIMIT_MS}`, () => {
    const slow = (ms: number) => [...Array(95).fill(10), ...Array(5).fill(ms)]
    expect(
      verdict({ ...ok, acks: [...Array(94).fill(10), ...Array(6).fill(301)] }),
    ).toEqual(['ack p95 301 ms is over 300 ms'])
    expect(verdict({ ...ok, acks: slow(1000) })).toEqual([])
    expect(
      verdict({ ...ok, acks: [...Array(94).fill(10), ...Array(6).fill(300)] }),
    ).toEqual([])
  })

  it(`holds a six-seat run to ${SIX_ACK_P95_LIMIT_MS} ms at p95 (P2-11)`, () => {
    expect(SIX_ACK_P95_LIMIT_MS).toBe(150)
    const at = (ms: number) => [...Array(94).fill(10), ...Array(6).fill(ms)]
    expect(verdict({ ...ok, acks: at(151) }, SIX_ACK_P95_LIMIT_MS)).toEqual([
      'ack p95 151 ms is over 150 ms',
    ])
    expect(verdict({ ...ok, acks: at(150) }, SIX_ACK_P95_LIMIT_MS)).toEqual([])
  })

  it('fails on any broken invariant, leak, unverified commitment or missing hand', () => {
    expect(
      verdict({
        ...ok,
        hands: 499,
        failures: ['chips'],
        leaks: 1,
        commitments: 498,
      }),
    ).toEqual([
      'only 499 of 500 hands finished',
      '1 invariant failures',
      '1 leaked frames',
      '498 of 499 commitments verified',
    ])
    expect(verdict({ ...ok, acks: [] })).toEqual(['no acknowledged moves'])
  })
})
