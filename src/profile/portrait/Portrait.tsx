// The player portrait on Your profile: every hand the player has played
// (load.ts), read as a style, traits and the big picture (read.ts), with the
// numbers behind it split by format, seat, starting hand and opponent.
import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Fingerprint } from 'lucide-react'
import { LineChart } from '../../components/progress/Charts'
import type { HandRecord } from '../../lib/storage'
import { loadEveryHand } from './load'
import type { EveryHand } from './load'
import { ARCHETYPES, FORMAT_NAME, aggression, portraitOf } from './read'
import type { Portrait as PortraitRead } from './read'
import { breakdown, rate } from './stats'
import type { Rate, Split, Stats } from './stats'

const pct = (r: Rate) => {
  const v = rate(r)
  return v === null ? '—' : `${Math.round(100 * v)}`
}
const per100 = (v: number | null) =>
  v === null ? '—' : `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}`
const num = (v: number) => v.toLocaleString('en-US')

const CONFIDENCE = {
  none: 'Not enough hands yet',
  early: 'Early read',
  settling: 'Taking shape',
  solid: 'Settled',
} as const

/** The style map: looseness across, aggression up. */
function StyleMap({ portrait }: { portrait: PortraitRead }) {
  const size = 240,
    pad = 8
  const at = (v: number) => pad + (v / 100) * (size - 2 * pad)
  const quadrants = [
    { x: 0, y: 0, label: ARCHETYPES.tag.short },
    { x: 1, y: 0, label: ARCHETYPES.lag.short },
    { x: 0, y: 1, label: ARCHETYPES.rock.short },
    { x: 1, y: 1, label: ARCHETYPES.station.short },
  ]
  const { loose, aggro } = portrait
  return (
    <svg
      className="style-map"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={
        loose !== null && aggro !== null
          ? `Style map: looseness ${Math.round(loose)} of 100, aggression ${Math.round(aggro)} of 100`
          : 'Style map: not enough hands yet'
      }
    >
      <rect
        className="style-map-bg"
        x={pad}
        y={pad}
        width={size - 2 * pad}
        height={size - 2 * pad}
        rx="10"
      />
      <line
        className="style-map-axis"
        x1={size / 2}
        x2={size / 2}
        y1={pad}
        y2={size - pad}
      />
      <line
        className="style-map-axis"
        y1={size / 2}
        y2={size / 2}
        x1={pad}
        x2={size - pad}
      />
      {quadrants.map((q) => (
        <text
          key={q.label}
          className="style-map-label"
          x={q.x ? size - pad - 8 : pad + 8}
          y={q.y ? size - pad - 10 : pad + 18}
          textAnchor={q.x ? 'end' : 'start'}
        >
          {q.label}
        </text>
      ))}
      <text
        className="style-map-axis-text"
        x={size / 2}
        y={size - pad - 10}
        textAnchor="middle"
      >
        looser →
      </text>
      <text
        className="style-map-axis-text"
        x={pad + 14}
        y={size / 2}
        textAnchor="middle"
        transform={`rotate(-90 ${pad + 14} ${size / 2})`}
      >
        more aggressive →
      </text>
      {portrait.formatPoints.length > 1 &&
        portrait.formatPoints.map((p) => (
          <g key={p.format}>
            <circle
              className={`style-map-format ${p.format}`}
              cx={at(p.loose)}
              cy={at(100 - p.aggro)}
              r="6"
            />
            <title>{`${FORMAT_NAME[p.format]}: ${num(p.hands)} hands`}</title>
          </g>
        ))}
      {loose !== null && aggro !== null && (
        <circle
          className="style-map-you"
          cx={at(loose)}
          cy={at(100 - aggro)}
          r="9"
        />
      )}
    </svg>
  )
}

