// The counts behind the portrait, over any set of hands (hands.ts): the
// standard tracker stats (VPIP, PFR, 3-bet, aggression, continuation bets,
// showdowns), results in big blinds, decision quality where hands were
// graded, and time taken. Every rate keeps its sample, so the page can say
// how much it rests on.
import type { Grade } from '../../lib/grading'
import type { Act, Format, HoleGroup, PlayedHand, Street } from './hands'

/** `n` of `of` chances. */
export type Rate = { n: number; of: number }
export const rate = (r: Rate): number | null => (r.of ? r.n / r.of : null)

const count = (
  hands: PlayedHand[],
  chance: (h: PlayedHand) => boolean,
  hit: (h: PlayedHand) => boolean,
): Rate => {
  let n = 0,
    of = 0
  for (const h of hands)
    if (chance(h)) {
      of += 1
      if (hit(h)) n += 1
    }
  return { n, of }
}

/** A postflop bet at least this share of the pot before it is a big bet. */
export const BIG_BET = 0.66

/** The bet faced, as a share of the pot before it. */
export const betShare = (a: Act) =>
  a.facing > 0 ? a.facing / Math.max(1e-9, a.pot - a.facing) : 0

const median = (values: number[]) => {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export type Stats = {
  hands: number
  /** Big blinds won. */
  net: number
  /** Luck-adjusted, over the hands that have it. */
  expected: { net: number; hands: number }
  bbPer100: number | null
  vpip: Rate
  pfr: Rate
  threeBet: Rate
  foldTo3bet: Rate
  cbet: Rate
  foldToCbet: Rate
  /** Went to showdown, of the flops seen. */
  wtsd: Rate
  /** Won at showdown. */
  wsd: Rate
  /** After the flop. */
  postflop: { raises: number; calls: number; checks: number; folds: number }
  /** (bets + raises) / calls; null with no calls. */
  af: number | null
  /** Bets and raises, of every postflop decision but checks. */
  afq: Rate
  /** Postflop, facing a bet. */
  facing: { fold: number; call: number; raise: number }
  /** Folded to big postflop bets. */
  foldToBig: Rate
  /** River bets and raises made with under 35% equity (graded hands). */
  riverBluffs: Rate
  /** Graded decisions. */
  graded: number
  accuracy: number | null
  evLost: number
  grades: Record<Grade, number>
  /** Median decision time (online), ms. */
  decisionMs: number | null
  /** Median time on big decisions: facing a big bet, or the river. */
  bigDecisionMs: number | null
  timeouts: number
}

export function statsOf(hands: PlayedHand[]): Stats {
  const acts = hands.flatMap((h) => h.acts)
  const post = acts.filter((a) => a.street !== 'preflop')
  const postflop = { raises: 0, calls: 0, checks: 0, folds: 0 }
  const facing = { fold: 0, call: 0, raise: 0 }
  let bigFolds = 0,
    bigFaced = 0
  for (const a of post) {
    if (a.action === 'raise') postflop.raises += 1
    else if (a.action === 'call') postflop.calls += 1
    else if (a.action === 'check') postflop.checks += 1
    else postflop.folds += 1
    if (a.facing > 0) {
      if (a.action === 'fold') facing.fold += 1
      else if (a.action === 'call') facing.call += 1
      else if (a.action === 'raise') facing.raise += 1
      if (betShare(a) >= BIG_BET) {
        bigFaced += 1
        if (a.action === 'fold') bigFolds += 1
      }
    }
  }
  const graded = acts.filter((a) => a.accuracy !== undefined)
  const grades = { Best: 0, Good: 0, Inaccuracy: 0, Mistake: 0, Blunder: 0 }
  for (const a of graded) if (a.grade) grades[a.grade] += 1
  const riverRaises = acts.filter(
    (a) =>
      a.street === 'river' && a.action === 'raise' && a.equity !== undefined,
  )
  const timed = acts.filter((a) => a.ms !== undefined && !a.timeout)
  const net = hands.reduce((s, h) => s + h.net, 0)
  const withExpected = hands.filter((h) => h.expected !== undefined)
  return {
    hands: hands.length,
    net,
    expected: {
      net: withExpected.reduce((s, h) => s + h.expected!, 0),
      hands: withExpected.length,
    },
    bbPer100: hands.length ? (100 * net) / hands.length : null,
    vpip: count(
      hands,
      (h) => h.acts.some((a) => a.street === 'preflop'),
      (h) => h.vpip,
    ),
    pfr: count(
      hands,
      (h) => h.acts.some((a) => a.street === 'preflop'),
      (h) => h.pfr,
    ),
    threeBet: count(
      hands,
      (h) => h.threeBetChance,
      (h) => h.threeBet,
    ),
    foldTo3bet: count(
      hands,
      (h) => h.foldTo3betChance,
      (h) => h.foldTo3bet,
    ),
    cbet: count(
      hands,
      (h) => h.cbetChance,
      (h) => h.cbet,
    ),
    foldToCbet: count(
      hands,
      (h) => h.facedCbet,
      (h) => h.foldedToCbet,
    ),
    wtsd: count(
      hands,
      (h) => h.sawFlop,
      (h) => h.showdown,
    ),
    wsd: count(
      hands,
      (h) => h.showdown,
      (h) => h.wonShowdown,
    ),
    postflop,
    af: postflop.calls ? postflop.raises / postflop.calls : null,
    afq: {
      n: postflop.raises,
      of: postflop.raises + postflop.calls + postflop.folds,
    },
    facing,
    foldToBig: { n: bigFolds, of: bigFaced },
    riverBluffs: {
      n: riverRaises.filter((a) => a.equity! < 0.35).length,
      of: riverRaises.length,
    },
    graded: graded.length,
    accuracy: graded.length
      ? graded.reduce((s, a) => s + a.accuracy!, 0) / graded.length
      : null,
    evLost: graded.reduce((s, a) => s + (a.evLost ?? 0), 0),
    grades,
    decisionMs: median(timed.map((a) => a.ms!)),
    bigDecisionMs: median(
      timed
        .filter((a) => a.street === 'river' || betShare(a) >= BIG_BET)
        .map((a) => a.ms!),
    ),
    timeouts: acts.filter((a) => a.timeout).length,
  }
}

const groupBy = <K extends string>(
  hands: PlayedHand[],
  key: (h: PlayedHand) => K | null | undefined,
) => {
  const out = new Map<K, PlayedHand[]>()
  for (const h of hands) {
    const k = key(h)
    if (k == null) continue
    const list = out.get(k)
    if (list) list.push(h)
    else out.set(k, [h])
  }
  return out
}

export type Split<K extends string = string> = { key: K; stats: Stats }

const splits = <K extends string>(
  hands: PlayedHand[],
  key: (h: PlayedHand) => K | null | undefined,
  order?: K[],
): Split<K>[] => {
  const groups = groupBy(hands, key)
  const keys = order ? order.filter((k) => groups.has(k)) : [...groups.keys()]
  return keys.map((k) => ({ key: k, stats: statsOf(groups.get(k)!) }))
}

export const FORMATS: Format[] = ['practice', 'heads-up', 'six-max']
export const POSITIONS = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']
export const HOLE_GROUPS: HoleGroup[] = [
  'premium',
  'strong',
  'speculative',
  'weak',
]
export const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river']

/** Where graded EV went: one street and move, e.g. calling on the river. */
export type Spot = {
  street: Street
  action: Act['action']
  decisions: number
  evLost: number
  accuracy: number
}

export function spots(hands: PlayedHand[]): Spot[] {
  const map = new Map<string, Spot>()
  for (const a of hands.flatMap((h) => h.acts)) {
    if (a.accuracy === undefined) continue
    const key = `${a.street}:${a.action}`
    const s = map.get(key) ?? {
      street: a.street,
      action: a.action,
      decisions: 0,
      evLost: 0,
      accuracy: 0,
    }
    s.decisions += 1
    s.evLost += a.evLost ?? 0
    s.accuracy += a.accuracy
    map.set(key, s)
  }
  return [...map.values()]
    .map((s) => ({ ...s, accuracy: s.accuracy / s.decisions }))
    .sort((a, b) => b.evLost - a.evLost)
}

/** A losing hand at least this big (bb) is a big loss. */
export const BIG_LOSS = 20
/** Hands after a big loss that count as "right after". */
export const AFTER = 5

/**
 * The hands played right after a big loss, in the same format (a practice
 * loss says nothing about the next online hand), against the rest.
 */
export function afterLosses(hands: PlayedHand[]) {
  const after = new Set<PlayedHand>()
  let losses = 0
  for (const format of FORMATS) {
    const list = hands.filter((h) => h.format === format)
    list.forEach((h, i) => {
      if (h.net > -BIG_LOSS) return
      losses += 1
      list.slice(i + 1, i + 1 + AFTER).forEach((n) => after.add(n))
    })
  }
  return {
    losses,
    after: statsOf(hands.filter((h) => after.has(h))),
    rest: statsOf(hands.filter((h) => !after.has(h))),
  }
}

/** The history in `parts` equal stretches, oldest first. */
export function trend(hands: PlayedHand[], parts = 8) {
  const size = Math.ceil(hands.length / parts)
  if (!size) return []
  const out: Stats[] = []
  for (let i = 0; i < hands.length; i += size)
    out.push(statsOf(hands.slice(i, i + size)))
  return out
}

export type Opponent = { name: string; stats: Stats }

/** Online opponents met in at least `min` hands, most hands first. */
export function opponents(hands: PlayedHand[], min = 10): Opponent[] {
  const map = new Map<string, PlayedHand[]>()
  for (const h of hands)
    for (const o of h.opponents) {
      const list = map.get(o)
      if (list) list.push(h)
      else map.set(o, [h])
    }
  return [...map.entries()]
    .filter(([, list]) => list.length >= min)
    .map(([name, list]) => ({ name, stats: statsOf(list) }))
    .sort((a, b) => b.stats.hands - a.stats.hands)
}

export type Breakdown = {
  /** Oldest first. */
  hands: PlayedHand[]
  all: Stats
  formats: Split<Format>[]
  positions: Split[]
  holeGroups: Split<HoleGroup>[]
  spots: Spot[]
  tilt: ReturnType<typeof afterLosses>
  trend: Stats[]
  opponents: Opponent[]
}

export function breakdown(played: PlayedHand[]): Breakdown {
  const hands = [...played].sort((a, b) => a.at - b.at)
  return {
    hands,
    all: statsOf(hands),
    formats: splits(hands, (h) => h.format, FORMATS),
    positions: splits(hands, (h) => h.position, POSITIONS),
    holeGroups: splits(hands, (h) => h.holeGroup, HOLE_GROUPS),
    spots: spots(hands),
    tilt: afterLosses(hands),
    trend: trend(hands),
    opponents: opponents(hands),
  }
}
