// The table drawn as an instrument: a void floor, a lacquered oval seen in
// perspective, a neon light set in its rail, and a woven felt printed with
// the odds arc, the betting line and the motto. The light in the rail is the
// clock: it drains from the seat that is acting (Rail). Shared by the
// heads-up Table and the six-seat ring; both lay their seats, cards and
// chips flat on top of it, so nothing that must be read is foreshortened.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/** The plane's own size; the scene scales it to fit its box. */
const W = 1080
const H = 640
/** How far the plane leans back, and how much of its height that leaves. */
const TILT = 36
const SEEN = Math.cos((TILT * Math.PI) / 180) + 0.06

/**
 * What the rail light shows. `clock`: the time left draining from `from`;
 * `full`: lit all round (your move, untimed); `thinking`: a short arc
 * circling while the other side decides; `win`: flooded gold; `off`: the
 * faint track only.
 */
export type RailMode = 'clock' | 'full' | 'thinking' | 'win' | 'off'

/** A server-owned turn clock (epoch ms), read against local time. */
export type RailClock = {
  deadline: number
  /** Time bank left when this decision started; inside the deadline. */
  bankMs: number
  /** Server time minus local time. */
  offset: number
  /** The decision's own time before the bank. */
  decisionMs?: number
}

/** The decision time every live table gives (worker/src/table.ts). */
const DECISION_MS = 20_000

/** Share of the clock left (0..1) and whether it is the bank running. */
function clockLeft(clock: RailClock, now: number) {
  const left = Math.max(0, clock.deadline - (now + clock.offset))
  const decision = Math.max(0, left - clock.bankMs)
  if (decision > 0)
    return {
      share: Math.min(1, decision / (clock.decisionMs ?? DECISION_MS)),
      bank: false,
    }
  return {
    share: clock.bankMs ? Math.min(1, left / clock.bankMs) : 0,
    bank: true,
  }
}

function useClockShare(clock: RailClock | null | undefined) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!clock) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [clock])
  return clock ? clockLeft(clock, now) : null
}

/** A point on the odds arc: p in 0..100 along a half circle of radius r. */
const arcPoint = (p: number, r: number) => {
  const a = Math.PI + (Math.PI * p) / 100
  return [540 + r * Math.cos(a), 400 + r * Math.sin(a)] as const
}
const TICKS = (() => {
  let d = ''
  for (let p = 0; p <= 100; p += 5) {
    const major = p % 25 === 0
    const [a, b] = arcPoint(p, major ? 278 : 283)
    const [c, e] = arcPoint(p, major ? 304 : 297)
    d += `M${a.toFixed(1)} ${b.toFixed(1)} L${c.toFixed(1)} ${e.toFixed(1)} `
  }
  return d
})()
const ARC = 'M250 400 A290 290 0 0 1 830 400'

/**
 * The odds scale printed behind the board: 0 to 100 with the price
 * (break-even) cut into it. Lit to your equity once the lab shows it, with
 * your own read as a gold bead.
 */
export type ArcReading = {
  equity?: number
  breakEven?: number
  guess?: number
}