const STAT_ROWS: {
  label: string
  title: string
  value: (s: Stats) => string
}[] = [
  { label: 'Hands', title: 'Hands played', value: (s) => num(s.hands) },
  {
    label: 'VPIP',
    title: 'Voluntarily put money in the pot pre-flop, %',
    value: (s) => pct(s.vpip),
  },
  { label: 'PFR', title: 'Raised pre-flop, %', value: (s) => pct(s.pfr) },
  {
    label: '3-bet',
    title: 'Re-raised a single raise pre-flop, %',
    value: (s) => pct(s.threeBet),
  },
  {
    label: 'Fold to 3-bet',
    title: 'Folded after raising and being re-raised, %',
    value: (s) => pct(s.foldTo3bet),
  },
  {
    label: 'C-bet',
    title: 'Bet the flop after raising pre-flop, %',
    value: (s) => pct(s.cbet),
  },
  {
    label: 'Fold to c-bet',
    title: "Folded to the pre-flop raiser's flop bet, %",
    value: (s) => pct(s.foldToCbet),
  },
  {
    label: 'Aggression',
    title: 'After the flop, bets and raises per call',
    value: (s) => (s.af === null ? '—' : s.af.toFixed(1)),
  },
  {
    label: 'WTSD',
    title: 'Went to showdown, of flops seen, %',
    value: (s) => pct(s.wtsd),
  },
  { label: 'W$SD', title: 'Won at showdown, %', value: (s) => pct(s.wsd) },
  {
    label: 'bb/100',
    title: 'Big blinds won per 100 hands',
    value: (s) => per100(s.bbPer100),
  },
  {
    label: 'Accuracy',
    title: 'Mean accuracy of graded decisions',
    value: (s) => (s.accuracy === null ? '—' : `${Math.round(s.accuracy)}`),
  },
]

