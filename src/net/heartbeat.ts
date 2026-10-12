// The link check both sockets share (ADR amendment 2026-10-12, "Live games").
// A WebSocket that lost its network can look open for minutes: the browser
// learns only when TCP gives up. Mid-hand that is a player who clicked and
// heard nothing. So each open socket sends the literal text `ping`, which the
// Worker's auto-response answers with `pong` without waking the Durable
// Object (so it costs nothing at the table), and a socket that stops
// answering is closed here, which takes the ordinary reconnect path.
//
// The same round trips are the player's latency, kept in a small store of
// its own: a ping every few seconds must not re-render the table.

/** One ping this often while a socket is open (0 in the class: tests). */
export const PING_EVERY_MS = 5000
/** This many pings unanswered and the socket is given up: about 10 s. */
export const MISSED_PONGS = 2
/**
 * Backstop for the count above: a ping outstanding while no frame of any
 * kind has arrived for this long. Only a pending ping counts, since a quiet
 * table that answers every ping is healthy however long since its last
 * snapshot, and a hidden tab's timers may run a minute apart.
 */
export const SILENCE_MS = 12_000
/** A tab coming back into view gets this long to answer before reconnecting. */
export const PROBE_MS = 1500
/** The median is of this many of the latest round trips. */
export const RTT_SAMPLES = 5
/** The latency shown moves in steps of this many ms, so it does not flicker. */
const RTT_STEP_MS = 5

export type HeartbeatOptions = {
  /** Between pings; 0 turns the heartbeat off. */
  intervalMs: number
  /** A monotonic clock in ms (performance.now): round trips are intervals. */
  now: () => number
  /** 0..1; spreads pings so a room of clients does not tick together. */
  random: () => number
  /** Writes `ping` to the socket. */
  send: () => void
  /** The socket stopped answering: close it and reconnect. */
  dead: () => void
  /** A round trip, in ms. */
  onRtt?: (ms: number) => void
}

export class Heartbeat {
  private timer: ReturnType<typeof setTimeout> | null = null
  private probing: ReturnType<typeof setTimeout> | null = null
  /**
   * When each unanswered ping went out, oldest first: replies come back in
   * order, so a `pong` answers the first.
   */
  private outstanding: number[] = []
  private heardAt = 0
  /** Frames heard: a count, since two can share one millisecond. */
  private frames = 0
  private running = false

  constructor(private readonly options: HeartbeatOptions) {}

  get on() {
    return this.options.intervalMs > 0
  }

  /** The socket opened: ping from now on. */
  start() {
    this.stop()
    if (!this.on) return
    this.running = true
    this.heardAt = this.options.now()
    this.schedule()
  }

  stop() {
    this.running = false
    this.outstanding = []
    if (this.timer) clearTimeout(this.timer)
    if (this.probing) clearTimeout(this.probing)
    this.timer = null
    this.probing = null
  }

  /** Any frame arrived: the link is alive. */
  heard() {
    this.heardAt = this.options.now()
    this.frames++
  }

  /** A `pong` arrived (also a frame, so it counts as heard). */
  pong() {
    const sentAt = this.outstanding.shift()
    this.heard()
    if (sentAt !== undefined)
      this.options.onRtt?.(Math.max(0, this.heardAt - sentAt))
  }

  /**
   * The tab is visible again or the network came back: ping at once, and
   * give the socket PROBE_MS to say anything at all before giving it up.
   */
  probe() {
    if (!this.running) return
    const before = this.frames
    this.ping()
    if (this.probing) clearTimeout(this.probing)
    this.probing = setTimeout(() => {
      this.probing = null
      if (this.running && this.frames === before) this.giveUp()
    }, PROBE_MS)
  }

  private schedule() {
    const { intervalMs, random } = this.options
    // ±10%, so clients that connected together drift apart.
    this.timer = setTimeout(
      () => this.tick(),
      intervalMs * (0.9 + 0.2 * random()),
    )
  }

  private tick() {
    this.timer = null
    if (!this.running) return
    const quiet = this.options.now() - this.heardAt >= SILENCE_MS
    if (
      this.outstanding.length >= MISSED_PONGS ||
      (this.outstanding.length > 0 && quiet)
    )
      return this.giveUp()
    this.ping()
    this.schedule()
  }

  private ping() {
    // Stamped before it is sent: a reply that comes back at once (a test's
    // socket, a very near server) must find its ping waiting.
    this.outstanding.push(this.options.now())
    try {
      this.options.send()
    } catch {
      // A socket that cannot send is dead; the missed pongs say so.
    }
  }

  private giveUp() {
    this.stop()
    this.options.dead()
  }
}

/**
 * The player's round-trip time: the median of the latest RTT_SAMPLES pings.
 * A store apart from the table's state, so a ping every 5 s re-renders only
 * what shows the figure, and only when the shown figure changes.
 */
export class RttStore {
  private samples: number[] = []
  private shown: number | null = null
  private listeners = new Set<() => void>()

  /** Exact median in ms, or null before the first reply. */
  median(): number | null {
    if (!this.samples.length) return null
    const sorted = [...this.samples].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }

  add(ms: number) {
    this.samples = [...this.samples, ms].slice(-RTT_SAMPLES)
    this.publish()
  }

  /** A new socket is a new path: its first reply starts the figure again. */
  reset() {
    this.samples = []
    this.publish()
  }

  /** The median in ms to the nearest step; the snapshot hooks read. */
  getSnapshot = () => this.shown

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish() {
    const median = this.median()
    const next =
      median === null ? null : Math.round(median / RTT_STEP_MS) * RTT_STEP_MS
    if (next === this.shown) return
    this.shown = next
    for (const listener of this.listeners) listener()
  }
}
