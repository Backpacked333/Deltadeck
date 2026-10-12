import { act, renderHook } from '@testing-library/react'
import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  HandCompletionV1,
  PresentationStateV1,
  SeatView,
} from '../shared/protocol'
import { firstHand, frame, MATCH } from '../net/testing'
import { completionPhase, useLiveRunout } from './runout'

const hand = { tableId: MATCH, matchId: MATCH, handNo: 1 }
const completion = (
  shape: HandCompletionV1['schedule']['shape'] = 'all_in_preflop',
): HandCompletionV1 => ({
  v: 1,
  hand,
  terminalStateVersion: 9,
  completedAt: 100_000,
  resultAvailable: true,
  final: {
    hand,
    board: shape === 'fold' ? [] : [0, 1, 2, 3, 4],
    shown: [],
    participants: [],
    stacksBySeat: {},
    pots: [],
    awards: [],
    netBySeat: {},
    showdown: shape !== 'fold',
  },
  schedule: {
    version: 'completion.v1',
    shape,
    beats:
      shape === 'fold' || shape === 'river'
        ? []
        : shape === 'all_in_turn'
          ? [{ offsetMs: 1400, boardCount: 5 }]
          : shape === 'all_in_flop'
            ? [
                { offsetMs: 900, boardCount: 4 },
                { offsetMs: 2300, boardCount: 5 },
              ]
            : [
                { offsetMs: 900, boardCount: 3 },
                { offsetMs: 1800, boardCount: 4 },
                { offsetMs: 3200, boardCount: 5 },
              ],
    resultHoldMs: 1500,
    earliestNextDealAt: 104_700,
  },
})
const live = (frame('welcome', 1, 0, firstHand()) as { view: SeatView }).view
const finalView = {
  ...live,
  board: [0, 1, 2, 3, 4],
  result: { awards: [], netBySeat: {}, showdown: true },
}
const envelope = (
  c = completion(),
  serverNow = 100_000,
): PresentationStateV1 => ({ completion: c, currentDecision: null, serverNow })
afterEach(() => vi.useRealTimers())

describe('authoritative completion schedules', () => {
  it.each([
    ['all_in_preflop', 0, 899, 0, 900, 3],
    ['all_in_flop', 3, 899, 3, 900, 4],
    ['all_in_turn', 4, 1399, 4, 1400, 5],
    ['river', 5, 0, 5, 1, 5],
    ['fold', 0, 0, 0, 1, 0],
  ] as const)(
    '%s starts on the correct street and follows the supplied beat',
    (shape, initial, before, countBefore, after, countAfter) => {
      const c = completion(shape)
      expect(completionPhase(c, c.completedAt, 0).visible).toBe(initial)
      expect(completionPhase(c, c.completedAt, before).visible).toBe(
        countBefore,
      )
      expect(completionPhase(c, c.completedAt, after).visible).toBe(countAfter)
    },
  )
  it('bounds result hold by earliestNextDealAt and never replays a late completion', () => {
    const c = completion()
    expect(completionPhase(c, 103_200, 0)).toEqual({
      visible: 5,
      revealing: false,
      holding: true,
    })
    expect(completionPhase(c, 104_700, 0)).toEqual({
      visible: 5,
      revealing: false,
      holding: false,
    })
    expect(completionPhase(c, 800_000, 0)).toEqual({
      visible: 5,
      revealing: false,
      holding: false,
    })
  })
  it('reduced motion skips reveal but does not change the server deal boundary', () => {
    expect(completionPhase(completion(), 100_000, 0, true)).toEqual({
      visible: 5,
      revealing: false,
      holding: true,
    })
  })
  it('server clock offset cannot change the local elapsed span', () => {
    const c = completion()
    const shifted = {
      ...c,
      completedAt: c.completedAt + 8_000_000,
      schedule: {
        ...c.schedule,
        earliestNextDealAt: c.schedule.earliestNextDealAt + 8_000_000,
      },
    }
    expect(completionPhase(c, 100_000, 1800)).toEqual(
      completionPhase(shifted, 8_100_000, 1800),
    )
  })
})

describe('live presentation catch-up', () => {
  it('catches up in one render after timers were suspended/backgrounded', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(performance, 'now').mockReturnValue(0)
    const { result } = renderHook(() =>
      useLiveRunout(finalView, envelope(), 0, 0),
    )
    expect(result.current.visible).toBe(0)
    spy.mockReturnValue(30_000)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(result.current).toEqual({
      visible: 5,
      revealing: false,
      holding: false,
    })
    spy.mockRestore()
  })
  it('immediately gives a new live decision priority over an old reveal or result hold', () => {
    vi.useFakeTimers()
    const old = envelope()
    const { result, rerender } = renderHook(
      ({ view, presentation }) =>
        useLiveRunout(view, presentation, performance.now(), 0),
      { initialProps: { view: finalView as SeatView, presentation: old } },
    )
    expect(result.current.revealing).toBe(true)
    const next = { ...live, handNo: 2 }
    rerender({
      view: next,
      presentation: {
        ...old,
        currentDecision: {
          decision: { ...hand, handNo: 2, actionIndex: 0, seat: 0 },
          stateVersion: 10,
          startedAt: 101_000,
          deadlineAt: 120_000,
        },
      },
    })
    expect(result.current).toEqual({
      visible: 0,
      revealing: false,
      holding: false,
    })
    act(() => vi.advanceTimersByTime(10_000))
    expect(result.current.revealing).toBe(false)
  })
  it('resync with a late server timestamp cancels the obsolete schedule', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ presentation, epoch }) =>
        useLiveRunout(finalView, presentation, performance.now(), epoch),
      { initialProps: { presentation: envelope(), epoch: 0 } },
    )
    expect(result.current.revealing).toBe(true)
    rerender({ presentation: envelope(completion(), 110_000), epoch: 1 })
    expect(result.current).toEqual({
      visible: 5,
      revealing: false,
      holding: false,
    })
  })
  it('reduced-motion hook renders all public result cards immediately', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MotionConfig reducedMotion="always">{children}</MotionConfig>
    )
    const { result } = renderHook(
      () => useLiveRunout(finalView, envelope(), performance.now(), 0),
      { wrapper },
    )
    expect(result.current.visible).toBe(5)
    expect(result.current.revealing).toBe(false)
  })
})