function StatTable({
  caption,
  columns,
  rows = STAT_ROWS,
}: {
  caption: string
  columns: { name: string; stats: Stats }[]
  rows?: typeof STAT_ROWS
}) {
  return (
    <div className="portrait-table-wrap">
      <table className="portrait-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" />
            {columns.map((c) => (
              <th key={c.name} scope="col">
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">
                <abbr title={r.title}>{r.label}</abbr>
              </th>
              {columns.map((c) => (
                <td key={c.name}>{r.value(c.stats)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const pick = (labels: string[]) =>
  STAT_ROWS.filter((r) => labels.includes(r.label))
const FORMAT_TITLE = {
  practice: 'vs Atlas',
  'heads-up': 'Heads-up',
  'six-max': 'Six-max',
} as const
const GROUP_TITLE = {
  premium: 'Premium (TT+, AK, AQs)',
  strong: 'Strong (66+, broadway, A9s+)',
  speculative: 'Speculative (small pairs, suited)',
  weak: 'Weak (everything else)',
} as const

function List({
  title,
  items,
  tone,
}: {
  title: string
  items: string[]
  tone?: string
}) {
  if (!items.length) return null
  return (
    <div className={`portrait-list ${tone ?? ''}`}>
      <h3>{title}</h3>
      <ul>
        {items.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </div>
  )
}

type Load =
  | { status: 'loading' }
  | { status: 'failed' }
  | ({ status: 'ready' } & EveryHand)

export function Portrait({
  client,
  userId,
  local,
}: {
  /** The account service; null for this browser's practice hands alone. */
  client: SupabaseClient | null
  userId: string | null
  local: HandRecord[]
}) {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setLoad({ status: 'loading' })
    loadEveryHand(client, userId, local).then(
      (every) => live && setLoad({ status: 'ready', ...every }),
      () => live && setLoad({ status: 'failed' }),
    )
    return () => {
      live = false
    }
    // The local hands are read once per load: a hand played meanwhile is in
    // the next visit's portrait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, userId, attempt])

  const hands = load.status === 'ready' ? load.hands : null
  const b = useMemo(() => (hands ? breakdown(hands) : null), [hands])
  const portrait = useMemo(() => (b ? portraitOf(b) : null), [b])

  return (
    <section className="panel portrait" aria-labelledby="me-portrait">
      <div className="panel-head">
        <div>
          <h2 id="me-portrait">
            <Fingerprint size={18} /> Your player portrait
          </h2>
          <p>
            Built from every hand you have ever played: against Atlas, heads-up
            and at six-max tables.
          </p>
        </div>
        {portrait && b && (
          <span className={`portrait-confidence ${portrait.confidence}`}>
            {CONFIDENCE[portrait.confidence]} · {num(b.all.hands)} hand
            {b.all.hands === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {load.status === 'loading' ? (
        <p className="muted" role="status">
          Reading every hand you have played…
        </p>
      ) : load.status === 'failed' || !b || !portrait ? (
        <p className="muted" role="alert">
          Your hands could not be read.{' '}
          <button
            className="text-button"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </button>
        </p>
      ) : (
        <>
          {load.missing.length > 0 && (
            <p className="muted" role="alert">
              Drawn without your{' '}
              {load.missing
                .map((m) =>
                  m === 'online' ? 'online hands' : 'saved practice hands',
                )
                .join(' or ')}
              , which could not be loaded.{' '}
              <button
                className="text-button"
                onClick={() => setAttempt((n) => n + 1)}
              >
                Try again
              </button>
            </p>
          )}
          <div className="portrait-identity">
            <StyleMap portrait={portrait} />
            <div className="portrait-headline">
              {portrait.archetype ? (
                <>
                  <span className="portrait-kicker">
                    {portrait.archetype.short}
                  </span>
                  <strong>{portrait.archetype.name}</strong>
                </>
              ) : (
                <strong>Your style is still forming</strong>
              )}
              <p>
                {portrait.archetype
                  ? portrait.archetype.blurb
                  : portrait.headline}
              </p>
              {portrait.traits.length > 0 && (
                <dl className="portrait-traits">
                  {portrait.traits.map((t) => (
                    <div key={t.key}>
                      <dt>{t.label}</dt>
                      <dd>
                        <span className="portrait-bar" aria-hidden="true">
                          <span style={{ width: `${Math.round(t.value)}%` }} />
                        </span>
                        <small>{t.note}</small>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </div>

          {portrait.summary.length > 0 && (
            <div className="portrait-big-picture">
              <h3>The big picture</h3>
              {portrait.summary.map((s) => (
                <p key={s}>{s}</p>
              ))}
              <div className="portrait-lists">
                <List
                  title="What works"
                  items={portrait.strengths}
                  tone="good"
                />
                <List
                  title="What costs you"
                  items={portrait.leaks}
                  tone="bad"
                />
                <List title="How you adapt" items={portrait.dynamics} />
                <List
                  title="Where you are heading"
                  items={portrait.trajectory}
                />
              </div>
            </div>
          )}

          {b.trend.length >= 4 && (
            <div>
              <h3>How your game has moved</h3>
              <LineChart
                width={980}
                height={180}
                label="Your style across your history, in equal stretches of hands"
                ends={['Earliest', 'Latest']}
                format={(v) => `${Math.round(v)}`}
                series={[
                  {
                    label: 'VPIP',
                    className: 'actual',
                    values: b.trend.map((s) => 100 * (rate(s.vpip) ?? 0)),
                  },
                  {
                    label: 'Aggression',
                    className: 'expected',
                    values: b.trend.map((s) => aggression(s) ?? 50),
                  },
                  ...(b.trend.every((s) => s.accuracy !== null)
                    ? [
                        {
                          label: 'Accuracy',
                          className: 'accuracy',
                          values: b.trend.map((s) => s.accuracy!),
                        },
                      ]
                    : []),
                ]}
              />
              <div className="legend">
                <span>
                  <i className="series-key actual" /> VPIP %
                </span>
                <span>
                  <i className="series-key expected" /> Aggression (0–100)
                </span>
                {b.trend.every((s) => s.accuracy !== null) && (
                  <span>
                    <i className="series-key accuracy" /> Accuracy
                  </span>
                )}
              </div>
            </div>
          )}

          {b.all.hands > 0 && (
            <details className="portrait-numbers" open={b.all.hands >= 30}>
              <summary>Every number, by context</summary>
              <h3>By game</h3>
              <StatTable
                caption="Your stats overall and in each format"
                columns={[
                  { name: 'All', stats: b.all },
                  ...(b.formats.length > 1
                    ? b.formats.map((f) => ({
                        name: FORMAT_TITLE[f.key],
                        stats: f.stats,
                      }))
                    : []),
                ]}
              />
              {b.positions.length > 1 && (
                <>
                  <h3>By seat</h3>
                  <StatTable
                    caption="Your stats in each position"
                    columns={b.positions.map((p: Split) => ({
                      name: p.key,
                      stats: p.stats,
                    }))}
                    rows={pick([
                      'Hands',
                      'VPIP',
                      'PFR',
                      '3-bet',
                      'C-bet',
                      'bb/100',
                      'Accuracy',
                    ])}
                  />
                </>
              )}
              {b.holeGroups.length > 0 && (
                <>
                  <h3>By starting hand</h3>
                  <StatTable
                    caption="Your stats with each group of starting hands"
                    columns={b.holeGroups.map((g) => ({
                      name: GROUP_TITLE[g.key],
                      stats: g.stats,
                    }))}
                    rows={pick(['Hands', 'VPIP', 'PFR', 'WTSD', 'bb/100'])}
                  />
                </>
              )}
              {b.opponents.length > 0 && (
                <>
                  <h3>By opponent</h3>
                  <StatTable
                    caption="Your stats against the opponents you have met most"
                    columns={b.opponents
                      .slice(0, 6)
                      .map((o) => ({ name: o.name, stats: o.stats }))}
                    rows={pick([
                      'Hands',
                      'VPIP',
                      'PFR',
                      'Aggression',
                      'WTSD',
                      'bb/100',
                    ])}
                  />
                </>
              )}
            </details>
          )}
        </>
      )}
    </section>
  )
}
