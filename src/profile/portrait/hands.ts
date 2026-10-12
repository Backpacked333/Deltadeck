// Every hand a player has played, in one shape: practice hands against Atlas
// (the browser's HandRecord) and online hands from the archive (HandRecordV1,
// heads-up and six-max). Each is reduced to the player's own decisions, in big
// blinds, and the facts the portrait counts (stats.ts): whether they put money
// in pre-flop, raised, faced or made a continuation bet, reached showdown.
//
// Practice records hold only the player's decisions, never Atlas's, so its
// pre-flop raises are read back from what the player faced: heads-up, every
// decision with chips to call (other than the button's first, completing the
// small blind) means Atlas raised since the player last acted.
import { positionNames } from '../../engine/positions'
import type { SeatId } from '../../engine/types'
import type { Grade } from '../../lib/grading'
import { fromId } from '../../lib/sim'
import type { HandRecord } from '../../lib/storage'
import type { HandRecordV1, MatchKind } from '../../shared/protocol'

export type Format = 'practice' | 'heads-up' | 'six-max'
export type Street = 'preflop' | 'flop' | 'turn' | 'river'
export type Move = 'fold' | 'check' | 'call' | 'raise'

/** One of the player's decisions. Chips are in big blinds. */
export type Act = {
  street: Street
  action: Move
  /** Chips to call. */
  facing: number
  /** In the middle before the action, current bets included. */
  pot: number
  /** The raise's target, or the chips a call added; 0 otherwise. */
  size: number
  /** The player's equity at the decision (practice only). */
  equity?: number
  grade?: Grade
  accuracy?: number
  /** EV given up, in big blinds. */
  evLost?: number
  /** Time taken (online only). */
  ms?: number
  timeout?: boolean
}

/** Starting hands in four groups, for "which hands do you play". */
export type HoleGroup = 'premium' | 'strong' | 'speculative' | 'weak'

export type PlayedHand = {
  id: string
  /** Epoch ms; 0 when unknown (the oldest practice records). */
  at: number
  format: Format
  /** The online kind, or 'practice'. */
  kind: MatchKind | 'practice'
  matchId?: string
  /** Players dealt in. */
  players: number
  /** BTN, SB, BB, UTG, HJ or CO; null for an unnamed seat. */
  position: string | null
  acts: Act[]
  /** Who the player was up against: usernames, or Atlas's style. */
  opponents: string[]
  /** e.g. 'AKs', 'T9o', '77'; absent when the cards are unknown. */
  hole?: string
  holeGroup?: HoleGroup
  // Pre-flop.
  vpip: boolean
  pfr: boolean
  /** Faced a single raise from someone else, and could re-raise. */
  threeBetChance: boolean
  threeBet: boolean
  /** Raised, then faced a re-raise. */
  foldTo3betChance: boolean
  foldTo3bet: boolean
  // The flop.
  sawFlop: boolean
  /** The pre-flop raiser, first to bet on the flop. */
  cbetChance: boolean
  cbet: boolean
  /** Faced the pre-flop raiser's flop bet. */
  facedCbet: boolean
  foldedToCbet: boolean
  // The end.
  showdown: boolean
  wonShowdown: boolean
  /** Result in big blinds. */
  net: number
  /** The result luck-adjusted, where known (practice EV, rated all-ins). */
  expected?: number
}

const RANKS = '23456789TJQKA'
const rankChar = (rank: number) => RANKS[rank - 2]

/** 'AKs', 'T9o' or '77', high card first. */
export function holeClass(
  a: { rank: number; suit: string | number },
  b: typeof a,
) {
  const [hi, lo] = a.rank >= b.rank ? [a, b] : [b, a]
  if (hi.rank === lo.rank) return `${rankChar(hi.rank)}${rankChar(lo.rank)}`
  return `${rankChar(hi.rank)}${rankChar(lo.rank)}${hi.suit === lo.suit ? 's' : 'o'}`
}

/**
 * A rough grouping, the same at every table size: premium (TT+, AK, AQs),
 * strong (66+, broadways, suited aces A9s+), speculative (small pairs,
 * suited connectors and one-gappers, suited aces), weak (the rest).
 */
export function holeGroup(hole: string): HoleGroup {
  const hi = RANKS.indexOf(hole[0]) + 2
  const lo = RANKS.indexOf(hole[1]) + 2
  const pair = hi === lo
  const suited = hole[2] === 's'
  if (pair) return hi >= 10 ? 'premium' : hi >= 6 ? 'strong' : 'speculative'
  if (hi === 14 && (lo === 13 || (lo === 12 && suited))) return 'premium'
  if (hi >= 10 && lo >= 10) return 'strong'
  if (hi === 14 && suited) return lo >= 9 ? 'strong' : 'speculative'
  if (suited && hi - lo <= 2 && lo >= 4) return 'speculative'
  return 'weak'
}

