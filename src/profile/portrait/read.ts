// What the numbers say about the player (stats.ts): a style on two axes
// (how many hands they play, how they play them), a handful of traits, and
// the big picture in plain sentences: who they are at the table, what works,
// what costs them, how they change with the game, the opponent and a bad
// beat, and where they are heading.
//
// Looseness is read against the table size: playing 60% of hands is normal
// heads-up and reckless six-handed. Each format's VPIP is placed in its own
// band, then the formats are weighed by hands played.
import type { Format } from './hands'
import { AFTER, BIG_LOSS, rate } from './stats'
import type { Breakdown, Spot, Stats } from './stats'

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v))
/** `v` placed in a band: its low edge reads 25, its high edge 75. */
const inBand = (v: number, lo: number, hi: number) =>
  clamp(25 + (50 * (v - lo)) / (hi - lo))
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(100 * v)}%`)
const bb = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)} bb`
const n = (v: number) => v.toLocaleString('en-US')
const plural = (v: number, one: string, many = `${one}s`) =>
  `${n(v)} ${v === 1 ? one : many}`

/** Usual VPIP for a sound player: [tight edge, loose edge]. */
export const VPIP_BAND: Record<Format, [number, number]> = {
  practice: [0.45, 0.75],
  'heads-up': [0.45, 0.75],
  'six-max': [0.18, 0.32],
}

export const FORMAT_NAME: Record<Format, string> = {
  practice: 'against Atlas',
  'heads-up': 'heads-up online',
  'six-max': 'at six-max tables',
}

/** Hands before any read; then how settled it is. */
export const MIN_HANDS = 30
export type Confidence = 'none' | 'early' | 'settling' | 'solid'
export const confidenceOf = (hands: number): Confidence =>
  hands < MIN_HANDS
    ? 'none'
    : hands < 200
      ? 'early'
      : hands < 1000
        ? 'settling'
        : 'solid'

/** 0–100, 50 the middle of a sound player's range; null without a sample. */
export function looseness(b: Breakdown): number | null {
  let sum = 0,
    weight = 0
  for (const { key, stats } of b.formats) {
    const v = rate(stats.vpip)
    if (v === null) continue
    sum += inBand(v, ...VPIP_BAND[key]) * stats.vpip.of
    weight += stats.vpip.of
  }
  return weight ? sum / weight : null
}

/** 0–100 from postflop bets and raises, and how often entering means raising. */
export function aggression(s: Stats): number | null {
  const parts: number[] = []
  const afq = rate(s.afq)
  if (afq !== null && s.afq.of >= 5) parts.push(inBand(afq, 0.25, 0.5))
  const vpip = rate(s.vpip)
  const pfr = rate(s.pfr)
  if (vpip && pfr !== null) parts.push(inBand(pfr / vpip, 0.4, 0.8))
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null
}

export type Archetype = { name: string; short: string; blurb: string }

export const ARCHETYPES = {
  balanced: {
    name: 'The All-rounder',
    short: 'Balanced',
    blurb:
      'You sit near the middle on both axes: a sound mix of patience and pressure that is hard to label, and hard to exploit.',
  },
  tag: {
    name: 'The Shark',
    short: 'Tight-aggressive',
    blurb:
      'You pick your hands carefully, and when you play, you play to win the pot: raising more than calling. The style most winning players share.',
  },
  lag: {
    name: 'The Maverick',
    short: 'Loose-aggressive',
    blurb:
      'You play a wide range and keep the pressure on. It wins pots others give up on, and costs the most when the reads are off.',
  },
  maniac: {
    name: 'The Maniac',
    short: 'Hyper-aggressive',
    blurb:
      'You play almost everything and bet almost every time. Opponents fold a lot, and the ones who wait for a hand get paid.',
  },
  station: {
    name: 'The Calling Station',
    short: 'Loose-passive',
    blurb:
      'You get involved often and prefer calling to raising. Curiosity keeps you in pots, but calling gives up the chance to win them by betting.',
  },
  rock: {
    name: 'The Rock',
    short: 'Tight-passive',
    blurb:
      'You wait for good hands and play them carefully. Solid, but predictable: when you do bet, opponents believe you.',
  },
  nit: {
    name: 'The Nit',
    short: 'Very tight',
    blurb:
      'You fold most hands and enter only with the best. You rarely lose big, and you leave value behind in the many pots you skip.',
  },
} satisfies Record<string, Archetype>

