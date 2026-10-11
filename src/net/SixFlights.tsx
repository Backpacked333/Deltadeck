// Chip motion at the six-seat table (P2-06b), the trainer's flights taken
// to six seats: when a street closes or the result arrives, each seat's
// bet flies from that seat to the pot; at the result each pot flies to its
// winner, one flight per winner of a split pot, in the order the engine
// pushes them (the last side pot first, the main pot last), a beat apart
// so the order shows. Decoration only: hidden from screen readers, who
// hear the pot and the result in words, and nothing at all under reduced
// motion, as with every other animation in the app. It reads only what
// the frame already shows (bets, invested chips, awards), so it adds no
// field to the wire. Heads-up tables keep Table.tsx's own flights.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useReducedMotionConfig } from 'motion/react'
import { ChipPile } from '../components/table/ChipPile'
import type { SeatView } from '../shared/protocol'

/** One flight, as long as the trainer's (styles.css `.flight`). */
const FLY_MS = 600
/** The result's first pot leaves once the last bets have landed. */
const PAY_MS = FLY_MS
/** Then each next pot this much later, so the award order shows. */
const NEXT_POT_MS = 350
/** A flight's chips leave the page a little after they land. */
const LINGER_MS = 100

type Point = { x: number; y: number }
type Flight = {
  id: number
  /** `seat-<id>`, `pot` (the one pot) or `pot-<index>` (a side pot's pill). */
  from: string
  /** `pot`, or `seat-<id>` for a winner. */
  to: string
  amount: number
  delay: number
  start: Point
  end: Point
}

/**
 * Where a flight starts and lands, as the middle of the box it leaves or
 * reaches, from the corner of the flight layer (which covers the ring).
 * Measured from the boxes SixRing has just laid out, once when the flights
 * launch and never while they fly: the ring's rows are as tall as what is
 * in them (board, pots, hole cards, a plate's extra line), so a fixed spot
 * per seat would land off its plate. The flights move by transform alone.
 */
function locate(layer: HTMLElement) {
  const ring = layer.parentElement
  const origin = layer.getBoundingClientRect()
  const centre = (el: Element | null | undefined): Point | null => {
    if (!el) return null
    const box = el.getBoundingClientRect()
    return {
      x: Math.round(box.left + box.width / 2 - origin.left),
      y: Math.round(box.top + box.height / 2 - origin.top),
    }
  }
  const find = (selector: string) => ring?.querySelector(selector)
  const seat = (id: number) => `.six-seat[data-seat="${id}"]`
  // The pot line while the hand is played; at the result, the pots paid,
  // or with a single pot the board, where the pot line was.
  const pot = () =>
    centre(find('.six-pot') ?? find('.six-pots') ?? find('.six-board'))
  return {
    /** The row on the plate's middle side where its bet showed. */
    bet: (id: number) => centre(find(`${seat(id)} .six-chips`)),
    plate: (id: number) => centre(find(`${seat(id)} .six-plate`)),
    pot,
    /** A side pot's own pill in the pots paid. */
    sidePot: (index: number) =>
      centre(find(`.six-pots [data-pot="${index}"]`)) ?? pot(),
  }
}

export function SixFlights({ view }: { view: SeatView | null }) {
  const reduced = useReducedMotionConfig()
  const layer = useRef<HTMLDivElement>(null)
  const previous = useRef(view)
  const nextId = useRef(0)
  const timers = useRef<number[]>([])
  const [flights, setFlights] = useState<Flight[]>([])
  useEffect(() => () => timers.current.forEach(window.clearTimeout), [])

  // A layout effect: the frame's new boxes are laid out but not painted,
  // so the chips start from where the bets were in the same paint that
  // takes the bets off the plates.
  useLayoutEffect(() => {
    const before = previous.current
    previous.current = view
    if (!view || !before || before === view) return
    // A new hand (or table) takes the last one's chips off at once.
    if (before.matchId !== view.matchId || before.handNo !== view.handNo) {
      timers.current.forEach(window.clearTimeout)
      timers.current = []
      setFlights([])
      return
    }
    const closed =
      view.board.length > before.board.length ||
      (!!view.result && !before.result)
    // Measured only when chips fly, which is when a street closes.
    if (reduced || !closed || !layer.current) return
    const at = locate(layer.current)
    const next: Flight[] = []
    const add = (
      from: string,
      to: string,
      amount: number,
      delay: number,
      start: Point | null,
      end: Point | null,
    ) => {
      if (amount > 0 && start && end)
        next.push({ id: ++nextId.current, from, to, amount, delay, start, end })
    }
    for (const p of view.players) {
      const was = before.players.find((b) => b.seat === p.seat)
      if (!was) continue
      // What it had out, less any of it handed back as uncalled.
      const gathered = was.bet + p.invested - was.invested
      add(`seat-${p.seat}`, 'pot', gathered, 0, at.bet(p.seat), at.pot())
    }
    if (view.result && !before.result) {
      const side = view.pot.layers.length >= 2
      // The awards go pot by pot, a split pot's side by side: each pot
      // takes its place from its first award, and its winners go together.
      const order = [...new Set(view.result.awards.map((a) => a.pot))]
      for (const award of view.result.awards)
        add(
          side ? `pot-${award.pot}` : 'pot',
          `seat-${award.seat}`,
          award.amount,
          PAY_MS + order.indexOf(award.pot) * NEXT_POT_MS,
          side ? at.sidePot(award.pot) : at.pot(),
          at.plate(award.seat),
        )
    }
    if (!next.length) return
    setFlights((list) => [...list, ...next])
    const ids = new Set(next.map((f) => f.id))
    const done = Math.max(...next.map((f) => f.delay)) + FLY_MS + LINGER_MS
    const timer = window.setTimeout(() => {
      timers.current = timers.current.filter((t) => t !== timer)
      setFlights((list) => list.filter((f) => !ids.has(f.id)))
    }, done)
    timers.current.push(timer)
  }, [view, reduced])

  return (
    <div className="six-flights" ref={layer} aria-hidden="true">
      {!reduced &&
        flights.map((f) => (
          <span
            key={f.id}
            className="six-flight"
            data-from={f.from}
            data-to={f.to}
            style={
              {
                '--fx': `${f.start.x}px`,
                '--fy': `${f.start.y}px`,
                '--tx': `${f.end.x}px`,
                '--ty': `${f.end.y}px`,
                animationDelay: `${f.delay}ms`,
              } as CSSProperties
            }
          >
            <ChipPile amount={f.amount} maxStacks={2} />
          </span>
        ))}
    </div>
  )
}