const SUIT_CHARS: Record<string, string> = {
  '♠': 's',
  '♥': 'h',
  '♦': 'd',
  '♣': 'c',
}
/** A practice label ('A♠', '10♥') as rank and suit; null if unreadable. */
function parseLabel(label: string) {
  const suit = SUIT_CHARS[label.slice(-1)]
  const r = label.slice(0, -1)
  const rank = r === '10' ? 10 : RANKS.indexOf(r) + 2
  return suit && rank >= 2 ? { rank, suit } : null
}

function withHole(
  cards: ({ rank: number; suit: string | number } | null)[] | undefined,
) {
  if (!cards || cards.length !== 2 || !cards[0] || !cards[1]) return {}
  const hole = holeClass(cards[0], cards[1])
  return { hole, holeGroup: holeGroup(hole) }
}

/** Practice blinds: 10 and 20 chips (src/lib/poker.ts). */
const PRACTICE_BB = 20

/** A practice hand, or null for a guided (scripted) one. */
export function fromPractice(hand: HandRecord): PlayedHand | null {
  if (hand.guided) return null
  const decisions = hand.decisions ?? []
  const bb = PRACTICE_BB
  const preflop = decisions.filter((d) => d.street === 'preflop')
  // Heads-up the button posts the small blind and acts first, facing half a
  // big blind; the big blind never faces exactly that (a raise is to 2 bb+).
  const button = preflop[0]?.toCall === bb / 2
  const acts: Act[] = decisions.map((d) => ({
    street: d.street,
    action: d.action,
    facing: d.toCall / bb,
    pot: d.pot / bb,
    size: d.amount / bb,
    equity: d.equity,
    grade: d.grade,
    accuracy: d.accuracy,
    evLost: d.evLost / bb,
  }))
  let raisesFaced = 0
  let raised = false
  let threeBetChance = false,
    threeBet = false,
    foldTo3betChance = false,
    foldTo3bet = false
  preflop.forEach((d, i) => {
    const facingRaise = d.toCall > 0 && !(i === 0 && button)
    if (facingRaise) raisesFaced += 1
    if (facingRaise && raisesFaced === 1 && !raised && !threeBetChance) {
      threeBetChance = true
      threeBet = d.action === 'raise'
    }
    if (facingRaise && raised && !foldTo3betChance) {
      foldTo3betChance = true
      foldTo3bet = d.action === 'fold'
    }
    if (d.action === 'raise') raised = true
  })
  const lastPre = preflop.at(-1)
  const foldedPre = lastPre?.action === 'fold'
  const sawFlop = !foldedPre && (hand.board?.length ?? 0) >= 3
  const flop = decisions.filter((d) => d.street === 'flop')
  const aggressor = lastPre?.action === 'raise'
  const atlasAggressor =
    !!lastPre && lastPre.action === 'call' && raisesFaced > 0
  const cbetChance = sawFlop && aggressor && flop[0]?.toCall === 0
  const faced =
    sawFlop && atlasAggressor ? flop.find((d) => d.toCall > 0) : undefined
  // Atlas's bet is a continuation bet only if the player had not bet first.
  const facedCbet =
    !!faced &&
    !flop.slice(0, flop.indexOf(faced)).some((d) => d.action === 'raise')
  const folded = decisions.some((d) => d.action === 'fold')
  return {
    id: `practice:${hand.id}`,
    at: hand.at ?? 0,
    format: 'practice',
    kind: 'practice',
    players: 2,
    position: preflop.length === 0 ? 'BB' : button ? 'BTN' : 'BB',
    acts,
    opponents: [`Atlas (${hand.style ?? 'balanced'})`],
    ...withHole(hand.hero?.map(parseLabel)),
    vpip: preflop.some((d) => d.action === 'call' || d.action === 'raise'),
    pfr: preflop.some((d) => d.action === 'raise'),
    threeBetChance,
    threeBet,
    foldTo3betChance,
    foldTo3bet,
    sawFlop,
    cbetChance,
    cbet: cbetChance && flop[0].action === 'raise',
    facedCbet,
    foldedToCbet: facedCbet && faced!.action === 'fold',
    showdown: !!hand.showdown && !folded,
    wonShowdown: !!hand.showdown && !folded && hand.net > 0,
    net: hand.net / bb,
    ...(hand.expectedNet !== undefined
      ? { expected: hand.expectedNet / bb }
      : {}),
  }
}

/** A rated decision's grade as the archive stores it. */
export type OnlineGrade = {
  idx: number
  grade: 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder'
  evLost: number
  accuracy: number
}