export function archetypeOf(loose: number, aggro: number): Archetype {
  if (Math.abs(loose - 50) < 10 && Math.abs(aggro - 50) < 10)
    return ARCHETYPES.balanced
  if (loose >= 85 && aggro >= 75) return ARCHETYPES.maniac
  if (loose <= 15 && aggro < 60) return ARCHETYPES.nit
  if (loose < 50) return aggro >= 50 ? ARCHETYPES.tag : ARCHETYPES.rock
  return aggro >= 50 ? ARCHETYPES.lag : ARCHETYPES.station
}

export type Trait = {
  key: string
  label: string
  /** 0–100. */
  value: number
  /** What the value means, in words. */
  note: string
}

const word = (v: number, low: string, mid: string, high: string) =>
  v < 35 ? low : v > 65 ? high : mid

export function traitsOf(b: Breakdown): Trait[] {
  const s = b.all
  const out: Trait[] = []
  const loose = looseness(b)
  if (loose !== null)
    out.push({
      key: 'loose',
      label: 'Looseness',
      value: loose,
      note: word(loose, 'Selective', 'Standard', 'Plays a lot of hands'),
    })
  const aggro = aggression(s)
  if (aggro !== null)
    out.push({
      key: 'aggro',
      label: 'Aggression',
      value: aggro,
      note: word(
        aggro,
        'Prefers calling',
        'Mixes bets and calls',
        'Bets and raises',
      ),
    })
  const big = rate(s.foldToBig)
  const wtsd = rate(s.wtsd)
  if (big !== null && s.foldToBig.of >= 5) {
    const value = clamp(
      wtsd === null
        ? 100 * (1 - big)
        : (100 * (1 - big) + inBand(wtsd, 0.22, 0.36)) / 2,
    )
    out.push({
      key: 'sticky',
      label: 'Stickiness',
      value,
      note: word(
        value,
        'Lets go under pressure',
        'Picks spots to continue',
        'Hard to push off a hand',
      ),
    })
  }
  const bluffs = rate(s.riverBluffs)
  if (bluffs !== null && s.riverBluffs.of >= 5) {
    const value = clamp(200 * bluffs)
    out.push({
      key: 'bluff',
      label: 'River bluffing',
      value,
      note: `${pct(bluffs)} of river bets with under 35% equity`,
    })
  }
  const weak = b.holeGroups.find((g) => g.key === 'weak')?.stats
  const weakVpip = weak && weak.vpip.of >= 10 ? rate(weak.vpip) : null
  const vpip = rate(s.vpip)
  if (weakVpip !== null && vpip) {
    const value = clamp(125 * (1 - weakVpip / vpip))
    out.push({
      key: 'discipline',
      label: 'Hand discipline',
      value,
      note: `Plays ${pct(weakVpip)} of weak starting hands, ${pct(vpip)} overall`,
    })
  }
  const composure = composureOf(b)
  if (composure)
    out.push({
      key: 'composure',
      label: 'Composure',
      value: composure.value,
      note: composure.note,
    })
  if (s.accuracy !== null && s.graded >= 10)
    out.push({
      key: 'accuracy',
      label: 'Decision accuracy',
      value: s.accuracy,
      note: `${plural(s.graded, 'graded decision')}`,
    })
  if (s.decisionMs !== null)
    out.push({
      key: 'tempo',
      label: 'Tempo',
      value: clamp(100 - s.decisionMs / 150),
      note: `${(s.decisionMs / 1000).toFixed(1)} s a decision${
        s.bigDecisionMs !== null
          ? `, ${(s.bigDecisionMs / 1000).toFixed(1)} s on big ones`
          : ''
      }`,
    })
  return out
}

/** How play changes after a big loss; null without enough of them. */
export function composureOf(b: Breakdown) {
  const { losses, after, rest } = b.tilt
  if (losses < 3 || after.hands < 15) return null
  const dv = (rate(after.vpip) ?? 0) - (rate(rest.vpip) ?? 0)
  const da =
    after.accuracy !== null && rest.accuracy !== null
      ? after.accuracy - rest.accuracy
      : 0
  const value = clamp(80 - 200 * Math.abs(dv) + 2 * Math.min(0, da))
  const changes: string[] = []
  if (Math.abs(dv) >= 0.08)
    changes.push(
      `${Math.round(100 * Math.abs(dv))} points ${dv > 0 ? 'looser' : 'tighter'}`,
    )
  if (da <= -5) changes.push(`${Math.round(-da)} points less accurately`)
  return {
    value,
    steady: changes.length === 0,
    note: changes.length
      ? `After a big loss: ${changes.join(', ')}`
      : 'Plays the same after a big loss',
    changes,
  }
}

