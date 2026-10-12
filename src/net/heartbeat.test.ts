import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Heartbeat,
  MISSED_PONGS,
  PING_EVERY_MS,
  PROBE_MS,
  RttStore,
  SILENCE_MS,
} from './heartbeat'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function beat(intervalMs = PING_EVERY_MS) {
  let clock = 0
  const sent: number[] = []
  const rtts: number[] = []
  const dead = vi.fn()
  const heartbeat = new Heartbeat({
    intervalMs,
    now: () => clock,
    random: () => 0.5, // no spread: exactly intervalMs
    send: () => sent.push(clock),
    dead,
    onRtt: (ms) => rtts.push(ms),
  })
  return {
    heartbeat,
    sent,
    rtts,
    dead,
    /** Moves both clocks: the timers' and the round-trip one. */
    advance: (ms: number) => {
      clock += ms
      vi.advanceTimersByTime(ms)
    },
  }
}

describe('Heartbeat', () => {
  it('is off at 0 ms: it sends nothing and gives nothing up', () => {
    const { heartbeat, sent, dead, advance } = beat(0)
    heartbeat.start()
    heartbeat.probe()
    advance(60_000)
    expect(sent).toEqual([])
    expect(dead).not.toHaveBeenCalled()
  })

  it('pings every interval and measures each round trip from its own ping', () => {
    const { heartbeat, sent, rtts, advance } = beat()
    heartbeat.start()
    advance(PING_EVERY_MS)
    expect(sent).toEqual([5000])
    advance(40)
    heartbeat.pong()
    expect(rtts).toEqual([40])
    advance(PING_EVERY_MS)
    expect(sent).toHaveLength(2)
  })

  it('answers the oldest ping first, since replies come back in order', () => {
    const { heartbeat, rtts, advance } = beat()
    heartbeat.start()
    advance(PING_EVERY_MS) // ping 1 at 5000
    advance(PING_EVERY_MS) // ping 2 at 10000
    advance(30)
    heartbeat.pong()
    expect(rtts).toEqual([5030])
    heartbeat.pong()
    expect(rtts).toEqual([5030, 30])
    // A reply nobody asked for measures nothing.
    heartbeat.pong()
    expect(rtts).toHaveLength(2)
  })

  it('gives the socket up after two pings with no reply, and stops', () => {
    const { heartbeat, sent, dead, advance } = beat()
    heartbeat.start()
    advance(PING_EVERY_MS * MISSED_PONGS)
    expect(dead).not.toHaveBeenCalled()
    expect(sent).toHaveLength(2)
    advance(PING_EVERY_MS) // about 15 s from open; 10 s past the first ping
    expect(dead).toHaveBeenCalledTimes(1)
    advance(60_000)
    expect(sent).toHaveLength(2)
    expect(dead).toHaveBeenCalledTimes(1)
  })

  it('keeps a socket that answers, however quiet the table is', () => {
    const { heartbeat, dead, advance } = beat()
    heartbeat.start()
    for (let i = 0; i < 20; i++) {
      advance(PING_EVERY_MS)
      heartbeat.pong()
    }
    expect(dead).not.toHaveBeenCalled()
  })

  it('does not take a long gap between ticks (a hidden tab) for silence', () => {
    // A hidden tab's timers can run a minute apart: one tick per minute here.
    const { heartbeat, dead, advance } = beat(60_000)
    heartbeat.start()
    for (let i = 0; i < 3; i++) {
      advance(60_000) // 60 s of quiet is past SILENCE_MS, and healthy
      heartbeat.pong()
    }
    expect(dead).not.toHaveBeenCalled()
  })

  it('treats any frame as proof of life', () => {
    const { heartbeat, dead, advance } = beat()
    heartbeat.start()
    advance(PING_EVERY_MS)
    advance(PING_EVERY_MS)
    heartbeat.heard() // a snapshot, not a pong: two pings are still unanswered
    advance(PING_EVERY_MS)
    // The count is the rule; the silence backstop alone would have waited.
    expect(dead).toHaveBeenCalledTimes(1)
    expect(SILENCE_MS).toBeGreaterThan(PING_EVERY_MS * MISSED_PONGS)
  })

  it('probes at once, and gives up if nothing at all is heard in time', () => {
    const { heartbeat, sent, dead, advance } = beat()
    heartbeat.start()
    advance(100)
    heartbeat.probe()
    expect(sent).toEqual([100])
    advance(PROBE_MS)
    expect(dead).toHaveBeenCalledTimes(1)
  })

  it('keeps a socket that says anything within the probe', () => {
    const { heartbeat, dead, advance } = beat()
    heartbeat.start()
    advance(100)
    heartbeat.probe()
    advance(PROBE_MS - 1)
    heartbeat.heard()
    advance(10)
    expect(dead).not.toHaveBeenCalled()
  })

  it('stops its timers', () => {
    const { heartbeat, sent, advance } = beat()
    heartbeat.start()
    heartbeat.probe()
    heartbeat.stop()
    advance(60_000)
    expect(sent).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('spreads its pings by a tenth either way', () => {
    let clock = 0
    const sent: number[] = []
    for (const [random, at] of [
      [0, 4500],
      [1, 5500],
    ] as const) {
      const heartbeat = new Heartbeat({
        intervalMs: 5000,
        now: () => clock,
        random: () => random,
        send: () => sent.push(at),
        dead: () => {},
      })
      heartbeat.start()
      vi.advanceTimersByTime(at - 1)
      expect(sent).not.toContain(at)
      vi.advanceTimersByTime(1)
      expect(sent).toContain(at)
      heartbeat.stop()
      clock += at
    }
  })
})

describe('RttStore', () => {
  it('is empty until the first reply, then the median of the last five', () => {
    const store = new RttStore()
    expect(store.median()).toBeNull()
    expect(store.getSnapshot()).toBeNull()
    for (const ms of [300, 20, 40, 60, 80]) store.add(ms)
    expect(store.median()).toBe(60)
    // The oldest falls away: 20 40 60 80 100.
    store.add(100)
    expect(store.median()).toBe(60)
    store.add(120)
    expect(store.median()).toBe(80)
  })

  it('averages the middle two of an even count', () => {
    const store = new RttStore()
    store.add(10)
    store.add(30)
    expect(store.median()).toBe(20)
  })

  it('shows the median to the nearest 5 ms and tells only when that moves', () => {
    const store = new RttStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.add(42)
    expect(store.getSnapshot()).toBe(40)
    expect(listener).toHaveBeenCalledTimes(1)
    store.add(43) // median 42.5: still 45? 42.5/5 = 8.5 -> 9 -> 45
    expect(store.getSnapshot()).toBe(45)
    expect(listener).toHaveBeenCalledTimes(2)
    store.add(43)
    store.add(43) // median 43: 45 again, nothing to say
    expect(store.getSnapshot()).toBe(45)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('forgets on reset, and an unsubscribed listener hears no more', () => {
    const store = new RttStore()
    const listener = vi.fn()
    const off = store.subscribe(listener)
    store.add(50)
    store.reset()
    expect(store.getSnapshot()).toBeNull()
    expect(store.median()).toBeNull()
    off()
    store.add(50)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