const GRADE_NAME: Record<OnlineGrade['grade'], Grade> = {
  best: 'Best',
  good: 'Good',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
}

const FORMAT: Record<MatchKind, Format> = {
  'hu-casual': 'heads-up',
  'hu-rated': 'heads-up',
  'six-casual': 'six-max',
}

/** An archived hand from the player's side, or null if they were not in it. */
export function fromOnline(
  record: HandRecordV1,
  userId: string,
  kind: MatchKind,
  extra: { at?: number; hole?: number[]; grades?: OnlineGrade[] } = {},
): PlayedHand | null {
  const me = record.seats.find((s) => s.userId === userId)
  if (!me) return null
  const hero: SeatId = me.seat
  const { config } = record
  const bb = config.blinds.bb
  const grades = new Map((extra.grades ?? []).map((g) => [g.idx, g]))
  const seats = config.seats.map((s) => s.seat)
  const names = positionNames(
    seats,
    config.button,
    config.bb !== undefined
      ? { sb: config.sb ?? null, bb: config.bb }
      : undefined,
  )

  const acts: Act[] = []
  let raises = 0
  let lastRaiser: SeatId | null = null
  let heroRaisedPre = false
  let threeBetChance = false,
    threeBet = false,
    foldTo3betChance = false,
    foldTo3bet = false
  let preflopAggressor: SeatId | null = null
  let flopBetBy: SeatId | null = null
  let cbetChance = false,
    cbet = false,
    facedCbet = false,
    foldedToCbet = false
  let heroFolded = false
  let foldedPre = false

  record.actions.forEach((a, idx) => {
    const move = a.action.type
    if (a.street === 'flop' && preflopAggressor === null)
      preflopAggressor = lastRaiser
    if (a.seat === hero) {
      const g = grades.get(idx)
      acts.push({
        street: a.street,
        action: move,
        facing: a.toCall / bb,
        pot: a.pot / bb,
        size: a.amount / bb,
        ms: a.decisionMs,
        ...(a.source === 'timeout' ? { timeout: true } : {}),
        ...(g
          ? {
              grade: GRADE_NAME[g.grade],
              accuracy: g.accuracy,
              evLost: g.evLost / bb,
            }
          : {}),
      })
      if (a.street === 'preflop') {
        const facingRaise = raises >= 1 && lastRaiser !== hero
        if (facingRaise && raises === 1 && !heroRaisedPre && !threeBetChance) {
          threeBetChance = true
          threeBet = move === 'raise'
        }
        if (facingRaise && heroRaisedPre && !foldTo3betChance) {
          foldTo3betChance = true
          foldTo3bet = move === 'fold'
        }
        if (move === 'raise') heroRaisedPre = true
        if (move === 'fold') foldedPre = true
      }
      if (a.street === 'flop') {
        if (preflopAggressor === hero && flopBetBy === null && !cbetChance) {
          cbetChance = true
          cbet = move === 'raise'
        }
        if (
          preflopAggressor !== null &&
          preflopAggressor !== hero &&
          flopBetBy === preflopAggressor &&
          !facedCbet
        ) {
          facedCbet = true
          foldedToCbet = move === 'fold'
        }
      }
      if (move === 'fold') heroFolded = true
    }
    if (move === 'raise') {
      if (a.street === 'preflop') {
        raises += 1
        lastRaiser = a.seat
      } else if (a.street === 'flop' && flopBetBy === null) {
        flopBetBy = a.seat
      }
    }
  })

  const net = (record.netBySeat[hero] ?? 0) / bb
  const adjusted = record.luck?.adjustedBySeat?.[hero]
  const preActs = acts.filter((a) => a.street === 'preflop')
  const showdown = record.showdown && !heroFolded
  return {
    id: `${record.matchId}:${record.handNo}`,
    at: extra.at ?? 0,
    format: FORMAT[kind],
    kind,
    matchId: record.matchId,
    players: seats.length,
    position: names[hero] ?? null,
    acts,
    opponents: record.seats
      .filter((s) => s.seat !== hero)
      .map((s) => s.username),
    ...withHole(extra.hole?.map(fromId)),
    vpip: preActs.some((a) => a.action === 'call' || a.action === 'raise'),
    pfr: preActs.some((a) => a.action === 'raise'),
    threeBetChance,
    threeBet,
    foldTo3betChance,
    foldTo3bet,
    sawFlop: !foldedPre && record.board.length >= 3,
    cbetChance,
    cbet,
    facedCbet,
    foldedToCbet,
    showdown,
    wonShowdown: showdown && record.awards.some((w) => w.seat === hero),
    net,
    ...(adjusted !== undefined ? { expected: adjusted / bb } : {}),
  }
}
