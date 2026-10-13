import { useId } from 'react'
import { DataTable } from './DataTable'
const linePatterns = [
  undefined,
  '8 4',
  '2 4',
  '10 4 2 4',
  '10 4 2 4 2 4',
  '12 6',
  '3 3',
  '6 3 1 3',
  '12 3 4 3',
  '1 5',
]
export interface SeriesChartProps {
  title: string
  summary: string
  xLabel: string
  xUnits: string
  yLabel: string
  yUnits: string
  series: readonly {
    name: string
    points: readonly { x: number; y: number | null }[]
  }[]
}
export function SeriesChart({
  title,
  summary,
  xLabel,
  xUnits,
  yLabel,
  yUnits,
  series,
}: SeriesChartProps) {
  const id = useId(),
    points = series.flatMap((s) => s.points)
  if (
    series.length > 10 ||
    points.length > 2000 ||
    points.some(
      (p) => !Number.isFinite(p.x) || (p.y !== null && !Number.isFinite(p.y)),
    )
  )
    return (
      <p role="alert">
        Chart data is invalid or too large; use finite public summaries up
        to2,000 points.
      </p>
    )
  const ys = points.flatMap((p) => (p.y === null ? [] : [p.y]))
  const xmin = points.length ? Math.min(...points.map((p) => p.x)) : 0,
    xmax = points.length ? Math.max(...points.map((p) => p.x)) : 1
  const ymin = ys.length ? Math.min(...ys) : 0,
    ymax = ys.length ? Math.max(...ys) : 1
  const x = (n: number) => 35 + (430 * (n - xmin)) / (xmax - xmin || 1),
    y = (n: number) => 220 - (180 * (n - ymin)) / (ymax - ymin || 1)
  return (
    <figure className="qp-series-chart">
      <figcaption id={id}>
        <strong>{title}</strong> — {summary}
      </figcaption>
      <ul aria-label="Chart line key">
        {series.map((s, i) => (
          <li key={s.name}>
            {s.name} —{' '}
            {linePatterns[i]
              ? `dash/gap pattern ${linePatterns[i]}`
              : 'solid line'}
          </li>
        ))}
      </ul>
      {ys.length ? (
        <svg
          viewBox="0 0 500 270"
          role="img"
          aria-labelledby={id}
          aria-describedby={`${id}-axes`}
        >
          <path d="M35,30V220H465" fill="none" stroke="currentColor" />
          {series.map((s, i) => {
            let move = true
            const path = s.points
              .map((p) => {
                if (p.y === null) {
                  move = true
                  return ''
                }
                const segment = `${move ? 'M' : 'L'}${x(p.x)},${y(p.y)}`
                move = false
                return segment
              })
              .join(' ')
            return (
              <g key={s.name}>
                <path
                  d={path}
                  fill="none"
                  stroke={['#176842', '#694c15', '#774083'][i % 3]}
                  strokeWidth={3}
                  strokeDasharray={linePatterns[i]}
                >
                  {<title>{s.name}</title>}
                </path>
                {s.points
                  .filter((p) => p.y !== null)
                  .map((p, j) => (
                    <circle
                      key={j}
                      cx={x(p.x)}
                      cy={y(p.y!)}
                      r={2}
                      fill="currentColor"
                    />
                  ))}
              </g>
            )
          })}
          <text x={35} y={245}>
            {xLabel} ({xUnits}): {xmin}–{xmax}
          </text>
          <text x={35} y={20}>
            {yLabel} ({yUnits}): {ymin}–{ymax}
          </text>
        </svg>
      ) : (
        <p>No reachable finite chart values are available.</p>
      )}
      <p id={`${id}-axes`}>
        Horizontal: {xLabel} ({xUnits}); vertical: {yLabel} ({yUnits}).
        Undefined branches are gaps, not zero. Every plotted value is provided
        in the table.
      </p>
      <DataTable
        caption={`${title} — equivalent values`}
        summary={summary}
        columns={['Series', `${xLabel} (${xUnits})`, `${yLabel} (${yUnits})`]}
        rows={series.flatMap((s) => s.points.map((p) => [s.name, p.x, p.y]))}
      />
    </figure>
  )
}