export function TableScene({
  mode,
  from = 180,
  clock,
  arc,
  motto = 'THINK IN PROBABILITIES',
  deck = false,
  children,
}: {
  mode: RailMode
  from?: number
  /** With mode `clock`: the turn clock to drain. */
  clock?: RailClock | null
  arc?: ArcReading | null
  motto?: string
  /** Draw the dealer's deck (the cards fly from it, PlayingCard). */
  deck?: boolean
  children?: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => {
      const { width, height } = el.getBoundingClientRect()
      setScale(Math.max(0.1, Math.min(width / W, height / (H * SEEN))))
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const timed = useClockShare(mode === 'clock' ? clock : null)
  const share =
    mode === 'clock' ? (timed?.share ?? 1) : mode === 'thinking' ? 0.22 : 1
  const angle = Math.max(10, share * 360)
  const tone =
    mode === 'win' ? 'win' : timed?.bank ? 'bank' : mode === 'off' ? 'off' : ''
  // The bright head rides the leading end of a draining clock.
  const th = ((from + angle - 1) * Math.PI) / 180
  const rx = 524.5
  const ry = 304.5
  const radius =
    1 / Math.sqrt((Math.sin(th) / rx) ** 2 + (Math.cos(th) / ry) ** 2)
  const head =
    mode === 'clock'
      ? { left: 540 + radius * Math.sin(th), top: 320 - radius * Math.cos(th) }
      : null

  return (
    <div className="scene" ref={box} aria-hidden="true">
      <div className="scene-floor" />
      <div
        className={`scene-plane rail-${mode} ${tone ? `rail-tone-${tone}` : ''}`}
        style={
          {
            width: W,
            height: H,
            '--k': scale,
            '--tilt': `${TILT}deg`,
            '--rail-from': `${from}deg`,
            '--rail-a': `${angle}deg`,
            visibility: scale ? undefined : 'hidden',
          } as CSSProperties
        }
      >
        <div className="scene-under" />
        <div className="scene-rail" />
        <div className="scene-sheen loop" />
        <div className="rail-halo">
          <i className="loop" />
        </div>
        <div className="scene-lip loop" />
        <div className="scene-channel loop" />
        <div className="rail-track loop" />
        <div className="rail-lit">
          <i className="rail-glow loop" />
          <i className="rail-line loop" />
          <i className="rail-core loop" />
        </div>
        {head && (
          <span
            className="rail-head"
            style={{ left: head.left, top: head.top }}
          />
        )}
        <div className="scene-blush" />
        <div className="scene-felt" />
        <div className="scene-weave" />
        <div className="scene-inlay" />
        <div className="scene-seam" />
        <Print arc={arc} motto={motto} />
        {deck && (
          <div className="deck-stack">
            <i />
            <i />
            <i>
              <svg viewBox="0 0 100 100">
                <path d="M50 3 C41 21 6 37 6 60 C6 74 17 83 29 83 C38 83 45 78 48 72 C47 83 42 91 33 97 L67 97 C58 91 53 83 52 72 C55 78 62 83 71 83 C83 83 94 74 94 60 C94 37 59 21 50 3Z" />
              </svg>
            </i>
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

/** Everything printed on the felt, in the plane's own 1080 × 640 units. */
function Print({ arc, motto }: { arc?: ArcReading | null; motto: string }) {
  const equity = arc?.equity
  const lit = equity === undefined ? 0 : Math.round(equity * 100)
  const beads: { p: number; r: number; className: string }[] = []
  if (arc?.guess !== undefined)
    beads.push({ p: arc.guess * 100, r: 8, className: 'arc-guess' })
  if (equity !== undefined)
    beads.push({ p: equity * 100, r: 6, className: 'arc-equity' })
  const price =
    arc?.breakEven !== undefined && arc.breakEven > 0
      ? [arcPoint(arc.breakEven * 100, 274), arcPoint(arc.breakEven * 100, 308)]
      : null
  return (
    <svg className="scene-print" viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
      <defs>
        <linearGradient id="scene-lit" x1="0" x2="1">
          <stop offset="0" stopColor="#6f8cff" />
          <stop offset=".45" stopColor="#e07aa8" />
          <stop offset="1" stopColor="#ffe49a" />
        </linearGradient>
        <path id="scene-motto" d="M300 532 Q540 624 780 532" />
      </defs>
      <ellipse className="print-dots" cx="540" cy="340" rx="420" ry="238" />
      <ellipse className="print-line" cx="540" cy="340" rx="440" ry="252" />
      <g className="print-gold">
        <path d="M540 586 l6 6 l-6 6 l-6 -6 Z" />
        <path d="M166 457 l6 6 l-6 6 l-6 -6 Z" />
        <path d="M166 211 l6 6 l-6 6 l-6 -6 Z" />
        <path d="M914 211 l6 6 l-6 6 l-6 -6 Z" />
        <path d="M914 457 l6 6 l-6 6 l-6 -6 Z" />
      </g>
      <g className="print-flourish" transform="translate(540 538)">
        <path d="M-150 -6 q-30 -14 -60 0" />
        <path d="M150 -6 q30 -14 60 0" />
      </g>
      <text className="print-motto">
        <textPath href="#scene-motto" startOffset="50%" textAnchor="middle">
          {motto}
        </textPath>
      </text>
      <path className="arc-base" d={ARC} />
      <path className="arc-ticks" d={TICKS} />
      <g className="arc-labels">
        <text x="282" y="405">
          0
        </text>
        <text x="540" y="160" textAnchor="middle">
          50
        </text>
        <text x="798" y="405" textAnchor="end">
          100
        </text>
      </g>
      <path
        className="arc-lit"
        d={ARC}
        pathLength={100}
        strokeDasharray={`${lit} 100`}
        stroke="url(#scene-lit)"
      />
      {price && (
        <path
          className="arc-price"
          d={`M${price[0][0].toFixed(1)} ${price[0][1].toFixed(1)} L${price[1][0].toFixed(1)} ${price[1][1].toFixed(1)}`}
        />
      )}
      {beads.map((b) => {
        const [x, y] = arcPoint(b.p, 290)
        return (
          <circle
            key={b.className}
            className={b.className}
            cx={x.toFixed(1)}
            cy={y.toFixed(1)}
            r={b.r}
          />
        )
      })}
    </svg>
  )
}
