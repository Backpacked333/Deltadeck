// Vector card art drawn in a 250×350 box. Everything here is original and
// generated in code: suit shapes, pip layouts and geometric court portraits.
import type { Card, Suit } from '../../lib/poker'
import { rankName } from '../../lib/poker'

const RED = 'var(--card-red, #c0392f)'
const INK = 'var(--card-ink, #1d2a24)'
const GOLD = '#c9a24a'
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

function Index({ card, flip }: { card: Card; flip?: boolean }) {
  const label = rankName(card.rank)
  return (
    <g transform={flip ? 'rotate(180 125 175)' : undefined}>
      <text
        x={label === '10' ? 36 : 34}
        y={66}
        textAnchor="middle"
        className="card-index"
        fill={suitColor(card.suit)}
        letterSpacing={label === '10' ? -4 : 0}
      >
        {label}
      </text>
      <SuitShape suit={card.suit} x={34} y={96} size={34} />
    </g>
  )
}

/** One half of a court portrait; the card mirrors it like a real deck. */
function CourtHalf({ card }: { card: Card }) {
  const color = suitColor(card.suit)
  const rank = card.rank
  return (
    <g>
      {/* robe with gold trim */}
      <path
        d="M84 172 C86 152 98 140 110 137 L140 137 C152 140 164 152 166 172 Z"
        fill={color}
      />
      <path
        d="M84 172 C86 152 98 140 110 137 L140 137 C152 140 164 152 166 172"
        fill="none"
        stroke={GOLD}
        strokeWidth="2.5"
      />
      <path
        d="M125 137 V172"
        stroke={GOLD}
        strokeWidth="2"
        strokeOpacity="0.8"
      />
      <path
        d="M108 136 L117 150 L125 138 L133 150 L142 136"
        fill="none"
        stroke="#fff"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <SuitShape suit={card.suit} x={108} y={160} size={16} fill="#fff" />
      <SuitShape suit={card.suit} x={142} y={160} size={16} fill="#fff" />
      {/* head */}
      <ellipse cx="125" cy="114" rx="17" ry="20" fill="#f1d9bd" />
      <path
        d="M115 112 h6 M129 112 h6"
        stroke={INK}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      {rank === 13 && (
        <>
          {/* crown */}
          <path
            d="M104 98 L108 74 L117 88 L125 70 L133 88 L142 74 L146 98 Z"
            fill={GOLD}
            stroke="#8a6a24"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <circle cx="125" cy="86" r="3.5" fill={color} />
          <path
            d="M108 128 Q125 142 142 128 L142 122 Q125 134 108 122 Z"
            fill="#8a6a24"
          />
        </>
      )}
      {rank === 12 && (
        <>
          {/* tiara and hair */}
          <path
            d="M106 106 C104 88 114 80 125 80 C136 80 146 88 144 106 C140 96 134 92 125 92 C116 92 110 96 106 106 Z"
            fill={INK}
          />
          <path
            d="M108 90 Q125 72 142 90"
            fill="none"
            stroke={GOLD}
            strokeWidth="4"
            strokeLinecap="round"
          />
          <circle cx="125" cy="78" r="4" fill={GOLD} />
          <circle cx="114" cy="83" r="2.5" fill={GOLD} />
          <circle cx="136" cy="83" r="2.5" fill={GOLD} />
        </>
      )}
      {rank === 11 && (
        <>
          {/* cap and feather */}
          <path
            d="M104 100 C104 84 116 78 128 78 C142 78 150 86 148 98 Z"
            fill={color}
          />
          <path
            d="M104 100 L148 98"
            stroke={GOLD}
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path
            d="M140 82 C150 70 162 66 170 68 C162 74 154 80 146 88"
            fill="none"
            stroke={GOLD}
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </>
      )}
    </g>
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
      <rect
        x="0"
        y="0"
        width="250"
        height="350"
        rx="18"
        fill="var(--card-face, #fffefa)"
      />
      <rect
        x="0"
        y="0"
        width="250"
        height="350"
        rx="18"
        filter="url(#qp-grain)"
        opacity="0.5"
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
          <Index card={card} />
          <Index card={card} flip />
          {pips?.map(([x, y], i) => (
            <SuitShape
              key={i}
              suit={card.suit}
              x={x}
              y={y}
              size={46}
              flip={y > 175}
            />
          ))}
          {card.rank === 14 && (
            <>
              <circle
                cx="125"
                cy="175"
                r="62"
                fill="none"
                stroke={color}
                strokeOpacity="0.18"
                strokeWidth="2"
              />
              <SuitShape
                suit={card.suit}
                x={125}
                y={175}
                size={card.suit === 's' ? 104 : 92}
              />
            </>
          )}
          {card.rank >= 11 && card.rank <= 13 && (
            <>
              <rect
                x="56"
                y="62"
                width="138"
                height="226"
                rx="10"
                fill={color}
                fillOpacity="0.07"
                stroke={color}
                strokeWidth="2.5"
              />
              <clipPath id={`court-${card.rank}${card.suit}`}>
                <rect x="58" y="64" width="134" height="222" rx="8" />
              </clipPath>
              <g clipPath={`url(#court-${card.rank}${card.suit})`}>
                <CourtHalf card={card} />
                <g transform="rotate(180 125 175)">
                  <CourtHalf card={card} />
                </g>
              </g>
              <line
                x1="58"
                y1="175"
                x2="192"
                y2="175"
                stroke={color}
                strokeOpacity="0.35"
                strokeWidth="1.5"
              />
            </>
          )}
        </>
      )}
    </svg>
  )
}

export function CardBack() {
  return (
    <svg viewBox="0 0 250 350" className="card-svg" aria-hidden="true">
      <rect
        width="250"
        height="350"
        rx="18"
        fill="var(--card-back-2, #1b4c3c)"
      />
      <rect
        x="10"
        y="10"
        width="230"
        height="330"
        rx="12"
        fill="url(#qp-lattice)"
      />
      <rect
        x="10"
        y="10"
        width="230"
        height="330"
        rx="12"
        fill="none"
        stroke="rgba(255,255,255,0.55)"
        strokeWidth="3"
      />
      <circle
        cx="125"
        cy="175"
        r="44"
        fill="var(--card-back-2, #1b4c3c)"
        stroke={GOLD}
        strokeWidth="3"
      />
      <SuitShape suit="s" x={125} y={175} size={52} fill={GOLD} />
    </svg>
  )
}

/** Shared SVG defs (grain filter, back lattice). Render once per page. */
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
        <filter id="qp-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="2"
            seed="7"
          />
          <feColorMatrix values="0 0 0 0 0.35  0 0 0 0 0.3  0 0 0 0 0.2  0 0 0 0.09 0" />
          <feComposite in2="SourceGraphic" operator="in" />
        </filter>
        <pattern
          id="qp-lattice"
          width="20"
          height="20"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="20" height="20" fill="var(--card-back-1, #2b6e57)" />
          <path
            d="M0 10 H20 M10 0 V20"
            stroke="rgba(255,255,255,0.13)"
            strokeWidth="2"
          />
          <circle cx="10" cy="10" r="2.2" fill="rgba(255,255,255,0.2)" />
        </pattern>
      </defs>
    </svg>
  )
}
