// Card art drawn in a 250×350 box: suit shapes, pip layouts, the Pearl
// face and the back are generated in code.
import type { Card, Suit } from '../../lib/poker'
import { rankName } from '../../lib/poker'

const RED = 'var(--card-red, #d23c4b)'
const INK = 'var(--card-ink, #17142a)'
const suitColor = (suit: Suit) => (suit === 'h' || suit === 'd' ? RED : INK)

/** A suit drawn in a 100×100 box, centered at (x, y) with the given size. */
export function SuitShape({
  suit,
  x,
  y,
  size,
  flip = false,
  fill,
}: {
  suit: Suit
  x: number
  y: number
  size: number
  flip?: boolean
  fill?: string
}) {
  const s = size / 100
  const color = fill ?? suitColor(suit)
  const transform = `translate(${x} ${y}) rotate(${flip ? 180 : 0}) scale(${s}) translate(-50 -50)`
  return (
    <g transform={transform} fill={color}>
      {suit === 'h' && (
        <path d="M50 92 C22 66 4 48 4 29 C4 14 15 4 29 4 C39 4 46 10 50 18 C54 10 61 4 71 4 C85 4 96 14 96 29 C96 48 78 66 50 92Z" />
      )}
      {suit === 'd' && (
        <path d="M50 2 Q65 27 90 50 Q65 73 50 98 Q35 73 10 50 Q35 27 50 2Z" />
      )}
      {suit === 's' && (
        <path d="M50 3 C41 21 6 37 6 60 C6 74 17 83 29 83 C38 83 45 78 48 72 C47 83 42 91 33 97 L67 97 C58 91 53 83 52 72 C55 78 62 83 71 83 C83 83 94 74 94 60 C94 37 59 21 50 3Z" />
      )}
      {suit === 'c' && (
        <>
          <circle cx="50" cy="27" r="21" />
          <circle cx="27" cy="58" r="21" />
          <circle cx="73" cy="58" r="21" />
          <rect x="40" y="35" width="20" height="30" />
          <path d="M46 58 C46 80 41 90 31 97 L69 97 C59 90 54 80 54 58Z" />
        </>
      )}
    </g>
  )
}

// Pip positions for 2–10 (x, y, flipped). Bottom-half pips point down.
const L = 89,
  C = 125,
  R = 161
const PIPS: Record<number, [number, number][]> = {
  2: [
    [C, 92],
    [C, 258],
  ],
  3: [
    [C, 92],
    [C, 175],
    [C, 258],
  ],
  4: [
    [L, 92],
    [R, 92],
    [L, 258],
    [R, 258],
  ],
  5: [
    [L, 92],
    [R, 92],
    [C, 175],
    [L, 258],
    [R, 258],
  ],
  6: [
    [L, 92],
    [R, 92],
    [L, 175],
    [R, 175],
    [L, 258],
    [R, 258],
  ],
  7: [
    [L, 92],
    [R, 92],
    [C, 133],
    [L, 175],
    [R, 175],
    [L, 258],
    [R, 258],
  ],
  8: [
    [L, 92],
    [R, 92],
    [C, 133],
    [L, 175],
    [R, 175],
    [C, 217],
    [L, 258],
    [R, 258],
  ],
  9: [
    [L, 92],
    [R, 92],
    [L, 147],
    [R, 147],
    [C, 175],
    [L, 203],
    [R, 203],
    [L, 258],
    [R, 258],
  ],
  10: [
    [L, 92],
    [R, 92],
    [C, 120],
    [L, 147],
    [R, 147],
    [L, 203],
    [R, 203],
    [C, 230],
    [L, 258],
    [R, 258],
  ],
}

// The Pearl deck: a pearl face inside a thin frame, large corner indices
// that read at table size, and pips drawn a little smaller and pulled in.
// Kings, queens and jacks carry the English-pattern court figures (public
// domain artwork, recoloured to the deck: public/cards/courts) in a gilded
// double frame; every other mark is drawn here.
const SUIT_WORDS = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' }
const COURT_WORDS: Record<number, string> = {
  11: 'jack',
  12: 'queen',
  13: 'king',
}
/** The court figure behind a face card, cropped to its frame. */
const courtArt = (card: Card) =>
  `/cards/courts/${COURT_WORDS[card.rank]}_${SUIT_WORDS[card.suit]}.webp`

function Index({ card, flip }: { card: Card; flip?: boolean }) {
  const label = rankName(card.rank)
  const color = suitColor(card.suit)
  const court = card.rank >= 11 && card.rank <= 13
  return (
    <g transform={flip ? 'rotate(180 125 175)' : undefined}>
      {court ? (
        <>
          <text
            x={22}
            y={58}
            textAnchor="middle"
            className="card-index card-index-court"
            fill={color}
          >
            {label}
          </text>
          <SuitShape suit={card.suit} x={22} y={82} size={24} />
        </>
      ) : (
        <>
          <text
            x={26}
            y={76}
            className="card-index"
            fill={color}
            fontSize={label === '10' ? 60 : 68}
            letterSpacing={label === '10' ? -7 : -2}
          >
            {label}
          </text>
          <SuitShape suit={card.suit} x={45} y={108} size={30} />
        </>
      )}
    </g>
  )
}