const MOVE: Record<Spot['action'], string> = {
  fold: 'Folding',
  check: 'Checking',
  call: 'Calling',
  raise: 'Betting and raising',
}
export const spotName = (s: Pick<Spot, 'street' | 'action'>) =>
  `${MOVE[s.action]} ${s.street === 'preflop' ? 'pre-flop' : `on the ${s.street}`}`

export type Portrait = {
  confidence: Confidence
  archetype: Archetype | null
  /** The map's coordinates, 0–100. */
  loose: number | null
  aggro: number | null
  /** Each format's own place on the map. */
  formatPoints: {
    format: Format
    loose: number
    aggro: number
    hands: number
  }[]
  traits: Trait[]
  headline: string
  summary: string[]
  strengths: string[]
  leaks: string[]
  dynamics: string[]
  trajectory: string[]
}

export function portraitOf(b: Breakdown): Portrait {
  const s = b.all
  const confidence = confidenceOf(s.hands)
  const loose = looseness(b)
  const aggro = aggression(s)
  const archetype =
    confidence !== 'none' && loose !== null && aggro !== null
      ? archetypeOf(loose, aggro)
      : null
  const formatPoints = b.formats.flatMap(({ key, stats }) => {
    const v = rate(stats.vpip)
    const a = aggression(stats)
    return v !== null && a !== null && stats.hands >= 10
      ? [
          {
            format: key,
            loose: inBand(v, ...VPIP_BAND[key]),
            aggro: a,
            hands: stats.hands,
          },
        ]
      : []
  })
  const traits = traitsOf(b)

  if (confidence === 'none')
    return {
      confidence,
      archetype: null,
      loose,
      aggro,
      formatPoints,
      traits,
      headline:
        s.hands === 0
          ? 'Your portrait starts with your first hand.'
          : `${plural(s.hands, 'hand')} in. Play ${MIN_HANDS - s.hands} more for a first read of your style.`,
      summary: [],
      strengths: [],
      leaks: [],
      dynamics: [],
      trajectory: [],
    }

  const where = b.formats.map(
    ({ key, stats }) => `${n(stats.hands)} ${FORMAT_NAME[key]}`,
  )
  const headline = archetype
    ? `${archetype.name}: ${archetype.short.toLowerCase()}`
    : 'Your style is still forming'

  const summary: string[] = []
  summary.push(
    `Read from every hand you have played: ${plural(s.hands, 'hand')}${
      where.length > 1
        ? ` (${where.join(', ')})`
        : ` ${FORMAT_NAME[b.formats[0].key]}`
    }.${archetype ? ` ${archetype.blurb}` : ''}`,
  )
  const vpips = b.formats
    .filter((f) => f.stats.vpip.of >= 10)
    .map((f) => `${pct(rate(f.stats.vpip))} of hands ${FORMAT_NAME[f.key]}`)
  if (vpips.length)
    summary.push(
      `You put money in ${vpips.join(' and ')}, and raise ${pct(
        rate(s.pfr) !== null && rate(s.vpip)
          ? rate(s.pfr)! / rate(s.vpip)!
          : null,
      )} of the time you do. After the flop you bet or raise on ${pct(rate(s.afq))} of decisions${
        s.af !== null ? ` (aggression factor ${s.af.toFixed(1)})` : ''
      }.`,
    )
  const luck =
    s.expected.hands >= 20
      ? ` Luck-adjusted, the ${plural(s.expected.hands, 'hand')} with an expected result come to ${bb(s.expected.net)}.`
      : ''
  summary.push(
    `Overall you are ${bb(s.net)}, ${s.bbPer100 === null ? '' : `${s.bbPer100 >= 0 ? '+' : '−'}${Math.abs(s.bbPer100).toFixed(1)} bb per 100 hands`}.${luck}`,
  )

  const strengths: string[] = []
  const leaks: string[] = []
  const solid = b.spots.filter((p) => p.decisions >= 15)
  const best = [...solid].sort((a, b) => b.accuracy - a.accuracy).slice(0, 2)
  for (const p of best)
    if (p.accuracy >= 80)
      strengths.push(
        `${spotName(p)}: ${Math.round(p.accuracy)} accuracy over ${plural(p.decisions, 'decision')}.`,
      )
  for (const p of b.spots.slice(0, 3))
    if (p.evLost >= 5 && p.decisions >= 5)
      leaks.push(
        `${spotName(p)} has cost you ${p.evLost.toFixed(0)} bb of expected value over ${plural(p.decisions, 'decision')} (accuracy ${Math.round(p.accuracy)}).`,
      )
  const cbet = rate(s.cbet)
  if (cbet !== null && s.cbet.of >= 15) {
    if (cbet >= 0.5 && cbet <= 0.8)
      strengths.push(
        `You follow up your pre-flop raises with a flop bet ${pct(cbet)} of the time: frequent, not automatic.`,
      )
    else if (cbet > 0.85)
      leaks.push(
        `You continuation-bet ${pct(cbet)} of flops. That often is easy to spot: check some of your weaker boards.`,
      )
    else if (cbet < 0.35)
      leaks.push(
        `You continuation-bet only ${pct(cbet)} of flops, giving up the initiative your pre-flop raise earned.`,
      )
  }
  const big = rate(s.foldToBig)
  if (big !== null && s.foldToBig.of >= 15) {
    if (big >= 0.6)
      leaks.push(
        `You fold to big bets ${pct(big)} of the time. Opponents who notice will push you off hands with large bets.`,
      )
    else if (big <= 0.25)
      leaks.push(
        `You fold to big bets only ${pct(big)} of the time. Large bets are usually stronger than they look; let some go.`,
      )
    else
      strengths.push(
        `Facing big bets you fold ${pct(big)} of the time: hard to bully, not easy to value-bet.`,
      )
  }
  const weak = b.holeGroups.find((g) => g.key === 'weak')?.stats
  const premium = b.holeGroups.find((g) => g.key === 'premium')?.stats
  if (
    weak &&
    weak.hands >= 20 &&
    weak.bbPer100 !== null &&
    weak.bbPer100 < -10 &&
    (rate(weak.vpip) ?? 0) >= 0.35
  )
    leaks.push(
      `Weak starting hands: you play ${pct(rate(weak.vpip))} of them and lose ${Math.abs(weak.bbPer100).toFixed(0)} bb per 100. Folding more of them is the quickest win.`,
    )
  if (premium && premium.hands >= 10 && (rate(premium.pfr) ?? 0) >= 0.8)
    strengths.push(
      `With premium hands you raise ${pct(rate(premium.pfr))} of the time, building the pots you are favourite to win.`,
    )
  else if (premium && premium.hands >= 10 && (rate(premium.pfr) ?? 1) < 0.6)
    leaks.push(
      `With premium hands you raise only ${pct(rate(premium.pfr))} of the time. Slow-playing them keeps pots small when you are ahead.`,
    )
  const positioned = b.positions.filter(
    (p) => p.stats.hands >= 30 && p.stats.bbPer100 !== null,
  )
  if (positioned.length >= 2) {
    const sorted = [...positioned].sort(
      (a, b) => a.stats.bbPer100! - b.stats.bbPer100!,
    )
    const worst = sorted[0]
    const top = sorted.at(-1)!
    if (top.stats.bbPer100! > 0)
      strengths.push(
        `Your best seat is ${top.key}: ${bb(top.stats.bbPer100!)} per 100 hands.`,
      )
    if (worst.stats.bbPer100! < 0 && worst.key !== 'BB' && worst.key !== 'SB')
      leaks.push(
        `You lose most from ${worst.key}: ${bb(worst.stats.bbPer100!)} per 100 hands.`,
      )
  }

  const dynamics: string[] = []
  const practice = b.formats.find((f) => f.key === 'practice')?.stats
  const hu = b.formats.find((f) => f.key === 'heads-up')?.stats
  if (practice && hu && practice.hands >= 30 && hu.hands >= 30) {
    const dv = (rate(hu.vpip) ?? 0) - (rate(practice.vpip) ?? 0)
    const da = (aggression(hu) ?? 50) - (aggression(practice) ?? 50)
    dynamics.push(
      Math.abs(dv) < 0.06 && Math.abs(da) < 10
        ? 'You play real opponents the way you practise: the habits carry over.'
        : `Against real opponents heads-up you play ${Math.abs(dv) < 0.06 ? 'as many hands' : dv > 0 ? `${Math.round(100 * dv)} points looser` : `${Math.round(-100 * dv)} points tighter`} and ${Math.abs(da) < 10 ? 'just as aggressively' : da > 0 ? 'more aggressively' : 'more passively'} than against Atlas.`,
    )
  }
  const six = b.formats.find((f) => f.key === 'six-max')?.stats
  if (six && six.hands >= 30) {
    const steal = b.positions.find((p) => p.key === 'BTN' || p.key === 'CO')
    dynamics.push(
      `Six-handed you play ${pct(rate(six.vpip))} of hands${steal ? `, and ${pct(rate(steal.stats.vpip))} on the ${steal.key === 'BTN' ? 'button' : 'cutoff'}` : ''}: ${
        (rate(six.vpip) ?? 0) > VPIP_BAND['six-max'][1]
          ? 'looser than most winning players, who wait for position'
          : (rate(six.vpip) ?? 0) < VPIP_BAND['six-max'][0]
            ? 'tighter than you need to be, especially late in the hand order'
            : 'in the range most winning players keep'
      }.`,
    )
  }
  const styles = b.opponents.filter((o) => o.name.startsWith('Atlas ('))
  if (styles.length >= 2) {
    const sorted = [...styles].sort(
      (a, b) => (a.stats.bbPer100 ?? 0) - (b.stats.bbPer100 ?? 0),
    )
    const hard = sorted[0]
    dynamics.push(
      `Of Atlas's styles, ${hard.name.slice(7, -1)} gives you the most trouble (${bb(hard.stats.bbPer100 ?? 0)} per 100 over ${plural(hard.stats.hands, 'hand')}).`,
    )
  }
  const humans = b.opponents.filter((o) => !o.name.startsWith('Atlas ('))
  if (humans.length) {
    const most = humans[0]
    dynamics.push(
      `Your most-played opponent is ${most.name}: ${plural(most.stats.hands, 'hand')}, ${bb(most.stats.net)}. Against them you play ${pct(rate(most.stats.vpip))} of hands.`,
    )
  }
  const composure = composureOf(b)
  if (composure)
    dynamics.push(
      composure.steady
        ? `After your ${n(b.tilt.losses)} big losses (${BIG_LOSS} bb or more), you kept playing your game. That steadiness is rarer than it sounds.`
        : `In the ${AFTER} hands after a big loss (${BIG_LOSS} bb or more) you play ${composure.changes.join(' and ')}. Take a breath before the next one.`,
    )
  if (
    s.bigDecisionMs !== null &&
    s.decisionMs !== null &&
    s.bigDecisionMs > 2 * s.decisionMs &&
    s.decisionMs > 0
  )
    dynamics.push(
      `You take ${(s.bigDecisionMs / s.decisionMs).toFixed(1)}× longer on big decisions. Thinking hard is good; a steady tempo also gives less away.`,
    )

  const trajectory: string[] = []
  const t = b.trend
  if (t.length >= 4) {
    const half = Math.floor(t.length / 2)
    const early = t.slice(0, half)
    const late = t.slice(-half)
    const mean = (xs: (number | null)[]) => {
      const v = xs.filter((x): x is number => x !== null)
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
    }
    const accE = mean(early.map((x) => x.accuracy))
    const accL = mean(late.map((x) => x.accuracy))
    if (accE !== null && accL !== null)
      trajectory.push(
        Math.abs(accL - accE) < 2
          ? `Your accuracy has held steady around ${Math.round(accL)}.`
          : `Your accuracy has ${accL > accE ? 'risen' : 'slipped'} from ${Math.round(accE)} to ${Math.round(accL)} between your earliest and latest hands.`,
      )
    const vE = mean(early.map((x) => rate(x.vpip)))
    const vL = mean(late.map((x) => rate(x.vpip)))
    if (vE !== null && vL !== null && Math.abs(vL - vE) >= 0.05)
      trajectory.push(
        `You play ${vL > vE ? 'more' : 'fewer'} hands than you used to: ${pct(vE)} then, ${pct(vL)} lately.`,
      )
    const wE = mean(early.map((x) => x.bbPer100))
    const wL = mean(late.map((x) => x.bbPer100))
    if (wE !== null && wL !== null)
      trajectory.push(
        `Your win rate went from ${bb(wE)} to ${bb(wL)} per 100 hands.${
          Math.abs(wL - wE) > 0 && s.hands < 1000
            ? ' Results swing a lot over a few hundred hands; accuracy is the steadier guide.'
            : ''
        }`,
      )
  }

  return {
    confidence,
    archetype,
    loose,
    aggro,
    formatPoints,
    traits,
    headline,
    summary,
    strengths: strengths.slice(0, 4),
    leaks: leaks.slice(0, 4),
    dynamics,
    trajectory,
  }
}