/** The court figure in its gilded double frame (art box 40,39 170×272). */
function Court({ card }: { card: Card }) {
  const id = `qp-court-${card.rank}${card.suit}`
  return (
    <>
      <clipPath id={id}>
        <rect x="40" y="39" width="170" height="272" rx="6" />
      </clipPath>
      <image
        href={courtArt(card)}
        x="23"
        y="22"
        width="204"
        height="306"
        preserveAspectRatio="none"
        clipPath={`url(#${id})`}
      />
      <rect
        x="41.25"
        y="40.25"
        width="167.5"
        height="269.5"
        rx="5"
        fill="none"
        stroke="#d4ad5c"
        strokeWidth="2.5"
      />
      <rect
        x="44.5"
        y="43.5"
        width="161"
        height="263"
        rx="3"
        fill="none"
        stroke="rgb(254 253 251 / 0.9)"
        strokeWidth="4"
      />
      <rect
        x="46.5"
        y="45.5"
        width="157"
        height="259"
        rx="2"
        fill="none"
        stroke="rgb(212 173 92 / 0.45)"
        strokeWidth="1"
      />
    </>
  )
}

export function CardFace({
  card,
  simple = false,
}: {
  card: Card
  simple?: boolean
}) {
  const color = suitColor(card.suit)
  const pips = PIPS[card.rank]
  return (
    <svg viewBox="0 0 250 350" className="card-svg" aria-hidden="true">
      <rect width="250" height="350" rx="22" fill="url(#qp-pearl)" />
      <rect
        x="11"
        y="11"
        width="228"
        height="328"
        rx="15"
        fill="none"
        stroke="rgb(23 20 42 / 0.08)"
        strokeWidth="1.5"
      />
      {simple ? (
        <>
          <text
            x="125"
            y="170"
            textAnchor="middle"
            className="card-index card-index-lg"
            fill={color}
          >
            {rankName(card.rank)}
          </text>
          <SuitShape suit={card.suit} x={125} y={250} size={92} />
        </>
      ) : (
        <>
          {card.rank >= 11 && card.rank <= 13 && <Court card={card} />}
          <Index card={card} />
          <Index card={card} flip />
          {pips?.map(([x, y], i) => (
            <SuitShape
              key={i}
              suit={card.suit}
              x={125 + (x - 125) * 0.86}
              y={175 + (y - 175) * 0.9}
              size={40}
              flip={y > 175}
            />
          ))}
          {card.rank === 14 && (
            <>
              <circle
                cx="125"
                cy="175"
                r="70"
                fill="none"
                stroke="url(#qp-light)"
                strokeWidth="2.5"
              />
              <circle
                cx="125"
                cy="175"
                r="60"
                fill="none"
                stroke={color}
                strokeOpacity="0.08"
              />
              <SuitShape
                suit={card.suit}
                x={125}
                y={175}
                size={card.suit === 's' ? 86 : 78}
              />
            </>
          )}
        </>
      )}
    </svg>
  )
}

/** The odds arc from the felt, mirrored, on a void back. */
export function CardBack() {
  const arcs = Array.from({ length: 6 }, (_, i) => {
    const r = 34 + i * 15
    const opacity = 0.9 - i * 0.13
    return (
      <g key={i} fill="none" stroke="url(#qp-light)" strokeWidth="2">
        <path
          d={`M${125 - r} 175 A${r} ${r} 0 0 1 ${125 + r} 175`}
          strokeOpacity={opacity}
        />
        <path
          d={`M${125 - r} 175 A${r} ${r} 0 0 0 ${125 + r} 175`}
          strokeOpacity={opacity * 0.35}
        />
      </g>
    )
  })
  return (
    <svg viewBox="0 0 250 350" className="card-svg" aria-hidden="true">
      <rect width="250" height="350" rx="22" fill="#0f0d1f" />
      <rect
        x="12"
        y="12"
        width="226"
        height="326"
        rx="14"
        fill="none"
        stroke="url(#qp-light)"
        strokeOpacity="0.55"
        strokeWidth="2"
      />
      <line
        x1="26"
        y1="175"
        x2="224"
        y2="175"
        stroke="rgb(255 255 255 / 0.08)"
        strokeWidth="1.5"
      />
      {arcs}
      <SuitShape suit="s" x={125} y={165} size={26} fill="#fff" />
    </svg>
  )
}

/** Shared SVG defs (the pearl face, the light gradient). Render once per page. */
export function CardDefs() {
  return (
    <svg
      width="0"
      height="0"
      style={{ position: 'absolute' }}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="qp-pearl" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="var(--card-face, #fefdfb)" />
          <stop offset="1" stopColor="var(--card-face-2, #efedf4)" />
        </linearGradient>
        <linearGradient id="qp-light" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#6f8cff" />
          <stop offset="0.5" stopColor="#e07aa8" />
          <stop offset="1" stopColor="#f0c060" />
        </linearGradient>
      </defs>
    </svg>
  )
}
